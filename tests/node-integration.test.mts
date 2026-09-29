// Integration tests for the node tool extension: real bubblewrap sandbox,
// real worker process, real persistence, isolation, and forced-termination
// behavior. Skips with an explicit reason when Linux/bubblewrap/node are
// unavailable. On a supported Linux environment these must pass for the
// implementation to count as verified; mocked argument tests are insufficient.
//
// Run: node --test tests/node-integration.test.mts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { NodeSessionController } from "../extensions/node/session.ts";
import { checkDependencies } from "../extensions/node/sandbox.ts";
import { LIMITS } from "../extensions/node/limits.ts";
import nodeExtension from "../extensions/node/index.ts";

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
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "node-int-proj-")));
	fs.writeFileSync(path.join(dir, "data.txt"), "fixture-content\n", "utf8");
	return trackCleanup(dir);
}

function makeController(projectDir: string): NodeSessionController {
	const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "node-int-runtime-"));
	trackCleanup(runtimeRoot);
	return new NodeSessionController({ projectDir, runtimeRoot });
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
		const r1 = await c.execute("let x = 41", undefined, undefined);
		assert.equal(r1.status, "ok");
		const gen1 = r1.generation;
		const r2 = await c.execute("x + 1", undefined, undefined);
		assert.equal(r2.status, "ok");
		assert.equal(r2.repr, "42");
		assert.equal(r2.generation, gen1, "same worker generation");
		// Plain (non-declaration) assignment persists on the global object too.
		await c.execute("y = 7", undefined, undefined);
		const r3 = await c.execute("x + y", undefined, undefined);
		assert.equal(r3.repr, "48");
	} finally {
		await c.dispose("test");
	}
});

test("functions, classes, and require persist across calls", async () => {
	const c = makeController(makeProject());
	try {
		const r1 = await c.execute(
			[
				"const crypto = require('node:crypto')",
				"function helper(n) { return n * 2 }",
				"class Widget { constructor() { this.kind = 'w' } }",
			].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r1.status, "ok", r1.exception?.traceback);
		const r2 = await c.execute(
			[
				"w = new Widget()",
				"helper(21) + crypto.createHash('sha256').update('x').digest().length + JSON.parse(JSON.stringify([1])).length",
			].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r2.status, "ok");
		assert.equal(r2.repr, "75"); // 42 + 32 + 1
	} finally {
		await c.dispose("test");
	}
});

test("stdout, stderr, unicode, and raw fd 1 writes are captured independently", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			[
				"const fs = require('node:fs')",
				"console.log('stdout-line-1')",
				"console.log('ünïcodé ✓ 中文')",
				"console.log('multi\\nline\\noutput')",
				"console.error('stderr-line')",
				"fs.writeSync(1, Buffer.from('raw-fd1-write\\n'))",
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

test("trailing async output is retained and not attributed to the next result", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			[
				"setTimeout(() => console.log('trailing-late-output'), 25)",
				"console.log('parent-done')",
				"'scheduled'",
			].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("parent-done"));
		assert.ok(r.stdout.includes("trailing-late-output"), "trailing async output must be captured");
		const r2 = await c.execute("console.log('next-exec')", undefined, undefined);
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
		await c.execute("let kept = 'intact'", undefined, undefined);
		const r = await c.execute("function broken(:", undefined, undefined);
		assert.equal(r.status, "runtime_error");
		assert.ok(r.exception);
		assert.equal(r.exception.type, "SyntaxError");
		const r2 = await c.execute("kept", undefined, undefined);
		assert.equal(r2.status, "ok");
		assert.equal(r2.repr, "'intact'");
	} finally {
		await c.dispose("test");
	}
});

test("runtime exceptions preserve state mutated before the error; stacks are trimmed", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			["let safe = 'before'", "throw new TypeError('boom')"].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "runtime_error");
		assert.equal(r.exception.type, "TypeError");
		assert.equal(r.exception.message, "boom");
		assert.ok(r.stateLost === false, "ordinary errors must keep the context");
		// Worker-internal frames must not reach the model-facing traceback.
		assert.ok(!r.exception.traceback.includes("readline"), `trimmed stack expected; got: ${r.exception.traceback}`);
		assert.ok(!r.exception.traceback.includes("worker.mjs"), `trimmed stack expected; got: ${r.exception.traceback}`);
		const r2 = await c.execute("safe", undefined, undefined);
		assert.equal(r2.repr, "'before'");
	} finally {
		await c.dispose("test");
	}
});

