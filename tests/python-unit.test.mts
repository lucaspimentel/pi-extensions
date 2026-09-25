// Unit tests for the python tool extension: schema validation, protocol
// framing/validation, result bounds, registration side effects, and error
// marking. These run everywhere; sandbox behavior is covered by
// tests/python-integration.test.mts.
//
// Run: node --test tests/python-unit.test.mts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LIMITS, PROTOCOL_VERSION } from "../extensions/python/limits.ts";
import { buildBwrapArgs, filterMountableReadRoots } from "../extensions/python/sandbox.ts";
import {
	boundHead,
	boundTail,
	decodeFrame,
	encodeRequest,
	FrameStream,
} from "../extensions/python/protocol.ts";
import { FAILURE_STATUSES, PythonSessionController } from "../extensions/python/session.ts";
import pythonExtension from "../extensions/python/index.ts";

// ── Registration: no side effects at import or registration time ────────────

function makePi() {
	const tools: any[] = [];
	const handlers: Record<string, any> = {};
	const listeners: Array<[string, (data: unknown) => void]> = [];
	return {
		tools,
		handlers,
		listeners,
		registerTool(tool: any) {
			tools.push(tool);
		},
		on(event: string, handler: any) {
			handlers[event] = handler;
			return () => {};
		},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				listeners.push([channel, handler]);
				return () => {};
			},
			emit(channel: string, data: unknown) {
				for (const [c, h] of listeners) if (c === channel) h(data);
			},
		},
	};
}

async function testRegistrationHasNoSideEffects() {
	const runtimeRoot = path.join(os.tmpdir(), "pi-python-tool");
	fs.mkdirSync(runtimeRoot, { recursive: true });
	const before = fs.readdirSync(runtimeRoot).sort();

	const resourcesBefore = new Set(process.getActiveResourcesInfo());
	const pi = makePi();
	pythonExtension(pi as any);
	const resourcesAfter = new Set(process.getActiveResourcesInfo());

	assert.equal(pi.tools.length, 1, "exactly one tool registered");
	assert.equal(pi.tools[0].name, "python");
	assert.equal(pi.tools[0].executionMode, "sequential", "tool must be sequential");
	assert.ok(pi.handlers.tool_result, "tool_result handler registered");
	assert.ok(pi.handlers.session_start, "session_start handler registered");
	assert.ok(pi.handlers.session_shutdown, "session_shutdown handler registered");
	assert.ok(pi.handlers.session_tree, "session_tree handler registered");
	assert.ok(
		pi.listeners.some(([c]) => c === "tool-permissions:mode"),
		"subscribed to the tool-permissions:mode event",
	);

	// No child processes, sockets, or timers created by registration.
	for (const r of resourcesAfter) {
		if (!resourcesBefore.has(r)) {
			assert.ok(
				!["ChildProcess", "TCPSocketWrap", "TCPServerWrap", "Timeout"].includes(r),
				`registration created a ${r} resource`,
			);
		}
	}

	// A status call must not allocate runtime directories either.
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "py-unit-proj-"));
	const st = await pi.tools[0].execute("t1", { action: "status" }, undefined, undefined, { cwd: projectDir });
	assert.equal(st.details.status, "ok");
	assert.equal(st.details.report.available, "unverified", "status must not probe dependencies");
	assert.equal(st.details.report.workerRunning, false);
	assert.equal(st.details.report.paths.scratchDir, undefined, "status must not allocate scratch");
	const after = fs.readdirSync(runtimeRoot).sort();
	assert.deepEqual(after, before, "status must not create runtime directories");
	fs.rmSync(projectDir, { recursive: true, force: true });
	console.log("  ✓ registration and status are side-effect free");
}

// ── Schema validation: invalid input rejected before touching the worker ────

