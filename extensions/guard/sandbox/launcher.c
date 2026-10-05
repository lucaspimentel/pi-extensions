/*
 * pi-guard-launch: two-mode launcher for the guard sandbox.
 *
 *   outer [--overlay LOWER:UPPER:WORK:MERGED]... -- BWRAP_PATH BWRAP_ARGS...
 *       Runs OUTSIDE bubblewrap, on the host. Creates a user namespace with an
 *       identity uid/gid map plus a private mount namespace, mounts one
 *       overlayfs per --overlay (unprivileged overlayfs needs both), then
 *       execv's bubblewrap with the remaining argv. Capabilities are dropped
 *       automatically on execve because the euid is non-root, so the stock
 *       setuid-less bwrap starts cleanly. Do not keep capabilities across the
 *       exec: bwrap aborts with "Unexpected capabilities but not setuid".
 *
 *   inner [--rlimit NAME=VALUE]... -- TARGET ARGV...
 *       Runs INSIDE the sandbox as the bwrap argv tail. Applies rlimits
 *       (soft = hard), installs the syscall policy (default allow, EPERM for
 *       the blocked list below; socket and socketpair are allowed because
 *       build tools need Unix sockets and loopback), sets no_new_privs, and
 *       execvp's the target so the filter and limits survive into it.
 *       New user namespaces inside the sandbox are prevented by bwrap
 *       --disable-userns (with --unshare-user), not by seccomp.
 *
 * libseccomp's API is declared by hand (no <seccomp.h>) so compilation needs
 * only the runtime shared object: pass the .so.2 path to the compiler and the
 * soname is recorded, so libseccomp upgrades need no rebuild. bwrap
 * --seccomp is unusable on some kernels (EINVAL from prctl), which is why the
 * policy is installed from inside the namespace.
 *
 * Any failure prints "pi-guard-launch: <reason>" to stderr and exits nonzero.
 * Unknown flags are errors. No shell anywhere; callers pass argv arrays.
 *
 * Build: cc -O2 -Wall -o pi-guard-launch launcher.c /path/to/libseccomp.so.2
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

/* Hand-declared libseccomp ABI (stable since 2.x). */
typedef void *scmp_filter_ctx;
#define SCMP_ACT_ALLOW 0x7fff0000U
#define SCMP_ACT_ERRNO(x) (0x00050000U | ((x) & 0xffffU))
extern scmp_filter_ctx seccomp_init(uint32_t def_action);
extern int seccomp_rule_add(scmp_filter_ctx ctx, uint32_t action, int syscall, unsigned int arg_cnt, ...);
extern int seccomp_load(scmp_filter_ctx ctx);
extern int seccomp_syscall_resolve_name(const char *name);
extern void seccomp_release(scmp_filter_ctx ctx);

/* socket and socketpair are deliberately absent: build tools need Unix
 * sockets and loopback (MSBuild node reuse, test runners). The network
 * namespace already isolates external traffic and abstract sockets. New user
 * namespaces are blocked by bwrap --disable-userns, not here. */
static const char *const BLOCKED[] = {
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
	"keyctl",
	"add_key",
	"request_key",
};

#define MAX_OVERLAYS 64

struct overlay_spec {
	const char *lower;
	const char *upper;
	const char *work;
	const char *merged;
};

