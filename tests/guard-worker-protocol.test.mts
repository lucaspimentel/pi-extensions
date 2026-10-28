// Frame-protocol coverage ported from the retired node/python unit suites,
// plus the python read-audit-hook harness from the retired python unit suite.
// The protocol cases exercise both live guard implementations without spawning
// a worker; the read-hook case loads the live worker.py in a bare python3 (no
// sandbox), which is skipped when no interpreter is installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import * as nodeProtocol from "../extensions/guard/tools/node/protocol.ts";
import * as pythonProtocol from "../extensions/guard/tools/python/protocol.ts";
import { LIMITS as NODE_LIMITS, PROTOCOL_VERSION as NODE_VERSION } from "../extensions/guard/tools/node/limits.ts";
import { LIMITS as PYTHON_LIMITS, PROTOCOL_VERSION as PYTHON_VERSION } from "../extensions/guard/tools/python/limits.ts";

for (const { name, protocol, LIMITS, PROTOCOL_VERSION, runtimeVersion, code } of [
	{ name: "node", protocol: nodeProtocol, LIMITS: NODE_LIMITS, PROTOCOL_VERSION: NODE_VERSION, runtimeVersion: "22.20.0", code: "console.log(1)\n" },
	{ name: "python", protocol: pythonProtocol, LIMITS: PYTHON_LIMITS, PROTOCOL_VERSION: PYTHON_VERSION, runtimeVersion: "3.10.12", code: "print(1)\n" },
]) {
	const { boundHead, boundTail, decodeFrame, encodeRequest, FrameStream } = protocol;

	test(`${name}: decodeFrame validates frames`, () => {
		// Valid frames.
		const ready = decodeFrame(JSON.stringify({ type: "ready", protocol: 1, runtimeVersion }));
		assert.ok(ready.ok && ready.frame.type === "ready");
		const result = decodeFrame(
			JSON.stringify({
				type: "result",
				protocol: 1,
				id: 3,
				status: "ok",
				repr: "42",
				reprTruncated: false,
				exception: null,
			}),
		);
		assert.ok(result.ok && result.frame.type === "result" && result.frame.id === 3);
		const errFrame = decodeFrame(JSON.stringify({ type: "error", protocol: 1, id: null, message: "bad" }));
		assert.ok(errFrame.ok && errFrame.frame.type === "error");

		// permission_needed requires a bounded absolute path, and sandboxProcesses
		// is optional but must be a non-negative integer when present.
		const denied = decodeFrame(
			JSON.stringify({ type: "result", protocol: 1, id: 4, status: "permission_needed", path: "/etc/hostname", repr: null, reprTruncated: false, exception: null }),
		);
		if (!denied.ok || denied.frame.type !== "result") assert.fail("an absolute permission_needed path must decode");
		assert.equal(denied.frame.path, "/etc/hostname");
		assert.equal(denied.frame.sandboxProcesses, 0, "sandboxProcesses defaults to 0 when absent");
		const atLimit = decodeFrame(
			JSON.stringify({ type: "result", protocol: 1, id: 6, status: "permission_needed", path: "/" + "p".repeat(4095), repr: null, reprTruncated: false, exception: null }),
		);
		assert.ok(atLimit.ok && atLimit.frame.type === "result", "a path of exactly the byte limit is still accepted");
		const counted = decodeFrame(
			JSON.stringify({ type: "result", protocol: 1, id: 5, status: "ok", repr: null, reprTruncated: false, exception: null, sandboxProcesses: 3 }),
		);
		if (!counted.ok || counted.frame.type !== "result") assert.fail("a non-negative integer sandboxProcesses must decode");
		assert.equal(counted.frame.sandboxProcesses, 3);

		// Malformed / oversized / wrong-shape frames.
		const cases: [string, string][] = [
			["not json", "valid JSON"],
			["[1,2,3]", "not an object"],
			[JSON.stringify({ type: "ready", protocol: 2, runtimeVersion }), "protocol version"],
			[JSON.stringify({ type: "result", protocol: 1, id: -1, status: "ok", repr: null, reprTruncated: false, exception: null }), "invalid id"],
			[JSON.stringify({ type: "result", protocol: 1, id: 1, status: "weird", repr: null, reprTruncated: false, exception: null }), "invalid status"],
			[JSON.stringify({ type: "result", protocol: 1, id: 1, status: "ok", repr: "x".repeat(LIMITS.maxReprBytes + 1), reprTruncated: false, exception: null }), "oversized repr"],
			[
				JSON.stringify({
					type: "result",
					protocol: 1,
					id: 1,
					status: "runtime_error",
					repr: null,
					reprTruncated: false,
					exception: { type: "E", message: "m", traceback: "t".repeat(LIMITS.maxTracebackBytes + 1) },
				}),
				"oversized traceback",
			],
			[JSON.stringify({ type: "bogus", protocol: 1 }), "unknown type"],
			[JSON.stringify({ type: "error", protocol: 1, id: "x", message: "m" }), "invalid error id"],
			[JSON.stringify({ type: "error", protocol: 1, id: null, message: 5 }), "invalid message type"],
			[JSON.stringify({ type: "ready", protocol: 1, runtimeVersion: 3 }), "invalid runtimeVersion"],
			[JSON.stringify({ type: "result", protocol: 1, id: 1, status: "permission_needed", repr: null, reprTruncated: false, exception: null }), "permission_needed without a path"],
			[JSON.stringify({ type: "result", protocol: 1, id: 1, status: "permission_needed", path: "etc/hostname", repr: null, reprTruncated: false, exception: null }), "permission_needed with a relative path"],
			[JSON.stringify({ type: "result", protocol: 1, id: 1, status: "permission_needed", path: "/" + "p".repeat(4096), repr: null, reprTruncated: false, exception: null }), "permission_needed path over the byte limit"],
			[JSON.stringify({ type: "result", protocol: 1, id: 1, status: "ok", repr: null, reprTruncated: false, exception: null, sandboxProcesses: -1 }), "negative sandboxProcesses"],
			[JSON.stringify({ type: "result", protocol: 1, id: 1, status: "ok", repr: null, reprTruncated: false, exception: null, sandboxProcesses: 1.5 }), "non-integer sandboxProcesses"],
			[JSON.stringify({ type: "result", protocol: 1, id: 1, status: "ok", repr: null, reprTruncated: false, exception: null, sandboxProcesses: "2" }), "non-numeric sandboxProcesses"],
		];
		for (const [input, label] of cases) {
			const out = decodeFrame(input);
			assert.ok(!out.ok, `frame must be rejected: ${label}`);
		}
	});

	// ── Protocol: FrameStream splitting and over-limit handling ─────────────────

	test(`${name}: FrameStream splits, bounds, and recovers`, () => {
		const lines: string[] = [];
		const stream = new FrameStream((line) => lines.push(line));
		assert.equal(stream.push(Buffer.from('{"a":1}\n{"b":2}\n{"c"')), null);
		assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
		assert.equal(stream.push(Buffer.from(':3}\n')), null);
		assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);

		// Split across chunks with multibyte content.
		const lines2: string[] = [];
		const s2 = new FrameStream((l) => lines2.push(l));
		const payload = JSON.stringify({ k: "héllo wörld" }) + "\n";
		const bytes = Buffer.from(payload, "utf8");
		s2.push(bytes.subarray(0, 5));
		s2.push(bytes.subarray(5, 20));
		s2.push(bytes.subarray(20));
		assert.deepEqual(lines2, [payload.trim()]);

		// Over-limit single line: exactly one violation, then recovery.
		const violations: string[] = [];
		const lines3: string[] = [];
		const s3 = new FrameStream((l) => lines3.push(l));
		let v = s3.push(Buffer.from("x".repeat(LIMITS.maxFrameBytes + 10)));
		if (v) violations.push(v);
		v = s3.push(Buffer.from("\n"));
		if (v) violations.push(v);
		assert.equal(violations.length, 1, "one violation for the over-limit line");
		assert.deepEqual(lines3, []);
		// Stream still works after the violation.
		s3.push(Buffer.from('{"ok":true}\n'));
		assert.deepEqual(lines3, ['{"ok":true}']);

		// Oversized valid-JSON frame (frame limit, not JSON validity).
		const big = JSON.stringify({ pad: "y".repeat(LIMITS.maxFrameBytes) });
		const lines4: string[] = [];
		const s4 = new FrameStream((l) => lines4.push(l));
		const v4 = s4.push(Buffer.from(big + "\n"));
		assert.ok(v4, "oversized frame must be reported");
		assert.deepEqual(lines4, []);
	});

	// ── Protocol: request encoding and bounds ────────────────────────────────────

	test(`${name}: encodeRequest frames and bounds requests`, () => {
		const buf = encodeRequest({ type: "exec", protocol: PROTOCOL_VERSION, id: 1, code });
		assert.ok(buf.toString("utf8").endsWith("\n"));
		const parsed = JSON.parse(buf.toString("utf8").trim());
		assert.equal(parsed.type, "exec");
		assert.equal(parsed.protocol, PROTOCOL_VERSION);
		// Newlines in code stay inside the JSON frame (escaped), one physical line.
		assert.equal(buf.toString("utf8").split("\n").length, 2);

		assert.throws(
			() => encodeRequest({ type: "exec", protocol: 1, id: 1, code: "x".repeat(LIMITS.maxFrameBytes) }),
			/limit/,
			"oversized request must throw before writing",
		);
	});

	// ── Bounds helpers ───────────────────────────────────────────────────────────

	test(`${name}: boundHead and boundTail keep the correct anchor`, () => {
		assert.deepEqual(boundTail("short", 100), { text: "short", truncated: false });
		const long = "a".repeat(1000) + "END";
		const tail = boundTail(long, 32);
		assert.ok(tail.truncated);
		assert.ok(tail.text.endsWith("END"), "tail keeps the end");
		assert.ok(Buffer.byteLength(tail.text, "utf8") <= 64);

		assert.deepEqual(boundHead("short", 100), { text: "short", truncated: false });
		const head = boundHead("START" + "b".repeat(1000), 32);
		assert.ok(head.truncated);
		assert.ok(head.text.startsWith("START"), "head keeps the start");
	});
}