async function testSchemaValidation() {
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "py-unit-proj-"));
	const pi = makePi();
	pythonExtension(pi as any);
	const execute = pi.tools[0].execute.bind(pi.tools[0]);
	const ctx = { cwd: projectDir };

	await assert.rejects(
		() => execute("t", { action: "execute" }, undefined, undefined, ctx),
		/code/,
		"execute without code must throw",
	);
	await assert.rejects(
		() => execute("t", { action: "reset", code: "x" }, undefined, undefined, ctx),
		/rejects/,
		"reset with code must throw",
	);
	await assert.rejects(
		() => execute("t", { action: "status", timeoutSeconds: 5 }, undefined, undefined, ctx),
		/rejects/,
		"status with timeoutSeconds must throw",
	);
	await assert.rejects(
		() => execute("t", { code: "x", timeoutSeconds: 0 }, undefined, undefined, ctx),
		/timeoutSeconds/,
		"timeoutSeconds 0 must throw",
	);
	await assert.rejects(
		() => execute("t", { code: "x", timeoutSeconds: LIMITS.maxTimeoutSeconds + 1 }, undefined, undefined, ctx),
		/timeoutSeconds/,
		"timeoutSeconds above ceiling must throw",
	);
	await assert.rejects(
		() => execute("t", { code: "x".repeat(LIMITS.maxCodeBytes + 1) }, undefined, undefined, ctx),
		/limit/,
		"oversized code must throw",
	);

	fs.rmSync(projectDir, { recursive: true, force: true });
	console.log("  ✓ invalid input rejected before starting or changing the worker");
}

// ── Error marking: failing statuses become Pi tool errors ───────────────────

function testErrorMarking() {
	const pi = makePi();
	pythonExtension(pi as any);
	const handler = pi.handlers.tool_result;

	const mkEvent = (status: string | undefined) => ({
		type: "tool_result",
		toolName: "python",
		toolCallId: "t",
		input: {},
		content: [{ type: "text", text: "x" }],
		isError: false,
		details: status === undefined ? undefined : { status },
	});

	for (const status of FAILURE_STATUSES) {
		const out = handler(mkEvent(status));
		assert.deepEqual(out, { isError: true }, `status ${status} must be marked as an error`);
	}
	for (const status of ["ok"]) {
		const out = handler(mkEvent(status));
		assert.equal(out, undefined, `status ${status} must not be marked as an error`);
	}
	assert.equal(handler({ ...mkEvent("ok"), toolName: "bash" }), undefined, "other tools untouched");
	assert.equal(handler(mkEvent(undefined)), undefined, "missing details untouched");
	console.log("  ✓ tool_result handler marks only failing python results as errors");
}

// ── Protocol: decodeFrame validation ─────────────────────────────────────────

function testDecodeFrame() {
	// Valid frames.
	const ready = decodeFrame(JSON.stringify({ type: "ready", protocol: 1, pythonVersion: "3.10.12" }));
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

	// Malformed / oversized / wrong-shape frames.
	const cases: [string, string][] = [
		["not json", "valid JSON"],
		["[1,2,3]", "not an object"],
		[JSON.stringify({ type: "ready", protocol: 2, pythonVersion: "3" }), "protocol version"],
		[JSON.stringify({ type: "result", protocol: 1, id: -1, status: "ok", repr: null, reprTruncated: false, exception: null }), "invalid id"],
		[JSON.stringify({ type: "result", protocol: 1, id: 1, status: "weird", repr: null, reprTruncated: false, exception: null }), "invalid status"],
		[JSON.stringify({ type: "result", protocol: 1, id: 1, status: "ok", repr: "x".repeat(LIMITS.maxReprBytes + 1), reprTruncated: false, exception: null }), "oversized repr"],
		[
			JSON.stringify({
				type: "result",
				protocol: 1,
				id: 1,
				status: "python_error",
				repr: null,
				reprTruncated: false,
				exception: { type: "E", message: "m", traceback: "t".repeat(LIMITS.maxTracebackBytes + 1) },
			}),
			"oversized traceback",
		],
		[JSON.stringify({ type: "bogus", protocol: 1 }), "unknown type"],
		[JSON.stringify({ type: "error", protocol: 1, id: "x", message: "m" }), "invalid error id"],
		[JSON.stringify({ type: "error", protocol: 1, id: null, message: 5 }), "invalid message type"],
		[JSON.stringify({ type: "ready", protocol: 1, pythonVersion: 3 }), "invalid pythonVersion"],
	];
	for (const [input, label] of cases) {
		const out = decodeFrame(input);
		assert.ok(!out.ok, `frame must be rejected: ${label}`);
	}
	console.log("  ✓ decodeFrame rejects malformed, oversized, and mistyped frames");
}

// ── Protocol: FrameStream splitting and over-limit handling ─────────────────

function testFrameStream() {
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
	console.log("  ✓ FrameStream splits chunks, bounds frames, and recovers after violations");
}

