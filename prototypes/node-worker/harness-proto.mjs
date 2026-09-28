// PROTOTYPE, throwaway: experiment suite for the node.js worker prototype.
// Run: node prototypes/node-worker/harness-proto.mjs [--bwrap]
// Validates: vm completion values, context persistence, fd-3 frame protocol,
// output capture via fd 1, error survival, process.exit containment, timeout
// kill + restart, and (with --bwrap) the worker under a bubblewrap sandbox.

import { spawn } from "node:child_process";
import fs from "node:fs";
import vm from "node:vm";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker-proto.mjs");

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
	if (cond) {
		pass++;
		console.log(`  PASS ${name}${detail ? ` :: ${detail}` : ""}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
console.log("== A. in-process vm experiments: completion values & persistence ==");
{
	const ctx = vm.createContext({ boot: 1 });
	const run = (code) => vm.runInContext(code, ctx, { filename: "<probe>" });

	check("trailing expression", run("1 + 1") === 2, String(run("40 + 2")));
	check("var decl completion", run("var a = 5") === undefined || run("var a = 5") === 5, String(run("var z = 5")));
	check("function decl completion", run("function f() {}") === undefined, String(run("function g() {}")));
	check("class decl completion", run("class C {}") === undefined, String(run("class D {}")));
	check("if block value", String(run("if (true) { 42 }")), "expect 42?");
	check("block value", String(run("{ const q = 1; q + 1 }")), "expect 2?");
	check("loop completion", String(run("let acc = 0; for (const i of [1, 2, 3]) { acc = i }")), "expect 3?");
	check("try value", String(run("try { 7 } catch (e) { 8 }")), "expect 7?");
	check("template value", String(run("`t${1 + 1}`")), "expect t2");
	check("void value", String(run("void 0")), "expect undefined");
	run("let lexical = 7");
	check("let persists across scripts", run("lexical") === 7, String(run("lexical")));
	run("function dbl(x) { return x * 2 }");
	check("function persists across scripts", run("dbl(21)") === 42, String(run("dbl(21)")));
	run("class Point { constructor(x) { this.x = x } }");
	check("class persists across scripts", run("new Point(3).x") === 3);
	// not transactional (same as python):
	run("h = 1");
	try {
		run("h = 2; throw new Error('x'); h = 3");
	} catch {
		/* expected */
	}
	check("state before throw stays mutated", run("h") === 2, String(run("h")));
}

// ---------------------------------------------------------------------------
console.log("== B. spawned worker: protocol, persistence, output, errors ==");
const out1 = [];
const w1 = spawnWorker(out1);
await waitReady(w1);

const r1 = await exec(w1, 1, "1 + 1");
check("1+1 -> repr '2'", r1.status === "ok" && r1.repr === "2", JSON.stringify(r1.repr));

const r2 = await exec(w1, 2, "let total = 0; for (let i = 1; i <= 5; i++) total += i; total");
check("loop snippet -> '15'", r2.status === "ok" && r2.repr === "15", JSON.stringify(r2.repr));

const r3 = await exec(w1, 3, "total");
check("var persists across requests", r3.repr === "15", JSON.stringify(r3.repr));

const r4 = await exec(w1, 4, "function double(x) { return x * 2 }");
check("decl -> repr null", r4.status === "ok" && r4.repr === null, JSON.stringify(r4.repr));

const r5 = await exec(w1, 5, "double(total)");
check("function persists -> '30'", r5.repr === "30", JSON.stringify(r5.repr));

const r6 = await exec(w1, 6, "JSON.stringify({ a: [1, 2, 3] })");
check("JSON.stringify -> quoted string", r6.repr === "'{\"a\":[1,2,3]}'", JSON.stringify(r6.repr));

const before = out1.length;
const r7 = await exec(w1, 7, 'console.log("hello from user code"); "after-log"');
const captured = out1.slice(before).join("");
check("console.log reaches fd 1", captured.includes("hello from user code"), JSON.stringify(captured));
check("result repr after logging", r7.repr === "'after-log'", JSON.stringify(r7.repr));

const r8 = await exec(w1, 8, 'throw new TypeError("boom")');
check(
	"throw -> node_error TypeError",
	r8.status === "node_error" && r8.exception?.type === "TypeError" && r8.exception.message === "boom",
	JSON.stringify(r8.exception),
);

const r9 = await exec(w1, 9, "({}).x.y");
check("TypeError from property access", r9.status === "node_error" && r9.exception?.type === "TypeError", JSON.stringify(r9.exception?.type));

const r10 = await exec(w1, 10, "total");
check("state survives an exception", r10.status === "ok" && r10.repr === "15", JSON.stringify(r10.repr));

const r11 = await exec(w1, 11, 'setTimeout(() => console.log("trailing-output"), 25), "done"');
check("async schedule returns immediately", r11.status === "ok" && r11.repr === "'done'", JSON.stringify(r11.repr));
await sleep(150);
const allOut = out1.join("");
check("trailing async output still captured", allOut.includes("trailing-output"), JSON.stringify(allOut.slice(-60)));

const r12 = await exec(w1, 12, "process.exit()");
check("process.exit shim throws, worker alive", r12.status === "node_error" && r12.exception.message.includes("disabled"), JSON.stringify(r12.exception?.message));
const r12b = await exec(w1, 13, "total");
check("worker alive after exit attempt", r12b.status === "ok" && r12b.repr === "15");

const r13 = await exec(w1, 14, "Promise.reject(new Error('late rejection')); 'scheduled'");
check("rejection scheduled, result ok", r13.status === "ok" && r13.repr === "'scheduled'", JSON.stringify(r13.repr));
await sleep(100);
const r13b = await exec(w1, 15, "total");
check("worker survives unhandled rejection", r13b.status === "ok" && r13b.repr === "15");
check("rejection surfaced on stderr", w1.stderr.join("").includes("unhandled rejection"), JSON.stringify(w1.stderr.join("").slice(-120)));

const r14 = await exec(w1, 16, "def f(): pass");
check("syntax error reported", r14.status === "node_error" && r14.exception?.type === "SyntaxError", JSON.stringify(r14.exception?.type));

const r15 = await exec(w1, 17, "Array.from({ length: 60 }, () => Array.from({ length: 60 }, () => 'x'.repeat(90)))");
check("big repr bounded + truncated", r15.repr.length <= 8192 + 20 && r15.reprTruncated === true, `len=${r15.repr.length} truncated=${r15.reprTruncated}`);

// This request hangs the worker's event loop; the parent timeout must kill it.
const r16 = exec(w1, 18, "while (true) {}");
const killed = await raceKill(w1, r16, 1500);
check("sync infinite loop -> parent kill", killed, "timeout kill fired");

console.log("== C. fresh worker after kill: state gone ==");
const out2 = [];
const w2 = spawnWorker(out2);
await waitReady(w2);
const r17 = await exec(w2, 1, "typeof total");
check("fresh worker has no old state", r17.status === "ok" && r17.repr === "'undefined'", JSON.stringify(r17.repr));
w2.child.kill();

// ---------------------------------------------------------------------------
if (process.argv.includes("--bwrap")) {
	console.log("== D. worker under bubblewrap ==");
	// PROTOTYPE finding: brew-installed node is a symlink chain into
	// /home/linuxbrew/Cellar/... and links shared libs from
	// /home/linuxbrew/opt/*, so the interpreter recipe differs from
	// system python: bind the brew root (or the resolved interpreter dir for
	// system installs). sandbox.ts's interpreter-binding logic will need this.
	const realNode = fs.realpathSync(process.execPath);
	const binds = ["--ro-bind", "/usr", "/usr"];
	if (realNode.startsWith("/home/linuxbrew/")) {
		binds.push("--ro-bind", "/home/linuxbrew", "/home/linuxbrew");
	} else {
		const dir = path.dirname(realNode);
		binds.push("--ro-bind", dir, dir);
	}
	const args = [
		"--unshare-all",
		"--die-with-parent",
		...binds,
		"--symlink", "usr/lib", "/lib",
		"--symlink", "usr/lib64", "/lib64",
		"--symlink", "usr/bin", "/bin",
		"--symlink", "usr/sbin", "/sbin",
		"--proc", "/proc",
		"--dev", "/dev",
		"--tmpfs", "/tmp",
		// mount the worker file 1:1, like sandbox.ts does for worker.py
		"--ro-bind", workerPath, workerPath,
		"--", realNode, workerPath,
	];
	const out3 = [];
	const w3 = spawnWorker(out3, ["bwrap", ...args]);
	try {
		await waitReady(w3, 10_000);
		const rb1 = await exec(w3, 1, "1 + 1");
		check("bwrap: exec works", rb1.status === "ok" && rb1.repr === "2", JSON.stringify(rb1));
		const rb2 = await exec(w3, 2, "console.log('in-sandbox'); 'ok'");
		check("bwrap: console output captured", out3.join("").includes("in-sandbox"), JSON.stringify(out3.join("")));
		const rb3 = await exec(w3, 3, "typeof require === 'undefined' ? 'no-require-global' : 'has-require'");
		check("bwrap: no require global in vm context", rb3.status === "ok" && rb3.repr === "'no-require-global'", JSON.stringify(rb3));
		const rb4 = await exec(w3, 4, "JSON.stringify(Array.from({length: 1e6}, (_, i) => i)).length");
		check("bwrap: cpu work runs", rb4.status === "ok", JSON.stringify(rb4.exception ?? rb4.repr));
	} finally {
		w3.child.kill();
	}
}

// ---------------------------------------------------------------------------
console.log(`\nVERDICT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// --- harness helpers --------------------------------------------------------

function spawnWorker(sink, command = null) {
	const child = command
		? spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe", "pipe"] })
		: spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
	const responses = [];
	let lineBuf = "";
	child.stdio[3].setEncoding("utf8");
	child.stdio[3].on("data", (chunk) => {
		lineBuf += chunk;
		for (;;) {
			const nl = lineBuf.indexOf("\n");
			if (nl === -1) break;
			const line = lineBuf.slice(0, nl);
			lineBuf = lineBuf.slice(nl + 1);
			if (line) responses.push(JSON.parse(line));
		}
	});
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (c) => sink.push(c));
	child.stderr.setEncoding("utf8");
	const stderr = [];
	child.stderr.on("data", (c) => stderr.push(c));
	return { child, responses, stderr };
}

async function waitReady(w, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (w.responses.some((f) => f.type === "ready")) return;
		if (w.child.exitCode !== null) throw new Error(`worker exited early: ${w.child.exitCode}`);
		await sleep(20);
	}
	throw new Error("worker never sent ready");
}

function exec(w, id, code) {
	return new Promise((resolve, reject) => {
		w.child.stdio[0].write(JSON.stringify({ type: "exec", protocol: 1, id, code }) + "\n");
		const timeout = setTimeout(() => {
			clearInterval(poll);
			reject(new Error(`exec ${id} timed out (worker hung)`));
		}, 10_000);
		const poll = setInterval(() => {
			const frame = w.responses.find((f) => f.type === "result" && f.id === id);
			if (frame) {
				clearTimeout(timeout);
				clearInterval(poll);
				resolve(frame);
			}
		}, 10);
		setTimeout(() => {
			clearInterval(poll);
			reject(new Error(`exec ${id} timed out (worker hung)`));
		}, 10_000);
	});
}

// Race an exec against a hard kill; returns true if the kill was needed.
function raceKill(w, execPromise, ms) {
	return new Promise((resolve) => {
		let done = false;
		execPromise.then(
			() => {
				if (!done) {
					done = true;
					resolve(false);
				}
			},
			() => {
				if (!done) {
					done = true;
					resolve(false);
				}
			},
		);
		setTimeout(() => {
			if (!done) {
				done = true;
				w.child.kill("SIGKILL");
				resolve(true);
			}
		}, ms);
	});
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
