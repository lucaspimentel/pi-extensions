/**
 * Synchronous event-bus queries for guard's step-5 subagent handshake.
 *
 * The installed event bus invokes a synchronous handler inline (its async
 * wrapper runs until the first await), so a guard responder that acks before
 * yielding answers during the emit below. This module therefore subscribes
 * before emitting, accepts only the matching validated response, unsubscribes
 * in finally, and refuses absent, malformed, contradictory, or non-synchronous
 * responses. It also requires exactly one correlated synchronous
 * acknowledgment: every additional matching acknowledgment is refused, even
 * when identical, because multiple responses indicate an ambiguous or
 * duplicated responder configuration. Never reuse the asynchronous
 * research-transition acknowledgment protocol here.
 *
 * Pure bus plumbing: no process.env access and no runtime guard imports beyond
 * the shared channel names and the profile type guard, so the child bootstrap
 * keeps a small dependency surface.
 *
 * The same discipline covers the extension presence query below. Presence is
 * only a liveness signal: it converts "nothing answered" into "a guard
 * extension is loaded but did not answer", and it can never authorize a
 * guarded dispatch or carry a profile.
 */

import { randomUUID } from "node:crypto";
import {
	CHILD_CONTRACT_ACK,
	CHILD_CONTRACT_REQUEST,
	EXTENSION_PRESENT_ACK,
	EXTENSION_PRESENT_REQUEST,
	SUBAGENT_SNAPSHOT_ACK,
	SUBAGENT_SNAPSHOT_REQUEST,
	type SnapshotFailureKind,
} from "../guard/policy/handshake.ts";
import { isProfile, type Profile } from "../guard/policy/profiles.ts";

/** Structural event-bus subset; keeps the bootstrap free of runtime imports. */
interface QueryBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export type GuardSnapshot =
	| { ok: true; profile: Profile }
	| { ok: false; kind: SnapshotFailureKind; reason: string };

/**
 * Presence outcome. `present` includes every correlated answer, valid or not:
 * a malformed, refused, or duplicated acknowledgment still proves a guard
 * extension is loaded.
 */
export type GuardPresence = { present: true; reason?: string } | { present: false };

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
	let duplicated = false;
	const off = events.on(SUBAGENT_SNAPSHOT_ACK, (data: unknown) => {
		if (!isRecord(data) || data.id !== id) return;
		// Any second correlated acknowledgment fails the query, regardless of
		// order, validity, version, success/refusal, or payload contents.
		if (seen) {
			duplicated = true;
			return;
		}
		seen = true;
		ack = data;
	});
	try {
		events.emit(SUBAGENT_SNAPSHOT_REQUEST, { version: 1, id, cwd });
	} finally {
		off();
	}
	// Checked before the first payload's validity: a duplicate taints the
	// whole exchange, so a later valid response must not recover it.
	if (duplicated) {
		return { ok: false, kind: "duplicate", reason: "duplicate guard snapshot acknowledgment: exactly one synchronous responder must answer the snapshot request" };
	}
	if (!seen || !isRecord(ack)) {
		return { ok: false, kind: "absent", reason: "no synchronous guard snapshot response; the guard is absent, uninitialized, or not synchronous" };
	}
	if (ack.version !== 1) {
		return { ok: false, kind: "malformed", reason: `unsupported guard snapshot response version ${JSON.stringify(ack.version)}` };
	}
	if (ack.ok === true && isProfile(ack.profile)) return { ok: true, profile: ack.profile };
	if (ack.ok === false && typeof ack.reason === "string" && ack.reason) return { ok: false, kind: "refused", reason: ack.reason };
	return { ok: false, kind: "malformed", reason: "malformed guard snapshot response" };
}

/**
 * Ask the parent session whether a guard extension is loaded at all. Guard
 * answers this from its factory, before session state exists, so it replies
 * even when the snapshot responder refuses. Must be called synchronously.
 *
 * Total by design: an event-bus failure resolves to `present` so an ungated
 * dispatch is never the result of a broken bus.
 */
export function queryGuardPresence(events: QueryBus): GuardPresence {
	const id = randomUUID();
	let ack: unknown;
	let seen = false;
	let duplicated = false;
	const off = events.on(EXTENSION_PRESENT_ACK, (data: unknown) => {
		if (!isRecord(data) || data.id !== id) return;
		// Any second correlated acknowledgment proves a duplicated or
		// contradictory responder configuration; it counts as present.
		if (seen) {
			duplicated = true;
			return;
		}
		seen = true;
		ack = data;
	});
	try {
		events.emit(EXTENSION_PRESENT_REQUEST, { version: 1, id });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { present: true, reason: `the guard presence query could not be emitted (${detail}); treating the guard as loaded` };
	} finally {
		off();
	}
	if (duplicated) {
		return { present: true, reason: "duplicate guard presence acknowledgment: exactly one synchronous responder must answer the presence request" };
	}
	if (!seen || !isRecord(ack)) return { present: false };
	if (ack.version !== 1) {
		return { present: true, reason: `unsupported guard presence response version ${JSON.stringify(ack.version)}` };
	}
	if (ack.ok !== true) {
		return { present: true, reason: typeof ack.reason === "string" && ack.reason ? `the guard refused the presence query: ${ack.reason}` : "the guard refused the presence query" };
	}
	return { present: true };
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
	let duplicated = false;
	const off = events.on(CHILD_CONTRACT_ACK, (data: unknown) => {
		if (!isRecord(data) || data.nonce !== contract.nonce) return;
		// Any second correlated acknowledgment fails the query, regardless of
		// order, validity, version, success/refusal, or payload contents.
		if (seen) {
			duplicated = true;
			return;
		}
		seen = true;
		ack = data;
	});
	try {
		events.emit(CHILD_CONTRACT_REQUEST, { version: contract.version, nonce: contract.nonce, profile: contract.profile });
	} finally {
		off();
	}
	// Checked before the first payload's validity: a duplicate taints the
	// whole exchange, so a later valid response must not recover it.
	if (duplicated) {
		return { ok: false, reason: `duplicate ${CHILD_CONTRACT_ACK} acknowledgment: exactly one synchronous responder must answer the contract request` };
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
