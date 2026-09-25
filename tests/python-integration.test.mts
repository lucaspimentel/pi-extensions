// Integration tests for the python tool extension: real bubblewrap sandbox,
// real worker process, real persistence, isolation, and forced-termination
// behavior. Skips with an explicit reason when Linux/bubblewrap/Python are
// unavailable. On a supported Linux environment these must pass for the
// implementation to count as verified; mocked argument tests are insufficient.
//
// Run: node --test tests/python-integration.test.mts
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { PythonSessionController } from "../extensions/python/session.ts";
import { checkDependencies } from "../extensions/python/sandbox.ts";
import { LIMITS } from "../extensions/python/limits.ts";
import pythonExtension from "../extensions/python/index.ts";

// ── Prerequisites: skip with an explicit reason when unsupported ─────────────

const deps = checkDependencies();
const supported = process.platform === "linux" && deps.ok;
const skipReason = supported
	? null
	: process.platform !== "linux"
		? `platform ${process.platform} is not Linux; sandbox tests require Linux with bubblewrap`
		: (deps.diagnostic ?? "sandbox dependencies unavailable");

const tempDirs: string[] = [];
function trackCleanup(dir: string) {
	tempDirs.push(dir);
	return dir;
}

function makeProject(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "py-int-proj-")));
	fs.writeFileSync(path.join(dir, "data.txt"), "fixture-content\n", "utf8");
	return trackCleanup(dir);
}

function makeController(projectDir: string): PythonSessionController {
	const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "py-int-runtime-"));
	trackCleanup(runtimeRoot);
	return new PythonSessionController({ projectDir, runtimeRoot });
}

/** Find live processes whose cmdline contains marker (host /proc scan). */
function findProcessesByCmdline(marker: string): number[] {
	const hits: number[] = [];
	try {
		for (const entry of fs.readdirSync("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			try {
				const cmdline = fs.readFileSync(path.join("/proc", entry, "cmdline"), "utf8");
				if (cmdline.includes(marker)) hits.push(Number(entry));
			} catch {
				/* vanished */
			}
		}
	} catch {
		/* /proc unavailable */
	}
	return hits;
}

async function waitFor(condition: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return condition();
}

const tests: { name: string; fn: () => Promise<void> }[] = [];
function test(name: string, fn: () => Promise<void>) {
	tests.push({ name, fn });
}

// ── Persistence and results ──────────────────────────────────────────────────

test("variables persist across executions within one worker generation", async () => {
	const c = makeController(makeProject());
	try {
		const r1 = await c.execute("x = 41", undefined, undefined);
		assert.equal(r1.status, "ok");
		const gen1 = r1.generation;
		const r2 = await c.execute("x + 1", undefined, undefined);
		assert.equal(r2.status, "ok");
		assert.equal(r2.repr, "42");
		assert.equal(r2.generation, gen1, "same worker generation");
	} finally {
		await c.dispose("test");
	}
});

test("imports, functions, and classes persist across calls", async () => {
	const c = makeController(makeProject());
	try {
		const r1 = await c.execute(
			["import json, hashlib", "def helper(n):", "    return n * 2", "class Widget:", "    kind = 'w'"].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r1.status, "ok");
		const r2 = await c.execute(
			["w = Widget()", "helper(21) + len(hashlib.sha256(b'x').hexdigest()) + json.dumps([1]).count('1')"].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r2.status, "ok");
		assert.equal(r2.repr, "107"); // 42 + 64 + 1
	} finally {
		await c.dispose("test");
	}
});

test("stdout, stderr, unicode, and raw os.write are captured independently", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			[
				"import sys, os",
				"print('stdout-line-1')",
				"print('ünïcodé ✓ 中文')",
				"print('multi\\nline\\noutput')",
				"sys.stderr.write('stderr-line\\n')",
				"os.write(1, b'raw-fd1-write\\n')",
			].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("stdout-line-1"));
		assert.ok(r.stdout.includes("ünïcodé ✓ 中文"));
		assert.ok(r.stdout.includes("multi\nline\noutput"));
		assert.ok(r.stdout.includes("raw-fd1-write"));
		assert.ok(r.stderr.includes("stderr-line"));
	} finally {
		await c.dispose("test");
	}
});