static void die(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

static void die(const char *fmt, ...) {
	va_list ap;
	va_start(ap, fmt);
	fputs("pi-guard-launch: ", stderr);
	vfprintf(stderr, fmt, ap);
	fputc('\n', stderr);
	va_end(ap);
	exit(1);
}

static int contains_char(const char *s, char c) {
	return s != NULL && strchr(s, c) != NULL;
}

/* Overlay option strings use ',' between options and cannot encode these
 * characters in paths; reject them before mounting. */
static int overlay_path_ok(const char *s) {
	return s != NULL && s[0] == '/' && !contains_char(s, ':') && !contains_char(s, ',');
}

static void write_file_or_die(const char *path, const char *text) {
	int fd = open(path, O_WRONLY);
	if (fd < 0) die("open %s failed", path);
	ssize_t len = (ssize_t)strlen(text);
	if (write(fd, text, (size_t)len) != len) {
		close(fd);
		die("short write to %s failed", path);
	}
	close(fd);
}

static void mount_overlays(struct overlay_spec *specs, size_t count) {
	for (size_t i = 0; i < count; i++) {
		if (!overlay_path_ok(specs[i].lower) || !overlay_path_ok(specs[i].upper) ||
			!overlay_path_ok(specs[i].work) || !overlay_path_ok(specs[i].merged)) {
			die("overlay path is not absolute or contains ':' or ','", "");
		}
		char opts[4 * 4096];
		int n = snprintf(opts, sizeof(opts), "lowerdir=%s,upperdir=%s,workdir=%s",
			specs[i].lower, specs[i].upper, specs[i].work);
		if (n < 0 || (size_t)n >= sizeof(opts)) die("overlay options too long", "");
		if (mount("overlay", specs[i].merged, "overlay", 0, opts) == 0) continue;
		/* Some kernels require userxattr for overlayfs in a user namespace;
		 * the verified prototype did not, so try it only as a fallback. */
		n = snprintf(opts, sizeof(opts), "lowerdir=%s,upperdir=%s,workdir=%s,userxattr",
			specs[i].lower, specs[i].upper, specs[i].work);
		if (n < 0 || (size_t)n >= sizeof(opts)) die("overlay options too long", "");
		if (mount("overlay", specs[i].merged, "overlay", 0, opts) != 0) {
			fprintf(stderr, "pi-guard-launch: overlay mount of %s failed: %s\n",
				specs[i].merged, strerror(errno));
			exit(1);
		}
	}
}

static int run_outer(int argc, char **argv) {
	struct overlay_spec specs[MAX_OVERLAYS];
	size_t count = 0;
	int i = 2;
	while (i < argc) {
		if (strcmp(argv[i], "--overlay") == 0) {
			if (i + 1 >= argc) die("--overlay needs LOWER:UPPER:WORK:MERGED", "");
			char *spec = argv[++i];
			char *parts[4];
			int nparts = 0;
			char *tok = spec;
			for (char *p = spec; ; p++) {
				if (*p == ':') {
					if (nparts >= 3) die("overlay spec needs exactly 4 paths", "");
					*p = '\0';
					parts[nparts++] = tok;
					tok = p + 1;
				} else if (*p == '\0') {
					parts[nparts++] = tok;
					break;
				}
			}
			if (nparts != 4) die("overlay spec needs exactly 4 paths", "");
			if (count >= MAX_OVERLAYS) die("too many overlays", "");
			specs[count].lower = parts[0];
			specs[count].upper = parts[1];
			specs[count].work = parts[2];
			specs[count].merged = parts[3];
			count++;
			i++;
		} else if (strcmp(argv[i], "--") == 0) {
			i++;
			break;
		} else {
			die("unknown flag in outer mode: %s", argv[i]);
		}
	}
	if (i >= argc) die("outer mode needs BWRAP_PATH after --", "");

	/* Identity map first: the euid stays non-root so capabilities drop on
	 * execve and bwrap's setuid check passes. */
	uid_t uid = getuid();
	gid_t gid = getgid();
	if (unshare(CLONE_NEWUSER | CLONE_NEWNS) != 0) {
		die("unshare(user+mount) failed: %s", strerror(errno));
	}
	char map[64];
	snprintf(map, sizeof(map), "deny");
	write_file_or_die("/proc/self/setgroups", map);
	snprintf(map, sizeof(map), "%d %d 1", uid, uid);
	write_file_or_die("/proc/self/uid_map", map);
	snprintf(map, sizeof(map), "%d %d 1", gid, gid);
	write_file_or_die("/proc/self/gid_map", map);
	/* Nothing may propagate out of this mount namespace. */
	if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) {
		die("making / private failed: %s", strerror(errno));
	}
	mount_overlays(specs, count);
	/* execv, not execvp: the bwrap path is explicit. Environment is the
	 * minimal one the caller spawned us with; bwrap --clearenv handles the
	 * sandbox side. */
	execv(argv[i], &argv[i]);
	die("execv %s failed: %s", argv[i], strerror(errno));
	return 1;
}

static int rlimit_name(const char *name) {
	if (strcmp(name, "as") == 0) return RLIMIT_AS;
	if (strcmp(name, "fsize") == 0) return RLIMIT_FSIZE;
	if (strcmp(name, "nofile") == 0) return RLIMIT_NOFILE;
	if (strcmp(name, "core") == 0) return RLIMIT_CORE;
	return -1;
}

static int run_inner(int argc, char **argv) {
	int i = 2;
	while (i < argc) {
		if (strcmp(argv[i], "--rlimit") == 0) {
			if (i + 1 >= argc) die("--rlimit needs NAME=VALUE", "");
			char *pair = argv[++i];
			char *eq = strchr(pair, '=');
			if (eq == NULL) die("--rlimit needs NAME=VALUE, got %s", pair);
			*eq = '\0';
			int resource = rlimit_name(pair);
			if (resource < 0) die("unknown rlimit name: %s", pair);
			char *end = NULL;
			errno = 0;
			long long value = strtoll(eq + 1, &end, 10);
			if (errno != 0 || end == eq + 1 || (end != NULL && *end != '\0') || value < 0) {
				die("invalid rlimit value for %s", pair);
			}
			struct rlimit rl = { (rlim_t)value, (rlim_t)value };
			if (setrlimit(resource, &rl) != 0) {
				fprintf(stderr, "pi-guard-launch: setrlimit %s=%lld failed: %s\n",
					pair, value, strerror(errno));
				exit(1);
			}
			i++;
		} else if (strcmp(argv[i], "--") == 0) {
			i++;
			break;
		} else {
			die("unknown flag in inner mode: %s", argv[i]);
		}
	}
	if (i >= argc) die("inner mode needs TARGET after --", "");

	scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
	if (ctx == NULL) {
		die("seccomp_init failed", "");
	}
	for (size_t r = 0; r < sizeof(BLOCKED) / sizeof(BLOCKED[0]); r++) {
		int num = seccomp_syscall_resolve_name(BLOCKED[r]);
		if (num < 0) {
			fprintf(stderr, "pi-guard-launch: libseccomp does not know syscall %s\n", BLOCKED[r]);
			exit(1);
		}
		if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), num, 0) != 0) {
			fprintf(stderr, "pi-guard-launch: seccomp_rule_add failed for %s\n", BLOCKED[r]);
			exit(1);
		}
	}
	/* Not strictly required inside bubblewrap (it sets no_new_privs), but
	 * required if the launcher is ever run outside it. */
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
		die("prctl(PR_SET_NO_NEW_PRIVS): %s", strerror(errno));
	}
	if (seccomp_load(ctx) != 0) {
		die("seccomp_load failed (missing kernel seccomp support?)", "");
	}
	seccomp_release(ctx);
	execvp(argv[i], &argv[i]);
	die("execvp %s failed: %s", argv[i], strerror(errno));
	return 1;
}

int main(int argc, char **argv) {
	if (argc < 2) {
		die("usage: pi-guard-launch outer|inner [...]", "");
	}
	if (strcmp(argv[1], "outer") == 0) return run_outer(argc, argv);
	if (strcmp(argv[1], "inner") == 0) return run_inner(argc, argv);
	die("unknown mode: %s", argv[1]);
	return 1;
}
