"""Persistent Python worker for the pi "python" tool.

Runs inside a bubblewrap sandbox as one long-lived process that owns a single
execution namespace. Protocol: line-delimited JSON.

    requests  (fd 0, parent -> worker): {"type":"exec","protocol":1,"id":N,"code":"..."}
    responses (fd 3, worker -> parent): {"type":"ready"|"result"|"error",...}

Isolation guarantees installed here, before any user code runs:

* PR_SET_PDEATHSIG SIGKILL: if the parent (bwrap) dies, this process dies.
* RLIMIT_AS 512 MiB, RLIMIT_FSIZE 16 MiB, RLIMIT_NOFILE 128, RLIMIT_CORE 0,
  inherited by subprocesses. Per-process limits, not aggregate quotas.
* libseccomp policy (via system libseccomp, no Python packages): socket(),
  socketpair(), ptrace, bpf, userfaultfd, perf_event_open, process_vm_*,
  kexec and open_by_handle_at syscalls fail with EPERM. This blocks external
  network access and connections to host Unix-domain sockets exposed through
  bind mounts, which a network namespace alone does not prevent.

fd layout during user code:

* fd 0 is /dev/null, so input() and subprocess stdin meet immediate EOF and
  user code can never consume protocol requests.
* fd 1 and fd 2 are plain pipes the parent captures; print() and
  os.write(1, ...) cannot touch the protocol channel.
* fd 3 is the dedicated response channel. subprocesses do not inherit it
  (Python's subprocess defaults to close_fds=True).

The final expression of submitted code is evaluated and its repr returned,
bounded, like an interactive REPL (None is not shown).
"""

import ast
import ctypes
import json
import os
import resource
import sys
import traceback

PROTOCOL_VERSION = 1
RESPONSE_FD = 3
MAX_FRAME_BYTES = 128 * 1024
MAX_MESSAGE_CHARS = 8192
MAX_EXCEPTION_TYPE_CHARS = 128

# Syscalls blocked with EPERM. socket/socketpair are required restrictions:
# if libseccomp cannot install them, startup fails closed.
REQUIRED_BLOCKED = ("socket", "socketpair")
ALSO_BLOCKED = (
    "ptrace",
    "bpf",
    "userfaultfd",
    "perf_event_open",
    "process_vm_readv",
    "process_vm_writev",
    "kexec_load",
    "kexec_file_load",
    "open_by_handle_at",
    "name_to_handle_at",
)

SCMP_ACT_ALLOW = 0x7FFF0000
SCMP_ACT_ERRNO = 0x00050000
EPERM = 1
PR_SET_PDEATHSIG = 1
SIGKILL = 9


def send_frame(payload):
    """Write one JSON line to the protocol fd, handling partial writes."""
    data = (json.dumps(payload, ensure_ascii=True) + "\n").encode("ascii")
    view = memoryview(data)
    while view:
        written = os.write(RESPONSE_FD, view)
        view = view[written:]


def send_error(message, request_id=None):
    send_frame(
        {
            "type": "error",
            "protocol": PROTOCOL_VERSION,
            "id": request_id,
            "message": message[:MAX_MESSAGE_CHARS],
        }
    )


def apply_resource_limits():
    """Per-process limits, inherited by subprocesses. Not aggregate quotas."""
    limits = [
        (resource.RLIMIT_AS, 512 * 1024 * 1024),
        (resource.RLIMIT_FSIZE, 16 * 1024 * 1024),
        (resource.RLIMIT_NOFILE, 128),
        (resource.RLIMIT_CORE, 0),
    ]
    for res, value in limits:
        resource.setrlimit(res, (value, value))


def install_seccomp():
    """Install the socket-blocking seccomp policy. Fails closed."""
    lib = ctypes.CDLL("libseccomp.so.2")
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_init.argtypes = [ctypes.c_uint]
    lib.seccomp_rule_add.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint,
        ctypes.c_int,
        ctypes.c_uint,
    ]
    lib.seccomp_load.restype = ctypes.c_int
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]

    ctx = lib.seccomp_init(SCMP_ACT_ALLOW)
    if not ctx:
        raise RuntimeError("seccomp_init returned NULL")
    installed = []
    for name in REQUIRED_BLOCKED + ALSO_BLOCKED:
        num = lib.seccomp_syscall_resolve_name(name.encode("ascii"))
        if num < 0:
            if name in REQUIRED_BLOCKED:
                raise RuntimeError("libseccomp does not know required syscall " + name)
            continue  # syscall absent on this kernel/architecture: nothing to block
        rc = lib.seccomp_rule_add(ctx, SCMP_ACT_ERRNO | EPERM, num, 0)
        if rc != 0:
            raise RuntimeError("seccomp_rule_add failed for %s: rc=%d" % (name, rc))
        installed.append(name)
    rc = lib.seccomp_load(ctx)
    if rc != 0:
        raise RuntimeError("seccomp_load failed: rc=%d" % rc)
    return installed