test("subprocess trailing output is retained and not attributed to the next result", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			[
				"import subprocess, sys",
				"p = subprocess.Popen([sys.executable, '-c', \"import time; time.sleep(0.4); print('trailing-late-output')\"])",
				"print('parent-done')",
			].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("parent-done"));
		assert.ok(r.stdout.includes("trailing-late-output"), "trailing subprocess output must be captured");
		const r2 = await c.execute("print('next-exec')", undefined, undefined);
		assert.equal(r2.status, "ok");
		assert.ok(r2.stdout.includes("next-exec"));
		assert.ok(!r2.stdout.includes("trailing-late-output"), "trailing output must not leak into the next result");
	} finally {
		await c.dispose("test");
	}
});

test("syntax errors return a structured traceback and preserve state", async () => {
	const c = makeController(makeProject());
	try {
		await c.execute("kept = 'intact'", undefined, undefined);
		const r = await c.execute("def broken(:\n    pass", undefined, undefined);
		assert.equal(r.status, "python_error");
		assert.ok(r.exception);
		assert.equal(r.exception.type, "SyntaxError");
		assert.ok(r.exception.traceback.includes("SyntaxError"));
		const r2 = await c.execute("kept", undefined, undefined);
		assert.equal(r2.status, "ok");
		assert.equal(r2.repr, "'intact'");
	} finally {
		await c.dispose("test");
	}
});

test("runtime exceptions preserve state mutated before the error", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			["safe = 'before'", "raise ValueError('boom')"].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "python_error");
		assert.equal(r.exception.type, "ValueError");
		assert.equal(r.exception.message, "boom");
		assert.ok(r.exception.traceback.includes("ValueError"));
		assert.ok(r.stateLost === false, "ordinary errors must keep the interpreter");
		const r2 = await c.execute("safe", undefined, undefined);
		assert.equal(r2.repr, "'before'");
	} finally {
		await c.dispose("test");
	}
});

test("input() completes promptly with EOF instead of hanging or consuming protocol", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			["try:", "    input()", "except EOFError:", "    print('eof-ok')"].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("eof-ok"));
		assert.ok(r.durationMs < 10_000);
	} finally {
		await c.dispose("test");
	}
});

test("explicit reset clears interpreter state but preserves scratch files", async () => {
	const c = makeController(makeProject());
	try {
		await c.execute("marker = 'state'\nopen('/scratch/keepme.txt', 'w').write('kept')", undefined, undefined);
		const before = await c.status();
		assert.ok(before.paths.scratchDir, "scratch allocated");
		const scratchHost = before.paths.scratchDir!;
		assert.equal(fs.readFileSync(path.join(scratchHost, "keepme.txt"), "utf8"), "kept");

		await c.reset();
		const after = await c.status();
		assert.equal(after.workerRunning, false, "reset leaves the replacement worker unstarted");
		assert.equal(after.lastResetReason, "explicit_reset");
		assert.equal(fs.existsSync(scratchHost + "/keepme.txt"), true, "scratch survives reset");

		const r = await c.execute("print(marker)", undefined, undefined);
		assert.equal(r.status, "python_error", "interpreter state must be gone");
		assert.equal(r.exception.type, "NameError");
		const r2 = await c.execute("open('/scratch/keepme.txt').read()", undefined, undefined);
		assert.equal(r2.repr, "'kept'");
	} finally {
		await c.dispose("test");
	}
});

// ── Forced termination and recovery ──────────────────────────────────────────