test("process.exit is neutralized; the worker and its state survive", async () => {
	const c = makeController(makeProject());
	try {
		await c.execute("let marker = 'state'", undefined, undefined);
		const r = await c.execute("process.exit()", undefined, undefined);
		assert.equal(r.status, "runtime_error");
		assert.ok(r.exception.message.includes("disabled"));
		const r2 = await c.execute("marker", undefined, undefined);
		assert.equal(r2.status, "ok");
		assert.equal(r2.repr, "'state'", "worker must stay alive with state intact");
	} finally {
		await c.dispose("test");
	}
});

test("unhandled rejections do not kill the worker", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute("Promise.reject(new Error('late rejection')); 'scheduled'", undefined, undefined);
		assert.equal(r.status, "ok");
		assert.equal(r.repr, "'scheduled'");
		// Give the rejection a tick to fire; then confirm the worker is usable.
		await new Promise((res) => setTimeout(res, 150));
		const r2 = await c.execute("'still-alive'", undefined, undefined);
		assert.equal(r2.status, "ok");
		assert.equal(r2.repr, "'still-alive'");
	} finally {
		await c.dispose("test");
	}
});

test("explicit reset clears context state but preserves scratch files", async () => {
	const c = makeController(makeProject());
	try {
		await c.execute(
			"let marker = 'state'; require('fs').writeFileSync('/scratch/keepme.txt', 'kept')",
			undefined,
			undefined,
		);
		const before = await c.status();
		assert.ok(before.paths.scratchDir, "scratch allocated");
		const scratchHost = before.paths.scratchDir!;
		assert.equal(fs.readFileSync(path.join(scratchHost, "keepme.txt"), "utf8"), "kept");

		await c.reset();
		const after = await c.status();
		assert.equal(after.workerRunning, false, "reset leaves the replacement worker unstarted");
		assert.equal(after.lastResetReason, "explicit_reset");
		assert.equal(fs.existsSync(scratchHost + "/keepme.txt"), true, "scratch survives reset");

		const r = await c.execute("console.log(marker)", undefined, undefined);
		assert.equal(r.status, "runtime_error", "context state must be gone");
		assert.equal(r.exception.type, "ReferenceError");
		const r2 = await c.execute("require('fs').readFileSync('/scratch/keepme.txt', 'utf8')", undefined, undefined);
		assert.equal(r2.repr, "'kept'");
	} finally {
		await c.dispose("test");
	}
});

// ── Forced termination and recovery ──────────────────────────────────────────

test("infinite loop stops at the requested deadline; state loss is reported", async () => {
	const c = makeController(makeProject());
	try {
		const r1 = await c.execute("let lost = 'value'", undefined, undefined);
		assert.equal(r1.status, "ok");
		const gen1 = r1.generation;
		const t0 = Date.now();
		const r2 = await c.execute("while (true) {}", 1, undefined);
		const elapsed = Date.now() - t0;
		assert.equal(r2.status, "timeout");
		assert.equal(r2.stateLost, true);
		assert.ok(elapsed < 15_000, `timeout must take about 1s, took ${elapsed}ms`);
		const r3 = await c.execute("console.log(lost)", undefined, undefined);
		assert.equal(r3.status, "runtime_error", "state must be gone after timeout");
		assert.equal(r3.exception.type, "ReferenceError");
		assert.ok(r3.generation > gen1, "fresh worker generation after timeout");
	} finally {
		await c.dispose("test");
	}
});

test("cancellation kills the sandbox promptly", async () => {
	const c = makeController(makeProject());
	try {
		const ac = new AbortController();
		const execPromise = c.execute("while (true) {}", 120, ac.signal);
		await new Promise((r) => setTimeout(r, 500));
		ac.abort();
		const r = await execPromise;
		assert.equal(r.status, "cancelled");
		assert.equal(r.stateLost, true);
	} finally {
		await c.dispose("test");
	}
});

