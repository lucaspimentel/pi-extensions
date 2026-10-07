// Unit tests for the update-jira extension: configuration validation,
// branch/key resolution, digest shaping, result envelopes with the text
// budget and spill handling, the per-ticket write queue, and the pointer
// state machine. Network-free by construction.
//
// Run: node --test tests/update-jira-unit.test.mts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	DEFAULT_BRANCH_KEY_REGEX,
	configWarningId,
	isValidKey,
	normalizeKey,
	parseConfig,
	parseConfigText,
	validateSiteUrl,
} from "../extensions/update-jira/config.ts";
import {
	detectGitBranch,
	extractBranchKeys,
	resolveBranchTarget,
	resolvePullRequest,
	resolveTarget,
	validateRemoteLinkUrl,
	type SubprocessRunner,
} from "../extensions/update-jira/branch.ts";
import { buildIssueDigest, renderDigestText, truncateDescription } from "../extensions/update-jira/digest.ts";
import {
	byteLength,
	buildFullText,
	buildSpillText,
	createSpillManager,
	TEXT_BUDGET_BYTES,
} from "../extensions/update-jira/results.ts";
import { WriteQueue, QueuedCancelledError } from "../extensions/update-jira/write-queue.ts";
import {
	decidePointerMessage,
	reconstructLastPointer,
	POINTER_CUSTOM_TYPE,
	type PointerObservation,
} from "../extensions/update-jira/context.ts";
import { classifyOutcome, extractServerData, parseNestedOutcome } from "../extensions/update-jira/mcp.ts";

const fixturesDir = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "update-jira");
function readFixture(name: string): unknown {
	return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
}

// ── Configuration ────────────────────────────────────────────────────────────

test("config: valid configuration with defaults applied in memory", () => {
	const result = parseConfig({ siteUrl: "https://datadoghq.atlassian.net" });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.config.site, "https://datadoghq.atlassian.net/");
	assert.equal(result.config.branchKeyRegex, DEFAULT_BRANCH_KEY_REGEX);
	assert.deepEqual(result.config.branchMappings, {});
});

test("config: trailing slash and casing of site are normalized for identity", () => {
	const a = parseConfig({ siteUrl: "https://example.atlassian.net" });
	const b = parseConfig({ siteUrl: "https://example.atlassian.net/" });
	assert.equal(a.ok && b.ok && a.config.site === b.config.site, true);
});

test("config: site URL validation rejects bad shapes", () => {
	for (const bad of [
		undefined,
		"",
		"http://example.atlassian.net",
		"ftp://example.atlassian.net",
		"https://user:pass@example.atlassian.net",
		"https://example.atlassian.net/jira",
		"https://example.atlassian.net/?x=1",
		"https://example.atlassian.net/#frag",
		"not a url",
	]) {
		const result = validateSiteUrl(bad);
		assert.equal(result.ok, false, `expected rejection for ${String(bad)}`);
	}
});

test("config: unknown keys and invalid regexes and mappings fail closed", () => {
	assert.equal(parseConfig({ siteUrl: "https://e.atlassian.net", extra: true }).ok, false);
	assert.equal(parseConfig({ siteUrl: "https://e.atlassian.net", branchKeyRegex: "(" }).ok, false);
	assert.equal(parseConfig({ siteUrl: "https://e.atlassian.net", branchKeyRegex: "(?:)" }).ok, false, "empty match rejected");
	assert.equal(parseConfig({ siteUrl: "https://e.atlassian.net", branchKeyRegex: "" }).ok, false);
	assert.equal(parseConfig({ siteUrl: "https://e.atlassian.net", branchMappings: { "x": "not-a-key" } }).ok, false);
	assert.equal(parseConfig({ siteUrl: "https://e.atlassian.net", branchMappings: [] }).ok, false);
	assert.equal(parseConfig([]).ok, false);
	assert.equal(parseConfigText("{ nope").ok, false);
});

test("config: mapping values are normalized to uppercased keys", () => {
	const result = parseConfig({ siteUrl: "https://e.atlassian.net", branchMappings: { "  main ": " proj-1 " } });
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.config.branchMappings["  main "], "PROJ-1");
});

