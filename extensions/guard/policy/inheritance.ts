/**
 * Step-5 subagent inheritance contract.
 *
 * The parent subagent extension serializes the parent's effective profile
 * into PI_GUARD_INHERIT immediately before spawning a child. The child's
 * guard parses the same variable once per process and installs the inherited
 * profile as an immutable restriction for the child's lifetime: the child may
 * only keep its inherited profile or switch to research (subject to the usual
 * research-hold rules).
 *
 * This module is pure: parsing and serialization never touch process.env, so
 * tests can exercise them directly and the guard factory captures the parsed
 * contract once, so later environment changes cannot relax a running child.
 *
 * The nonce is a fresh per-child correlation identifier, not a credential.
 * No credentials or policy configuration travel through this contract.
 */

import { isProfile, type Profile } from "./profiles.ts";

/** The single environment variable carrying the contract. */
export const INHERIT_ENV = "PI_GUARD_INHERIT";

/** Current contract version; children refuse other versions. */
export const INHERITANCE_VERSION = 1;

/** Bounded size for the serialized payload; anything larger is malformed. */
const MAX_RAW_LENGTH = 1024;

/** Nonces are opaque short identifiers (randomUUID fits). */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface InheritanceContract {
	version: typeof INHERITANCE_VERSION;
	profile: Profile;
	nonce: string;
}

/**
 * How a guard session sees the ambient contract:
 * - null: ordinary session (the variable is absent).
 * - { profile }: a valid contract; the profile is an immutable restriction.
 * - { error }: the variable was present but invalid; the session is blocked
 *   and never initialized as an executable default-profile runtime.
 */
export type InheritanceConstraint = { profile: Profile } | { error: string };

export type ParsedInheritance =
	| { ok: true; contract: InheritanceContract }
	| { ok: false; /** True when the variable existed but was invalid. */ present: boolean; reason: string };

/** Parse a raw environment value. An absent value denotes an ordinary session. */
export function parseInheritance(raw: string | undefined | null): ParsedInheritance {
	if (raw === undefined || raw === null) {
		return { ok: false, present: false, reason: `${INHERIT_ENV} is not set (ordinary session)` };
	}
	if (raw.length > MAX_RAW_LENGTH) {
		return { ok: false, present: true, reason: `payload exceeds ${MAX_RAW_LENGTH} characters` };
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (err) {
		return { ok: false, present: true, reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, present: true, reason: "payload is not a JSON object" };
	}
	const record = value as Record<string, unknown>;
	const unknownKeys = Object.keys(record).filter((key) => key !== "version" && key !== "profile" && key !== "nonce");
	if (unknownKeys.length > 0) {
		return { ok: false, present: true, reason: `unsupported fields: ${unknownKeys.join(", ")}` };
	}
	if (record.version !== INHERITANCE_VERSION) {
		return { ok: false, present: true, reason: `unsupported contract version ${JSON.stringify(record.version)}` };
	}
	if (!isProfile(record.profile)) {
		return { ok: false, present: true, reason: `invalid profile ${JSON.stringify(record.profile)}` };
	}
	if (typeof record.nonce !== "string" || !NONCE_PATTERN.test(record.nonce)) {
		return { ok: false, present: true, reason: "invalid nonce" };
	}
	return { ok: true, contract: { version: INHERITANCE_VERSION, profile: record.profile, nonce: record.nonce } };
}

/** Serialize a contract for the child environment. */
export function serializeInheritance(profile: Profile, nonce: string): string {
	return JSON.stringify({ version: INHERITANCE_VERSION, profile, nonce });
}

/** Map a parse result to the session constraint. */
export function constraintFromParse(parsed: ParsedInheritance): InheritanceConstraint | null {
	if (parsed.ok) return { profile: parsed.contract.profile };
	return parsed.present ? { error: parsed.reason } : null;
}
