// Tests for the session-search extension's pure modules (parse, search, store).
//
// The extension factory (index.ts) is a thin wiring layer over these, so the
// tests exercise the real logic: extraction rules, ranking/snippets, and
// incremental index refresh.
//
// Run: node tests/session-search.test.mts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, utimesSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";

const { parseSession, TEXT_CAP, isBoilerplate, isSubagentName } = await import("../extensions/session-search/parse.ts");
const { parseQuery, searchSessions, formatHits, formatHit } = await import("../extensions/session-search/search.ts");
const { refreshIndex, loadIndex, saveIndex, listSessionFiles, sessionsDir } = await import("../extensions/session-search/store.ts");

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

ok("excludePaths hides sessions by path (current-session exclusion)", () => {
	const index = [
		fakeIndexedSession({ path: "/s/current.jsonl" }),
		fakeIndexedSession({ path: "/s/other.jsonl" }),
	];
	assert.deepEqual(searchSessions(index, "alpha", { excludePaths: ["/s/current.jsonl"] }).map((h) => h.path), ["/s/other.jsonl"]);
	// non-normalized equivalent paths still match after resolve()
	assert.deepEqual(searchSessions(index, "alpha", { excludePaths: ["/s/../s/current.jsonl"] }).map((h) => h.path), ["/s/other.jsonl"]);
	// empty/undefined/mismatched exclusions exclude nothing
	assert.equal(searchSessions(index, "alpha", { excludePaths: [] }).length, 2);
	assert.equal(searchSessions(index, "alpha", {}).length, 2);
	assert.equal(searchSessions(index, "alpha", { excludePaths: ["/s/nope.jsonl"] }).length, 2);
	// composes with the other filters
	assert.deepEqual(searchSessions(index, "alpha", { cwd: "/proj", excludePaths: ["/s/current.jsonl"] }).map((h) => h.path), ["/s/other.jsonl"]);
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

const { extractWindowContext, selectAnchoredExcerpt, selectTailExcerpt, WINDOW_MESSAGES, TAIL_MESSAGES, TOTAL_CAP, PER_MESSAGE_CAP } = await import("../extensions/session-search/context.ts");

function contextFixture(): string {
	const lines: string[] = [line({ type: "session", version: 3, id: "s", timestamp: "2026-09-22T10:00:00.000Z", cwd: "/p" })];
	for (let i = 1; i <= 20; i++) {
		const ts = `2026-09-22T10:${String(i).padStart(2, "0")}:00.000Z`;
		const role = i % 2 === 1 ? "user" : "assistant";
		if (i === 11) {
			// boilerplate + summary near the anchor, in chronological file position;
			// the boilerplate sits INSIDE the window so the blocklist is exercised,
			// not just window clipping
			lines.push(msg("user", "<skill name=\"x\">injected junk</skill>", "2026-09-22T10:10:05.000Z", "m21"));
			lines.push(line({ type: "custom_message", customType: "idle-summary", content: "recap of the work", timestamp: "2026-09-22T10:10:15.000Z", id: "m23", parentId: null }));
		}
		lines.push(msg(role, `message number ${i}`, ts, `m${i}`));
	}
	// tool results must be excluded from the window
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

// ── excerpt selection: metadata + tail (context.ts) ──────────────────────────
console.log("context.ts: selection");

ok("selection: tail keeps the last TAIL_MESSAGES entries, oldest dropped first", () => {
	assert.equal(TAIL_MESSAGES, 10);
	const sel = selectTailExcerpt(contextFixture());
	assert.deepEqual(sel.anchored, { tail: true });
	assert.equal(sel.messageCount, 10);
	assert.equal(sel.truncated, false);
	assert.ok(sel.body.includes("message number 20"));
	assert.ok(sel.body.includes("message number 11"));
	assert.ok(!sel.body.includes("message number 10")); // 21 items: the tail starts at message 11
});

ok("selection: a missed query is labeled, an empty session is an empty success", () => {
	const missed = selectTailExcerpt(contextFixture(), { missed: true });
	assert.deepEqual(missed.anchored, { queryMissed: true });
	assert.equal(missed.messageCount, 10);
	assert.deepEqual(selectTailExcerpt(""), { body: "", messageCount: 0, truncated: false, anchored: { tail: true } });
	const headerOnly = selectTailExcerpt(contextFixture().split("\n")[0]);
	assert.equal(headerOnly.messageCount, 0);
	assert.equal(headerOnly.body, "");
});

ok("selection: the tail trims the oldest entries to fit the caps", () => {
	const big = "z".repeat(5000);
	const lines = [line({ type: "session", version: 3, id: "s", timestamp: "2026-09-22T10:00:00.000Z", cwd: "/p" })];
	for (let i = 1; i <= 12; i++) lines.push(msg("user", `marker-${i} ${big}`, `2026-09-22T10:${String(i).padStart(2, "0")}:00.000Z`, `m${i}`));
	const sel = selectTailExcerpt(lines.join("\n"));
	assert.equal(sel.truncated, true);
	assert.ok(sel.messageCount < 12);
	assert.ok(sel.body.includes("marker-12"));
	assert.ok(!sel.body.includes("marker-1 "));
	assert.ok(Buffer.byteLength(sel.body, "utf8") <= TOTAL_CAP);
});

ok("selection: anchored metadata is reported and forced anchors survive the budget", () => {
	const big = "y".repeat(5000);
	const lines = [line({ type: "session", version: 3, id: "s", timestamp: "2026-09-22T10:00:00.000Z", cwd: "/p" })];
	for (let i = 1; i <= 10; i++) lines.push(msg("user", `marker-${i} ${big}`, `2026-09-22T10:${String(i).padStart(2, "0")}:00.000Z`, `b${i}`));
	const anchor = "2026-09-22T10:05:00.000Z";
	const far = "2026-09-22T10:09:00.000Z";
	const sel = selectAnchoredExcerpt(lines.join("\n"), anchor, [anchor, far]);
	assert.deepEqual(sel.anchored, { ts: anchor });
	assert.equal(sel.truncated, true);
	assert.ok(sel.body.includes("marker-5"), "window center kept");
	assert.ok(sel.body.includes("marker-9"), "far anchor kept");
	assert.ok(!sel.body.includes("marker-1 "));
	assert.equal((sel.body.match(/marker-\d+ /g) ?? []).length, sel.messageCount);
	assert.ok(Buffer.byteLength(sel.body, "utf8") <= TOTAL_CAP);
});

ok("selection: the byte cap holds for multi-byte text", () => {
	const wide = "é".repeat(4000); // 2 bytes per character
	const lines = [line({ type: "session", version: 3, id: "s", timestamp: "2026-09-22T10:00:00.000Z", cwd: "/p" })];
	for (let i = 1; i <= 10; i++) lines.push(msg("user", `wide-${i} ${wide}`, `2026-09-22T10:${String(i).padStart(2, "0")}:00.000Z`, `w${i}`));
	const sel = selectTailExcerpt(lines.join("\n"));
	assert.equal(sel.truncated, true);
	assert.ok(Buffer.byteLength(sel.body, "utf8") <= TOTAL_CAP, `body was ${Buffer.byteLength(sel.body, "utf8")} bytes`);
});

// ── sessions directory resolution (store.ts) ─────────────────────────────────
console.log("store.ts: sessionsDir");

ok("sessionsDir: explicit home wins, then PI_CODING_AGENT_DIR, then ~/.pi/agent", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		delete process.env.PI_CODING_AGENT_DIR;
		assert.equal(sessionsDir("/tmp/home"), join("/tmp/home", ".pi", "agent", "sessions"));
		assert.equal(sessionsDir(), join(homedir(), ".pi", "agent", "sessions"));
		process.env.PI_CODING_AGENT_DIR = "/tmp/agent-dir";
		assert.equal(sessionsDir(), join("/tmp/agent-dir", "sessions"));
		assert.equal(sessionsDir("/tmp/home"), join("/tmp/home", ".pi", "agent", "sessions"), "explicit home wins");
		process.env.PI_CODING_AGENT_DIR = "~/custom-agent";
		assert.equal(sessionsDir(), join(homedir(), "custom-agent", "sessions"));
		process.env.PI_CODING_AGENT_DIR = "";
		assert.equal(sessionsDir(), join(homedir(), ".pi", "agent", "sessions"), "empty override falls back");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

// ── excerpt orchestration (excerpt.ts) ──────────────────────────────────────
console.log("excerpt.ts");

const { buildExcerpt, excerptText, excerptToolResult } = await import("../extensions/session-search/excerpt.ts");
const { excerptOutputSchema } = await import("../extensions/session-search/schema.ts");

/** Every envelope, success or failure, must satisfy the declared output schema. */
function assertEnvelope(env: any, label: string = "") {
	assert.equal(Value.Check(excerptOutputSchema, env), true, `${label}: ${JSON.stringify(env).slice(0, 200)}`);
	if (!env.ok) assert.equal(env.error !== undefined, true, `${label}: failures carry an error`);
}

/** A realistic session: a ~100KB system prompt and an ~830KB toolResult line. */
function excerptFixture(): string {
	const systemPrompt = "S".repeat(100 * 1024);
	const toolOutput = "T".repeat(830 * 1024);
	const lines = [
		line({ type: "session", version: 3, id: "sess-ex", timestamp: "2026-10-28T00:00:00.000Z", cwd: "/proj/thing" }),
		line({ type: "model_change", id: "mc", timestamp: "2026-10-28T00:00:00.001Z", provider: "p", modelId: "m" }),
		msg("system", systemPrompt, "2026-10-28T00:00:01.000Z", "sys"),
	];
	for (let i = 1; i <= 12; i++) {
		const ts = `2026-10-28T00:${String(i).padStart(2, "0")}:00.000Z`;
		lines.push(msg(i % 2 === 1 ? "user" : "assistant", `conversation turn ${i} about the intake sampler`, ts, `c${i}`));
		if (i === 4) lines.push(line({ type: "message", id: "tr4", timestamp: ts, message: { role: "toolResult", content: [{ type: "text", text: toolOutput }] } }));
	}
	lines.push(line({ type: "session_info", id: "si", timestamp: "2026-10-28T00:13:00.000Z", name: "excerpt fixture session" }));
	return lines.join("\n");
}

const exTmp = mkdtempSync(join(tmpdir(), "session-excerpt-test-"));
try {
	const root = join(exTmp, "sessions");
	const proj = join(root, "--proj--");
	mkdirSync(proj, { recursive: true });
	const content = excerptFixture();
	const sessionFile = join(proj, "2026-10-28T00-00-00-000Z_ex.jsonl");
	writeFileSync(sessionFile, content);

	ok("excerpt: no query returns the tail, without the system prompt or tool output", () => {
		const env = buildExcerpt({ path: sessionFile, sessionsRoot: root });
		assertEnvelope(env, "tail");
		assert.equal(env.ok, true);
		assert.deepEqual(env.anchored, { tail: true });
		assert.equal(env.messageCount, 10);
		assert.equal(env.truncated, false);
		assert.ok(env.body.includes("conversation turn 12"));
		assert.ok(env.body.includes("conversation turn 3"));
		assert.ok(!env.body.includes("conversation turn 2"));
		assert.ok(!env.body.includes("SSSS"));
		assert.ok(!env.body.includes("TTTT"));
		assert.equal(env.sessionId, "sess-ex");
		assert.equal(env.name, "excerpt fixture session");
		assert.equal(env.cwd, "/proj/thing");
		assert.equal(env.selfSession, false);
		assert.ok(excerptText(env).startsWith("Excerpt from \"excerpt fixture session\" (/proj/thing, 2026-10-28, via session_excerpt)"));
	});

	ok("excerpt: a query anchors the window on its matches", () => {
		const env = buildExcerpt({ path: sessionFile, sessionsRoot: root, query: "turn 6" });
		assertEnvelope(env, "anchored");
		assert.equal(env.ok, true);
		assert.deepEqual(env.anchored, { ts: "2026-10-28T00:06:00.000Z" });
		assert.equal(env.messageCount, 11); // the symmetric +/- 5 window
		assert.ok(env.body.includes("conversation turn 6"));
		assert.ok(env.body.includes("conversation turn 1"));
		assert.ok(env.body.includes("conversation turn 11"));
		assert.ok(!env.body.includes("conversation turn 12"));
	});

	ok("excerpt: a query that matches nothing falls back to the labeled tail", () => {
		const env = buildExcerpt({ path: sessionFile, sessionsRoot: root, query: "zzz-not-present" });
		assert.equal(env.ok, true);
		assert.deepEqual(env.anchored, { queryMissed: true });
		assert.equal(env.messageCount, 10);
		assert.ok(excerptText(env).includes("the query matched nothing in this session"));
	});

	ok("excerpt: the active session's own file is allowed and flagged", () => {
		const env = buildExcerpt({ path: sessionFile, sessionsRoot: root, activeSessionPath: sessionFile });
		assert.equal(env.selfSession, true);
		assert.ok(excerptText(env).includes(", this session,"));
		const other = buildExcerpt({ path: sessionFile, sessionsRoot: root, activeSessionPath: join(proj, "other.jsonl") });
		assert.equal(other.selfSession, false);
	});

	ok("excerpt: paths outside the sessions tree are rejected", () => {
		const siblingDir = join(exTmp, "sessions-other");
		mkdirSync(siblingDir, { recursive: true });
		const siblingFile = join(siblingDir, "x.jsonl");
		writeFileSync(siblingFile, content);
		const outside = join(exTmp, "outside.jsonl");
		writeFileSync(outside, content);
		for (const p of [siblingFile, join(root, "..", "sessions-other", "x.jsonl"), outside]) {
			const env = buildExcerpt({ path: p, sessionsRoot: root });
			assertEnvelope(env, p);
			assert.equal(env.ok, false, p);
			assert.equal(env.error?.kind, "outside_sessions", p);
			assert.equal(env.messageCount, 0, p);
			assert.equal(env.body, "", p);
		}
	});

	ok("excerpt: a symlink inside the tree cannot escape it", () => {
		const outside = join(exTmp, "secret.jsonl");
		writeFileSync(outside, content);
		const link = join(proj, "linked.jsonl");
		symlinkSync(outside, link);
		const env = buildExcerpt({ path: link, sessionsRoot: root });
		assert.equal(env.ok, false);
		assert.equal(env.error?.kind, "outside_sessions");
	});

	ok("excerpt: a symlinked sessions root is still usable", () => {
		const realRoot = join(exTmp, "real-sessions");
		mkdirSync(join(realRoot, "--p--"), { recursive: true });
		writeFileSync(join(realRoot, "--p--", "s.jsonl"), content);
		const linkRoot = join(exTmp, "linked-sessions");
		symlinkSync(realRoot, linkRoot);
		const env = buildExcerpt({ path: join(linkRoot, "--p--", "s.jsonl"), sessionsRoot: linkRoot });
		assert.equal(env.ok, true, env.error?.message ?? "");
		assert.ok(env.body.includes("conversation turn 12"));
	});

	ok("excerpt: missing, non-regular, and unreadable targets are 'unreadable'", () => {
		assert.equal(buildExcerpt({ path: join(proj, "nope.jsonl"), sessionsRoot: root }).error?.kind, "unreadable");
		const dir = join(proj, "dir.jsonl");
		mkdirSync(dir);
		assert.equal(buildExcerpt({ path: dir, sessionsRoot: root }).error?.kind, "unreadable");
		const env = buildExcerpt({
			path: sessionFile,
			sessionsRoot: root,
			readFile: () => {
				throw new Error("EACCES: permission denied");
			},
		});
		assertEnvelope(env, "read failure");
		assert.equal(env.error?.kind, "unreadable");
		assert.ok(env.error?.message.includes("EACCES"));
	});

	ok("excerpt: non-session files are rejected", () => {
		const notJsonl = join(proj, "notes.txt");
		writeFileSync(notJsonl, content);
		assert.equal(buildExcerpt({ path: notJsonl, sessionsRoot: root }).error?.kind, "not_a_session");
		const plain = join(proj, "plain.jsonl");
		writeFileSync(plain, msg("user", "just a message", "2026-10-28T00:00:00.000Z", "m"));
		assert.equal(buildExcerpt({ path: plain, sessionsRoot: root }).error?.kind, "not_a_session");
		const empty = join(proj, "empty.jsonl");
		writeFileSync(empty, "");
		assert.equal(buildExcerpt({ path: empty, sessionsRoot: root }).error?.kind, "not_a_session");
		assert.equal(buildExcerpt({ path: "   ", sessionsRoot: root }).error?.kind, "not_a_session");
	});

	ok("excerpt: cancellation is reported before and after the read", () => {
		const before = new AbortController();
		before.abort();
		const early = buildExcerpt({ path: sessionFile, sessionsRoot: root, signal: before.signal });
		assert.equal(early.error?.kind, "cancelled");
		const after = new AbortController();
		const late = buildExcerpt({
			path: sessionFile,
			sessionsRoot: root,
			signal: after.signal,
			readFile: (p) => {
				after.abort();
				return readFileSync(p, "utf8");
			},
		});
		assert.equal(late.error?.kind, "cancelled");
	});

	ok("excerpt: a session with no indexable content is an empty success", () => {
		const meta = join(proj, "meta.jsonl");
		writeFileSync(meta, line({ type: "session", version: 3, id: "sess-meta", timestamp: "2026-10-28T00:00:00.000Z", cwd: "/x" }));
		const env = buildExcerpt({ path: meta, sessionsRoot: root });
		assertEnvelope(env, "metadata only");
		assert.equal(env.ok, true);
		assert.equal(env.messageCount, 0);
		assert.equal(env.body, "");
		assert.equal(env.sessionId, "sess-meta");
		assert.ok(excerptText(env).includes("no indexable messages"));
	});

	ok("excerpt: the tool result mirrors the envelope and marks failures", () => {
		const okEnv = buildExcerpt({ path: sessionFile, sessionsRoot: root });
		const result = excerptToolResult(okEnv);
		assert.equal(result.isError, false);
		assert.equal(JSON.stringify(result.structuredContent), JSON.stringify(result.details.result));
		assert.deepEqual(result.structuredContent, okEnv);
		assert.equal(result.content[0].type, "text");
		assert.ok(result.content[0].text.startsWith("Excerpt from"));
		assert.ok(result.content[0].text.includes("conversation turn 12"));
		const bad = excerptToolResult(buildExcerpt({ path: join(exTmp, "outside.jsonl"), sessionsRoot: root }));
		assert.equal(bad.isError, true);
		assert.equal(bad.structuredContent.ok, false);
		assert.ok(bad.content[0].text.includes("outside_sessions"));
	});

	ok("excerpt: reading a session writes no files and consults no index", () => {
		const rootBefore = readdirSync(root).sort();
		const projBefore = readdirSync(proj).sort();
		buildExcerpt({ path: sessionFile, sessionsRoot: root, query: "sampler" });
		buildExcerpt({ path: sessionFile, sessionsRoot: root });
		assert.deepEqual(readdirSync(root).sort(), rootBefore);
		assert.deepEqual(readdirSync(proj).sort(), projBefore);
	});
} finally {
	rmSync(exTmp, { recursive: true, force: true });
}

console.log(`\n${passed} tests passed`);
