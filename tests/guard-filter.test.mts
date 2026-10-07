// Run: node tests/guard-filter.test.mts
import assert from "node:assert/strict";
import { filterSearchResult, type SearchResultEvent, type SearchFilterPolicy } from "../extensions/guard/filter.ts";

const tests: { name: string; fn: () => void }[] = [];
function test(name: string, fn: () => void): void {
	tests.push({ name, fn });
}
function policy(overrides: Partial<SearchFilterPolicy> = {}): SearchFilterPolicy {
	return { profile: "default", cwd: "/project", config: { maskPatterns: [], maskExceptions: [] }, ...overrides };
}
function event(text: string, overrides: Partial<SearchResultEvent> = {}): SearchResultEvent {
	return { toolName: "grep", input: { path: "/project" }, content: [{ type: "text", text }], ...overrides };
}
function filtered(text: string, overrides: Partial<SearchResultEvent> = {}, config = policy()) {
	const result = filterSearchResult(event(text, overrides), config);
	assert.ok(result, "guarded searches always replace all result channels");
	return result;
}
function output(text: string, overrides: Partial<SearchResultEvent> = {}, config = policy()): string {
	return filtered(text, overrides, config).content.map((part) => part.text).join("\n");
}

// First tracer bullet at the agreed public seam.
test("directory grep removes masked matches and keeps public matches", () => {
	assert.equal(output(".env:1: PRIVATE_TOKEN\nsrc/app.ts:2: public"), "src/app.ts:2: public\n1 matches in masked files omitted");
});

test("direct masked file queries and context rows never reveal their blocks", () => {
	assert.equal(output(".env-1- PRIVATE_BEFORE\n.env:2: PRIVATE_MATCH\n.env-3- PRIVATE_AFTER", { input: { path: "/project/config/.env" } }), "1 matches in masked files omitted");
	assert.equal(output("config/.env-1- PRIVATE\nconfig/.env:2: PRIVATE\nconfig/.env-3- PRIVATE\n--\nsrc/a.ts-3- before\nsrc/a.ts:4: public\nsrc/a.ts-5- after"), "src/a.ts-3- before\nsrc/a.ts:4: public\nsrc/a.ts-5- after\n1 matches in masked files omitted");
});

test("grouped ffgrep removes masked headers and all context without dropping public blocks", () => {
	assert.equal(output("config/.env\n 1- PRIVATE_BEFORE\n 2: PRIVATE_MATCH\n 3- PRIVATE_AFTER\n 4: PRIVATE_MATCH_2\n\nsrc/a.ts\n 10- before\n 11: public\n 12- after", { toolName: "ffgrep" }), "src/a.ts\n 10- before\n 11: public\n 12- after\n2 matches in masked files omitted");
});

test("default masks and exceptions merge with custom basename-only configuration", () => {
	const config = policy({ config: { maskPatterns: ["secret.*"], maskExceptions: [".env.local", "secret.example"] } });
	assert.equal(output(".env:1: PRIVATE\nsecret.txt:2: PRIVATE\n.env.example:3: example\n.env.sample:4: sample\n.env.template:5: template\n.env.local:6: local\nsecret.example:7: example\ndir.key/public.ts:8: public", {}, config), ".env.example:3: example\n.env.sample:4: sample\n.env.template:5: template\n.env.local:6: local\nsecret.example:7: example\ndir.key/public.ts:8: public\n2 matches in masked files omitted");
});

test("all default key and credentials basenames are masked", () => {
	for (const name of [".env", ".env.prod", "cert.pem", "private.key", "cert.pfx", "cert.p12", "a.keystore", "id_rsa.pub", "id_ecdsa", "id_ed25519", ".netrc", ".npmrc", ".pypirc"]) {
		assert.equal(output(`nested/${name}:1: PRIVATE`), "1 matches in masked files omitted", name);
	}
});

test("Windows and relative path variants use the resolved file basename", () => {
	for (const file of ["C:\\repo\\.env", "C:/repo/private.key", "./config/../.env", "../keys/id_rsa", "\\\\server\\share\\private.pem"]) {
		assert.equal(output(`${file}:3: PRIVATE`), "1 matches in masked files omitted", file);
		assert.equal(output(`${file}\n 3: PRIVATE`, { toolName: "ffgrep" }), "1 matches in masked files omitted", file);
	}
	assert.equal(output(".env:1: PRIVATE", { input: { path: "config" } }), "1 matches in masked files omitted");
	assert.equal(output("public.ts:2: public", { input: { path: "/project/.env" } }), "1 matches in masked files omitted", "masked direct root must not be bypassed by an unexpected display basename");
});