test("infinite loop stops at the requested deadline; state loss is reported", async () => {
	const c = makeController(makeProject());
	try {
		const r1 = await c.execute("lost = 'value'", undefined, undefined);
		assert.equal(r1.status, "ok");
		const gen1 = r1.generation;
		const t0 = Date.now();
		const r2 = await c.execute("while True:\n    pass", 1, undefined);
		const elapsed = Date.now() - t0;
		assert.equal(r2.status, "timeout");
		assert.equal(r2.stateLost, true);
		assert.ok(elapsed < 15_000, `timeout must take about 1s, took ${elapsed}ms`);
		const r3 = await c.execute("print(lost)", undefined, undefined);
		assert.equal(r3.status, "python_error", "state must be gone after timeout");
		assert.equal(r3.exception.type, "NameError");
		assert.ok(r3.generation > gen1, "fresh worker generation after timeout");
	} finally {
		await c.dispose("test");
	}
});

test("cancellation kills the sandbox including setsid descendants", async () => {
	const projectDir = makeProject();
	const marker = `py-int-setsid-${Date.now()}`;
	const c = makeController(projectDir);
	try {
		const ac = new AbortController();
		const execPromise = c.execute(
			[
				"import subprocess, sys, os",
				`subprocess.Popen([sys.executable, '-c', "import os, time, sys; os.setsid(); sys.stderr.write('${marker}'); sys.stderr.flush(); time.sleep(60)"])`,
				"import time",
				"time.sleep(60)",
			].join("\n"),
			120,
			ac.signal,
		);
		await new Promise((r) => setTimeout(r, 800));
		assert.ok(findProcessesByCmdline(marker).length > 0, "setsid descendant should be running");
		ac.abort();
		const r = await execPromise;
		assert.equal(r.status, "cancelled");
		assert.equal(r.stateLost, true);

		const gone = await waitFor(() => findProcessesByCmdline(marker).length === 0, 5_000);
		assert.ok(gone, `setsid descendant must be killed; survivors: ${findProcessesByCmdline(marker)}`);
	} finally {
		await c.dispose("test");
	}
});

test("timeout kills the sandbox including setsid descendants", async () => {
	const marker = `py-int-timeout-setsid-${Date.now()}`;
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			[
				"import subprocess, sys, os, time",
				`subprocess.Popen([sys.executable, '-c', "import os, time, sys; os.setsid(); sys.stderr.write('${marker}'); sys.stderr.flush(); time.sleep(60)"])`,
				"time.sleep(60)",
			].join("\n"),
			1,
			undefined,
		);
		assert.equal(r.status, "timeout");
		const gone = await waitFor(() => findProcessesByCmdline(marker).length === 0, 5_000);
		assert.ok(gone, `setsid descendant must be killed after timeout; survivors: ${findProcessesByCmdline(marker)}`);
	} finally {
		await c.dispose("test");
	}
});

test("os._exit is handled as worker death: partial output kept, state lost, recovery works", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			["print('dying-soon')", "import os", "os._exit(7)"].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "worker_error");
		assert.equal(r.stateLost, true);
		assert.ok(r.stdout.includes("dying-soon"), "partial output must be returned");
		const r2 = await c.execute("print('recovered')", undefined, undefined);
		assert.equal(r2.status, "ok");
		assert.ok(r2.stdout.includes("recovered"));
		assert.ok(r2.generation > r.generation);
	} finally {
		await c.dispose("test");
	}
});

test("output flood is bounded; sandbox killed; partial log flagged", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			["import sys", "while True:", "    sys.stdout.write('flood' * 100 + '\\n')", "    sys.stdout.flush()"].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "output_limit");
		assert.equal(r.stateLost, true);
		assert.equal(r.outputLimitExceeded, true);
		assert.equal(r.logComplete, false);
		assert.ok(r.stdout.length <= 64 * 1024 + 4096, "excerpt must be bounded");
		assert.ok(r.logPaths, "a partial log must be saved");
		assert.ok(fs.existsSync(r.logPaths!.stdout), "log file must exist");
		const r2 = await c.execute("print('fresh-again')", undefined, undefined);
		assert.equal(r2.status, "ok");
		assert.ok(r2.generation > r.generation);
	} finally {
		await c.dispose("test");
	}
});