test("worker death (SIGKILL from outside) is handled: partial output kept, recovery works", async () => {
	const c = makeController(makeProject());
	try {
		// Kill the worker out from under the controller while an execution is
		// still pending: busy-wait (a setTimeout would return its result frame
		// immediately). The kill is aimed via the /proc cmdline marker.
		const execPromise = c.execute("console.log('dying-soon'); const end = Date.now() + 30000; while (Date.now() < end) {}", undefined, undefined);
		await new Promise((r) => setTimeout(r, 700));
		const workers = findProcessesByCmdline("/worker.mjs");
		assert.ok(workers.length > 0, "worker process should be running");
		for (const pid of workers) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* raced */
			}
		}
		const r = await execPromise;
		assert.equal(r.status, "worker_error");
		assert.equal(r.stateLost, true);
		assert.ok(r.stdout.includes("dying-soon"), "partial output must be returned");
		const r2 = await c.execute("console.log('recovered')", undefined, undefined);
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
		const r = await c.execute("while (true) { console.log('flood'.repeat(100)) }", undefined, undefined);
		assert.equal(r.status, "output_limit");
		assert.equal(r.stateLost, true);
		assert.equal(r.outputLimitExceeded, true);
		assert.equal(r.logComplete, false);
		assert.ok(r.stdout.length <= 64 * 1024 + 4096, "excerpt must be bounded");
		assert.ok(r.logPaths, "a partial log must be saved");
		assert.ok(fs.existsSync(r.logPaths!.stdout), "log file must exist");
		const r2 = await c.execute("console.log('fresh-again')", undefined, undefined);
		assert.equal(r2.status, "ok");
		assert.ok(r2.generation > r.generation);
	} finally {
		await c.dispose("test");
	}
});

test("address-space limit backstops runaway Buffer allocation; catchable cases preserve state", async () => {
	const c = makeController(makeProject());
	try {
		// 1.5 GiB Buffer with a 512 MiB heap: a catchable RangeError (external,
		// non-heap allocation failure), unlike extreme heap growth which crashes.
		const r = await c.execute(
			["try {", "    const b = Buffer.alloc(1.5 * 1024 * 1024 * 1024)", "    console.log('allocated', b.length)", "} catch (e) {", "    console.log('blocked', e.name)"].join("\n") + "\n}",
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("blocked"), `oversized allocation must be catchable; got: ${r.stdout}`);
		assert.ok(!r.stdout.includes("allocated"));
		// Worker still usable after the failed allocation.
		const r2 = await c.execute("40 + 2", undefined, undefined);
		assert.equal(r2.status, "ok");
		assert.equal(r2.repr, "42");
	} finally {
		await c.dispose("test");
	}
});