// ── python: live worker read-audit hook (loads the real worker.py) ──────────

test("python: the live worker's read-audit hook denies out-of-mount reads", (t) => {
	// A bare interpreter loads worker.py as a module (no sandbox, no protocol),
	// which covers the hook itself; skip (do not fail) when python3 is absent.
	const pythonBin = process.env.PI_PYTHON_TOOL_INTERPRETER || "python3";
	const probe = spawnSync(pythonBin, ["-c", "print('ok')"], { encoding: "utf8", timeout: 10_000 });
	if (probe.error || probe.status !== 0) {
		t.skip("python3 not available on this machine");
		return;
	}
	const workerPath = path.join(import.meta.dirname, "../extensions/guard/tools/python/worker.py");
	const harness = `
import importlib.util, os, sys, tempfile
spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

# parse_mounted_prefixes: real /proc on Linux; root "/" excluded.
prefixes = w.parse_mounted_prefixes()
assert prefixes, "no mountpoints parsed"
assert "/" not in prefixes

# _path_outside_mounts: inside a mount allowed, outside denied.
assert not w._path_outside_mounts("/usr/lib", ["/usr"])
assert w._path_outside_mounts("/etc/passwd", ["/usr"])
assert w._path_outside_mounts("/usrx", ["/usr"]), "prefix must not match partial components"

# Hook + execute_code end to end, with cwd as the only writable location.
cwd = tempfile.mkdtemp()
os.chdir(cwd)
with open(os.path.join(cwd, "allow.txt"), "w") as fh:
    fh.write("fixture")
# Allowed prefixes: cwd, /proc, the worker's own directory, and the interpreter's
# stdlib tree (the real sandbox mounts the interpreter tree read-only, and
# formatting the denial traceback imports stdlib modules from it).
w.install_read_audit_hook([cwd, "/proc", os.path.dirname(os.path.abspath(sys.argv[1])), os.path.dirname(os.__file__)])
ns = {"__builtins__": __builtins__}
r_ok = w.execute_code(dict(ns), "open('allow.txt').read()", 100)  # relative, inside cwd
assert r_ok["status"] == "ok", r_ok
assert r_ok["repr"] == "'fixture'", r_ok
r_denied = w.execute_code(dict(ns), "open('/etc/hostname').read()", 100)
assert r_denied["status"] == "permission_needed", r_denied
assert r_denied["path"] == "/etc/hostname", r_denied
assert r_denied["exception"] is not None and r_denied["exception"]["type"] == "SandboxReadDenied", r_denied
# Directory listing outside the mounts is hooked too; inside is fine.
r_list = w.execute_code(dict(ns), "import os; os.listdir('/etc')", 100)
assert r_list["status"] == "permission_needed", r_list
r_list_ok = w.execute_code(dict(ns), "import os; os.listdir('.')", 100)
assert r_list_ok["status"] == "ok", r_list_ok
# State is preserved across a permission_needed (ordinary exception path).
r_state = w.execute_code(dict(ns), "marker = 1; marker + 1", 100)
assert r_state["status"] == "ok" and r_state["repr"] == "2", r_state
print("WORKER-HOOK-OK")
`;
	const run = spawnSync(pythonBin, ["-", workerPath], { input: harness, encoding: "utf8", timeout: 30_000 });
	assert.ok(
		run.status === 0 && (run.stdout ?? "").includes("WORKER-HOOK-OK"),
		`worker read-audit harness failed: ${run.stderr ?? run.stdout}`,
	);
});