// ── Protocol: request encoding and bounds ────────────────────────────────────

function testEncodeRequest() {
	const buf = encodeRequest({ type: "exec", protocol: PROTOCOL_VERSION, id: 1, code: "print(1)\n" });
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
	console.log("  ✓ encodeRequest produces single-line frames and rejects oversize");
}

// ── Bounds helpers ───────────────────────────────────────────────────────────

function testBoundHelpers() {
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
	console.log("  ✓ boundTail/boundHead bound text with the right anchor");
}

// ── Controller static behavior (no sandbox required) ─────────────────────────

async function testControllerStatics() {
	const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "py-unit-runtime-"));
	const controller = new PythonSessionController({ projectDir: os.tmpdir(), runtimeRoot });

	// Disposed controller refuses execution without spawning anything.
	await controller.dispose("test");
	const res = await controller.execute("1", undefined, undefined);
	assert.equal(res.status, "unavailable");
	assert.equal(res.stateLost, false);

	// Repeated dispose is safe.
	await controller.dispose("test");
	await controller.dispose("test");

	// Pre-aborted signal: cancelled, no worker.
	const controller2 = new PythonSessionController({ projectDir: os.tmpdir(), runtimeRoot });
	const ac = new AbortController();
	ac.abort();
	const res2 = await controller2.execute("1", undefined, ac.signal);
	assert.equal(res2.status, "cancelled");
	assert.equal(res2.stateLost, false);
	const st = await controller2.status();
	assert.equal(st.workerRunning, false, "no worker may start for an aborted request");
	assert.equal(st.generation, 0);
	await controller2.dispose("test");

	// Scratch/log dirs are deleted by dispose.
	assert.equal(fs.existsSync(runtimeRoot + "/scratch"), false);
	const remaining = fs.readdirSync(runtimeRoot);
	assert.equal(remaining.length, 0, `dispose must delete runtime dirs, found: ${remaining.join(", ")}`);
	fs.rmSync(runtimeRoot, { recursive: true, force: true });
	console.log("  ✓ controller refuses disposed/aborted work and cleans up its directories");
}

// ── Workspace mount flag (allow-edits/yolo remount) ──────────────────────────

function makeLaunchSpec(writableWorkspace?: boolean) {
	return {
		projectDir: "/fake/project",
		scratchDir: "/fake/scratch",
		workerPath: "/fake/worker.py",
		bwrapPath: "/usr/bin/bwrap",
		interpreterPath: "/usr/bin/python3",
		...(writableWorkspace === undefined ? {} : { writableWorkspace }),
	};
}

async function testWorkspaceMountFlag() {
	/** Index of the argv entry binding the project dir at /workspace, or -1. */
	function projectMountIndex(args: string[], flag: string): number {
		for (let i = 0; i < args.length - 2; i++) {
			if (args[i] === flag && args[i + 1] === "/fake/project" && args[i + 2] === "/workspace") return i;
		}
		return -1;
	}

	// Default (flag absent): read-only project mount.
	const ro = buildBwrapArgs(makeLaunchSpec());
	assert.notEqual(projectMountIndex(ro, "--ro-bind"), -1, "project must be --ro-bound by default");
	assert.equal(projectMountIndex(ro, "--bind"), -1, "project must not be writable by default");

	// writableWorkspace: true -> writable bind, never ro-bind.
	const rw = buildBwrapArgs(makeLaunchSpec(true));
	assert.notEqual(projectMountIndex(rw, "--bind"), -1, "project must be --bind when writable");
	assert.equal(projectMountIndex(rw, "--ro-bind"), -1, "project must not use --ro-bind when writable");

	// Controller stores the flag and reports it in status().
	const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "py-unit-mount-"));
	const rwController = new PythonSessionController({ projectDir: os.tmpdir(), runtimeRoot, writableWorkspace: true });
	const st = await rwController.status();
	assert.equal(st.workspaceMode, "read-write");
	await rwController.dispose("test");
	const roController = new PythonSessionController({ projectDir: os.tmpdir(), runtimeRoot });
	const st2 = await roController.status();
	assert.equal(st2.workspaceMode, "read-only");
	await roController.dispose("test");
	fs.rmSync(runtimeRoot, { recursive: true, force: true });
	console.log("  ✓ /workspace mount is read-only by default and read-write with writableWorkspace");
}

