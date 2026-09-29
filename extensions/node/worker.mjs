// Persistent Node.js worker for the pi "node" tool.
//
// Runs inside a bubblewrap sandbox as one long-lived process that owns a single
// vm execution context. Protocol: line-delimited JSON (mirrors worker.py).
//
//     requests  (fd 0, parent -> worker): {"type":"exec","protocol":1,"id":N,"code":"..."}
//     responses (fd 3, worker -> parent): {"type":"ready"|"result"|"error",...}
//
// Environment installed here, before any user code runs:
//
// * The process is launched through /usr/bin/prlimit by the parent (the node
//   worker cannot set its own rlimits): RLIMIT_AS 2 GiB, RLIMIT_FSIZE 16 MiB,
//   RLIMIT_NOFILE 128, RLIMIT_CORE 0, inherited by subprocesses. Per-process
//   limits, not aggregate quotas. The JS heap is capped separately via
//   --max-old-space-size on the worker's command line.
// * fd layout matches worker.py: fd 0 carries protocol requests, fd 1/2 are
//   plain pipes the parent captures (console.log cannot touch the protocol
//   channel), fd 3 is the dedicated response channel. Unlike worker.py there
//   is no /dev/null detach: reopening fd 0 through /proc/self/fd fails with
//   ENXIO on child_process pipes, so fd 0 is read directly. User code has no
//   path to fd 0 without first escaping the vm context (see below).
// * No seccomp policy: node has no stdlib FFI to load libseccomp. External
//   network is blocked by the network namespace; the mount policy never
//   mounts host Unix-domain sockets. This is weaker than the python worker,
//   which blocks socket() outright; a Unix socket inside the mounted project
//   or read roots is connectable. Documented in the extension README.
//
// The vm module is convenience, NOT a security boundary: host-realm objects
// injected into the context (console, timers, require) enable full escapes.
// The isolation boundary is bubblewrap, exactly like the python worker.
//
// Execution semantics:
// * State (global object and global lexical environment: var/let/const/
//   function/class) persists across executions. Execution is not transactional:
//   mutations before an error remain.
// * The completion value of the script is the "final expression" result,
//   returned bounded via util.inspect (undefined is not shown).
// * On timeout, cancellation, output overflow, worker death, or protocol
//   failure the parent kills the entire sandbox; state is lost and the next
//   execution starts a fresh worker. Code is never replayed automatically.
// * No top-level await: wrapping in an async function would lose persistence.
// * No dynamic import(): vm scripts have no importModuleDynamically callback.
//   require IS available (built via createRequire("/workspace/")) so user code
//   has file I/O and can load builtins and project modules, like python's
//   stdlib.

import * as fs from "node:fs";
import * as readline from "node:readline";
import * as vm from "node:vm";
import * as util from "node:util";
import { createRequire } from "node:module";

const PROTOCOL_VERSION = 1;
const RESPONSE_FD = 3;
const MAX_FRAME_BYTES = 128 * 1024;
const MAX_MESSAGE_CHARS = 8192;
const MAX_EXCEPTION_TYPE_CHARS = 128;

// Syscall-level hardening is not available (see header); these limits are
// applied by the parent's prlimit wrapper. Kept here as documentation only.

function sendFrame(payload) {
	fs.writeSync(RESPONSE_FD, JSON.stringify(payload) + "\n");
}

function sendError(message, requestId = null) {
	sendFrame({
		type: "error",
		protocol: PROTOCOL_VERSION,
		id: requestId,
		message: message.slice(0, MAX_MESSAGE_CHARS),
	});
}

function boundedHead(text, limit) {
	if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
	return { text: Buffer.from(text, "utf8").subarray(0, limit).toString("utf8") + "...[truncated]", truncated: true };
}

function boundedTail(text, limit) {
	if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
	let cut = text;
	while (cut.length > 0 && Buffer.byteLength(cut, "utf8") > limit) cut = cut.slice(1);
	return { text: "...[truncated]\n" + cut, truncated: true };
}

/**
 * Keep the header and the user-script frames of a stack; drop worker-internal
 * frames (readline, vm internals, this file). Only applies when the stack
 * actually contains user frames ("<node>" script frames), so exotic errors
 * from host-realm boundaries keep their full, bounded stack.
 */
function trimStack(stack) {
	const lines = stack.split("\n");
	const hasUserFrames = lines.some((line, i) => i > 0 && line.includes("<node>") && line.trim().startsWith("at "));
	if (!hasUserFrames) return stack;
	return lines
		.filter((line, i) => i === 0 || (line.includes("<node>") && line.trim().startsWith("at ")) || !line.trim().startsWith("at "))
		.join("\n");
}

function formatException(err) {
	const type = String((err && (err.name || (err.constructor && err.constructor.name))) || "Error").slice(0, MAX_EXCEPTION_TYPE_CHARS);
	const message = err && err.message !== undefined ? String(err.message) : String(err);
	const boundedMessage = boundedHead(message, MAX_MESSAGE_CHARS);
	const stack = err && typeof err.stack === "string" ? err.stack : `${type}: ${boundedMessage.text}`;
	const boundedTraceback = boundedTail(trimStack(stack), 16 * 1024);
	return {
		type,
		message: boundedMessage.text,
		traceback: boundedTraceback.text,
		tracebackTruncated: boundedTraceback.truncated,
	};
}