def set_parent_death_signal():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0)


def bounded(text, limit):
    """Truncate a string to a byte budget, keeping the end. Returns (text, cut)."""
    if len(text) <= limit:
        return text, False
    cut = text
    while cut and len(cut.encode("utf-8", "replace")) > limit:
        cut = cut[1:]
    return "...[truncated]\n" + cut, True


def format_exception(exc):
    """Build bounded exception details for an ordinary Python error."""
    etype = type(exc).__name__[:MAX_EXCEPTION_TYPE_CHARS]
    message = str(exc)
    if len(message) > MAX_MESSAGE_CHARS:
        message = message[:MAX_MESSAGE_CHARS] + "...[truncated]"
    parts = traceback.format_exception(type(exc), exc, exc.__traceback__)
    tb, tb_truncated = bounded("".join(parts), 16384)
    return {
        "type": etype,
        "message": message,
        "traceback": tb,
        "tracebackTruncated": tb_truncated,
    }


def split_final_expression(tree):
    """Split a module AST into (exec_tree, eval_expr_node or None).

    Mirrors REPL behavior: a trailing expression statement is evaluated and
    shown; everything else is executed as a plain module.
    """
    body = tree.body
    if body and isinstance(body[-1], ast.Expr):
        eval_node = ast.Expression(body[-1].value)
        tree.body = body[:-1]
        return tree, eval_node
    return tree, None


def execute_code(namespace, code, repr_limit):
    """Run user code. Returns a result-frame payload (no type/id fields).

    Execution is not transactional: state mutated before an exception stays
    mutated. The interpreter and namespace survive ordinary Python errors.
    """
    try:
        tree = ast.parse(code, "<python>", "exec")
    except (SyntaxError, ValueError, MemoryError, RecursionError) as exc:
        return {
            "status": "python_error",
            "repr": None,
            "reprTruncated": False,
            "exception": format_exception(exc),
            "sandboxProcesses": count_live_others(),
        }

    exec_tree, eval_node = split_final_expression(tree)
    try:
        if exec_tree.body:
            exec(compile(exec_tree, "<python>", "exec"), namespace)
        repr_value = None
        repr_truncated = False
        if eval_node is not None:
            value = eval(compile(eval_node, "<python>", "eval"), namespace)
            if value is not None:
                try:
                    text = repr(value)
                except (MemoryError, RecursionError):
                    text = "<repr failed: %s>" % type(value).__name__
                except Exception as inner:
                    text = "<repr raised %s>" % type(inner).__name__
                repr_value, repr_truncated = bounded(text, repr_limit)
        return {
            "status": "ok",
            "repr": repr_value,
            "reprTruncated": repr_truncated,
            "exception": None,
            "sandboxProcesses": count_live_others(),
        }
    except BaseException as exc:
        # Keep the worker alive across ordinary Python errors, including
        # SystemExit. Only unrecoverable protocol failures end the loop.
        if isinstance(exc, SystemExit):
            pass
        # Read of a path outside the sandbox mounts: report it so the parent can
        # offer the user a permission prompt. State is preserved (this is an
        # ordinary exception path); the worker stays alive.
        if isinstance(exc, SandboxReadDenied):
            denied_path, _truncated = bounded(str(exc.path), 4096)
            return {
                "status": "permission_needed",
                "path": denied_path,
                "repr": None,
                "reprTruncated": False,
                "exception": format_exception(exc),
                "sandboxProcesses": count_live_others(),
            }
        return {
            "status": "python_error",
            "repr": None,
            "reprTruncated": False,
            "exception": format_exception(exc),
            "sandboxProcesses": count_live_others(),
        }


class SandboxReadDenied(Exception):
    """Raised by the read audit hook for opens outside the sandbox mounts.

    This is UX, not a security boundary: the kernel mounts (read-only project,
    private tmpfs, granted read roots) remain the real enforcement. The hook
    exists so the parent can offer the user a permission prompt instead of a
    bare FileNotFoundError.
    """

    def __init__(self, path):
        super().__init__(path)
        self.path = path