test("memory limit (RLIMIT_AS) raises without host exhaustion or a hang", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute("x = bytearray(600 * 1024 * 1024)", undefined, undefined);
		assert.ok(
			r.status === "python_error" || r.status === "worker_error",
			`expected python_error or worker_error, got ${r.status}`,
		);
		if (r.status === "python_error") {
			assert.equal(r.exception.type, "MemoryError");
			// Worker should still be usable after a clean MemoryError.
			const r2 = await c.execute("40 + 2", undefined, undefined);
			assert.equal(r2.status, "ok");
			assert.equal(r2.repr, "42");
		}
	} finally {
		await c.dispose("test");
	}
});

test("per-file size limit (RLIMIT_FSIZE) blocks oversized writes", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			["try:", "    open('/scratch/big.bin', 'wb').write(b'\\0' * (17 * 1024 * 1024))", "    print('wrote-too-much')", "except OSError as e:", "    print('blocked', e.errno)"].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("blocked"), "RLIMIT_FSIZE must surface as OSError");
		assert.ok(!r.stdout.includes("wrote-too-much"));
	} finally {
		await c.dispose("test");
	}
});

test("file descriptor limit (RLIMIT_NOFILE) blocks fd exhaustion", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			[
				"handles = []",
				"try:",
				"    for i in range(200):",
				"        handles.append(open('/dev/null'))",
				"    print('opened-all')",
				"except OSError as e:",
				"    print('fd-blocked', len(handles))",
			].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("fd-blocked"), "fd limit must raise OSError");
		assert.ok(!r.stdout.includes("opened-all"));
	} finally {
		await c.dispose("test");
	}
});

// ── Isolation ────────────────────────────────────────────────────────────────

test("project is readable at /workspace but cannot be modified or deleted", async () => {
	const projectDir = makeProject();
	const c = makeController(projectDir);
	try {
		const r = await c.execute("open('/workspace/data.txt').read().strip()", undefined, undefined);
		assert.equal(r.status, "ok");
		assert.equal(r.repr, "'fixture-content'");

		const w = await c.execute(
			["try:", "    open('/workspace/data.txt', 'w').write('x')", "    print('WRITE-SUCCEEDED')", "except OSError as e:", "    print('write-blocked', e.errno)"].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(w.status, "ok");
		assert.ok(w.stdout.includes("write-blocked"), "project writes must fail");
		assert.ok(!w.stdout.includes("WRITE-SUCCEEDED"));

		const d = await c.execute(
			["import os", "try:", "    os.remove('/workspace/data.txt')", "    print('DELETE-SUCCEEDED')", "except OSError as e:", "    print('delete-blocked', e.errno)"].join("\n"),
			undefined,
			undefined,
		);
		assert.ok(d.stdout.includes("delete-blocked"), "project deletes must fail");
		assert.equal(fs.readFileSync(path.join(projectDir, "data.txt"), "utf8"), "fixture-content\n");
	} finally {
		await c.dispose("test");
	}
});

test("writes under /scratch map to the host scratch directory", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute("open('/scratch/host-mapping.txt', 'w').write('from-sandbox')", undefined, undefined);
		assert.equal(r.status, "ok");
		const st = await c.status();
		const hostFile = path.join(st.paths.scratchDir!, "host-mapping.txt");
		assert.equal(fs.readFileSync(hostFile, "utf8"), "from-sandbox");
	} finally {
		await c.dispose("test");
	}
});

test("host-only files are unreachable, including through project symlinks", async () => {
	const projectDir = makeProject();
	const canaryPath = path.join(os.tmpdir(), `py-int-canary-${Date.now()}.txt`);
	fs.writeFileSync(canaryPath, "host-secret", "utf8");
	fs.symlinkSync(canaryPath, path.join(projectDir, "canary-link"));
	const c = makeController(projectDir);
	try {
		const r = await c.execute(
			["try:", "    print(open('/workspace/canary-link').read())", "except OSError as e:", "    print('symlink-blocked', type(e).__name__)"].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("symlink-blocked"), `symlink escape must fail; got: ${r.stdout}`);
		assert.ok(!r.stdout.includes("host-secret"));

		const r2 = await c.execute(
			["try:", "    print(open(" + JSON.stringify(canaryPath) + ").read())", "except OSError as e:", "    print('direct-blocked', type(e).__name__)"].join("\n"),
			undefined,
			undefined,
		);
		assert.ok(r2.stdout.includes("direct-blocked"), `direct host access must fail; got: ${r2.stdout}`);
	} finally {
		await c.dispose("test");
		fs.rmSync(canaryPath, { force: true });
	}
});