test("config: warning identity is stable per unchanged invalid state", () => {
	const bad = parseConfig({ siteUrl: "https://e.atlassian.net", branchKeyRegex: "(" });
	assert.equal(configWarningId(bad), configWarningId(parseConfig({ siteUrl: "https://e.atlassian.net", branchKeyRegex: "(" })));
	assert.equal(
		configWarningId(parseConfig({ siteUrl: "https://e.atlassian.net", branchKeyRegex: "[" })),
		"branchKeyRegex is not a valid regular expression: Invalid regular expression: /[/: Unterminated character class",
	);
	assert.equal(configWarningId(parseConfig({ siteUrl: "https://e.atlassian.net" })), undefined);
});

test("keys: normalization and validation", () => {
	assert.equal(normalizeKey("  sles-3026 "), "SLES-3026");
	assert.equal(isValidKey("PROJ-123"), true);
	assert.equal(isValidKey("ABC1-9"), true);
	assert.equal(isValidKey("proj-123"), false, "must be normalized first");
	assert.equal(isValidKey("P-1"), false);
	assert.equal(isValidKey("PROJ_1"), false);
	assert.equal(isValidKey("1PROJ-1"), false);
});

// ── Branch detection and target resolution ──────────────────────────────────

function fakeRun(result: Partial<{ code: number | null; stdout: string; stderr: string; error?: string }>, calls?: Array<{ command: string; args: string[]; cwd: string }>): SubprocessRunner {
	return async (command, args, cwd) => {
		calls?.push({ command, args, cwd });
		return { code: 0, stdout: "", stderr: "", ...result };
	};
}

test("branch: detached HEAD and genuine failures are distinguished", async () => {
	const detached = await detectGitBranch(fakeRun({ stdout: "HEAD\n" }), "/repo");
	assert.deepEqual(detached, { ok: true, branch: null });
	const named = await detectGitBranch(fakeRun({ stdout: "feature/SLES-3026-fix\n" }), "/repo");
	assert.deepEqual(named, { ok: true, branch: "feature/SLES-3026-fix" });
	const failed = await detectGitBranch(fakeRun({ code: 128, stderr: "fatal: not a git repository" }), "/repo");
	assert.equal(failed.ok, false);
	if (failed.ok) return;
	assert.ok(failed.message.includes("not a git repository"));
});

test("branch: whole-match extraction, dedupe, and zero-length rejection", () => {
	const ok = extractBranchKeys("sles-3026-fix-SLES-3026", DEFAULT_BRANCH_KEY_REGEX);
	assert.deepEqual(ok, { ok: true, keys: ["SLES-3026"] });
	const multi = extractBranchKeys("abc-1-SLES-3026-and-DEF-2", DEFAULT_BRANCH_KEY_REGEX);
	assert.equal(multi.ok && multi.keys.join(",") === ["ABC-1", "SLES-3026", "DEF-2"].join(","), true, JSON.stringify(multi));
	const zero = extractBranchKeys("x", "(?:)");
	assert.equal(zero.ok, false);
	if (!zero.ok) assert.equal(zero.kind, "config_invalid");
});

test("branch: resolveTarget explicit key path bypasses git", async () => {
	const calls: Array<{ command: string }> = [];
	const run = fakeRun({}, calls);
	const config = parseConfig({ siteUrl: "https://e.atlassian.net" });
	assert.ok(config.ok);
	const good = await resolveTarget({ config: config.config, ticketKey: " sles-3026 ", cwd: "/repo", run });
	assert.deepEqual(good, { ok: true, key: "SLES-3026", source: "explicit" });
	assert.equal(calls.length, 0, "explicit targets do not run git");
	const bad = await resolveTarget({ config: config.config, ticketKey: "nope", cwd: "/repo", run });
	assert.equal(bad.ok, false);
	if (!bad.ok) assert.equal(bad.kind, "invalid_key");
});

