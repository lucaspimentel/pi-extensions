/**
 * Synchronous event-bus queries for guard's step-5 subagent handshake.
 *
 * The installed event bus invokes a synchronous handler inline (its async
 * wrapper runs until the first await), so a guard responder that acks before
 * yielding answers during the emit below. This module therefore subscribes
 * before emitting, accepts only the matching validated response, unsubscribes
 * in finally, and refuses absent, malformed, contradictory, or non-synchronous
 * responses. Never reuse the asynchronous research-transition acknowledgment
 * protocol here.
 *
 * Pure bus plumbing: no process.env access and no guard imports beyond the
 * profile type guard, so the child bootstrap keeps a small dependency surface.
 */

import { randomUUID } from "node:crypto";
import { isProfile, type Profile } from "../guard/policy/profiles.ts";

/** Structural event-bus subset; keeps the bootstrap free of runtime imports. */
interface QueryBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export const SUBAGENT_SNAPSHOT_REQUEST = "guard:subagent-snapshot-request";
export const SUBAGENT_SNAPSHOT_ACK = "guard:subagent-snapshot-ack";
export const CHILD_CONTRACT_REQUEST = "guard:child-contract-request";
export const CHILD_CONTRACT_ACK = "guard:child-contract-ack";

export type GuardSnapshot = { ok: true; profile: Profile } | { ok: false; reason: string };

export type ContractProof = { ok: true } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ask the parent guard for the effective profile snapshot. Must be called
 * synchronously, immediately before spawn, with no await in between.
 */
export function queryGuardSnapshot(events: QueryBus, cwd: string): GuardSnapshot {
	const id = randomUUID();
	let ack: unknown;
	let seen = false;
	const off = events.on(SUBAGENT_SNAPSHOT_ACK, (data: unknown) => {
		if (seen) return;
		if (isRecord(data) && data.id === id) {
			seen = true;
			ack = data;
		}
	});
	try {
		events.emit(SUBAGENT_SNAPSHOT_REQUEST, { version: 1, id, cwd });
	} finally {
		off();
	}
	if (!seen || !isRecord(ack)) {
		return { ok: false, reason: "no synchronous guard snapshot response; the guard is absent, uninitialized, or not synchronous" };
	}
	if (ack.version !== 1) {
		return { ok: false, reason: `unsupported guard snapshot response version ${JSON.stringify(ack.version)}` };
	}
	if (ack.ok === true && isProfile(ack.profile)) return { ok: true, profile: ack.profile };
	if (ack.ok === false && typeof ack.reason === "string" && ack.reason) return { ok: false, reason: ack.reason };
	return { ok: false, reason: "malformed guard snapshot response" };
}

/**
 * Child side: ask the child's guard to prove it consumed the exact
 * inheritance contract. Runs at the child's first agent start, before any
 * delegated model or tool execution.
 */
export function requestChildContract(
	events: QueryBus,
	contract: { version: number; profile: Profile; nonce: string },
): ContractProof {
	let ack: unknown;
	let seen = false;
	const off = events.on(CHILD_CONTRACT_ACK, (data: unknown) => {
		if (seen) return;
		if (isRecord(data) && data.nonce === contract.nonce) {
			seen = true;
			ack = data;
		}
	});
	try {
		events.emit(CHILD_CONTRACT_REQUEST, { version: contract.version, nonce: contract.nonce, profile: contract.profile });
	} finally {
		off();
	}
	if (!seen || !isRecord(ack)) {
		return { ok: false, reason: `no synchronous ${CHILD_CONTRACT_ACK} response; the child guard is absent, too old to acknowledge the contract, or not initialized` };
	}
	if (ack.version !== 1) {
		return { ok: false, reason: `unsupported child contract ack version ${JSON.stringify(ack.version)}` };
	}
	if (ack.ok !== true) {
		return { ok: false, reason: typeof ack.reason === "string" && ack.reason ? `child guard refused the contract: ${ack.reason}` : "child guard refused the contract" };
	}
	if (ack.nonce !== contract.nonce) return { ok: false, reason: "child contract nonce mismatch in the ack" };
	if (ack.inherited !== contract.profile) {
		return { ok: false, reason: `child guard acknowledged inherited profile ${JSON.stringify(ack.inherited)}, expected ${contract.profile}` };
	}
	return { ok: true };
}
