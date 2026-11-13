/**
 * Step-5 subagent handshake channels shared by the guard and subagent
 * extensions.
 *
 * Three channel pairs live here so both sides agree on one spelling:
 *
 * - snapshot request/ack: the state-aware per-spawn query. Guard refuses it
 *   when its session is uninitialized, transitioning, workspace-locked, bound
 *   to another cwd, or blocked by invalid inheritance.
 * - child contract request/ack: the dispatched child's proof that its own
 *   guard consumed the inherited contract, demanded by the child startup gate.
 * - extension presence request/ack: answered unconditionally as soon as the
 *   guard factory runs, before and independently of session state. It carries
 *   no profile and authorizes nothing; its only job is to let the subagent
 *   extension tell "no guard extension is loaded" apart from "a guard
 *   extension is loaded but did not answer the snapshot handshake".
 *
 * Versioning is deliberately per direction: the child contract REQUEST carries
 * the inheritance contract version (`INHERITANCE_VERSION`, validated by
 * guard), while every ack this module describes is version 1.
 *
 * This module stays import-free at runtime (types only) so the child startup
 * gate, which imports the query helpers, keeps a small dependency surface.
 */

import type { Profile } from "./profiles.ts";

export const SUBAGENT_SNAPSHOT_REQUEST = "guard:subagent-snapshot-request";
export const SUBAGENT_SNAPSHOT_ACK = "guard:subagent-snapshot-ack";
export const CHILD_CONTRACT_REQUEST = "guard:child-contract-request";
export const CHILD_CONTRACT_ACK = "guard:child-contract-ack";
export const EXTENSION_PRESENT_REQUEST = "guard:extension-present-request";
export const EXTENSION_PRESENT_ACK = "guard:extension-present-ack";

/** Shape of the snapshot, contract, and presence ack payloads guard emits. */
export interface SubagentAckBase {
	version: 1;
	ok: boolean;
	reason?: string;
}

export interface SnapshotRequest {
	version: 1;
	id: string;
	cwd: string;
}

export interface PresenceRequest {
	version: 1;
	id: string;
}

/** Carries the inheritance contract version, not the ack version. */
export interface ContractRequest {
	version: number;
	nonce: string;
	profile: Profile;
}

/**
 * Why a snapshot query produced no profile. Only "absent" may lead to an
 * ungated dispatch; every other kind means something answered and refused,
 * contradicted itself, or spoke a version this build cannot read.
 */
export type SnapshotFailureKind = "absent" | "refused" | "malformed" | "duplicate";