test("per-file size limit (RLIMIT_FSIZE) blocks oversized writes", async () => {
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			[
				"try {",
				"    require('fs').writeFileSync('/scratch/big.bin', Buffer.alloc(17 * 1024 * 1024))",
				"    console.log('wrote-too-much')",
				"} catch (e) {",
				"    console.log('blocked', e.code)",
			].join("\n") + "\n}",
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("blocked"), "RLIMIT_FSIZE must surface as an error");
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
				"const handles = []",
				"try {",
				"    for (let i = 0; i < 200; i++) handles.push(require('fs').openSync('/dev/null', 'r'))",
				"    console.log('opened-all')",
				"} catch (e) {",
				"    console.log('fd-blocked', handles.length)",
			].join("\n") + "\n}",
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("fd-blocked"), "fd limit must raise an error");
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
		const r = await c.execute("require('fs').readFileSync('/workspace/data.txt', 'utf8').trim()", undefined, undefined);
		assert.equal(r.status, "ok");
		assert.equal(r.repr, "'fixture-content'");

		const w = await c.execute(
			[
				"try {",
				"    require('fs').writeFileSync('/workspace/data.txt', 'x')",
				"    console.log('WRITE-SUCCEEDED')",
				"} catch (e) {",
				"    console.log('write-blocked', e.code)",
			].join("\n") + "\n}",
			undefined,
			undefined,
		);
		assert.equal(w.status, "ok");
		assert.ok(w.stdout.includes("write-blocked"), "project writes must fail");
		assert.ok(!w.stdout.includes("WRITE-SUCCEEDED"));

		const d = await c.execute(
			[
				"try {",
				"    require('fs').unlinkSync('/workspace/data.txt')",
				"    console.log('DELETE-SUCCEEDED')",
				"} catch (e) {",
				"    console.log('delete-blocked', e.code)",
			].join("\n") + "\n}",
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
		const r = await c.execute("require('fs').writeFileSync('/scratch/host-mapping.txt', 'from-sandbox')", undefined, undefined);
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
	const canaryPath = path.join(os.tmpdir(), `node-int-canary-${Date.now()}.txt`);
	fs.writeFileSync(canaryPath, "host-secret", "utf8");
	fs.symlinkSync(canaryPath, path.join(projectDir, "canary-link"));
	const c = makeController(projectDir);
	try {
		const r = await c.execute(
			[
				"try {",
				"    console.log(require('fs').readFileSync('/workspace/canary-link', 'utf8'))",
				"} catch (e) {",
				"    console.log('symlink-blocked', e.code)",
			].join("\n") + "\n}",
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("symlink-blocked"), `symlink escape must fail; got: ${r.stdout}`);
		assert.ok(!r.stdout.includes("host-secret"));

		const r2 = await c.execute(
			[
				"try {",
				"    console.log(require('fs').readFileSync(" + JSON.stringify(canaryPath) + ", 'utf8'))",
				"} catch (e) {",
				"    console.log('direct-blocked', e.code)",
			].join("\n") + "\n}",
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
	process.env.PI_NODE_TOOL_SECRET = `secret-${Date.now()}`;
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			"console.log(Object.keys(process.env).length === 0 ? 'secret-absent' : 'secret-present')",
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("secret-absent"), `host env must not leak; got: ${r.stdout}`);
		assert.ok(!r.stdout.includes(process.env.PI_NODE_TOOL_SECRET!));
	} finally {
		await c.dispose("test");
		delete process.env.PI_NODE_TOOL_SECRET;
	}
});