test("safe no-match output replaces poisoned details rather than passing it through", () => {
	for (const toolName of ["grep", "ffgrep"]) {
		const result = filtered("No matches found", { toolName, details: { raw: "PRIVATE" } });
		assert.deepEqual(result.content, [{ type: "text", text: "No matches found" }]);
		assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
		assert.equal(result.isError, false);
	}
});

test("known complete truncation and status notices are retained, not arbitrary suffixes", () => {
	const notice = "[2 matches limit reached. Use limit=4 for more, or refine pattern. 50KB limit reached. Some lines truncated to 500 chars. Use read tool to see full lines]";
	assert.equal(output(`.env:1: PRIVATE\nsrc/a.ts:2: public\n\n${notice}`), `src/a.ts:2: public\n\n${notice}\n1 matches in masked files omitted`);
	assert.equal(output(".env\n 1: PRIVATE\n\nsrc/a.ts\n 2: public\n\n[Results truncated]", { toolName: "ffgrep" }), "src/a.ts\n 2: public\n\n[Results truncated]\n1 matches in masked files omitted");
});

const suppression = {
	content: [{ type: "text", text: "Search result suppressed by guard: unable to safely filter masked files." }],
	details: { guard: { suppressed: true } },
	isError: true,
};

test("malformed, ambiguous, orphaned and partially truncated text fails closed", () => {
	const cases: Array<[string, string]> = [
		["grep", "PRIVATE"], ["grep", "file:0: PRIVATE"], ["grep", "file:1:"],
		["grep", "file-1- PRIVATE"], ["grep", "file:1: public\nPRIVATE"],
		["grep", ".env:1: PRIVATE\n[50KB limit rea"], ["grep", "No matches found: PRIVATE"],
		["grep", "file:1: public\n[Results truncated: PRIVATE]"],
		["ffgrep", ".env\nPRIVATE"], ["ffgrep", " 1: PRIVATE"], ["ffgrep", ".env"],
		["ffgrep", "file.ts\n 0: PRIVATE"], ["ffgrep", "file.ts\n 1- PRIVATE"],
		["ffgrep", "file.ts\n 1: public\nPRIVATE"], ["ffgrep", "file.ts\n 1: public\n 2:"],
	];
	for (const [toolName, text] of cases) assert.deepEqual(filtered(text, { toolName }), suppression, `${toolName}: ${text}`);
});

