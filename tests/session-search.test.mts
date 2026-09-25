// Tests for the session-search extension's pure modules (parse, search, store).
//
// The extension factory (index.ts) is a thin wiring layer over these, so the
// tests exercise the real logic: extraction rules, ranking/snippets, and
// incremental index refresh.
//
// Run: node tests/session-search.test.mts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseSession, TEXT_CAP, isBoilerplate, isSubagentName } = await import("../extensions/session-search/parse.ts");
const { parseQuery, searchSessions, formatHits, formatHit } = await import("../extensions/session-search/search.ts");
const { refreshIndex, loadIndex, saveIndex, listSessionFiles } = await import("../extensions/session-search/store.ts");

let passed = 0;
function ok(name: string, fn: () => void) {
	fn();
	passed++;
	console.log(`  ok ${passed} - ${name}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────
function line(obj: any): string {
	return JSON.stringify(obj);
}

function msg(role: string, content: any, ts: string, id: string): string {
	return line({ type: "message", id, parentId: null, timestamp: ts, message: { role, content } });
}

function makeFixture(): string {
	const long = "needle-tail ".repeat(900) + "END"; // > 8KB
	return [
		line({ type: "session", version: 3, id: "sess-1", timestamp: "2026-09-22T10:00:00.000Z", cwd: "/home/lucas/source/datadog/serverless-components", parentSession: undefined }),
		line({ type: "model_change", id: "m1", timestamp: "2026-09-22T10:00:00.001Z", provider: "p", modelId: "m" }),
		line({ type: "session_info", id: "s1", timestamp: "2026-09-22T10:00:00.002Z", name: "serverless-components.lpimentel-add-error-sampler" }),
		msg("user", "fake-intake serverless-components 1385 logs", "2026-09-22T10:00:05.000Z", "e1"),
		msg("user", [{ type: "text", text: "second question " }, { type: "text", text: "about intake sampling" }], "2026-09-22T10:05:00.000Z", "e2"),
		msg("user", "fake-intake serverless-components 1385 logs", "2026-09-22T12:00:00.000Z", "e3"), // branch dupe
		msg("assistant", [{ type: "text", text: "The fake-intake path is crates/datadog-log-intake/src/fake_intake.rs" }], "2026-09-22T10:06:00.000Z", "e4"),
		msg("assistant", [{ type: "toolCall", name: "read", input: {} }], "2026-09-22T10:07:00.000Z", "e5"),
		line({ type: "message", id: "e6", timestamp: "2026-09-22T10:08:00.000Z", message: { role: "toolResult", content: [{ type: "text", text: "fake-intake noise should not be indexed" }] } }),
		msg("user", "<skill name=\"review-pr\">injected boilerplate fake-intake</skill>", "2026-09-22T10:09:00.000Z", "e7"),
		msg("user", "<env:foo>legit pasted xml about fake-intake</env:foo>", "2026-09-22T10:10:00.000Z", "e8"),
		line({ type: "compaction", id: "e9", timestamp: "2026-09-22T11:00:00.000Z", summary: "Compacted: discussed fake-intake sampler configuration", firstKeptEntryId: "x", tokensBefore: 100 }),
		line({ type: "custom_message", customType: "idle-summary", content: "Recap: implemented error sampler for fake-intake", display: true, timestamp: "2026-09-22T11:30:00.000Z", id: "e10", parentId: null }),
		msg("user", long, "2026-09-22T11:40:00.000Z", "e11"),
	].join("\n");
}

// ── parse ────────────────────────────────────────────────────────────────────
console.log("parse.ts");

ok("extracts session metadata", () => {
	const s = parseSession(makeFixture(), "/fake/path.jsonl");
	assert.equal(s.sessionId, "sess-1");
	assert.equal(s.cwd, "/home/lucas/source/datadog/serverless-components");
	assert.equal(s.started, "2026-09-22T10:00:00.000Z");
	assert.equal(s.lastActivity, "2026-09-22T12:00:00.000Z");
	assert.equal(s.isSubagent, false);
	assert.equal(s.name, "serverless-components.lpimentel-add-error-sampler");
});

ok("keeps user and assistant text, drops toolResult/thinking noise", () => {
	const s = parseSession(makeFixture(), "/fake/path.jsonl");
	const texts = s.entries.map((e) => e.text);
	assert.ok(texts.some((t) => t.includes("fake-intake serverless-components 1385")));
	assert.ok(texts.some((t) => t.includes("fake_intake.rs")));
	assert.ok(!texts.some((t) => t.includes("noise should not be indexed")));
	// assistant toolCall-only message produced no text entry
	const assistants = s.entries.filter((e) => e.origin === "assistant");
	assert.equal(assistants.length, 1);
});

ok("dedupes identical user text across branches with a branch count", () => {
	const s = parseSession(makeFixture(), "/fake/path.jsonl");
	const users = s.entries.filter((e) => e.origin === "user" && e.text.includes("1385"));
	assert.equal(users.length, 1);
	assert.equal(users[0].branches, 2);
});

ok("excludes blocklisted boilerplate but keeps pasted XML", () => {
	const s = parseSession(makeFixture(), "/fake/path.jsonl");
	const texts = s.entries.map((e) => e.text);
	assert.ok(!texts.some((t) => t.includes("injected boilerplate")));
	assert.ok(texts.some((t) => t.includes("legit pasted xml")));
	assert.ok(isBoilerplate("<system-reminder>nope"));
	assert.ok(!isBoilerplate("   <env:foo>legit"));
	assert.ok(!isBoilerplate("compare List<String> to <T>"));
});

ok("indexes compaction and custom_message as summary origin", () => {
	const s = parseSession(makeFixture(), "/fake/path.jsonl");
	const summaries = s.entries.filter((e) => e.origin === "summary");
	assert.equal(summaries.length, 2);
	assert.deepEqual(
		summaries.map((e) => e.source).sort(),
		["compaction", "idle-summary"],
	);
	assert.ok(summaries.some((e) => e.text.includes("fake-intake sampler")));
});

ok("caps entry text at TEXT_CAP (8KB, head-only)", () => {
	assert.equal(TEXT_CAP, 8 * 1024);
	const s = parseSession(makeFixture(), "/fake/path.jsonl");
	const longEntry = s.entries.find((e) => e.text.includes("needle-tail"));
	assert.ok(longEntry);
	assert.ok(longEntry!.text.length <= TEXT_CAP);
	assert.ok(!longEntry!.text.includes("END")); // head-only cap
});

ok("detects subagent sessions by session_info name pattern", () => {
	assert.ok(isSubagentName("general-purpose#4d4119cf"));
	assert.ok(!isSubagentName("serverless-components.lpimentel-add-error-sampler"));
	assert.ok(!isSubagentName(undefined));
	const content = makeFixture().replace(
		'"name":"serverless-components.lpimentel-add-error-sampler"',
		'"name":"general-purpose#4d4119cf"',
	);
	const s = parseSession(content, "/fake/path.jsonl");
	assert.equal(s.isSubagent, true);
});

ok("tolerates corrupt lines", () => {
	const s = parseSession("{not json}\n" + makeFixture() + "\n{also bad}", "/fake/path.jsonl");
	assert.equal(s.sessionId, "sess-1");
});

// ── search ───────────────────────────────────────────────────────────────────
console.log("search.ts");

function fakeIndexedSession(overrides: Partial<any> = {}): any {
	return {
		path: "/s/default.jsonl",
		sessionId: "id",
		cwd: "/proj",
		started: "2026-01-01T00:00:00.000Z",
		lastActivity: "2026-01-01T00:00:00.000Z",
		isSubagent: false,
		entries: [{ origin: "user", ts: "2026-01-01T00:00:00.000Z", text: "alpha beta" }],
		mtime: 0,
		size: 0,
		...overrides,
	};
}

ok("AND semantics: all terms must match somewhere in the session", () => {
	const index = [fakeIndexedSession(), fakeIndexedSession({ path: "/s/b.jsonl", entries: [{ origin: "user", ts: "t", text: "alpha only" }] })];
	const hits = searchSessions(index, "alpha beta");
	assert.equal(hits.length, 1);
	assert.equal(hits[0].path, "/s/default.jsonl");
	assert.equal(searchSessions(index, "gamma").length, 0);
});

ok("ranking tiers: user > assistant > summary", () => {
	const index = [
		fakeIndexedSession({ path: "/s/summary.jsonl", entries: [{ origin: "summary", ts: "t", text: "alpha" }] }),
		fakeIndexedSession({ path: "/s/assistant.jsonl", entries: [{ origin: "assistant", ts: "t", text: "alpha" }] }),
		fakeIndexedSession({ path: "/s/user.jsonl", entries: [{ origin: "user", ts: "t", text: "alpha" }] }),
	];
	const hits = searchSessions(index, "alpha", { limit: 10 });
	assert.deepEqual(hits.map((h) => h.path), ["/s/user.jsonl", "/s/assistant.jsonl", "/s/summary.jsonl"]);
	assert.deepEqual(hits.map((h) => h.tier), ["user", "assistant", "summary"]);
});

ok("subagent sessions are penalized within their tier", () => {
	const index = [
		fakeIndexedSession({ path: "/s/main.jsonl", entries: [{ origin: "user", ts: "t", text: "alpha" }] }),
		fakeIndexedSession({ path: "/s/sub.jsonl", isSubagent: true, entries: [{ origin: "user", ts: "t", text: "alpha" }] }),
	];
	const hits = searchSessions(index, "alpha");
	assert.equal(hits[0].path, "/s/main.jsonl");
	assert.ok(hits[0].score > hits[1].score);
	assert.equal(hits[1].score, Math.floor(hits[0].score / 2));
});

ok("regex mode via leading slash", () => {
	const index = [fakeIndexedSession({ entries: [{ origin: "user", ts: "t", text: "error 1385 and error 999" }] })];
	const hits = searchSessions(index, "/error \\d{4}\\b");
	assert.equal(hits.length, 1);
	assert.equal(searchSessions(index, "/error \\d{5}").length, 0);
	assert.equal(parseQuery("/[invalid"), null);
});

ok("filters: cwd substring, since date, in origin, limit", () => {
	const index = [
		fakeIndexedSession({ path: "/s/a.jsonl", cwd: "/home/x/serverless-components", lastActivity: "2026-09-22T00:00:00.000Z", entries: [{ origin: "assistant", ts: "t", text: "alpha" }] }),
		fakeIndexedSession({ path: "/s/b.jsonl", cwd: "/home/x/other", lastActivity: "2026-01-01T00:00:00.000Z", entries: [{ origin: "user", ts: "t", text: "alpha" }] }),
	];
	assert.deepEqual(searchSessions(index, "alpha", { cwd: "serverless-components" }).map((h) => h.path), ["/s/a.jsonl"]);
	assert.deepEqual(searchSessions(index, "alpha", { since: "2026-06-01" }).map((h) => h.path), ["/s/a.jsonl"]);
	assert.deepEqual(searchSessions(index, "alpha", { in: "user" }).map((h) => h.path), ["/s/b.jsonl"]);
	assert.equal(searchSessions(index, "alpha", { limit: 1 }).length, 1);
});

ok("snippets: clipped +-60 chars, origin-labeled, max 4 kept (2 in tool output)", () => {
	const filler = "x".repeat(200);
	const index = [
		fakeIndexedSession({
			entries: [
				{ origin: "user", ts: "t1", text: filler + " findable-needle " + filler },
				{ origin: "assistant", ts: "t2", text: filler + " findable-needle " + filler },
				{ origin: "summary", ts: "t3", text: filler + " findable-needle " + filler },
				{ origin: "user", ts: "t4", text: filler + " findable-needle " + filler },
			],
		}),
	];
	const hits = searchSessions(index, "findable-needle");
	assert.equal(hits.length, 1);
	assert.equal(hits[0].snippets.length, 4); // preview card can show all
	assert.ok(hits[0].snippets[0].text.length <= 60 * 2 + 6 + 20);
	assert.ok(hits[0].snippets.every((s) => s.text.includes("findable-needle")));
	assert.equal(hits[0].tier, "user"); // best origin wins even with snippet cap
	// tool output renders only the first 2
	const toolOut = formatHits(hits, "findable-needle");
	const snippetLines = toolOut.split("\n").filter((l) => l.trimStart().startsWith("user:") || l.trimStart().startsWith("assistant:") || l.trimStart().startsWith("summary:"));
	assert.equal(snippetLines.length, 2);
});

ok("formatHit: full card with all snippets, dates, and path", () => {
	const card = formatHit({
		path: "/s/x.jsonl", sessionId: "id", cwd: "/proj", name: "my session",
		started: "2026-09-22T10:00:00.000Z", lastActivity: "2026-09-22T12:00:00.000Z",
		isSubagent: false, score: 350, tier: "user",
		snippets: [
			{ origin: "user", ts: "2026-09-22T10:01:00.000Z", text: "first" },
			{ origin: "summary", ts: "2026-09-22T11:00:00.000Z", source: "compaction", text: "second" },
		],
	});
	assert.ok(card.includes("my session"));
	assert.ok(card.includes("/s/x.jsonl"));
	assert.ok(card.includes("started: 2026-09-22 10:00:00"));
	assert.ok(card.includes("user @ 2026-09-22 10:01:00: first"));
	assert.ok(card.includes("summary (compaction) @ 2026-09-22 11:00:00: second"));
});

ok("formatHits: ranked, path-bearing, hard-capped at ~4KB", () => {
	const many = Array.from({ length: 50 }, (_, i) =>
		fakeIndexedSession({ path: `/s/filler-${i}-${"y".repeat(120)}.jsonl`, entries: [{ origin: "user", ts: "t", text: "alpha " + "z".repeat(100) }] }),
	);
	const out = formatHits(searchSessions(many, "alpha", { limit: 50 }), "alpha");
	assert.ok(out.length <= 4 * 1024 + 200); // small slack for the truncation notice
	assert.ok(out.includes("narrow the query"));
	const small = formatHits(searchSessions([fakeIndexedSession()], "alpha"), "alpha");
	assert.ok(small.includes("/s/default.jsonl"));
	assert.ok(formatHits([], "nothing").includes("No sessions matched"));
});

// ── store ────────────────────────────────────────────────────────────────────
console.log("store.ts");

const tmp = mkdtempSync(join(tmpdir(), "session-search-test-"));
try {
	const projA = join(tmp, "--home-lucas-proj-a--");
	const projB = join(tmp, "--home-lucas-proj-b--");
	for (const d of [projA, projB]) mkdirSync(d, { recursive: true });
	const fileA = join(projA, "2026-01-01T00-00-00-000Z_a.jsonl");
	const fileB = join(projB, "2026-01-01T00-00-00-000Z_b.jsonl");
	writeFileSync(fileA, makeFixture());
	writeFileSync(fileB, line({ type: "session", version: 3, id: "sess-2", timestamp: "2026-09-23T00:00:00.000Z", cwd: "/home/lucas/source/other" }) + "\n" + msg("user", "unrelated content", "2026-09-23T00:00:01.000Z", "f1"));

	ok("listSessionFiles walks project subdirectories", () => {
		const files = listSessionFiles(tmp);
		assert.equal(files.length, 2);
	});

	const index = new Map();

	ok("first refresh parses everything", () => {
		const r = refreshIndex(index, tmp);
		assert.equal(r.parsed, 2);
		assert.equal(r.total, 2);
		assert.equal(index.size, 2);
		const a = index.get(fileA)!;
		assert.equal(a.sessionId, "sess-1");
		assert.ok(a.entries.length > 0);
		assert.ok(a.mtime > 0 && a.size > 0);
	});

	ok("unchanged files are not re-parsed", () => {
		const r = refreshIndex(index, tmp);
		assert.equal(r.parsed, 0);
		assert.equal(r.pruned, 0);
	});

	ok("changed files (mtime/size) are re-parsed", () => {
		writeFileSync(fileB, line({ type: "session", version: 3, id: "sess-2b", timestamp: "2026-09-24T00:00:00.000Z", cwd: "/home/lucas/source/other" }) + "\n" + msg("user", "updated content xyzzy", "2026-09-24T00:00:01.000Z", "f2"));
		// force a distinct mtime
		const later = new Date(Date.now() + 2000);
		utimesSync(fileB, later, later);
		const r = refreshIndex(index, tmp);
		assert.equal(r.parsed, 1);
		assert.equal(index.get(fileB)!.sessionId, "sess-2b");
	});

	ok("deleted files are pruned from the index", () => {
		unlinkSync(fileB);
		const r = refreshIndex(index, tmp);
		assert.equal(r.pruned, 1);
		assert.ok(!index.has(fileB));
	});

	ok("save/load roundtrips the index", () => {
		const file = join(tmp, "index.jsonl");
		saveIndex(index, file);
		const loaded = loadIndex(file);
		assert.equal(loaded.size, index.size);
		assert.equal(loaded.get(fileA)!.sessionId, "sess-1");
	});
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

// ── context extraction ───────────────────────────────────────────────────
console.log("context.ts");

const { extractWindowContext, WINDOW_MESSAGES, TOTAL_CAP, PER_MESSAGE_CAP } = await import("../extensions/session-search/context.ts");

function contextFixture(): string {
	const lines: string[] = [line({ type: "session", version: 3, id: "s", timestamp: "2026-09-22T10:00:00.000Z", cwd: "/p" })];
	for (let i = 1; i <= 20; i++) {
		const ts = `2026-09-22T10:${String(i).padStart(2, "0")}:00.000Z`;
		const role = i % 2 === 1 ? "user" : "assistant";
		if (i === 11) {
			// a summary near the anchor, in chronological file position
			lines.push(line({ type: "custom_message", customType: "idle-summary", content: "recap of the work", timestamp: "2026-09-22T10:10:15.000Z", id: "m23", parentId: null }));
		}
		lines.push(msg(role, `message number ${i}`, ts, `m${i}`));
	}
	// tool results and boilerplate must be excluded from the window
	lines.push(msg("user", "<skill name=\"x\">injected junk</skill>", "2026-09-22T10:10:30.000Z", "m21"));
	lines.push(line({ type: "message", id: "m22", timestamp: "2026-09-22T10:10:31.000Z", message: { role: "toolResult", content: [{ type: "text", text: "tool noise" }] } }));
	return lines.join("\n");
}

ok("window: includes ±5 items around the anchor, skips toolResult/boilerplate, includes summaries", () => {
	assert.equal(WINDOW_MESSAGES, 5);
	const out = extractWindowContext(contextFixture(), "2026-09-22T10:10:00.000Z");
	assert.ok(out.includes("message number 10")); // anchor
	assert.ok(out.includes("message number 5")); // 5 back
	assert.ok(out.includes("message number 14")); // 5 forward (summary takes one slot)
	assert.ok(!out.includes("message number 15")); // outside window
	assert.ok(!out.includes("message number 4")); // outside window
	assert.ok(!out.includes("injected junk"));
	assert.ok(!out.includes("tool noise"));
	assert.ok(out.includes("summary (idle-summary): recap of the work"));
	// numbered roles with timestamps
	assert.ok(/\[10:10:00\] assistant: message number 10/.test(out));
});

ok("window: all anchor timestamps are widened in even when far apart", () => {
	const out = extractWindowContext(contextFixture(), "2026-09-22T10:10:00.000Z", ["2026-09-22T10:01:00.000Z", "2026-09-22T10:19:00.000Z"]);
	assert.ok(out.includes("message number 1"));
	assert.ok(out.includes("message number 19"));
	assert.ok(!out.includes("message number 20")); // beyond the far anchor
});

ok("window: per-message and total caps are enforced", () => {
	assert.equal(PER_MESSAGE_CAP, 2 * 1024);
	assert.equal(TOTAL_CAP, 16 * 1024);
	const big = "y".repeat(5000);
	const lines: string[] = [];
	for (let i = 1; i <= 10; i++) {
		lines.push(msg("user", `marker-${i} ` + big, `2026-09-22T10:${String(i).padStart(2, "0")}:00.000Z`, `b${i}`));
	}
	const out = extractWindowContext(lines.join("\n"), "2026-09-22T10:05:00.000Z");
	assert.ok(out.length <= TOTAL_CAP + 2000); // one item may exceed before its own drop
	assert.ok(!out.includes("marker-1")); // farthest-from-anchor dropped
	assert.ok(out.includes("marker-5")); // anchor kept
	assert.ok(out.includes("[...truncated]")); // per-message cap applied
});

ok("window: missing anchor falls back to nearest timestamp", () => {
	const out = extractWindowContext(contextFixture(), "2026-09-22T10:09:59.999Z");
	assert.ok(out.includes("message number 10"));
	assert.equal(extractWindowContext("", "2026-09-22T10:00:00.000Z"), "");
});

console.log(`\n${passed} tests passed`);