test("host environment secrets are not exposed to the worker", async () => {
	process.env.PI_PYTHON_TOOL_SECRET = `secret-${Date.now()}`;
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			["import os", "print('secret-present' if 'PI_PYTHON_TOOL_SECRET' in os.environ else 'secret-absent')", "print(sorted(k for k in os.environ))"].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("secret-absent"), `host env must not leak; got: ${r.stdout}`);
		assert.ok(!r.stdout.includes(process.env.PI_PYTHON_TOOL_SECRET));
	} finally {
		await c.dispose("test");
		delete process.env.PI_PYTHON_TOOL_SECRET;
	}
});

test("connections to a host loopback TCP listener fail", async () => {
	const server = net.createServer(() => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as net.AddressInfo).port;
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			[
				"import socket",
				"try:",
				`    socket.create_connection(("127.0.0.1", ${port}), timeout=2)`,
				"    print('TCP-CONNECTED')",
				"except OSError as e:",
				"    print('tcp-blocked', e.errno)",
			].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("tcp-blocked"), `loopback connect must fail; got: ${r.stdout}`);
		assert.ok(!r.stdout.includes("TCP-CONNECTED"));
	} finally {
		await c.dispose("test");
		server.close();
	}
});

test("connections to a host Unix socket inside the mounted project fail", async () => {
	const projectDir = makeProject();
	const sockPath = path.join(projectDir, "host.sock");
	try {
		fs.rmSync(sockPath, { force: true });
	} catch {
		/* ignore */
	}
	const server = net.createServer(() => {});
	await new Promise<void>((resolve) => server.listen(sockPath, resolve));
	const c = makeController(projectDir);
	try {
		const r = await c.execute(
			[
				"import socket",
				"try:",
				"    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
				`    s.connect(${JSON.stringify(sockPath)})`,
				"    print('UNIX-CONNECTED')",
				"except OSError as e:",
				"    print('unix-blocked', e.errno)",
			].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("unix-blocked"), `unix socket connect must fail; got: ${r.stdout}`);
		assert.ok(!r.stdout.includes("UNIX-CONNECTED"));
	} finally {
		await c.dispose("test");
		server.close();
		try {
			fs.rmSync(sockPath, { force: true });
		} catch {
			/* ignore */
		}
	}
});

// ── Lifecycle and integration ────────────────────────────────────────────────

test("independent controller instances are isolated from one another", async () => {
	const c1 = makeController(makeProject());
	const c2 = makeController(makeProject());
	try {
		await c1.execute("shared = 'from-one'", undefined, undefined);
		const st1 = await c1.status();
		const st2 = await c2.status();
		assert.notEqual(st1.paths.scratchDir, st2.paths.scratchDir, "scratch dirs must differ");
		const r = await c2.execute("print(shared)", undefined, undefined);
		assert.equal(r.status, "python_error", "namespaces must be independent");
	} finally {
		await c1.dispose("test");
		await c2.dispose("test");
	}
});