def count_live_others():
    """Live processes in the sandbox pid namespace besides pid 1 (bwrap) and self.

    The namespace-local /proc only shows sandbox processes, so this cheaply
    tells the parent whether anything (a spawned subprocess, a re-parented
    grandchild) may still write to the output pipes after the result frame.
    Zombies are excluded: they hold no pipes and no one will wait on them.
    """
    self_pid = os.getpid()
    count = 0
    try:
        entries = os.listdir("/proc")
    except OSError:
        return 0
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid == 1 or pid == self_pid:
            continue
        try:
            with open("/proc/%s/stat" % entry, "rb") as fh:
                data = fh.read()
            close = data.rindex(b")")
            state = data[close + 2 : close + 3]
            if state != b"Z":
                count += 1
        except (OSError, ValueError):
            continue
    return count


class LineReader:
    """Reads newline-delimited frames from a raw fd with a length bound."""

    def __init__(self, fd, limit):
        self.fd = fd
        self.limit = limit
        self.buf = bytearray()

    def read_line(self):
        """Returns (status, line) where status is 'ok', 'too_long', or 'eof'."""
        while True:
            nl = self.buf.find(b"\n")
            if nl >= 0:
                line = bytes(self.buf[:nl])
                del self.buf[: nl + 1]
                if len(line) > self.limit:
                    return ("too_long", None)
                return ("ok", line)
            if len(self.buf) > self.limit:
                # Over-limit line: swallow everything up to the next newline.
                while True:
                    nl = self.buf.find(b"\n")
                    if nl >= 0:
                        del self.buf[: nl + 1]
                        return ("too_long", None)
                    chunk = os.read(self.fd, 65536)
                    if not chunk:
                        self.buf.clear()
                        return ("eof", None)
                    self.buf.extend(chunk)
            chunk = os.read(self.fd, 65536)
            if not chunk:
                if self.buf:
                    self.buf.clear()
                    return ("too_long", None)
                return ("eof", None)
            self.buf.extend(chunk)


def parse_mounted_prefixes():
    """Sandbox mountpoints from /proc/self/mounts, excluding the root "/".

    Returns a sorted list of absolute prefix paths. Any path equal to one of
    these or nested under one is readable; everything else is outside the
    sandbox view and triggers a read prompt.
    """
    prefixes = []
    with open("/proc/self/mounts", "rb") as fh:
        data = fh.read().decode("utf-8", "replace")
    for line in data.splitlines():
        fields = line.split()
        # <device> <mountpoint> <fstype> ...
        if len(fields) < 2:
            continue
        mountpoint = fields[1]
        # /proc/self/mounts escapes spaces/octal; unescape the common \040 form.
        mountpoint = mountpoint.replace("\\040", " ").replace("\\011", "\t").replace("\\134", "\\")
        if mountpoint == "/" or not mountpoint.startswith("/"):
            continue
        prefixes.append(mountpoint.rstrip("/") or "/")
    return sorted(set(prefixes))


def _decode_audit_path(arg):
    if isinstance(arg, bytes):
        try:
            return arg.decode("utf-8", "replace")
        except Exception:  # pragma: no cover - decode with replace cannot raise
            return None
    if isinstance(arg, str):
        return arg
    return None


def _path_outside_mounts(path, prefixes):
    """True when path resolves outside every mounted prefix.

    Relative paths resolve against the cwd (the sandbox starts in /workspace).
    Only candidates that fail the literal prefix check pay for a realpath call,
    which resolves symlinks pointing back into mounted territory.
    """
    if not os.path.isabs(path):
        path = os.path.join(os.getcwd(), path)
    normalized = os.path.normpath(path)
    for prefix in prefixes:
        if normalized == prefix or normalized.startswith(prefix + "/"):
            return False
    try:
        real = os.path.realpath(normalized)
    except Exception:
        return True
    if real == normalized:
        return True
    for prefix in prefixes:
        if real == prefix or real.startswith(prefix + "/"):
            return False
    return True