test("branch: resolveTarget regex, mapping, ambiguous, and git failure paths", async () => {
	const config = parseConfig({
		siteUrl: "https://e.atlassian.net",
		branchMappings: { "release": "MAP-9" },
	});
	assert.ok(config.ok);
	const resolved = await resolveTarget({ config: config.config, cwd: "/repo", run: fakeRun({ stdout: "feature/SLES-3026\n" }) });
	assert.deepEqual(resolved, { ok: true, key: "SLES-3026", source: "regex", branch: "feature/SLES-3026" });
	const mapped = await resolveTarget({ config: config.config, cwd: "/repo", run: fakeRun({ stdout: "release\n" }) });
	assert.deepEqual(mapped, { ok: true, key: "MAP-9", source: "mapping", branch: "release" });
	const ambiguous = await resolveTarget({ config: config.config, cwd: "/repo", run: fakeRun({ stdout: "ABC-1-DEF-2\n" }) });
	assert.equal(ambiguous.ok, false);
	if (!ambiguous.ok) {
		assert.equal(ambiguous.kind, "ambiguous_key");
		assert.deepEqual(ambiguous.candidates, ["ABC-1", "DEF-2"]);
	}
	const none = await resolveTarget({ config: config.config, cwd: "/repo", run: fakeRun({ stdout: "no-key-here\n" }) });
	assert.equal(none.ok, false);
	if (!none.ok) assert.equal(none.kind, "no_ticket");
	const failed = await resolveTarget({ config: config.config, cwd: "/repo", run: fakeRun({ code: 1, stderr: "boom" }) });
	assert.equal(failed.ok, false);
	if (!failed.ok) assert.equal(failed.kind, "subprocess_failed");
});

test("branch: pure branch target resolution matches resolveTarget", () => {
	const config = parseConfig({ siteUrl: "https://e.atlassian.net" });
	assert.ok(config.ok);
	assert.deepEqual(resolveBranchTarget(config.config, null).ok, false);
	assert.deepEqual(resolveBranchTarget(config.config, "map-branch-ok"), {
		ok: false,
		kind: "no_ticket",
		message: 'no ticket key was found in branch "map-branch-ok" and no exact branch mapping matches it',
	});
});

test("branch: gh PR resolution success, failure, and malformed output", async () => {
	const good = await resolvePullRequest(fakeRun({ stdout: '{"url":"https://github.com/o/r/pull/7","title":"T"}' }), "/repo");
	assert.deepEqual(good, { ok: true, pr: { url: "https://github.com/o/r/pull/7", title: "T" } });
	const failed = await resolvePullRequest(fakeRun({ code: 1, stderr: "no PR" }), "/repo");
	assert.equal(failed.ok, false);
	if (!failed.ok) assert.equal(failed.kind, "subprocess_failed");
	const malformed = await resolvePullRequest(fakeRun({ stdout: "not json" }), "/repo");
	assert.equal(malformed.ok, false);
	if (!malformed.ok) assert.equal(malformed.kind, "invalid_response");
	const noUrl = await resolvePullRequest(fakeRun({ stdout: '{"title":"T"}' }), "/repo");
	assert.equal(noUrl.ok, false);
});

test("branch: remote link URLs must be credential-free https", () => {
	assert.deepEqual(validateRemoteLinkUrl("https://github.com/o/r/pull/1"), { ok: true });
	assert.equal(validateRemoteLinkUrl("http://github.com/o/r/pull/1").ok, false);
	assert.equal(validateRemoteLinkUrl("https://user@github.com/o/r/pull/1").ok, false);
	assert.equal(validateRemoteLinkUrl("javascript:alert(1)").ok, false);
});

// ── Digest ───────────────────────────────────────────────────────────────────

test("digest: shapes the fixture payload and preserves format metadata", () => {
	const fixture = readFixture("issue-digest.json") as { data: unknown };
	const result = buildIssueDigest(fixture.data);
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.equal(result.digest.key, "EXAMPLE-101");
	assert.equal(result.digest.summary, "Placeholder summary text");
	assert.equal(result.digest.status, "In Progress");
	assert.equal(result.digest.assignee, "Example User");
	assert.equal(result.digest.descriptionTruncated, false);
	assert.equal(result.digest.appliedContentFormat, "markdown");
});

test("digest: handles missing fields, unassigned issues, and null descriptions", () => {
	const result = buildIssueDigest({ key: "EXAMPLE-2", fields: { description: null } });
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.equal(result.digest.summary, "(no summary)");
	assert.equal(result.digest.status, "(unknown status)");
	assert.equal(result.digest.assignee, "Unassigned");
	assert.equal(result.digest.description, "");
	assert.equal(result.digest.descriptionTruncated, false);
});

test("digest: description is capped at 1500 characters with a marker", () => {
	const long = "x".repeat(2000);
	const truncated = truncateDescription(long);
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.text.length, 1500);
	const digest = buildIssueDigest({ key: "EXAMPLE-3", fields: { description: long } });
	assert.ok(digest.ok);
	if (!digest.ok) return;
	assert.equal(digest.digest.descriptionTruncated, true);
	const text = renderDigestText(digest.digest);
	assert.ok(text.includes("raw: true"), "truncation guidance points at raw: true");
});