test("connections to a host loopback TCP listener fail (network namespace)", async () => {
	const server = net.createServer(() => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as net.AddressInfo).port;
	const c = makeController(makeProject());
	try {
		const r = await c.execute(
			[
				"const net = require('node:net')",
				"const s = net.connect(" + port + ", '127.0.0.1')",
				"s.setTimeout(3000)",
				"s.on('connect', () => console.log('TCP-CONNECTED'))",
				"s.on('error', (e) => console.log('tcp-blocked', e.code || e.message))",
				"s.on('timeout', () => { console.log('tcp-timeout'); s.destroy() })",
			].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(!r.stdout.includes("TCP-CONNECTED"), `loopback connect must fail; got: ${r.stdout}`);
		// seccomp rejects socket() with EPERM before the netns is even relevant.
		assert.ok(r.stdout.includes("tcp-blocked EPERM"), `socket() must be blocked with EPERM; got: ${r.stdout}`);
	} finally {
		await c.dispose("test");
		server.close();
	}
});

test("a Unix socket inside the mounted project is blocked by seccomp (parity with python)", async () => {
	// The seccomp launcher installs the same policy as worker.py: socket() is
	// rejected with EPERM before the address family matters, so even a
	// project-local Unix socket is unreachable. This used to be a documented
	// delta (netns-only hardening); the launcher flipped it deliberately.
	const projectDir = makeProject();
	const sockPath = path.join(projectDir, "host.sock");
	const server = net.createServer(() => {});
	await new Promise<void>((resolve) => server.listen(sockPath, resolve));
	const c = makeController(projectDir);
	try {
		const r = await c.execute(
			[
				"const net = require('node:net')",
				"try { console.log('dir:', require('fs').readdirSync('/workspace').join(',')) } catch (e) { console.log('dir-err', e.code) }",
				"const s = net.connect('/workspace/host.sock')",
				"s.on('connect', () => console.log('UNIX-CONNECTED'))",
				"s.on('error', (e) => console.log('unix-blocked', e.code || e.message))",
			].join("\n"),
			undefined,
			undefined,
		);
		assert.equal(r.status, "ok");
		assert.ok(r.stdout.includes("unix-blocked EPERM"), `socket() must be blocked with EPERM by the seccomp launcher; got: ${r.stdout}`);
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

test("require of project files works; require outside the mounts fails", async () => {
	const projectDir = makeProject();
	fs.writeFileSync(path.join(projectDir, "helper.cjs"), "module.exports.value = 41;\n", "utf8");
	const c = makeController(projectDir);
	try {
		const r = await c.execute("require('/workspace/helper.cjs').value + 1", undefined, undefined);
		assert.equal(r.status, "ok");
		assert.equal(r.repr, "42");
		const r2 = await c.execute("require('/etc/hostname')", undefined, undefined);
		assert.equal(r2.status, "runtime_error", "reads outside the mounts must fail");
	} finally {
		await c.dispose("test");
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
		const r = await c2.execute("console.log(shared)", undefined, undefined);
		assert.equal(r.status, "runtime_error", "contexts must be independent");
	} finally {
		await c1.dispose("test");
		await c2.dispose("test");
	}
});

test("dispose deletes scratch and log directories, is idempotent, and leaves no workers", async () => {
	const projectDir = makeProject();
	const c = makeController(projectDir);
	await c.execute("require('fs').writeFileSync('/scratch/doomed.txt', 'bye')", undefined, undefined);
	const st = await c.status();
	const scratchDir = st.paths.scratchDir!;
	const logDir = st.paths.logDir!;
	assert.ok(fs.existsSync(path.join(scratchDir, "doomed.txt")));
	assert.ok(fs.existsSync(logDir));

	// Start a long execution so a worker exists at dispose time.
	const ac = new AbortController();
	const execPromise = c.execute("const end = Date.now() + 30000; while (Date.now() < end) {}", 120, ac.signal);
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
	await c1.execute("require('fs').writeFileSync('/scratch/old-context.txt', 'old')", undefined, undefined);
	const st1 = await c1.status();
	await c1.dispose("session_tree_change");
	assert.equal(fs.existsSync(st1.paths.scratchDir!), false);
});

test("no surviving worker processes after the suite", async () => {
	// Give late kills a moment, then verify nothing from this test run
	// survives. Scope to test-owned workers: their scratch mounts live under
	// the node-int-runtime temp roots, unlike a live pi session's worker.
	await new Promise((r) => setTimeout(r, 500));
	const survivors = findProcessesByCmdline("/worker.mjs").filter((pid) => {
		try {
			return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("node-int-runtime");
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
			const r = await c.execute(`console.log('first-exec-${i}')`, undefined, undefined);
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

// ── Extension-level happy path (through the registered tool) ────────────────

function makeExtensionHarness() {
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
	nodeExtension(pi as any);
	return { tool, handlers, events: pi.events };
}

if (supported) {
	test("extension-level execute returns the inspected final expression", async () => {
		const harness = makeExtensionHarness();
		const project = makeProject();
		const ctx = { cwd: project, hasUI: true };
		harness.handlers.session_start({}, ctx);
		const result = await harness.tool.execute("call-1", { code: "let n = 20; n * 2" }, undefined, undefined, ctx);
		assert.equal(result.details?.status, "ok", JSON.stringify(result.details ?? {}));
		const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
		assert.ok(text.includes("result: 40"), `expected the final-expression repr; got: ${text.slice(0, 300)}`);
		// Second call in the same session sees the persisted state.
		const result2 = await harness.tool.execute("call-2", { code: "n + 1" }, undefined, undefined, ctx);
		assert.equal(result2.details?.status, "ok");
		const text2 = (result2.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
		assert.ok(text2.includes("result: 21"), `persistence through the tool; got: ${text2.slice(0, 300)}`);
		await harness.handlers.session_shutdown({}, {});
	});
}

// ── Runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
if (!supported) {
	console.log(`SKIP: node integration tests: ${skipReason}`);
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

// Exit explicitly: killed-sandbox child handles can keep the event loop alive
// when stdout is piped (node --test runs this file as a child), so the
// process would otherwise hang after a fully passing run.
process.exit(0);