def install_read_audit_hook(prefixes):
    """Raise SandboxReadDenied for open/listdir/scandir outside the mounts.

    stat/existence probes are deliberately NOT hooked: they are the weakest
    signal (no content read) and accidental glob patterns over outside paths
    would trigger prompt storms. The hook must never break interpreter
    internals: any error inside it is swallowed and the open proceeds to the
    kernel, which returns its own error (usually FileNotFoundError).
    """
    prefixes = tuple(prefixes)

    def hook(event, args):
        if event not in ("open", "os.listdir", "os.scandir"):
            return
        try:
            path = _decode_audit_path(args[0] if args else None)
            if path is None:
                return
            if _path_outside_mounts(path, prefixes):
                raise SandboxReadDenied(path)
        except SandboxReadDenied:
            raise
        except Exception:
            pass

    sys.addaudithook(hook)


def main():
    repr_limit = 8192
    if len(sys.argv) > 1:
        try:
            repr_limit = max(64, min(int(sys.argv[1]), 1024 * 1024))
        except ValueError:
            pass

    # Security setup must complete before the ready handshake so no user code
    # ever runs without it. Any failure is fatal and reported, never degraded.
    set_parent_death_signal()
    try:
        apply_resource_limits()
        install_seccomp()
    except Exception as exc:
        try:
            send_error("security setup failed: %s" % exc)
        except OSError:
            pass
        os._exit(1)

    # Read-path prompting: derive the readable allow-set from the sandbox's own
    # mountpoints. bwrap mounts the project (/workspace), scratch (/scratch),
    # the private tmpfs (/tmp), runtime dirs (/usr, /proc, /dev) and the granted
    # read roots 1:1 at their host paths, so the mountpoint list IS the set of
    # readable prefixes and can never drift from what the kernel enforces.
    # The root "/" is excluded: the sandbox rootfs is a namespace-private tmpfs
    # whose only contents are the mounts below, and treating "/" as readable
    # would allow everything. Deriving from /proc/self/mounts keeps the hook in
    # sync with reality without any protocol change. Fail-open: if the parse
    # fails, no hook is installed and out-of-sandbox opens just fail with the
    # kernel's own error (usually FileNotFoundError).
    try:
        install_read_audit_hook(parse_mounted_prefixes())
    except Exception:
        pass  # prompting is best-effort UX; kernel mounts still enforce

    # Detach fd 0 (the request channel) for request reading, then point fd 0
    # and sys.stdin at /dev/null: input() and subprocess stdin hit EOF
    # immediately instead of consuming protocol frames.
    request_fd = os.dup(0)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)

    reader = LineReader(request_fd, MAX_FRAME_BYTES)

    namespace = {"__name__": "__console__", "__doc__": None, "__builtins__": __builtins__}

    send_frame(
        {
            "type": "ready",
            "protocol": PROTOCOL_VERSION,
            "pythonVersion": "%d.%d.%d" % sys.version_info[:3],
        }
    )

    while True:
        status, line = reader.read_line()
        if status == "eof":
            return 0
        if status == "too_long":
            try:
                send_error("request frame over limit; discarded")
            except OSError:
                return 1
            continue
        try:
            request = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            try:
                send_error("request frame is not valid JSON")
            except OSError:
                return 1
            continue
        if not isinstance(request, dict):
            try:
                send_error("request frame is not a JSON object")
            except OSError:
                return 1
            continue
        if request.get("protocol") != PROTOCOL_VERSION:
            try:
                send_error("unsupported protocol version")
            except OSError:
                return 1
            continue

        if request.get("type") == "exec":
            request_id = request.get("id")
            code = request.get("code")
            if not isinstance(request_id, int) or isinstance(request_id, bool) or not isinstance(code, str):
                try:
                    send_error("exec request has invalid id or code", None)
                except OSError:
                    return 1
                continue
            try:
                payload = execute_code(namespace, code, repr_limit)
            except BaseException as exc:  # defensive: report, keep worker alive
                try:
                    payload = {
                        "status": "python_error",
                        "repr": None,
                        "reprTruncated": False,
                        "exception": {
                            "type": type(exc).__name__,
                            "message": "worker-level failure: %s" % exc,
                            "traceback": "",
                            "tracebackTruncated": False,
                        },
                        "sandboxProcesses": 0,
                    }
                except BaseException:
                    return 1
            payload["type"] = "result"
            payload["protocol"] = PROTOCOL_VERSION
            payload["id"] = request_id
            try:
                send_frame(payload)
            except OSError:
                return 1
        else:
            try:
                send_error("unknown request type: %r" % (request.get("type"),))
            except OSError:
                return 1


if __name__ == "__main__":
    sys.exit(main())
