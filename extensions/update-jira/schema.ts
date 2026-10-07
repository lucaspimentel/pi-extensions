/**
 * Shared TypeBox output schema for both update-jira tools. Every result,
 * success or failure, returns a matching structuredContent envelope.
 */

import { Type } from "typebox";

export const resultOutputSchema = Type.Object({
	tool: Type.Union([Type.Literal("jira_read"), Type.Literal("jira_update")]),
	action: Type.String(),
	site: Type.String(),
	ticket: Type.Optional(Type.String()),
	ok: Type.Boolean(),
	data: Type.Optional(Type.Unknown()),
	error: Type.Optional(
		Type.Object({
			kind: Type.String(),
			message: Type.String(),
			evidence: Type.Optional(Type.Unknown()),
		}),
	),
	spillPath: Type.Optional(Type.String()),
});
