/**
 * session-search/schema.ts
 *
 * Output schema for the `session_excerpt` tool. Every result, success or
 * failure, returns one envelope matching this schema as both
 * `structuredContent` and `details.result`; failures also set `isError: true`.
 *
 * Field notes (settled design):
 *   - Every field except `name` and `error` is always present, including on
 *     failures, so callers never branch on undefined.
 *   - `anchored` describes the selection that was actually made and only
 *     means anything when `ok` is true. On a failure it carries the
 *     deterministic `{ tail: true }` placeholder because no selection ran.
 *   - A session that parses but holds no indexable entries is a SUCCESS with
 *     `messageCount: 0` and an empty `body`.
 */

import { Type } from "typebox";

export const excerptAnchorSchema = Type.Union([
	Type.Object({ ts: Type.String({ description: "Anchor timestamp used to center the window." }) }),
	Type.Object({ tail: Type.Literal(true) }),
	Type.Object({ queryMissed: Type.Literal(true) }),
]);

export const excerptErrorKindSchema = Type.Union([
	Type.Literal("outside_sessions"),
	Type.Literal("unreadable"),
	Type.Literal("not_a_session"),
	Type.Literal("cancelled"),
]);

export const excerptErrorSchema = Type.Object({
	kind: excerptErrorKindSchema,
	message: Type.String(),
});

export const excerptOutputSchema = Type.Object({
	ok: Type.Boolean(),
	path: Type.String({ description: "Absolute path of the session file that was read." }),
	sessionId: Type.String(),
	name: Type.Optional(Type.String()),
	cwd: Type.String(),
	started: Type.String(),
	selfSession: Type.Boolean({ description: "True when the excerpt came from the session making this call." }),
	anchored: excerptAnchorSchema,
	messageCount: Type.Number(),
	truncated: Type.Boolean({ description: "True when a cap dropped entries or clipped message text." }),
	body: Type.String({ description: "Rendered excerpt: one [HH:MM:SS] role: text line per entry." }),
	error: Type.Optional(excerptErrorSchema),
});

export type ExcerptAnchorEnvelope = { ts: string } | { tail: true } | { queryMissed: true };
export type ExcerptErrorKind = "outside_sessions" | "unreadable" | "not_a_session" | "cancelled";

/**
 * The flat result envelope, matching excerptOutputSchema field for field.
 * Declared as a type alias (not an interface) so TypeScript infers an implicit
 * index signature and the envelope satisfies pi's JSON-compatible
 * `structuredContent` type without a cast.
 */
export type ExcerptEnvelope = {
	ok: boolean;
	path: string;
	sessionId: string;
	name?: string;
	cwd: string;
	started: string;
	selfSession: boolean;
	anchored: ExcerptAnchorEnvelope;
	messageCount: number;
	truncated: boolean;
	body: string;
	error?: { kind: ExcerptErrorKind; message: string };
};

/** The tool result shape returned by `session_excerpt`. */
export interface ExcerptToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: { result: ExcerptEnvelope };
	structuredContent: ExcerptEnvelope;
	isError: boolean;
}