// ── Permission-mode event wiring ─────────────────────────────────────────

// ── Read-root filtering and binds (step 2.5) ────────────────────────────────

function testFilterMountableReadRoots() {
	const project = "/fake/project";

	// Empty input -> empty output.
	assert.deepEqual(filterMountableReadRoots([], project), { mountable: [], skipped: [] });

	// Reserved sandbox mounts are skipped, including anything under them.
	const reserved = filterMountableReadRoots(
		["/tmp", "/tmp/x", "/usr", "/usr/share", "/proc", "/dev", "/workspace", "/scratch", "/worker.py"],
		project,
	);
	assert.deepEqual(reserved.mountable, []);
	assert.equal(reserved.skipped.length, 9);
	assert.ok(reserved.skipped.every((s) => s.reason.startsWith("reserved sandbox mount")));

	// Project dir and anything inside it are skipped (readable at /workspace).
	const projectCovered = filterMountableReadRoots([project, `${project}/sub`, "/var/tmp"], project);
	assert.deepEqual(projectCovered.mountable, ["/var/tmp"]);
	assert.deepEqual(
		projectCovered.skipped.map((s) => s.root),
		[project, `${project}/sub`],
	);
	assert.ok(projectCovered.skipped.every((s) => s.reason === "covered by /workspace"));

	// A root CONTAINING the project is kept: it grants sibling directories too.
	const ancestor = filterMountableReadRoots(["/fake"], project);
	assert.deepEqual(ancestor.mountable, ["/fake"]);
	assert.equal(ancestor.skipped.length, 0);

	// Nested roots dedupe to the shallowest kept root.
	const nested = filterMountableReadRoots(["/home/u", "/home/u/data", "/home/u/data/deep", "/other"], project);
	assert.deepEqual(nested.mountable, ["/home/u", "/other"]);
	assert.deepEqual(
		nested.skipped.map((s) => [s.root, s.reason]),
		[
			["/home/u/data", "covered by /home/u"],
			["/home/u/data/deep", "covered by /home/u"],
		],
	);

	// Exact duplicates keep one; trailing slashes normalize.
	const dupes = filterMountableReadRoots(["/var/tmp", "/var/tmp/", "/var/tmp"], project);
	assert.deepEqual(dupes.mountable, ["/var/tmp"]);
	assert.equal(dupes.skipped.length, 0);

	// Non-absolute and garbage entries are skipped with a reason; "/" is rejected.
	const garbage = filterMountableReadRoots(["relative/path", "", "/", 42, null, "/ok/dir"], project);
	assert.deepEqual(garbage.mountable, ["/ok/dir"]);
	assert.ok(garbage.skipped.some((s) => s.reason === "not an absolute path"));

	// No project dir known: project-based skips simply do not fire.
	const noProject = filterMountableReadRoots(["/fake/project", "/var/tmp"], undefined);
	assert.deepEqual(noProject.mountable, ["/fake/project", "/var/tmp"]);
	assert.equal(noProject.skipped.length, 0);

	console.log("  ✓ filterMountableReadRoots skips reserved/project/nested roots and keeps the rest");
}

async function testReadRootBinds() {
	// buildBwrapArgs mounts pre-filtered roots read-only 1:1 (bind-try form).
	const spec = {
		projectDir: "/fake/project",
		scratchDir: "/fake/scratch",
		workerPath: "/fake/worker.py",
		bwrapPath: "/usr/bin/bwrap",
		interpreterPath: "/usr/bin/python3",
		readRoots: ["/var/tmp", "/home/u/data"],
	};
	const args = buildBwrapArgs(spec);
	for (const root of spec.readRoots) {
		const idx = args.indexOf("--ro-bind-try");
		let found = -1;
		for (let i = 0; i < args.length - 2; i++) {
			if (args[i] === "--ro-bind-try" && args[i + 1] === root && args[i + 2] === root) found = i;
		}
		assert.notEqual(found, -1, `read root ${root} must be mounted --ro-bind-try 1:1`);
		assert.ok(idx !== -1); // the flag exists at all
	}
	// Without readRoots, no bind-try for read-root paths (other bind-try
	// entries, like /etc/ld.so.cache, are pre-existing and unrelated).
	const plain = buildBwrapArgs({ ...spec, readRoots: undefined });
	for (const root of spec.readRoots) {
		for (let i = 0; i < plain.length - 2; i++) {
			assert.ok(
				!(plain[i] === "--ro-bind-try" && plain[i + 1] === root && plain[i + 2] === root),
				`read root ${root} must not be mounted when readRoots is absent`,
			);
		}
	}

	// Controller stores the roots and reports them in status().
	const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "py-unit-roots-"));
	const c1 = new PythonSessionController({ projectDir: os.tmpdir(), runtimeRoot, readRoots: ["/var/tmp"] });
	const st1 = await c1.status();
	assert.deepEqual(st1.readRoots, ["/var/tmp"]);
	await c1.dispose("test");
	const c2 = new PythonSessionController({ projectDir: os.tmpdir(), runtimeRoot });
	const st2 = await c2.status();
	assert.deepEqual(st2.readRoots, []);
	await c2.dispose("test");
	fs.rmSync(runtimeRoot, { recursive: true, force: true });
	console.log("  ✓ read roots mount --ro-bind-try 1:1 and surface in status()");
}

