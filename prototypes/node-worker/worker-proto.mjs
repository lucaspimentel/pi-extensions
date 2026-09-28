// PROTOTYPE, throwaway: validates the vm-context approach for a node.js
// equivalent of extensions/python/worker.py. Not for production; see
// harness-proto.mjs for the experiment suite.
//
// Protocol mirrors the python worker: line-delimited JSON, requests on fd 0,
// responses on fd 3. User output goes to fd 1/2 (captured by the parent);
// the protocol channel is separate.
//
// Key ideas under test:
// 1. Persistent state across executions via one vm.createContext; scripts
//    share its global object AND its global lexical environment (let/const/
//    class survive across scripts in the same context).
// 2. Final-expression repr via script COMPLETION VALUES: vm.runInContext
//    returns the completion value of the script, so a trailing expression
//    statement's value falls out for free, with no AST parser.
// 3. Event loop must stay live between requests (async fd-0 reading), so
//    timers/microtasks scheduled by user code still run.
// 4. Security note: the vm module is convenience, NOT a security boundary
//    (host-realm objects injected into the context enable full escapes, e.g.
//    console.log.constructor("return process")()). The boundary is bwrap;
//    same threat model as the python worker.

import fs from "node:fs";
import readline from "node:readline";
import vm from "node:vm";
import util from "node:util";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 128 * 1024;
const MAX_MESSAGE_CHARS = 8192;
const MAX_REPR_BYTES = 8192;
const MAX_TRACEBACK_BYTES = 16 * 1024;

function boundHead(text, maxBytes) {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	const buf = Buffer.from(text, "utf8");
	return { text: buf.subarray(0, maxBytes).toString("utf8") + "...[truncated]", truncated: true };
}

function boundTail(text, maxBytes) {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	let cut = text;
	while (cut.length > 0 && Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(1);
	return { text: "...[truncated]\n" + cut, truncated: true };
}

function send(frame) {
	fs.writeSync(3, JSON.stringify(frame) + "\n");
}

function formatException(err) {
	const type = (err && (err.name || err.constructor?.name)) || "Error";
	const message = err && err.message !== undefined ? String(err.message) : String(err);
	const bounded = boundTail(String(err?.stack ?? `${type}: ${message}`), MAX_TRACEBACK_BYTES);
	return {
		type: type.slice(0, 128),
		message: boundHead(message, MAX_MESSAGE_CHARS).text,
		traceback: bounded.text,
		tracebackTruncated: bounded.truncated,
	};
}

function reprOf(value) {
	if (value === undefined) return { repr: null, reprTruncated: false };
	let text;
	try {
		text = util.inspect(value, {
			depth: 2,
			maxArrayLength: 100,
			maxStringLength: 1024,
			breakLength: 80,
			showProxy: false,
		});
	} catch (err) {
		text = `<inspect failed: ${err?.name ?? "?"}>`;
	}
	const bounded = boundHead(text, MAX_REPR_BYTES);
	return { repr: bounded.text, reprTruncated: bounded.truncated };
}

// Keep the worker alive across unhandled async failures from user code,
// mirroring worker.py's "worker stays alive" semantics. Surface them on
// stderr so the parent's capture shows them.
process.on("unhandledRejection", (reason) => {
	try {
		fs.writeSync(2, `unhandled rejection: ${formatException(reason).type}: ${formatException(reason).message}\n`);
	} catch {
		/* fd 2 may be gone; nothing sensible to do */
	}
});
process.on("uncaughtException", (err) => {
	try {
		fs.writeSync(2, `uncaught exception (worker survives): ${formatException(err).type}: ${formatException(err).message}\n`);
	} catch {
		/* ditto */
	}
});

// PROTOTYPE finding: worker.py's dup-fd-0-then-/dev/null detach does not port:
// open('/proc/self/fd/0') fails with ENXIO when fd 0 is a child_process pipe
// (it works for shell pipes). Since user code in the vm context has no path to
// fd 0 without a full vm (host-realm) escape, we read fd 0 directly. Caveat vs
// python: subprocesses spawned by user code inherit fd 0 and could consume
// protocol frames, but spawning subprocesses already requires escaping the vm
// context (no require/import inside), so the exposure is not new.
const requestFd = 0;

// The execution namespace. An empty context has NO globals at all; inject the
// usual set. `process` is a shim: user code must not be able to exit the
// worker (node has no way to intercept a real process.exit).
const sandbox = {
	console, // real console: console.log goes to fd 1, which the parent captures
	process: {
		platform: process.platform,
		arch: process.arch,
		version: process.version,
		env: {},
		cwd: () => process.cwd(),
		exit: () => {
			throw new Error("process.exit is disabled in the sandbox; state is preserved");
		},
	},
	setTimeout,
	setInterval,
	setImmediate,
	clearTimeout,
	clearInterval,
	clearImmediate,
	queueMicrotask,
	structuredClone,
	Buffer,
	URL,
	TextEncoder,
	TextDecoder,
};
const context = vm.createContext(sandbox);

function countLiveOthers() {
	let count = 0;
	let entries;
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === 1 || pid === process.pid) continue;
		try {
			const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
			const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
			if (state !== "Z") count++;
		} catch {
			/* raced with exit */
		}
	}
	return count;
}

function executeCode(code) {
	// Not transactional: state mutated before a throw stays mutated (same as
	// python). Completion value of the whole script = final expression value.
	let value;
	// No vm timeout option: a per-exec vm timeout cannot interrupt synchronous
// work anyway without a resolvable deadline, and the parent enforces the wall
// clock by killing the sandbox (same as worker.py).
	try {
		value = vm.runInContext(code, context, { filename: "<node>" });
	} catch (err) {
		return {
			status: "node_error",
			repr: null,
			reprTruncated: false,
			exception: formatException(err),
			sandboxProcesses: countLiveOthers(),
		};
	}
	const { repr, reprTruncated } = reprOf(value);
	return { status: "ok", repr, reprTruncated, exception: null, sandboxProcesses: countLiveOthers() };
}

send({ type: "ready", protocol: PROTOCOL_VERSION, nodeVersion: process.version });

const lines = readline.createInterface({
	input: fs.createReadStream(null, { fd: requestFd }),
	crlfDelay: Infinity,
});
lines.on("line", (line) => {
	if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
		send({ type: "error", protocol: PROTOCOL_VERSION, id: null, message: "request frame over limit; discarded" });
		return;
	}
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		send({ type: "error", protocol: PROTOCOL_VERSION, id: null, message: "request frame is not valid JSON" });
		return;
	}
	if (request === null || typeof request !== "object" || Array.isArray(request)) {
		send({ type: "error", protocol: PROTOCOL_VERSION, id: null, message: "request frame is not a JSON object" });
		return;
	}
	if (request.protocol !== PROTOCOL_VERSION) {
		send({ type: "error", protocol: PROTOCOL_VERSION, id: null, message: "unsupported protocol version" });
		return;
	}
	if (request.type !== "exec" || !Number.isInteger(request.id) || typeof request.code !== "string") {
		send({ type: "error", protocol: PROTOCOL_VERSION, id: null, message: "unsupported request type or invalid id/code" });
		return;
	}
	const payload = executeCode(request.code);
	send({ type: "result", protocol: PROTOCOL_VERSION, id: request.id, ...payload });
});
lines.on("close", () => process.exit(0));