test("nontext content and extra metadata are never copied", () => {
	assert.deepEqual(filtered("ignored", { content: [{ type: "image", data: "PRIVATE" }] }), suppression);
	assert.deepEqual(filtered("ignored", { content: [{ type: "text" }] }), suppression);
	const result = filtered("src/a.ts:1: public", {
		content: [{ type: "text", text: "src/a.ts:1: public", metadata: { raw: "PRIVATE" } }],
		details: { raw: "PRIVATE", truncation: { content: ".env:1: PRIVATE" } },
	});
	assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("known structured matches are filtered with their contexts and whitelisted fields", () => {
	const result = filtered(".env:1: PRIVATE\nsrc/a.ts:2: public", {
		structuredContent: {
			matches: [
				{ path: ".env", line: 1, text: "PRIVATE", context: [{ line: 2, text: "PRIVATE_CONTEXT" }] },
				{ path: "src/a.ts", line: 2, text: "public", context: [{ line: 1, text: "before", metadata: "PRIVATE" }], metadata: { raw: "PRIVATE" } },
			],
			raw: "PRIVATE",
		},
		details: { matches: [{ path: ".env", text: "PRIVATE" }], cursor: "PRIVATE" },
	});
	assert.deepEqual(result.structuredContent, { matches: [{ path: "src/a.ts", line: 2, text: "public", context: [{ line: 1, text: "before" }] }] });
	assert.equal(JSON.stringify(result).includes("PRIVATE"), false, "programmatic callers and model output must both be redacted");
	assert.equal(result.details.guard.omittedMatches, 1, "the text and structured copies are not double-counted");
});

test("filePath/lineNumber/lineText structured records and context aliases are recognized", () => {
	const result = filtered("cert.pem:1: PRIVATE\npublic.ts:3: public", {
		structuredContent: { matches: [
			{ filePath: "cert.pem", lineNumber: 1, lineText: "PRIVATE", before: [{ lineNumber: 2, lineText: "PRIVATE" }] },
			{ filePath: "public.ts", lineNumber: 3, lineText: "public", before: [{ lineNumber: 2, lineText: "before" }], after: [{ lineNumber: 4, lineText: "after" }] },
		] },
	});
	assert.deepEqual(result.structuredContent, { matches: [{ path: "public.ts", line: 3, text: "public", before: [{ line: 2, text: "before" }], after: [{ line: 4, text: "after" }] }] });
});

test("structured-only masked matches cannot sneak past unmasked text", () => {
	const result = filtered("public.ts:2: public", {
		structuredContent: { matches: [{ path: "public.ts", line: 2, text: "public" }, { path: ".env", line: 1, text: "PRIVATE" }] },
	});
	assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
	assert.equal(result.content[0].text, "public.ts:2: public\n1 matches in masked files omitted");
});

test("unknown or ambiguous structured schemas suppress the entire result", () => {
	for (const structuredContent of [
		{ raw: "PRIVATE" }, { result: { matches: [] }, raw: "PRIVATE" }, "PRIVATE", null,
		[{ path: ".env", text: "PRIVATE" }], { matches: "PRIVATE" },
		{ matches: [{ text: "PRIVATE", line: 1 }] },
		{ matches: [{ path: "public.ts", filePath: ".env", line: 1, text: "PRIVATE" }] },
		{ matches: [{ path: "public.ts", line: 1, text: "public", context: "PRIVATE" }] },
		{ matches: [{ path: "public.ts", line: 1, text: "public", context: [{ path: ".env", line: 2, text: "PRIVATE" }] }] },
		{ matches: [{ path: "public.ts", line: "1", text: "PRIVATE" }] },
		{ matches: [{ path: "public.ts", line: 1, text: "public", before: [{ text: "PRIVATE" }] }] },
	]) assert.deepEqual(filtered("public.ts:1: public", { structuredContent, details: { secret: "PRIVATE" } }), suppression);
});

test("no-match structured records retain only empty known matches", () => {
	const result = filtered("No matches found", { structuredContent: { matches: [], raw: "PRIVATE" } });
	assert.deepEqual(result.structuredContent, { matches: [] });
	assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
	assert.deepEqual(filtered("No matches found", { structuredContent: { matches: [{ path: ".env", line: 1, text: "PRIVATE" }] } }), suppression);
});

test("malformed inputs and throwing accessors return fixed output, never exceptions", () => {
	for (const malformed of [null, {}, { toolName: "grep", input: null, content: [] }, { toolName: "grep", input: {}, content: null }, { toolName: "grep", input: { path: 12 }, content: [{ type: "text", text: "PRIVATE" }] }]) {
		let result: unknown;
		assert.doesNotThrow(() => { result = filterSearchResult(malformed as SearchResultEvent, policy()); });
		assert.deepEqual(result, suppression);
	}
	const broken = event("public.ts:1: public");
	Object.defineProperty(broken, "structuredContent", { get() { throw new Error("PRIVATE"); } });
	assert.deepEqual(filterSearchResult(broken, policy()), suppression);
	const brokenPolicy = policy();
	Object.defineProperty(brokenPolicy, "config", { get() { throw new Error("PRIVATE"); } });
	assert.deepEqual(filterSearchResult(event("public.ts:1: public"), brokenPolicy), suppression);
});

test("content-only overrides remove stale structured content and never retain opaque details", () => {
	const result = filtered("public.ts:1: public");
	assert.equal(Object.hasOwn(result, "structuredContent"), false);
	assert.deepEqual(Object.keys(result).sort(), ["content", "details", "isError"]);
	assert.deepEqual(result.details, { guard: { suppressed: false, omittedMatches: 0 } });
});

test("only grep and ffgrep in guarded profiles are filtered", () => {
	for (const profile of ["research", "default", "auto", "trusted"]) {
		assert.equal(output(".env:1: PRIVATE", {}, policy({ profile })), "1 matches in masked files omitted");
	}
	for (const profile of ["yolo", "unrestricted"]) {
		assert.equal(filterSearchResult(event("PRIVATE", { structuredContent: { raw: "PRIVATE" } }), policy({ profile })), undefined);
	}
	for (const toolName of ["read", "bash", "mcp__other__grep", "fffind"]) assert.equal(filterSearchResult(event("PRIVATE", { toolName }), policy()), undefined);
});

test("relative and filesystem-root queries accept directory syntax without rereading files", () => {
	for (const root of [".", "./", "/", "/project/", "config/"]) {
		assert.equal(output(".env:1: PRIVATE\npublic.ts:2: public", { input: { path: root } }), "public.ts:2: public\n1 matches in masked files omitted", root);
	}
	assert.equal(output(".env:1: PRIVATE", { input: {} }, policy({ cwd: "/" })), "1 matches in masked files omitted");
	assert.equal(output(".env\n 1: PRIVATE", { toolName: "ffgrep", input: { path: "**/*" } }), "1 matches in masked files omitted");
});

test("Windows basename masking is case-insensitive and honors default exceptions", () => {
	assert.equal(output("C:\\repo\\.ENV:1: PRIVATE\nC:\\repo\\PRIVATE.KEY:2: PRIVATE\nC:\\repo\\.ENV.EXAMPLE:3: public"), "C:\\repo\\.ENV.EXAMPLE:3: public\n2 matches in masked files omitted");
});

test("every content block is sanitized and original error details are discarded", () => {
	const result = filtered("ignored", {
		content: [{ type: "text", text: ".env:1: PRIVATE" }, { type: "text", text: "public.ts:2: public" }],
		isError: true,
		details: { message: "PRIVATE", metadata: { content: "PRIVATE" } },
	});
	assert.deepEqual(result.content, [{ type: "text", text: "public.ts:2: public\n1 matches in masked files omitted" }]);
	assert.equal(result.isError, true);
	assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
	assert.deepEqual(filtered("ignored", { content: [{ type: "text", text: "public.ts:2: public" }, { type: "image", data: "PRIVATE" }] }), suppression);
});

test("invalid policy, controls, path delimiters and sparse arrays cannot bypass suppression", () => {
	assert.deepEqual(filtered("public.ts:1: public", {}, policy({ config: { maskPatterns: [null as unknown as string], maskExceptions: [] } })), suppression);
	assert.deepEqual(filtered("public.ts:1: public\u001b[31mPRIVATE"), suppression);
	assert.deepEqual(filtered("safe-1- config/.env:2: PRIVATE"), suppression);
	assert.deepEqual(filtered("ignored", { content: new Array(1) }), suppression);
	assert.deepEqual(filtered("public.ts:1: public", { structuredContent: { matches: new Array(1) } }), suppression);
});

test("partial source rows, unsafe line numbers and sparse contexts fail closed", () => {
	assert.deepEqual(filtered("public.ts:1: public\r.env:2: PRIVATE"), suppression);
	assert.deepEqual(filtered("public.ts:9007199254740993: PRIVATE"), suppression);
	assert.deepEqual(filtered("public.ts\n 9007199254740993: PRIVATE", { toolName: "ffgrep" }), suppression);
	assert.deepEqual(filtered("public.ts:1: public", { structuredContent: { matches: [{ path: "public.ts", line: 1, text: "public", context: new Array(1) }] } }), suppression);
	assert.deepEqual(filtered("public.ts:1: public", {}, policy({ config: { maskPatterns: "secret.*" as unknown as string[], maskExceptions: [] } })), suppression);
	assert.equal(output(".env:1: PRIVATE\r\npublic.ts:2: public\r\n"), "public.ts:2: public\n1 matches in masked files omitted");
});

test("Windows UNC paths and normalized trailing dots cannot evade basename masking", () => {
	assert.equal(output("//server/share/.ENV:1: PRIVATE\nC:/repo/private.key.:2: PRIVATE"), "2 matches in masked files omitted");
});

test("conflicting omission counts across result channels suppress ambiguous results", () => {
	assert.deepEqual(filtered(".env:1: PRIVATE", { structuredContent: { matches: [
		{ path: ".env", line: 1, text: "PRIVATE" }, { path: ".env", line: 2, text: "PRIVATE" },
	] } }), suppression);
});

test("the public seam accepts pi-style content interfaces without index signatures", () => {
	interface BuiltinTextContent { type: "text"; text: string }
	const result: { toolName: string; input: Record<string, unknown>; content: BuiltinTextContent[] } = {
		toolName: "grep", input: {}, content: [{ type: "text", text: ".env:1: PRIVATE" }],
	};
	assert.equal(filterSearchResult(result, policy())?.content[0].text, "1 matches in masked files omitted");
});

let passed = 0;
let failed = 0;
for (const t of tests) {
	try {
		t.fn();
		passed++;
		console.log(`  ok ${t.name}`);
	} catch (error) {
		failed++;
		console.error(`  FAIL ${t.name}:`, error);
	}
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