function reprOf(value, reprLimit) {
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
		text = `<inspect failed: ${err && err.name ? err.name : "?"}>`;
	}
	const bounded = boundedHead(text, reprLimit);
	return { repr: bounded.text, reprTruncated: bounded.truncated };
}

// Keep the worker alive across unhandled async failures from user code,
// mirroring worker.py's "worker stays alive" semantics. Surface them on
// stderr so the parent's capture shows them.
process.on("unhandledRejection", (reason) => {
	try {
		const e = formatException(reason);
		fs.writeSync(2, `unhandled rejection: ${e.type}: ${e.message}\n`);
	} catch {
		/* fd 2 may be gone; nothing sensible to do */
	}
});
process.on("uncaughtException", (err) => {
	try {
		const e = formatException(err);
		fs.writeSync(2, `uncaught exception (worker survives): ${e.type}: ${e.message}\n`);
	} catch {
		/* ditto */
	}
});

// The execution namespace. An empty vm context has NO globals at all; inject
// the useful set. `process` is a shim: user code must not be able to exit the
// worker (node cannot intercept a real process.exit the way worker.py catches
// SystemExit). `require` resolves against /workspace so user code can load
// node builtins and project modules; the sandbox mounts remain the read
// boundary (requires outside the mounts fail with the kernel's own error).
const sandbox = {
	console, // real console: console.log goes to fd 1, which the parent captures
	require: createRequire("/workspace/"),
	process: {
		platform: process.platform,
		arch: process.arch,
		version: process.version,
		env: {},
		cwd: () => process.cwd(),
		exit: () => {
			throw new Error("process.exit is disabled in the sandbox; context state is preserved");
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
			const close = stat.lastIndexOf(")");
			const state = stat.slice(close + 2, close + 3);
			if (state !== "Z") count++;
		} catch {
			/* raced with exit */
		}
	}
	return count;
}

function executeCode(code, reprLimit) {
	// Run user code. Returns a result-frame payload (no type/id fields).
	// Not transactional: state mutated before an exception stays mutated. The
	// context and its state survive ordinary JavaScript errors.
	//
	// No vm timeout option: a per-exec vm timeout is enforced parent-side by
	// killing the sandbox (same as worker.py), and the completion value (the
	// final-expression result) is only available from a plain script
	// evaluation.
	let value;
	try {
		value = vm.runInContext(code, context, { filename: "<node>" });
	} catch (err) {
		return {
			status: "runtime_error",
			repr: null,
			reprTruncated: false,
			exception: formatException(err),
			sandboxProcesses: countLiveOthers(),
		};
	}
	const { repr, reprTruncated } = reprOf(value, reprLimit);
	return {
		status: "ok",
		repr,
		reprTruncated,
		exception: null,
		sandboxProcesses: countLiveOthers(),
	};
}

function main() {
	let reprLimit = 8192;
	const parsedLimit = Number.parseInt(process.argv[2] ?? "", 10);
	if (Number.isFinite(parsedLimit)) {
		reprLimit = Math.max(64, Math.min(parsedLimit, 1024 * 1024));
	}

	// Requests are read from fd 0 asynchronously (the event loop must stay
	// live between requests so timers and microtasks scheduled by user code
	// keep running). No /dev/null detach: see the fd-layout note in the header.
	const lines = readline.createInterface({
		input: fs.createReadStream(null, { fd: 0 }),
		crlfDelay: Infinity,
	});

	sendFrame({
		type: "ready",
		protocol: PROTOCOL_VERSION,
		runtimeVersion: `${process.versions.node}`,
	});

	lines.on("line", (line) => {
		if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
			sendError("request frame over limit; discarded");
			return;
		}
		let request;
		try {
			request = JSON.parse(line);
		} catch {
			sendError("request frame is not valid JSON");
			return;
		}
		if (request === null || typeof request !== "object" || Array.isArray(request)) {
			sendError("request frame is not a JSON object");
			return;
		}
		if (request.protocol !== PROTOCOL_VERSION) {
			sendError("unsupported protocol version");
			return;
		}
		if (request.type !== "exec" || !Number.isInteger(request.id) || request.id < 0 || typeof request.code !== "string") {
			sendError("unsupported request type or invalid id/code");
			return;
		}
		let payload;
		try {
			payload = executeCode(request.code, reprLimit);
		} catch (err) {
			// Defensive: report, keep the worker alive.
			payload = {
				status: "runtime_error",
				repr: null,
				reprTruncated: false,
				exception: {
					type: err && err.name ? String(err.name).slice(0, MAX_EXCEPTION_TYPE_CHARS) : "Error",
					message: boundedHead(`worker-level failure: ${err && err.message ? err.message : String(err)}`, MAX_MESSAGE_CHARS).text,
					traceback: "",
					tracebackTruncated: false,
				},
				sandboxProcesses: 0,
			};
		}
		sendFrame({
			type: "result",
			protocol: PROTOCOL_VERSION,
			id: request.id,
			...payload,
		});
	});
	lines.on("close", () => process.exit(0));
}

main();