test("dispose deletes scratch and log directories, is idempotent, and leaves no workers", async () => {
	const projectDir = makeProject();
	const marker = `py-int-dispose-${Date.now()}`;
	const c = makeController(projectDir);
	await c.execute(`open('/scratch/doomed.txt', 'w').write('${marker}')`, undefined, undefined);
	const st = await c.status();
	const scratchDir = st.paths.scratchDir!;
	const logDir = st.paths.logDir!;
	assert.ok(fs.existsSync(path.join(scratchDir, "doomed.txt")));
	assert.ok(fs.existsSync(logDir));

	// Start a long execution so a worker and its children exist at dispose time.
	const ac = new AbortController();
	const execPromise = c.execute("import time; time.sleep(30)", 120, ac.signal);
	await new Promise((r) => setTimeout(r, 500));
	await c.dispose("test");
	ac.abort();
	const r = await execPromise;
	assert.ok(["cancelled", "worker_error"].includes(r.status), `unexpected status ${r.status}`);

	assert.equal(fs.existsSync(scratchDir), false, "scratch must be deleted on dispose");
	assert.equal(fs.existsSync(logDir), false, "logs must be deleted on dispose");
	await c.dispose("test"); // idempotent
	await c.dispose("test");
	assert.equal(fs.existsSync(scratchDir), false);
});

test("session-tree style re-creation deletes the old context's scratch", async () => {
	// Mirrors the extension behavior: a context change disposes the old
	// controller (deleting its scratch) and starts a fresh one.
	const c1 = makeController(makeProject());
	await c1.execute("open('/scratch/old-context.txt', 'w').write('old')", undefined, undefined);
	const st1 = await c1.status();
	await c1.dispose("session_tree_change");
	assert.equal(fs.existsSync(st1.paths.scratchDir!), false);
});

test("no surviving worker processes after the suite", async () => {
	// Give late kills a moment, then verify nothing from this test run
	// survives. Scope to test-owned workers: their scratch mounts live under
	// the py-int-runtime temp roots, unlike a live pi session's worker.
	await new Promise((r) => setTimeout(r, 500));
	const survivors = findProcessesByCmdline("/worker.py").filter((pid) => {
		try {
			return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("py-int-runtime");
		} catch {
			return false;
		}
	});
	assert.deepEqual(survivors, [], `no worker processes may survive; found: ${survivors}`);
});

test("first execution on fresh workers captures stdout despite pipe races", async () => {
	// Regression: the result frame can be processed before pending stdout data
	// events fire (separate pipes), which used to drop the first execution's
	// output. Hammer the window: many fresh workers, first-execution prints.
	for (let i = 0; i < 5; i++) {
		const c = makeController(makeProject());
		try {
			const r = await c.execute(`print('first-exec-${i}')`, undefined, undefined);
			assert.equal(r.status, "ok");
			assert.ok(
				r.stdout.includes(`first-exec-${i}`),
				`first-execution stdout lost on iteration ${i}: got ${JSON.stringify(r.stdout)}`,
			);
		} finally {
			await c.dispose("test");
		}
	}
});

// ── Out-of-sandbox read prompts (step 3, through the extension) ─────────────

interface ExtensionHarness {
	tool: { execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<any> };
	handlers: Record<string, (event: unknown, ctx: unknown) => unknown>;
	events: { on(channel: string, handler: (data: unknown) => void): () => void; emit(channel: string, data: unknown): void };
}

function makeExtensionHarness(): ExtensionHarness {
	let tool: any;
	const handlers: Record<string, any> = {};
	const listeners: Array<[string, (data: unknown) => void]> = [];
	const pi = {
		registerTool: (t: any) => {
			tool = t;
		},
		on: (event: string, handler: any) => {
			handlers[event] = handler;
			return () => {};
		},
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				listeners.push([channel, handler]);
				return () => {};
			},
			emit: (channel: string, data: unknown) => {
				for (const [c, h] of [...listeners]) if (c === channel) h(data);
			},
		},
	};
	pythonExtension(pi as any);
	return { tool, handlers, events: pi.events } as ExtensionHarness;
}

/** Fake tool-permissions listener: counts prompts, grants or denies, and on
 * grant re-broadcasts { mode, readRoots } BEFORE the verdict (the real
 * extension's ordering contract). */