async function testPermissionModeEvent() {
	const pi = makePi();
	pythonExtension(pi as any);
	const emit = (payload: unknown) => pi.events.emit("tool-permissions:mode", payload);

	// Unknown modes are ignored (mount stays read-only): no dispose, no crash.
	emit({ mode: "bogus" });
	emit({ mode: undefined });
	emit(null);
	emit(42);

	// edits/yolo flip to writable, manual/auto flip back.
	emit({ mode: "edits" });
	emit({ mode: "yolo" });
	emit({ mode: "auto" });
	emit({ mode: "manual" });

	// Roots ride along: valid arrays are accepted, absent/malformed roots mean
	// "no root mounts" (never "keep whatever was mounted").
	emit({ mode: "manual", readRoots: ["/var/tmp"] });
	emit({ mode: "manual", readRoots: "/var/tmp" }); // not an array -> cleared
	emit({ mode: "manual", readRoots: ["/tmp", "/var/tmp"] }); // /tmp skipped, /var/tmp kept
	emit({ mode: "manual", readRoots: ["/var/tmp", 42, "relative"] }); // filtered
	emit({ mode: "manual" }); // absent -> cleared

	// Repeated identical events are no-ops (no state churn).
	emit({ mode: "manual", readRoots: ["/var/tmp"] });
	emit({ mode: "manual", readRoots: ["/var/tmp"] });

	console.log("  ✓ tool-permissions:mode events (mode + readRoots) are consumed safely on any payload");
}

// ── Limits table sanity ──────────────────────────────────────────────────────

function testLimits() {
	assert.equal(LIMITS.maxCodeBytes, 64 * 1024);
	assert.equal(LIMITS.defaultTimeoutSeconds, 30);
	assert.equal(LIMITS.maxTimeoutSeconds, 120);
	assert.equal(LIMITS.startupTimeoutMs, 10_000);
	assert.equal(LIMITS.cleanupTimeoutMs, 5_000);
	assert.equal(LIMITS.outputBudgetBytes, 1024 * 1024);
	assert.equal(LIMITS.maxReprBytes, 8 * 1024);
	assert.equal(LIMITS.maxFrameBytes, 128 * 1024);
	assert.equal(LIMITS.rlimitAsBytes, 512 * 1024 * 1024);
	assert.equal(LIMITS.rlimitFsizeBytes, 16 * 1024 * 1024);
	assert.equal(LIMITS.rlimitNofile, 128);
	assert.ok(FAILURE_STATUSES.has("timeout"));
	assert.ok(!FAILURE_STATUSES.has("ok"));
	console.log("  ✓ centralized limits match the documented defaults");
}

const tests = [
	testRegistrationHasNoSideEffects,
	testSchemaValidation,
	testErrorMarking,
	testDecodeFrame,
	testFrameStream,
	testEncodeRequest,
	testBoundHelpers,
	testControllerStatics,
	testWorkspaceMountFlag,
	testFilterMountableReadRoots,
	testReadRootBinds,
	testPermissionModeEvent,
	testLimits,
];

let failed = 0;
for (const t of tests) {
	try {
		await t();
	} catch (err) {
		failed++;
		console.error(`  ✗ ${t.name}:`, err);
	}
}
if (failed > 0) {
	console.error(`\n${failed} unit test(s) failed`);
	process.exit(1);
}
console.log("\nAll python unit tests passed.");