test("digest: HTML bodies are flagged as unsafe write-back sources", () => {
	const digest = buildIssueDigest({ key: "EXAMPLE-4", fields: { description: "<p>x</p>" }, appliedContentFormat: "html", warning: "override happened" });
	assert.ok(digest.ok);
	if (!digest.ok) return;
	const text = renderDigestText(digest.digest);
	assert.ok(text.includes("not a safe write-back source"));
	assert.ok(text.includes("override happened"));
});

test("digest: rejects payloads without an issue key", () => {
	assert.equal(buildIssueDigest({}).ok, false);
	assert.equal(buildIssueDigest("nope").ok, false);
});

// ── Result envelope and spill ────────────────────────────────────────────────

const baseEnvelope = {
	tool: "jira_read" as const,
	action: "get",
	site: "https://e.atlassian.net/",
	ticket: "EXAMPLE-1",
	ok: true,
	data: { key: "EXAMPLE-1" },
};

test("results: full text and byte budget measurement", () => {
	const text = buildFullText(baseEnvelope);
	assert.ok(text.includes("jira_read get EXAMPLE-1"));
	assert.ok(text.includes("EXAMPLE-1"));
	assert.equal(byteLength("aé"), 3);
	assert.ok(byteLength(text) < TEXT_BUDGET_BYTES);
});

