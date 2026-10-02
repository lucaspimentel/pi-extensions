// run: node test-ask-lock.mjs
//
// Tests for createAskLock (rules.ts), the shared mutex that serializes the
// extension's permission dialogs (the tool_call ask section and the python
// read-permission prompt). pi's TUI keeps at most one extension dialog alive;
// a second concurrent ctx.ui.select orphans the first, whose promise never
// settles and hangs the tool call. The lock guarantees only one dialog body
// runs at a time, and that a rejected/aborted dialog cannot poison the queue
// for later dialogs.

import assert from "node:assert/strict";
import { createAskLock } from "./test-helpers.mjs";

let pass = 0, fail = 0;

function test(desc, actual, expected) {
	const ok = actual === expected;
	console.log((ok ? "  ✓" : "  ✗") + " " + desc);
	if (!ok) {
		console.log(`      got:      ${JSON.stringify(actual)}`);
		console.log(`      expected:  ${JSON.stringify(expected)}`);
	}
	ok ? pass++ : fail++;
}

function section(name) {
	console.log(`\n── ${name} ${"─".repeat(Math.max(0, 50 - name.length))}`);
}

function summary() {
	console.log(`\n  ${pass} passed, ${fail} failed`);
	return fail;
}

/** Deferred promise: externally resolvable/rejectable. */
function deferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

section("serialization");

// Two locked runs started back to back: run #2 must not start until run #1's
// promise resolves, even though both were invoked synchronously in the same
// tick (the concurrent-ask repro: parallel MCP calls with no allow rules).
{
	const lock = createAskLock();
	const gate = deferred();
	const order = [];
	let started2 = false;

	const p1 = lock(async () => {
		order.push("start1");
		await gate.promise;
		order.push("end1");
		return "one";
	});
	const p2 = lock(async () => {
		started2 = true;
		order.push("start2");
		return "two";
	});

	await tick();
	test("run #2 does not start while run #1 is pending", started2, false);
	gate.resolve();
	test("run #1 result propagates to its caller", await p1, "one");
	test("run #2 result propagates to its caller", await p2, "two");
	test("run #2 started only after run #1 finished", order.join(","), "start1,end1,start2");
}

section("chain survives rejection and abort");

// A rejected run must propagate to its own caller AND leave the lock usable:
// the next queued dialog must still run (a failed dialog must never wedge the
// extension into a state where no future permission can be answered).
{
	const lock = createAskLock();
	const boom = new Error("dialog failed");
	const p1 = lock(async () => { throw boom; });
	const p2 = lock(async () => "recovered");

	let caught;
	try { await p1; } catch (e) { caught = e; }
	test("rejection propagates to run #1's caller", caught, boom);
	test("run #2 still executes after run #1 rejected", await p2, "recovered");

	// Same with an aborted run (AbortSignal.throwIfAborted inside the body,
	// mirroring a dialog interrupted by an already-fired abort).
	const controller = new AbortController();
	controller.abort();
	const p3 = lock(async () => {
		controller.signal.throwIfAborted();
		return "never";
	});
	const p4 = lock(async () => "after-abort");
	let abortErr;
	try { await p3; } catch (e) { abortErr = e; }
	test("abort surfaces as AbortError to run #3's caller", abortErr?.name, "AbortError");
	test("run #4 still executes after run #3 aborted", await p4, "after-abort");
}

section("value and rejection propagation");

{
	const lock = createAskLock();
	test("resolves with the inner value", await lock(async () => 42), 42);
	test("inner object identity preserved", await lock(async () => undefined), undefined);

	// A synchronous-looking resolve (already-settled chain) must not deadlock:
	// two back-to-back immediately-resolving runs both complete.
	const a = lock(async () => "a");
	const b = lock(async () => "b");
	test("back-to-back immediate runs both complete", `${await a}/${await b}`, "a/b");
}

process.exit(summary() === 0 ? 0 : 1);
