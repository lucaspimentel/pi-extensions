/**
 * Guard child startup gate (guard step 5).
 *
 * The subagent extension passes this file to a dispatched child with
 * --extension, together with the PI_GUARD_INHERIT contract. The child's guard
 * parses the same variable once per process and installs the inherited
 * profile as an immutable restriction; this gate refuses to let the child run
 * any delegated model or tool execution unless that guard proves, over the
 * synchronous guard:child-contract-request/ack handshake, that it consumed
 * the exact contract (version, nonce, profile) with the restriction installed
 * and an available runtime.
 *
 * Refusal is fatal on purpose: pi catches handler errors and continues, and
 * the installed print-mode setup supplies no shutdown handler, so a refusal
 * writes one bounded stderr line and exits nonzero before the first delegated
 * request. Stdout stays reserved for pi's JSON events. Never load this file
 * in an ordinary parent session: the fatal path must only ever run in a
 * dedicated child.
 *
 * Limits: trusted extensions run with host privileges, so this gate is a
 * liveness and correctness check for the guard handshake, not a defense
 * against malicious extensions or arbitrary child processes.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INHERIT_ENV, parseInheritance, type InheritanceContract } from "../guard/policy/inheritance.ts";
import { requestChildContract } from "./guard-snapshot.ts";

/** Deliberate child-only fatal path: bounded stderr, nonzero exit, no stdout. */
function failChild(reason: string): never {
	try { fs.writeSync(2, `guard subagent startup gate: ${reason}\n`); } catch { /* stderr is best effort */ }
	process.exit(1);
}

export default function guardChildGate(pi: ExtensionAPI) {
	const parsed = parseInheritance(process.env[INHERIT_ENV]);
	if (!parsed.ok) {
		// Absent: ordinary session, no gate. Present but invalid: fail closed
		// before any delegated execution; never fall back to an unguarded run.
		if (!parsed.present) return;
		failChild(`invalid ${INHERIT_ENV}: ${parsed.reason}`);
	}
	const contract: InheritanceContract = parsed.contract;
	let proven = false;
	const resetProof = () => { proven = false; };

	// Session replacement invalidates readiness from an old session.
	pi.on("session_start", resetProof);
	pi.on("session_tree", resetProof);

	// Block tool calls while startup proof is unavailable (commands and
	// extension-initiated calls that precede the first agent run).
	pi.on("tool_call", async () => {
		if (proven) return undefined;
		return { block: true, reason: "guard startup gate: proof pending; tool calls are blocked until the child guard acknowledges the inheritance contract" };
	});

	// Runs before the first delegated model request, after session
	// initialization; revalidated on every run rather than cached.
	pi.on("before_agent_start", () => {
		const outcome = requestChildContract(pi.events, contract);
		if (!outcome.ok) failChild(outcome.reason);
		proven = true;
		return undefined;
	});
}