function fakePermissionsListener(
	harness: ExtensionHarness,
	mode: "grant" | "deny",
) {
	let prompts = 0;
	harness.events.on("tool-permissions:prompt", (data) => {
		prompts++;
		const p = data as { id: number; path: string };
		const trimmed = p.path.replace(/\/+$/, "");
		const root = trimmed.slice(0, trimmed.lastIndexOf("/")) || p.path;
		if (mode === "grant") {
			harness.events.emit("tool-permissions:mode", { mode: "manual", readRoots: [root] });
			harness.events.emit("tool-permissions:promptResult", { id: p.id, outcome: "allow" });
		} else {
			harness.events.emit("tool-permissions:promptResult", { id: p.id, outcome: "deny" });
		}
	});
	return { get prompts() { return prompts; } };
}

async function runExtension(harness: ExtensionHarness, projectDir: string, code: string) {
	const ctx = { cwd: projectDir, hasUI: true };
	harness.handlers.session_start({}, ctx);
	return harness.tool.execute("call-1", { code }, undefined, undefined, ctx);
}

/** Reset the extension's module state between tests (it persists per process). */
async function resetExtension(harness: ExtensionHarness) {
	await harness.handlers.session_shutdown({}, {});
}

const readHostFile = "open('/etc/hostname').read().strip()";

if (supported) {
	test("out-of-sandbox read prompts, then grant mounts the root and replays", async () => {
		const harness = makeExtensionHarness();
		await resetExtension(harness);
		const listener = fakePermissionsListener(harness, "grant");
		const project = makeProject();
		const result = await runExtension(harness, project, readHostFile);
		assert.equal(result.details?.status, "ok", JSON.stringify(result.details ?? {}));
		assert.equal(listener.prompts, 1, "exactly one prompt for one ungranted path");
		const host = fs.readFileSync("/etc/hostname", "utf8").trim();
		const text = (result.content as Array<{ type: string; text?: string }> | undefined)
			?.find((c) => c.type === "text")?.text ?? "";
		assert.ok(text.includes(host), `replayed code must read the granted file; got: ${text.slice(0, 400)}`);
	});

	test("denied reads return permission_needed and are remembered for the session", async () => {
		const harness = makeExtensionHarness();
		await resetExtension(harness);
		const listener = fakePermissionsListener(harness, "deny");
		const project = makeProject();
		const r1 = await runExtension(harness, project, readHostFile);
		assert.equal(r1.details?.status, "permission_needed");
		assert.equal(r1.details?.permissionPath, "/etc/hostname");
		assert.match(r1.details?.diagnostic ?? "", /denied by the user/);
		assert.equal(listener.prompts, 1);
		// Second attempt at the same covering dir auto-denies without a prompt.
		const ctx = { cwd: project, hasUI: true };
		harness.handlers.session_start({}, ctx);
		const r2 = await harness.tool.execute("call-2", { code: readHostFile }, undefined, undefined, ctx);
		assert.equal(r2.details?.status, "permission_needed");
		assert.equal(listener.prompts, 1, "no second prompt for a denied root");
	});

	test("aborted signal during a pending read prompt settles as deny", async () => {
		const harness = makeExtensionHarness();
		await resetExtension(harness);
		const ac = new AbortController();
		// Deterministic: abort exactly when the prompt is emitted, so the await
		// is pending and the abort listener settles it as deny.
		harness.events.on("tool-permissions:prompt", () => ac.abort());
		const project = makeProject();
		const ctx = { cwd: project, hasUI: true };
		harness.handlers.session_start({}, ctx);
		const result = await harness.tool.execute("call-3", { code: readHostFile }, ac.signal, undefined, ctx);
		assert.equal(result.details?.status, "permission_needed");
		assert.match(result.details?.diagnostic ?? "", /denied by the user/);
	});
}

// ── Runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
if (!supported) {
	console.log(`SKIP: python integration tests: ${skipReason}`);
} else {
	for (const t of tests) {
		try {
			await t.fn();
			passed++;
			console.log(`  ✓ ${t.name}`);
		} catch (err) {
			failed++;
			console.error(`  ✗ ${t.name}:`, err);
		}
	}
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

// Best-effort removal of test fixtures and runtime roots.
for (const dir of tempDirs) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}