test("results: oversized results spill with owner-only permissions and cleanup", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-jira-test-"));
	try {
		const manager = createSpillManager({ tmpRoot: dir }, "session-1");
		const big = { ...baseEnvelope, data: { blob: "y".repeat(TEXT_BUDGET_BYTES) } };
		const written = manager.write(big);
		assert.ok("path" in written);
		const content = JSON.parse(fs.readFileSync(written.path, "utf8"));
		assert.equal(content.spillPath, written.path, "the final spill path is included in the saved envelope");
		assert.deepEqual(content.data, big.data);
		if (process.platform !== "win32") {
			assert.equal(fs.statSync(path.join(dir, "update-jira-spill", "session-1")).mode & 0o777, 0o700);
			assert.equal(fs.statSync(written.path).mode & 0o777, 0o600);
		}
		assert.equal(buildSpillText(big, written.path).includes(written.path), true);
		manager.cleanup();
		assert.equal(fs.existsSync(path.join(dir, "update-jira-spill", "session-1")), false);
		manager.cleanup(); // idempotent
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("results: spill write failure is reported without throwing", () => {
	const manager = createSpillManager(
		{
			tmpRoot: "/proc/definitely/not/writable",
			mkdirTmpRoot: () => {
				throw new Error("denied");
			},
		},
		"session-2",
	);
	const result = manager.write(baseEnvelope);
	assert.ok("error" in result);
	if ("error" in result) assert.equal(result.error, "denied");
});

// ── Write queue ──────────────────────────────────────────────────────────────

test("queue: same ticket serializes, different tickets run concurrently", async () => {
	const queue = new WriteQueue();
	const events: string[] = [];
	let release1: (() => void) | undefined;
	const gate1 = new Promise<void>((r) => (release1 = r));
	const t1 = queue.enqueue("site/", "A-1", async () => {
		events.push("a1-start");
		await gate1;
		events.push("a1-end");
	});
	const t2 = queue.enqueue("site/", "A-1", async () => {
		events.push("a2-start");
	});
	const t3 = queue.enqueue("site/", "B-2", async () => {
		events.push("b3-start");
	});
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(events, ["a1-start", "b3-start"], "B-2 is not blocked by A-1");
	release1!();
	await Promise.all([t1, t2, t3]);
	assert.deepEqual(events, ["a1-start", "b3-start", "a1-end", "a2-start"]);
});

test("queue: queued cancellation prevents dispatch and releases ownership", async () => {
	const queue = new WriteQueue();
	const events: string[] = [];
	let release: (() => void) | undefined;
	const gate = new Promise<void>((r) => (release = r));
	const first = queue.enqueue("site/", "A-1", async () => {
		events.push("first-start");
		await gate;
		events.push("first-end");
	});
	const second = queue.enqueue("site/", "A-1", async () => {
		events.push("second-start");
	});
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(queue.cancelPending("site/", "A-1"), 1);
	release!();
	await first;
	await assert.rejects(second, QueuedCancelledError);
	assert.deepEqual(events, ["first-start", "first-end"], "the cancelled task never started");
	// Ownership released: a new task runs normally.
	const third = await queue.enqueue("site/", "A-1", async () => "ok");
	assert.equal(third, "ok");
});

test("queue: failure releases the queue for the next task", async () => {
	const queue = new WriteQueue();
	await assert.rejects(queue.enqueue("site/", "A-1", async () => {
		throw new Error("boom");
	}), /boom/);
	const result = await queue.enqueue("site/", "A-1", async () => "recovered");
	assert.equal(result, "recovered");
});

// ── Pointer state machine ────────────────────────────────────────────────────

function observation(overrides: Partial<PointerObservation> & { outcome: PointerObservation["outcome"] }): PointerObservation {
	return { site: "https://e.atlassian.net/", cwd: "/repo", branch: "feature/x", ...overrides };
}

test("pointer: fresh resolved state emits a pointer, unchanged state suppresses", () => {
	const first = observation({ outcome: { status: "resolved", key: "SLES-1" } });
	const message = decidePointerMessage(first, undefined);
	assert.ok(message);
	assert.equal(message.customType, POINTER_CUSTOM_TYPE);
	assert.equal(message.display, true);
	assert.ok(message.content.includes("SLES-1"));
	assert.ok(message.content.includes("jira_read"));
	assert.equal(decidePointerMessage(first, { observation: first, emitted: "pointer" }), undefined);
});

test("pointer: A to B to A emits on every change", () => {
	const a = observation({ outcome: { status: "resolved", key: "SLES-1" } });
	const b = observation({ outcome: { status: "resolved", key: "SLES-2" } });
	const afterA = decidePointerMessage(b, { observation: a, emitted: "pointer" });
	assert.ok(afterA && afterA.content.includes("SLES-2"));
	const backToA = decidePointerMessage(a, { observation: b, emitted: "pointer" });
	assert.ok(backToA && backToA.content.includes("SLES-1"));
});

test("pointer: initial unresolved emits nothing; changed unresolved corrects once", () => {
	const unresolved = observation({ outcome: { status: "unresolved", reason: "no_ticket", message: "nothing found" } });
	assert.equal(decidePointerMessage(unresolved, undefined), undefined);
	const correction = decidePointerMessage(unresolved, { observation: observation({ outcome: { status: "resolved", key: "SLES-1" } }), emitted: "pointer" });
	assert.ok(correction);
	assert.equal(correction.details.emitted, "correction");
	assert.ok(correction.content.includes("no resolved default ticket"));
	assert.equal(decidePointerMessage(unresolved, { observation: unresolved, emitted: "correction" }), undefined, "unchanged corrections suppressed");
	const changed = observation({ branch: "other", outcome: { status: "unresolved", reason: "ambiguous_key", message: "two keys" } });
	const correction2 = decidePointerMessage(changed, { observation: unresolved, emitted: "correction" });
	assert.ok(correction2 && correction2.content.includes("ambiguous_key"));
});

test("pointer: invalid config clears a pointer once per unchanged state", () => {
	const bad1 = observation({ outcome: { status: "config_invalid", message: "bad site", fingerprint: "bad site" } });
	assert.equal(decidePointerMessage(bad1, undefined), undefined, "no pointer to clear");
	const pointer = observation({ outcome: { status: "resolved", key: "SLES-1" } });
	const correction = decidePointerMessage(bad1, { observation: pointer, emitted: "pointer" });
	assert.ok(correction && correction.content.includes("configuration is invalid"));
	assert.equal(decidePointerMessage(bad1, { observation: bad1, emitted: "correction" }), undefined, "same invalid state suppressed");
	const recovered = decidePointerMessage(pointer, { observation: bad1, emitted: "correction" });
	assert.ok(recovered && recovered.details.emitted === "pointer", "valid config allows a fresh pointer");
});

test("pointer: reconstruction reads the last pointer entry from the branch", () => {
	const message = decidePointerMessage(observation({ outcome: { status: "resolved", key: "SLES-1" } }), undefined);
	assert.ok(message);
	const entries = [
		{ type: "message", message: { role: "user" } },
		{ type: "custom_message", customType: POINTER_CUSTOM_TYPE, content: message.content, display: true, details: message.details },
		{ type: "custom_message", customType: "other", content: "x", display: true },
	];
	const reconstructed = reconstructLastPointer(entries);
	assert.ok(reconstructed);
	assert.equal(reconstructed.observation.outcome.status, "resolved");
	if (reconstructed.observation.outcome.status === "resolved") assert.equal(reconstructed.observation.outcome.key, "SLES-1");
	assert.equal(reconstructLastPointer([{ type: "custom_message", customType: "other" }]), undefined);
	assert.equal(reconstructLastPointer("nope"), undefined);
});

// ── Nested outcome parsing and classification ────────────────────────────────

function outcomeWith(result: unknown, isError?: boolean) {
	return { isError, result };
}

test("mcp: nested envelope parsing reads the complete structured content", () => {
	const nested = readFixture("nested-envelope.json") as Record<string, unknown>;
	const parsed = parseNestedOutcome(nested.outcome as never);
	assert.equal(parsed.transportOk, true);
	assert.equal(parsed.serverOk, true);
	assert.equal(parsed.hasStructuredContent, true);
});

test("mcp: server errors are surfaced with status codes and messages", () => {
	const envelope = { content: [{ type: "text", text: JSON.stringify(readFixture("error-not-found.json")) }], isError: true };
	const parsed = parseNestedOutcome(outcomeWith({ content: envelope.content, isError: true, structuredContent: envelope }, true));
	assert.equal(parsed.transportOk, false);
	assert.equal(parsed.serverError?.statusCode, 404);
	const failure = classifyOutcome(parsed, { isWrite: false });
	assert.equal(failure?.kind, "not_found");
	const writeFailure = classifyOutcome(parsed, { isWrite: true });
	assert.equal(writeFailure?.kind, "not_found", "definitive server rejection is not relabelled as unknown");
});

test("mcp: classification covers unavailable tools, blocks, aborts, and malformed bodies", () => {
	const unknown = parseNestedOutcome(outcomeWith({ content: [{ type: "text", text: "Tool mcp__atlassian__nope not found" }] }, true));
	assert.equal(classifyOutcome(unknown, { isWrite: false })?.kind, "tool_unavailable");
	assert.equal(classifyOutcome(unknown, { isWrite: true })?.kind, "tool_unavailable");

	const blocked = parseNestedOutcome(outcomeWith({ content: [{ type: "text", text: "Tool execution was blocked: guard denied" }] }, true));
	assert.equal(classifyOutcome(blocked, { isWrite: false })?.kind, "permission_denied");
	assert.equal(classifyOutcome(blocked, { isWrite: true })?.kind, "permission_denied", "a known block is pre-dispatch");

	const aborted = parseNestedOutcome(outcomeWith({ content: [{ type: "text", text: "Operation aborted" }] }, true));
	assert.equal(classifyOutcome(aborted, { isWrite: false })?.kind, "cancelled");
	assert.equal(classifyOutcome(aborted, { isWrite: true })?.kind, "write_outcome_unknown");

	const opaque = parseNestedOutcome(outcomeWith({ content: [{ type: "text", text: "connect ECONNREFUSED" }] }, true));
	assert.equal(classifyOutcome(opaque, { isWrite: false })?.kind, "transport_error");
	assert.equal(classifyOutcome(opaque, { isWrite: true })?.kind, "write_outcome_unknown", "arbitrary error text is not proof of no dispatch");

	const malformed = parseNestedOutcome(outcomeWith({ content: [{ type: "text", text: "<html>boom</html>" }] }));
	assert.equal(malformed.transportOk, true);
	assert.equal(malformed.serverOk, null);
	assert.equal(classifyOutcome(malformed, { isWrite: false })?.kind, "invalid_response");
	assert.equal(classifyOutcome(malformed, { isWrite: true })?.kind, "write_outcome_unknown");
});

test("mcp: definitive success survives a later abort signal", () => {
	const controller = new AbortController();
	controller.abort();
	const parsed = parseNestedOutcome(
		outcomeWith({ content: [{ type: "text", text: "truncated" }], isError: false, structuredContent: { content: [{ type: "text", text: JSON.stringify({ data: {} }) }], isError: false } }),
	);
	assert.equal(parsed.serverOk, true);
	assert.equal(classifyOutcome(parsed, { isWrite: true, signal: controller.signal }), null);
});

test("mcp: server data extraction uses the observed top-level data envelope", () => {
	assert.deepEqual(extractServerData({ data: { key: "X" } }), { key: "X" });
	assert.deepEqual(extractServerData({ payload: { data: { key: "X" } } }), { key: "X" });
	assert.deepEqual(extractServerData({ data: [] }), []);
});
