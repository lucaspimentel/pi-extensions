// Tests for gh-read API operation orchestration (extensions/gh-read/api.ts).
// Network-free: the requester seam is stubbed with scripted GitHub-shaped
// responses, so no gh child or network is involved. Real-jq filtering has
// its own suite (tests/gh-read-jq.test.mts); jq here uses the injected seam.
//
// Design: docs/gh-read-design.md ("GitHub API operations").
//
// Run: node --test tests/gh-read-api.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { GhApiRunner, setApiSpawnOverride } from "../extensions/gh-read/api-spawn.ts";

import {
	API_DISPLAY_CAP,
	MAX_PAGES_PER_SOURCE,
	PAGE_SIZE,
	type ApiOperationDeps,
	type ApiToolResult,
	runApiOperation,
} from "../extensions/gh-read/api.ts";
import type { ApiRequester, ApiRequestOutcome, GhApiResponse } from "../extensions/gh-read/api-spawn.ts";
import { validateToolParams } from "../extensions/gh-read/validate.ts";

// ── Harness ──────────────────────────────────────────────────────────────────

function response(body: string, headers = ""): Extract<ApiRequestOutcome, { kind: "response" }> {
	return {
		kind: "response",
		httpStatus: 200,
		headers: `HTTP/1.1 200 OK\r\n${headers}\r\n`,
		body,
		bodyBytes: Buffer.byteLength(body, "utf8"),
	} satisfies GhApiResponse;
}

function error(reason: string, httpStatus?: number): ApiRequestOutcome {
	return { kind: "error", reason, ...(httpStatus !== undefined ? { httpStatus } : {}), interrupted: httpStatus !== undefined };
}

interface ScriptedRequester extends ApiRequester {
	requests: string[];
	script: Array<(pathAndQuery: string) => ApiRequestOutcome>;
}

function requester(script: Array<(pathAndQuery: string) => ApiRequestOutcome>): ScriptedRequester {
	const self: ScriptedRequester = {
		requests: [],
		script,
		async request(pathAndQuery: string) {
			self.requests.push(pathAndQuery);
			const next = self.script.shift();
			if (next === undefined) throw new Error(`unexpected request: ${pathAndQuery}`);
			return next(pathAndQuery);
		},
		capturedBytes: () => 0,
		budgetExhausted: () => false,
		deadline: () => Date.now() + 30_000,
	};
	return self;
}

function jsonScript(entries: Array<[string, unknown]>, headers = ""): ScriptedRequester {
	return requester(entries.map(([, value]) => () => response(JSON.stringify(value), headers)));
}

async function run(params: Record<string, unknown>, apiRequester: ApiRequester, deps?: Omit<ApiOperationDeps, "requester">): Promise<ApiToolResult> {
	const checked = validateToolParams(params);
	if (!checked.ok || checked.kind !== "api") throw new Error(`unexpected validation outcome: ${JSON.stringify(checked)}`);
	return await runApiOperation(checked.api, "/repo", undefined, { requester: apiRequester, ...deps });
}

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

function linkHeader(nextPage: number, endpoint: string, query: string): string {
	return `Link: <https://api.github.com/${endpoint}?${query}&page=${nextPage}>; rel="next"\r\n`;
}

for (const subcommand of ["pr comments", "pr reviews"] as const) {
	const endpoint = `repos/OWNER/REPO/pulls/123/${subcommand.split(" ")[1]}`;
	const params = { subcommand, repo: "OWNER/REPO", pr: 123 };
	test(`${subcommand}: empty and verbatim arrays without ref resolution`, async () => {
		for (const data of [[], [{ id: 42, body: "review", state: "CHANGES_REQUESTED", in_reply_to_id: 12, unknown: { nested: [1, null] } }]]) {
			const api = requester([() => response(JSON.stringify(data))]);
			const result = await run(params, api);
			assert.equal(result.isError, undefined);
			assert.deepEqual(api.requests, [`${endpoint}?per_page=100&page=1`]);
			assert.ok(result.content[0].text.endsWith(JSON.stringify(data)));
			assert.equal(result.details.source_complete, true);
			assert.equal(result.details.items_returned, data.length);
		}
	});
	test(`${subcommand}: sequential pages preserve order and duplicates`, async () => {
		const item = { id: 1, in_reply_to_id: 7, nested: { extra: true } };
		const api = requester([
			() => response(JSON.stringify([item]), linkHeader(2, endpoint, "per_page=100")),
			() => response(JSON.stringify([item])),
		]);
		const result = await run(params, api);
		assert.deepEqual(api.requests, [1, 2].map(page => `${endpoint}?per_page=100&page=${page}`));
		assert.ok(result.content[0].text.endsWith(JSON.stringify([item, item])));
		assert.equal(result.details.pages_fetched, 2);
	});
}

for (const subcommand of ["pr comments", "pr reviews"] as const) {
	const params = { subcommand, repo: "OWNER/REPO", pr: 123 };
	const endpoint = `repos/OWNER/REPO/pulls/123/${subcommand.split(" ")[1]}`;
	const token = (overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ v: 1, op: subcommand, repo: params.repo, pr: params.pr, perPage: PAGE_SIZE, source: { page: 11, done: false }, ...overrides })).toString("base64url");
	const data = (result: ApiToolResult) => JSON.parse(result.content[0].text.split("\ndata:\n")[1]!);
	const position = (result: ApiToolResult) => JSON.parse(Buffer.from(result.details.continuation as string, "base64url").toString("utf8"));

	test(`${subcommand}: ten-page bound and independent continuation, newly fetched batch only`, async () => {
		const api = requester(Array.from({ length: MAX_PAGES_PER_SOURCE }, (_, i) => () => response(JSON.stringify([{ id: i + 1 }]), linkHeader(i + 2, endpoint, "per_page=100"))));
		const first = await run(params, api);
		assert.equal(first.isError, undefined);
		assert.equal(first.details.source_complete, false);
		assert.equal(first.details.pages_fetched, 10);
		assert.equal(first.details.items_returned, 10);
		assert.match(first.details.incomplete_reason as string, /page limit/);
		assert.equal(position(first).source.page, 11);
		assert.equal(position(first).op, subcommand);
		assert.equal(first.content[0].text.match(/^continuation:/gm)?.length, 1);
		const next = requester([() => response('[{"id":11}]')]);
		const resumed = await run({ ...params, continuation: first.details.continuation }, next);
		assert.deepEqual(next.requests, [`${endpoint}?per_page=100&page=11`]);
		assert.deepEqual(data(resumed), [{ id: 11 }]);
		assert.equal(resumed.details.resumed, true);
		assert.equal(resumed.details.source_complete, true);
		assert.equal(resumed.details.continuation, undefined);
		assert.match(resumed.content[0].text, /only the newly fetched batch/);
	});

	test(`${subcommand}: invalid token target and page invariants reject before any request`, async () => {
		const variants = [
			{ op: subcommand === "pr comments" ? "pr reviews" : "pr comments" },
			{ repo: "other/repo" }, { pr: 124 }, { pr: "123" }, { pr: 0 },
			{ perPage: 99 }, { perPage: "100" }, { source: null }, { source: [] }, { source: {} },
			...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null, true].map(page => ({ source: { page, done: false } })),
			{ source: { page: 2, done: true } }, { source: { page: 2, done: "false" } },
		];
		for (const variant of variants) {
			const api = requester([]);
			const result = await run({ ...params, continuation: token(variant) }, api);
			assert.equal(result.isError, true, JSON.stringify(variant));
			assert.equal(api.requests.length, 0);
		}
	});

	test(`${subcommand}: unsafe next links never requested and accepted items survive`, async () => {
		for (const url of [
			`https://evil.example/${endpoint}?per_page=100&page=2`,
			`https://api.github.com/${endpoint.replace("123", "124")}?per_page=100&page=2`,
			`https://api.github.com/${endpoint}/extra?per_page=100&page=2`,
			`https://api.github.com/${endpoint}?per_page=50&page=2`,
			`https://api.github.com/${endpoint}?page=2`,
			`https://api.github.com/${endpoint}?per_page=100&page=2&extra=1`,
			...[1, 3].map(page => `https://api.github.com/${endpoint}?per_page=100&page=${page}`),
		]) {
			const api = requester([() => response('[{"id":1}]', `Link: <${url}>; rel="next"\r\n`)]);
			const result = await run(params, api);
			assert.equal(result.isError, true, url);
			assert.equal(api.requests.length, 1);
			assert.equal(api.requests[0], `${endpoint}?per_page=100&page=1`);
			assert.deepEqual(data(result), [{ id: 1 }]);
			assert.equal(position(result).source.page, 2);
			assert.match(result.details.source_error as string, /next-link validation failed/);
		}
	});

	test(`${subcommand}: exactly 100 without next Link is complete; display clipping is separate`, async () => {
		for (const items of [Array.from({ length: 100 }, (_, id) => ({ id })), [{ body: "界🙂".repeat(API_DISPLAY_CAP) }]]) {
			const result = await run(params, requester([() => response(JSON.stringify(items))]));
			assert.equal(result.isError, undefined);
			assert.equal(result.details.source_complete, true);
			assert.equal(result.details.items_returned, items.length);
			assert.equal(result.details.continuation, undefined);
			assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= API_DISPLAY_CAP);
			if (items.length === 1) {
				assert.equal(result.details.output_truncated, true);
				assert.match(result.content[0].text, /NOT complete JSON/);
				assert.ok(!result.content[0].text.includes("\uFFFD"));
				assert.ok(Buffer.byteLength(JSON.stringify(result.details)) < 1000, "no hidden full payload");
			}
		}
	});

	test(`${subcommand}: budget and deadline stops retain partial batch without errors`, async () => {
		for (const stop of ["budget", "deadline"]) {
			let now = 0;
			const api = requester([() => {
				now = 2;
				return response('[{"id":1}]', linkHeader(2, endpoint, "per_page=100"));
			}]);
			if (stop === "budget") api.budgetExhausted = () => api.requests.length > 0;
			else api.deadline = () => 1;
			const result = await run(params, api, { clock: { now: () => now, setTimeout, clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) } });
			assert.equal(result.isError, undefined);
			assert.deepEqual(data(result), [{ id: 1 }]);
			assert.equal(result.details.source_complete, false);
			assert.equal(result.details.pages_fetched, 1);
			assert.equal(position(result).source.page, 2);
			assert.match(result.details.incomplete_reason as string, stop === "budget" ? /budget/ : /deadline/);
		}
	});

	test(`${subcommand}: real runner deadline between responses is a nonerror stop`, async () => {
		let now = 1_000_000;
		let spawns = 0;
		const clock = { now: () => now, setTimeout, clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
		const runner = new GhApiRunner({ clock });
		setApiSpawnOverride(((_command: string, args: string[]) => {
			spawns++;
			assert.equal(args.at(-1), `${endpoint}?per_page=100&page=1`);
			const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
			queueMicrotask(() => {
				child.stdout.emit("data", Buffer.from(`HTTP/1.1 200 OK\r\n${linkHeader(2, endpoint, "per_page=100")}\r\n[{"id":1}]`));
				child.emit("close", 0, null);
				now += 30_000;
			});
			return child;
		}) as never);
		try {
			const result = await run(params, runner, { clock });
			assert.equal(result.isError, undefined);
			assert.deepEqual(data(result), [{ id: 1 }]);
			assert.equal(result.details.source_complete, false);
			assert.equal(position(result).source.page, 2);
			assert.match(result.details.incomplete_reason as string, /deadline/);
			assert.equal(spawns, 1);
		} finally {
			setApiSpawnOverride(null);
		}
	});

	test(`${subcommand}: HTTP, interrupted, JSON and extraction failures retain retry positions`, async () => {
		for (const failure of [error("forbidden diagnostic", 403), error("not found diagnostic", 404), error("response interrupted", 200), response("invalid json"), response('{"not":"array"}')]) {
			for (const partial of [false, true]) {
				const api = requester([
					...(partial ? [() => response('[{"id":1}]', linkHeader(2, endpoint, "per_page=100"))] : []),
					() => failure,
				]);
				const result = await run(params, api);
				assert.equal(result.isError, true);
				assert.deepEqual(data(result), partial ? [{ id: 1 }] : []);
				assert.equal(api.requests.length, partial ? 2 : 1, "no retry");
				assert.equal(position(result).source.page, partial ? 2 : 1);
				if (failure.kind === "error") {
					assert.ok((result.details.source_error as string).includes(failure.reason));
					assert.ok((result.details.source_error as string).includes(String(failure.httpStatus)));
				}
				const retry = requester([() => response("[]")]);
				await run({ ...params, continuation: result.details.continuation }, retry);
				assert.deepEqual(retry.requests, [`${endpoint}?per_page=100&page=${partial ? 2 : 1}`]);
			}
		}
	});

	test(`${subcommand}: jq once on assembled arrays, counts and continuation are unfiltered`, async () => {
		for (const partial of [false, true]) {
			for (const output of ["2", ""]) {
				const api = requester([
					() => response('[{"id":1}]', linkHeader(2, endpoint, "per_page=100")),
					() => partial ? error("forbidden", 403) : response('[{"id":2}]'),
				]);
				let calls = 0;
				const result = await run({ ...params, jq: "length", ...(partial ? { continuation: token({ source: { page: 1, done: false } }) } : {}) }, api, {
					jqRun: async (expression, document) => {
						calls++;
						assert.equal(expression, "length");
						assert.deepEqual(JSON.parse(document), partial ? [{ id: 1 }] : [{ id: 1 }, { id: 2 }]);
						return { kind: "result", output, outputTruncated: false, outputBytes: output.length };
					},
				});
				assert.equal(calls, 1);
				assert.equal(result.details.items_returned, partial ? 1 : 2);
				assert.equal(result.details.source_complete, !partial);
				assert.equal(typeof result.details.continuation, partial ? "string" : "undefined");
				assert.match(result.content[0].text, /mutable reads/);
				assert.match(result.content[0].text, /resolved\/outdated/);
				if (partial) assert.equal(result.details.resumed, true);
			}
		}
		const api = requester([() => response('[{"id":1}]', linkHeader(2, endpoint, "per_page=100")), () => error("forbidden", 403)]);
		const failed = await run({ ...params, jq: "bad" }, api, { jqRun: async () => ({ kind: "error", reason: "compile error" }) });
		assert.equal(failed.isError, true);
		assert.equal(failed.details.items_returned, 1);
		assert.equal(failed.details.source_complete, false);
		assert.equal(typeof failed.details.continuation, "string");
		assert.match(failed.content[0].text, /jq filtering failed/);
	});
}

// ── issue comments: conversation comments on issues and PRs ──────────────────

const ISSUE_ENDPOINT = "repos/OWNER/REPO/issues/123/comments";
const issueParams = { subcommand: "issue comments", repo: "OWNER/REPO", issue: 123 } as const;
// Literal v1 fixtures: these exact strings must keep decoding, and the PR one
// must never be accepted by the issue operation (or vice versa).
const LITERAL_PR_TOKEN = "eyJ2IjoxLCJvcCI6InByIGNvbW1lbnRzIiwicmVwbyI6Ik9XTkVSL1JFUE8iLCJwciI6MTIzLCJwZXJQYWdlIjoxMDAsInNvdXJjZSI6eyJwYWdlIjoyLCJkb25lIjpmYWxzZX19";
const LITERAL_ISSUE_TOKEN = "eyJ2IjoxLCJvcCI6Imlzc3VlIGNvbW1lbnRzIiwicmVwbyI6Ik9XTkVSL1JFUE8iLCJpc3N1ZSI6MTIzLCJwZXJQYWdlIjoxMDAsInNvdXJjZSI6eyJwYWdlIjoyLCJkb25lIjpmYWxzZX19";
const issueToken = (overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ v: 1, op: "issue comments", repo: issueParams.repo, issue: issueParams.issue, perPage: PAGE_SIZE, source: { page: 11, done: false }, ...overrides })).toString("base64url");
const issueData = (result: ApiToolResult) => JSON.parse(result.content[0].text.split("\ndata:\n")[1]!);
const issuePosition = (result: ApiToolResult) => JSON.parse(Buffer.from(result.details.continuation as string, "base64url").toString("utf8"));

const SAMPLE_COMMENT = {
	id: 42,
	user: { login: "lucaspimentel", id: 7, type: "User" },
	created_at: "2026-10-01T12:00:00Z",
	updated_at: "2026-10-02T12:00:00Z",
	body: "conversation comment",
	html_url: "https://github.com/OWNER/REPO/issues/123#issuecomment-42",
	unknown: { nested: [1, null] },
};

test("issue comments: empty and verbatim arrays from the issues endpoint without ref resolution", async () => {
	for (const data of [[], [SAMPLE_COMMENT]]) {
		const api = requester([() => response(JSON.stringify(data))]);
		const result = await run(issueParams, api);
		assert.equal(result.isError, undefined);
		assert.deepEqual(api.requests, [`${ISSUE_ENDPOINT}?per_page=100&page=1`]);
		assert.ok(result.content[0].text.endsWith(JSON.stringify(data)));
		assert.equal(result.details.source_complete, true);
		assert.equal(result.details.items_returned, data.length);
		assert.equal(result.details.repo, "OWNER/REPO");
		assert.equal(result.details.issue, 123);
		assert.equal(result.details.pr, undefined, "issue reads never emit pr metadata");
		assert.ok(!api.requests.some((path) => path.includes("/pulls/")));
	}
});

test("issue comments: sequential pages preserve order and duplicates", async () => {
	const item = { id: 1, body: "dup" };
	const api = requester([
		() => response(JSON.stringify([item]), linkHeader(2, ISSUE_ENDPOINT, "per_page=100")),
		() => response(JSON.stringify([item])),
	]);
	const result = await run(issueParams, api);
	assert.deepEqual(api.requests, [1, 2].map(page => `${ISSUE_ENDPOINT}?per_page=100&page=${page}`));
	assert.ok(result.content[0].text.endsWith(JSON.stringify([item, item])));
	assert.equal(result.details.pages_fetched, 2);
	assert.equal(result.details.source_complete, true);
});

test("issue comments: ten-page bound, exact token shape, and resume returning only the new batch", async () => {
	const api = requester(Array.from({ length: MAX_PAGES_PER_SOURCE }, (_, i) => () => response(JSON.stringify([{ id: i + 1 }]), linkHeader(i + 2, ISSUE_ENDPOINT, "per_page=100"))));
	const first = await run(issueParams, api);
	assert.equal(first.isError, undefined);
	assert.equal(first.details.source_complete, false);
	assert.equal(first.details.pages_fetched, 10);
	assert.equal(first.details.items_returned, 10);
	assert.match(first.details.incomplete_reason as string, /page limit/);
	assert.deepEqual(issuePosition(first), { v: 1, op: "issue comments", repo: "OWNER/REPO", issue: 123, perPage: PAGE_SIZE, source: { page: 11, done: false } });
	assert.equal(first.content[0].text.match(/^continuation:/gm)?.length, 1);
	const next = requester([() => response('[{"id":11}]')]);
	const resumed = await run({ ...issueParams, continuation: first.details.continuation }, next);
	assert.deepEqual(next.requests, [`${ISSUE_ENDPOINT}?per_page=100&page=11`]);
	assert.deepEqual(issueData(resumed), [{ id: 11 }]);
	assert.equal(resumed.details.resumed, true);
	assert.equal(resumed.details.source_complete, true);
	assert.equal(resumed.details.continuation, undefined);
	assert.match(resumed.content[0].text, /only the newly fetched batch/);
});

test("issue comments: literal v1 tokens resume; cross-operation tokens reject before any request", async () => {
	const resumed = await run({ ...issueParams, continuation: LITERAL_ISSUE_TOKEN }, requester([() => response("[]")]));
	assert.deepEqual(resumed.details.resumed, true);

	// The issue operation rejects a PR token, and the PR operation rejects an issue token.
	const issueApi = requester([]);
	const crossIn = await run({ ...issueParams, continuation: LITERAL_PR_TOKEN }, issueApi);
	assert.equal(crossIn.isError, true);
	assert.equal(issueApi.requests.length, 0);
	assert.match(crossIn.content[0].text, /continuation does not match this invocation/);
	const prApi = requester([]);
	const crossOut = await run({ subcommand: "pr comments", repo: "OWNER/REPO", pr: 123, continuation: LITERAL_ISSUE_TOKEN }, prApi);
	assert.equal(crossOut.isError, true);
	assert.equal(prApi.requests.length, 0);
	assert.match(crossOut.content[0].text, /continuation does not match this invocation/);
});

test("issue comments: invalid token target and page invariants reject before any request", async () => {
	const variants = [
		{ op: "pr comments" }, { op: "issue comments " }, { op: 1 },
		{ repo: "other/repo" }, { repo: "owner/repo" }, { repo: 123 },
		{ issue: 124 }, { issue: "123" }, { issue: 0 }, { issue: -1 }, { issue: 1.5 }, { issue: Number.MAX_SAFE_INTEGER + 1 },
		{ issue: undefined },
		{ perPage: 99 }, { perPage: "100" },
		{ source: null }, { source: [] }, { source: {} }, { source: { page: 1 } }, { source: { done: false } },
		...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null, true].map(page => ({ source: { page, done: false } })),
		{ source: { page: 2, done: true } }, { source: { page: 2, done: "false" } },
	];
	for (const variant of variants) {
		const api = requester([]);
		const result = await run({ ...issueParams, continuation: issueToken(variant) }, api);
		assert.equal(result.isError, true, JSON.stringify(variant));
		assert.equal(api.requests.length, 0, JSON.stringify(variant));
	}
});

test("issue comments: unsafe next links never requested and accepted items survive", async () => {
	for (const url of [
		`https://evil.example/${ISSUE_ENDPOINT}?per_page=100&page=2`,
		`https://api.github.com/${ISSUE_ENDPOINT.replace("123", "124")}?per_page=100&page=2`,
		`https://api.github.com/${ISSUE_ENDPOINT}/extra?per_page=100&page=2`,
		`https://api.github.com/${ISSUE_ENDPOINT}?per_page=50&page=2`,
		`https://api.github.com/${ISSUE_ENDPOINT}?page=2`,
		`https://api.github.com/${ISSUE_ENDPOINT}?per_page=100&page=2&extra=1`,
		...[1, 3].map(page => `https://api.github.com/${ISSUE_ENDPOINT}?per_page=100&page=${page}`),
	]) {
		const api = requester([() => response('[{"id":1}]', `Link: <${url}>; rel="next"\r\n`)]);
		const result = await run(issueParams, api);
		assert.equal(result.isError, true, url);
		assert.equal(api.requests.length, 1, url);
		assert.equal(api.requests[0], `${ISSUE_ENDPOINT}?per_page=100&page=1`);
		assert.deepEqual(issueData(result), [{ id: 1 }]);
		assert.equal(issuePosition(result).source.page, 2);
		assert.match(result.details.source_error as string, /next-link validation failed/);
	}
});

test("issue comments: exactly 100 without next Link is complete; display clipping is separate", async () => {
	for (const items of [Array.from({ length: 100 }, (_, id) => ({ id })), [{ body: "界🙂".repeat(API_DISPLAY_CAP) }]]) {
		const result = await run(issueParams, requester([() => response(JSON.stringify(items))]));
		assert.equal(result.isError, undefined);
		assert.equal(result.details.source_complete, true);
		assert.equal(result.details.items_returned, items.length);
		assert.equal(result.details.continuation, undefined, "clipping must not create a continuation");
		assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= API_DISPLAY_CAP);
		if (items.length === 1) {
			assert.equal(result.details.output_truncated, true);
			assert.match(result.content[0].text, /NOT complete JSON/);
			assert.ok(!result.content[0].text.includes("\uFFFD"));
			assert.ok(Buffer.byteLength(JSON.stringify(result.details)) < 1000, "no hidden full payload");
		}
	}
});

test("issue comments: budget and deadline stops retain partial batch without errors", async () => {
	for (const stop of ["budget", "deadline"]) {
		let now = 0;
		const api = requester([() => {
			now = 2;
			return response('[{"id":1}]', linkHeader(2, ISSUE_ENDPOINT, "per_page=100"));
		}]);
		if (stop === "budget") api.budgetExhausted = () => api.requests.length > 0;
		else api.deadline = () => 1;
		const result = await run(issueParams, api, { clock: { now: () => now, setTimeout, clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) } });
		assert.equal(result.isError, undefined);
		assert.deepEqual(issueData(result), [{ id: 1 }]);
		assert.equal(result.details.source_complete, false);
		assert.equal(result.details.pages_fetched, 1);
		assert.equal(issuePosition(result).source.page, 2);
		assert.match(result.details.incomplete_reason as string, stop === "budget" ? /budget/ : /deadline/);
	}
});

test("issue comments: HTTP, interrupted, JSON and extraction failures retain retry positions", async () => {
	for (const failure of [error("forbidden diagnostic", 403), error("not found diagnostic", 404), error("response interrupted", 200), response("invalid json"), response('{"not":"array"}')]) {
		for (const partial of [false, true]) {
			const api = requester([
				...(partial ? [() => response('[{"id":1}]', linkHeader(2, ISSUE_ENDPOINT, "per_page=100"))] : []),
				() => failure,
			]);
			const result = await run(issueParams, api);
			assert.equal(result.isError, true);
			assert.deepEqual(issueData(result), partial ? [{ id: 1 }] : []);
			assert.equal(api.requests.length, partial ? 2 : 1, "no retry");
			assert.equal(issuePosition(result).source.page, partial ? 2 : 1);
			if (failure.kind === "error") {
				assert.ok((result.details.source_error as string).includes(failure.reason));
				assert.ok((result.details.source_error as string).includes(String(failure.httpStatus)));
			}
			const retry = requester([() => response("[]")]);
			await run({ ...issueParams, continuation: result.details.continuation }, retry);
			assert.deepEqual(retry.requests, [`${ISSUE_ENDPOINT}?per_page=100&page=${partial ? 2 : 1}`]);
		}
	}
});

test("issue comments: jq once on the assembled new array; counts and continuation stay unfiltered", async () => {
	for (const partial of [false, true]) {
		for (const output of ["1", ""]) {
			const api = requester([
				() => response('[{"id":1}]', linkHeader(2, ISSUE_ENDPOINT, "per_page=100")),
				() => partial ? error("forbidden", 403) : response('[{"id":2}]'),
			]);
			let calls = 0;
			const result = await run({ ...issueParams, jq: "length", ...(partial ? { continuation: issueToken({ source: { page: 1, done: false } }) } : {}) }, api, {
				jqRun: async (expression, document) => {
					calls++;
					assert.equal(expression, "length");
					assert.deepEqual(JSON.parse(document), partial ? [{ id: 1 }] : [{ id: 1 }, { id: 2 }]);
					return { kind: "result", output, outputTruncated: false, outputBytes: output.length };
				},
			});
			assert.equal(calls, 1);
			assert.equal(result.details.items_returned, partial ? 1 : 2);
			assert.equal(result.details.source_complete, !partial);
			assert.equal(typeof result.details.continuation, partial ? "string" : "undefined");
			assert.match(result.content[0].text, /conversation comments/);
			assert.match(result.content[0].text, /'pr comments' operation/);
			if (partial) assert.equal(result.details.resumed, true);
		}
	}
	const api = requester([() => response('[{"id":1}]', linkHeader(2, ISSUE_ENDPOINT, "per_page=100")), () => error("forbidden", 403)]);
	const failed = await run({ ...issueParams, jq: "bad" }, api, { jqRun: async () => ({ kind: "error", reason: "compile error" }) });
	assert.equal(failed.isError, true);
	assert.equal(failed.details.items_returned, 1);
	assert.equal(failed.details.source_complete, false);
	assert.equal(typeof failed.details.continuation, "string");
	assert.match(failed.content[0].text, /jq filtering failed/);
});

test("issue comments: distinction and mutability notices survive scalar, empty, invalid-continuation, and clipped output", async () => {
	const expectNotices = (result: ApiToolResult) => {
		assert.match(result.content[0].text, /conversation comments for both issues and pull requests/);
		assert.match(result.content[0].text, /inline PR review comments and replies require the 'pr comments' operation/);
		assert.match(result.content[0].text, /offset paging may miss or duplicate items/);
		assert.match(result.content[0].text, /observed traversal, not a historical snapshot/);
		assert.ok(!/resolved\/outdated/.test(result.content[0].text), "review-only caveats stay out of issue reads");
	};
	// Scalar and empty data values from jq, still rendered with notices.
	for (const output of ["42\n", ""]) {
		const result = await run({ ...issueParams, jq: "length" }, requester([() => response("[]")]), {
			jqRun: async () => ({ kind: "result", output, outputTruncated: false, outputBytes: output.length }),
		});
		expectNotices(result);
	}
	// Handler error from an invalid continuation still carries the notices.
	const badContinuation = await run({ ...issueParams, continuation: issueToken({ issue: 999 }) }, requester([]));
	assert.equal(badContinuation.isError, true);
	expectNotices(badContinuation);
	// A clipped 50 KiB result still carries the notices.
	const clipped = await run(issueParams, requester([() => response(JSON.stringify([{ body: "界🙂".repeat(API_DISPLAY_CAP) }]))]));
	assert.equal(clipped.details.output_truncated, true);
	expectNotices(clipped);
});

// ── Contents: ref resolution and pinning ─────────────────────────────────────

test("contents: omitted ref resolves default branch then a full SHA, and pins the read", async () => {
	const apiRequester = jsonScript([
		["repos/o/r", { default_branch: "main" }],
		["commits", { sha: SHA }],
		["contents", { type: "file", path: "README.md", encoding: "base64", size: 5, content: Buffer.from("hello").toString("base64") }],
	]);
	const result = await run({ subcommand: "repo contents", repo: "o/r", path: "README.md" }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.deepEqual(apiRequester.requests, [
		"repos/o/r",
		"repos/o/r/commits/main",
		`repos/o/r/contents/README.md?ref=${SHA}`,
	]);
	assert.ok(result.content[0].text.includes("target: default branch 'main'"));
	assert.ok(result.content[0].text.includes(`resolved_sha: ${SHA}`));
	assert.ok(result.content[0].text.includes("hello"));
});

test("contents: explicit ref resolves once; complete lowercase SHAs skip resolution", async () => {
	const apiRequester = jsonScript([
		["commits", { sha: SHA }],
		["contents", { type: "file", encoding: "base64", size: 1, content: Buffer.from("x").toString("base64") }],
	]);
	await run({ subcommand: "repo contents", repo: "o/r", path: "f.txt", ref: "v1.2.3" }, apiRequester);
	assert.deepEqual(apiRequester.requests, [
		"repos/o/r/commits/v1.2.3",
		`repos/o/r/contents/f.txt?ref=${SHA}`,
	]);

	const direct = jsonScript([
		["contents", { type: "file", encoding: "base64", size: 1, content: Buffer.from("x").toString("base64") }],
	]);
	await run({ subcommand: "repo contents", repo: "o/r", path: "f.txt", ref: SHA }, direct);
	assert.deepEqual(direct.requests, [`repos/o/r/contents/f.txt?ref=${SHA}`]);
});

test("contents: root path hits the bare contents endpoint and returns a directory array", async () => {
	const entries = [{ type: "file", path: "a.txt" }, { type: "dir", path: "src" }];
	const apiRequester = jsonScript([
		["commits", { sha: SHA }],
		["contents", entries],
	]);
	const result = await run({ subcommand: "repo contents", repo: "o/r", path: "", ref: "main" }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.equal(apiRequester.requests[1], `repos/o/r/contents?ref=${SHA}`);
	assert.ok(result.content[0].text.includes(JSON.stringify(entries)));
});

// ── Contents: text, ranges, and unsupported content ─────────────────────────

function fileEntry(content: string, size?: number): Record<string, unknown> {
	return {
		type: "file",
		path: "f.txt",
		encoding: "base64",
		size: size ?? Buffer.byteLength(content, "utf8"),
		content: Buffer.from(content, "utf8").toString("base64"),
	};
}

test("contents: line ranges are 1-based inclusive, preserve CRLF and trailing-newline behavior", async () => {
	// "l1\r\nl2\r\nl3\n": splitLines -> ["l1\r\n","l2\r\n","l3\n"]; range 2..3.
	const apiRequester = jsonScript([
		["commits", { sha: SHA }],
		["contents", fileEntry("l1\r\nl2\r\nl3\n")],
	]);
	const result = await run({ subcommand: "repo contents", repo: "o/r", path: "f.txt", ref: "main", start_line: 2, end_line: 3 }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.ok(result.content[0].text.endsWith("l2\r\nl3\n"));
	assert.ok(result.content[0].text.includes("line_range: 2-3"));
});

test("contents: end alone means 1..end; omitted end means EOF; start past EOF yields empty text", async () => {
	const apiRequester = jsonScript([
		["commits", { sha: SHA }],
		["contents", fileEntry("a\nb\nc\n")],
	]);
	const head = await run({ subcommand: "repo contents", repo: "o/r", path: "f.txt", ref: "main", end_line: 2 }, apiRequester);
	assert.ok(head.content[0].text.includes("a\nb\n"));

	const eof = jsonScript([
		["commits", { sha: SHA }],
		["contents", fileEntry("a\nb\nc\n")],
	]);
	const tail = await run({ subcommand: "repo contents", repo: "o/r", path: "f.txt", ref: "main", start_line: 2 }, eof);
	assert.ok(tail.content[0].text.includes("b\nc\n"));

	const past = jsonScript([
		["commits", { sha: SHA }],
		["contents", fileEntry("a\n")],
	]);
	const empty = await run({ subcommand: "repo contents", repo: "o/r", path: "f.txt", ref: "main", start_line: 5 }, past);
	assert.equal(empty.isError, undefined);
});

test("contents: binary, non-UTF-8, and oversized content return metadata with reasons, not errors", async () => {
	// NUL bytes: binary heuristic.
	const binary = jsonScript([
		["commits", { sha: SHA }],
		["contents", { type: "file", encoding: "base64", size: 4, content: Buffer.from([0x61, 0x00, 0x62, 0x63]).toString("base64") }],
	]);
	const binaryResult = await run({ subcommand: "repo contents", repo: "o/r", path: "f.bin", ref: "main" }, binary);
	assert.equal(binaryResult.isError, undefined);
	assert.ok(binaryResult.content[0].text.includes("binary content"));
	assert.ok(binaryResult.content[0].text.includes("NUL"));

	// Invalid UTF-8.
	const bad = jsonScript([
		["commits", { sha: SHA }],
		["contents", { type: "file", encoding: "base64", size: 2, content: Buffer.from([0xff, 0xfe]).toString("base64") }],
	]);
	const badResult = await run({ subcommand: "repo contents", repo: "o/r", path: "f.txt", ref: "main" }, bad);
	assert.equal(badResult.isError, undefined);
	assert.ok(badResult.content[0].text.includes("not valid UTF-8"));

	// GitHub serves large files without inline content.
	const big = jsonScript([
		["commits", { sha: SHA }],
		["contents", { type: "file", encoding: "base64", size: 5 * 1024 * 1024, content: "" }],
	]);
	const bigResult = await run({ subcommand: "repo contents", repo: "o/r", path: "f.bin", ref: "main" }, big);
	assert.equal(bigResult.isError, undefined);
	assert.ok(bigResult.content[0].text.includes("oversized file"));

	// Malformed base64 from upstream is an error.
	const corrupt = jsonScript([
		["commits", { sha: SHA }],
		["contents", { type: "file", encoding: "base64", size: 4, content: "!!!not-base64!!!" }],
	]);
	const corruptResult = await run({ subcommand: "repo contents", repo: "o/r", path: "f.txt", ref: "main" }, corrupt);
	assert.equal(corruptResult.isError, true);
});

test("contents: 1000-entry directories are flagged possibly incomplete; ranges/jq on directories rejected", async () => {
	const entries = Array.from({ length: 1000 }, (_, i) => ({ type: "file", path: `f${i}.txt` }));
	const apiRequester = jsonScript([
		["commits", { sha: SHA }],
		["contents", entries],
	]);
	const result = await run({ subcommand: "repo contents", repo: "o/r", path: "", ref: "main" }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.ok(result.content[0].text.includes("may be incomplete"));
	assert.ok(result.content[0].text.includes("tree read"));

	const range = jsonScript([
		["commits", { sha: SHA }],
		["contents", entries],
	]);
	const ranged = await run({ subcommand: "repo contents", repo: "o/r", path: "", ref: "main", start_line: 1 }, range);
	assert.equal(ranged.isError, true);
	assert.ok(ranged.content[0].text.includes("line ranges apply only to text files"));

	const jqDir = jsonScript([
		["commits", { sha: SHA }],
		["contents", entries],
	]);
	const jqResult = await run({ subcommand: "repo contents", repo: "o/r", path: "", ref: "main", jq: "length" }, jqDir, {
		jqRun: async () => ({ kind: "result", output: "1000", outputTruncated: false, outputBytes: 4 }),
	});
	assert.equal(jqResult.isError, undefined);
	assert.ok(jqResult.content[0].text.trimEnd().endsWith("1000"));
});

test("contents: jq on file text is rejected with an explicit reason", async () => {
	const apiRequester = jsonScript([
		["commits", { sha: SHA }],
		["contents", fileEntry("text")],
	]);
	const result = await run({ subcommand: "repo contents", repo: "o/r", path: "f.txt", ref: "main", jq: "." }, apiRequester);
	assert.equal(result.isError, true);
	assert.ok(result.content[0].text.includes("jq is supported only for directory JSON"));
});

// ── Contents: symlinks and submodules ───────────────────────────────────────

test("contents: in-repository symlink to an ordinary file is followed exactly one level", async () => {
	const apiRequester = jsonScript([
		["commits", { sha: SHA }],
		["contents", { type: "symlink", path: "link", encoding: "base64", size: 6, content: Buffer.from("docs/f.txt").toString("base64") }],
		["contents", fileEntry("real content")],
	]);
	const result = await run({ subcommand: "repo contents", repo: "o/r", path: "link", ref: "main" }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.equal(apiRequester.requests[2], `repos/o/r/contents/docs/f.txt?ref=${SHA}`);
	assert.ok(result.content[0].text.includes("real content"));
	assert.ok(result.content[0].text.includes("followed_symlink: docs/f.txt"));
});

test("contents: broken or non-file symlink targets return metadata without following", async () => {
	// Broken: 404 on the target.
	const broken = requester([
		() => response(JSON.stringify({ sha: SHA })),
		() => response(JSON.stringify({ type: "symlink", path: "link", encoding: "base64", content: Buffer.from("gone.txt").toString("base64") })),
		() => error("Not Found", 404),
	]);
	const brokenResult = await run({ subcommand: "repo contents", repo: "o/r", path: "link", ref: "main" }, broken);
	assert.equal(brokenResult.isError, undefined);
	assert.ok(brokenResult.content[0].text.includes("not followed"));

	// Target is a directory.
	const dir = jsonScript([
		["commits", { sha: SHA }],
		["contents", { type: "symlink", path: "link", encoding: "base64", content: Buffer.from("src").toString("base64") }],
		["contents", [{ type: "file", path: "src/a" }]],
	]);
	const dirResult = await run({ subcommand: "repo contents", repo: "o/r", path: "link", ref: "main" }, dir);
	assert.equal(dirResult.isError, undefined);
	assert.ok(dirResult.content[0].text.includes("is not an ordinary file"));

	// Target escapes the repository root: no request at all.
	const escape = jsonScript([
		["commits", { sha: SHA }],
		["contents", { type: "symlink", path: "link", encoding: "base64", content: Buffer.from("../../../etc/passwd").toString("base64") }],
	]);
	const escapeResult = await run({ subcommand: "repo contents", repo: "o/r", path: "link", ref: "main" }, escape);
	assert.equal(escapeResult.isError, undefined);
	assert.ok(escapeResult.content[0].text.includes("escapes the repository root"));
	assert.equal(escape.requests.length, 2, "no target request for a root-escaping symlink");
});

test("contents: submodule entries return metadata and are never traversed", async () => {
	const apiRequester = jsonScript([
		["commits", { sha: SHA }],
		["contents", { type: "commit", path: "vendor/lib", sha: SHA2, size: 0 }],
	]);
	const result = await run({ subcommand: "repo contents", repo: "o/r", path: "vendor/lib", ref: "main" }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.ok(result.content[0].text.includes("submodule"));
	assert.ok(result.content[0].text.includes("never traversed"));
});

// ── Trees ────────────────────────────────────────────────────────────────────

test("tree: recursive default includes recursive=1; shallow omits the parameter entirely", async () => {
	const treeBody = { sha: "t".repeat(40), tree: [{ path: "a", type: "blob", mode: "100644", sha: SHA2 }], truncated: false };

	const recursive = jsonScript([
		["commits", { sha: SHA }],
		["git/commits", { tree: { sha: "t".repeat(40) } }],
		["git/trees", treeBody],
	]);
	const recursiveResult = await run({ subcommand: "repo tree", repo: "o/r", ref: "main" }, recursive);
	assert.equal(recursiveResult.isError, undefined);
	assert.ok(recursive.requests[2]!.startsWith(`repos/o/r/git/trees/${"t".repeat(40)}?recursive=1`));
	assert.ok(recursiveResult.content[0].text.includes('"mode":"100644"'));
	assert.ok(recursiveResult.content[0].text.includes("recursive: true"));

	const shallow = jsonScript([
		["commits", { sha: SHA }],
		["git/commits", { tree: { sha: "t".repeat(40) } }],
		["git/trees", treeBody],
	]);
	const shallowResult = await run({ subcommand: "repo tree", repo: "o/r", ref: "main", recursive: false }, shallow);
	assert.equal(shallowResult.isError, undefined);
	assert.ok(!shallow.requests[2]!.includes("recursive"), "shallow mode omits the recursive query parameter");
	assert.ok(shallow.requests[2]!.endsWith(`repos/o/r/git/trees/${"t".repeat(40)}`));
	assert.ok(shallowResult.content[0].text.includes("recursive: false"));
});

test("tree: subtree filter keeps exact and child entries; upstream truncation is preserved, not repaired", async () => {
	const treeBody = {
		sha: "t".repeat(40),
		truncated: true,
		tree: [
			{ path: "src", type: "tree" },
			{ path: "src/a.ts", type: "blob" },
			{ path: "srcx.ts", type: "blob" },
			{ path: "docs/b.md", type: "blob" },
		],
	};
	const apiRequester = jsonScript([
		["commits", { sha: SHA }],
		["git/commits", { tree: { sha: "t".repeat(40) } }],
		["git/trees", treeBody],
	]);
	const result = await run({ subcommand: "repo tree", repo: "o/r", ref: "main", path: "src" }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.ok(result.content[0].text.includes('"src/a.ts"'));
	assert.ok(!result.content[0].text.includes("srcx.ts"));
	assert.ok(!result.content[0].text.includes("docs/b.md"));
	assert.ok(result.content[0].text.includes("upstream_truncated: true"));
	assert.ok(result.content[0].text.includes("does not repair truncation"));
});

// ── Combined commit checks ───────────────────────────────────────────────────

const CHECK_RUN = { id: 1, name: "build", status: "completed", conclusion: "success" };
const STATUS = { context: "ci/legacy", state: "success" };

test("commit checks: both sources fetched against the pinned SHA; statuses deduped per context", async () => {
	const apiRequester = jsonScript([
		["commits", { sha: SHA }],
		["check-runs", { check_runs: [CHECK_RUN], total_count: 1 }],
		["status", { state: "success", statuses: [{ ...STATUS }, { ...STATUS, state: "pending" }] }],
	]);
	const result = await run({ subcommand: "commit checks", repo: "o/r", ref: "main" }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.ok(apiRequester.requests[1]!.startsWith(`repos/o/r/commits/${SHA}/check-runs?filter=latest&per_page=${PAGE_SIZE}`));
	assert.ok(apiRequester.requests[2]!.startsWith(`repos/o/r/commits/${SHA}/status?per_page=${PAGE_SIZE}`));
	const dataLine = result.content[0].text.split("data:\n")[1]!;
	const data = JSON.parse(dataLine.trimEnd()) as { check_runs: unknown[]; statuses: Array<Record<string, unknown>> };
	assert.equal(data.check_runs.length, 1);
	assert.equal(data.statuses.length, 1, "duplicate contexts collapse to the newest entry");
	assert.equal(data.statuses[0]!.state, "success");
	assert.ok(result.content[0].text.includes("not a transactional snapshot"));
});

test("commit checks: valid Link headers auto-page sequentially and reconstruct requests internally", async () => {
	const script = requester([
		() => response(JSON.stringify({ check_runs: [CHECK_RUN] }), linkHeader(2, `repos/o/r/commits/${SHA}/check-runs`, `filter=latest&per_page=${PAGE_SIZE}`)),
		() => response(JSON.stringify({ check_runs: [{ ...CHECK_RUN, id: 2 }] })),
		() => response(JSON.stringify({ statuses: [STATUS] })),
	]);
	const result = await run({ subcommand: "commit checks", repo: "o/r", ref: SHA }, script);
	assert.equal(result.isError, undefined);
	assert.equal(script.requests[0]!.endsWith(`page=1`), true);
	assert.equal(script.requests[1]!.endsWith(`page=2`), true);
	assert.ok(script.requests[2]!.includes("/status?"), "statuses source fetched after check runs");
	const dataLine = result.content[0].text.split("data:\n")[1]!;
	const data = JSON.parse(dataLine.trimEnd()) as { check_runs: unknown[] };
	assert.equal(data.check_runs.length, 2);
});

test("commit checks: malicious, foreign, and parameter-mutating next links are rejected as source errors", async () => {
	for (const badLink of [
		`Link: <https://evil.example.com/repos/o/r/commits/${SHA}/check-runs?filter=latest&per_page=${PAGE_SIZE}&page=2>; rel="next"\r\n`,
		`Link: <https://api.github.com/repos/o/r/other?filter=latest&per_page=${PAGE_SIZE}&page=2>; rel="next"\r\n`,
		`Link: <https://api.github.com/repos/o/r/commits/${SHA}/check-runs?filter=all&per_page=${PAGE_SIZE}&page=2>; rel="next"\r\n`,
		`Link: <https://api.github.com/repos/o/r/commits/${SHA}/check-runs?filter=latest&per_page=${PAGE_SIZE}&injected=1&page=2>; rel="next"\r\n`,
		`Link: <https://api.github.com/repos/o/r/commits/${SHA}/check-runs?filter=latest&per_page=${PAGE_SIZE}&page=5>; rel="next"\r\n`,
	]) {
		const script = requester([
			() => response(JSON.stringify({ check_runs: [CHECK_RUN] }), badLink),
			() => response(JSON.stringify({ statuses: [STATUS] })),
		]);
		const result = await run({ subcommand: "commit checks", repo: "o/r", ref: SHA }, script);
		assert.equal(result.isError, true, badLink);
		assert.ok(result.content[0].text.includes("next-link validation failed"), badLink);
		// The malicious URL is never fetched: page 2 is reconstructed or rejected.
		assert.ok(!script.requests.some((requestPath) => requestPath.includes("evil") || requestPath.includes("injected=1") || requestPath.includes("filter=all")));
	}
});

test("commit checks: page-limit stop is nonerror incompleteness with a continuation", async () => {
	const script = requester([
		...Array.from({ length: MAX_PAGES_PER_SOURCE }, (_, i) =>
			() => response(JSON.stringify({ check_runs: [CHECK_RUN] }), linkHeader(i + 2, `repos/o/r/commits/${SHA}/check-runs`, `filter=latest&per_page=${PAGE_SIZE}`)),
		),
		() => response(JSON.stringify({ statuses: [] })),
	]);
	const result = await run({ subcommand: "commit checks", repo: "o/r", ref: SHA }, script);
	assert.equal(result.isError, undefined, "a stop between complete responses is not an error");
	assert.ok(result.content[0].text.includes("page limit reached"));
	assert.ok(typeof result.details["continuation"] === "string");
});

test("commit checks: failed source preserves completed-source data and reports a per-source error", async () => {
	const script = requester([
		() => response(JSON.stringify({ check_runs: [CHECK_RUN] })),
		() => error("boom", 500),
	]);
	const result = await run({ subcommand: "commit checks", repo: "o/r", ref: SHA }, script);
	assert.equal(result.isError, true);
	const dataLine = result.content[0].text.split("data:\n")[1]!;
	const data = JSON.parse(dataLine.trimEnd()) as { check_runs: unknown[]; statuses: unknown[] };
	assert.equal(data.check_runs.length, 1, "completed source data is preserved");
	assert.equal(data.statuses.length, 0);
	assert.ok(result.content[0].text.includes("statuses_error"));
});

test("commit checks: continuation resumes at the saved positions without re-resolving refs", async () => {
	// First run: checks completes, statuses fails on page 1.
	const first = requester([
		() => response(JSON.stringify({ sha: SHA })),
		() => response(JSON.stringify({ check_runs: [CHECK_RUN] })),
		() => error("boom", 500),
	]);
	const firstResult = await run({ subcommand: "commit checks", repo: "o/r", ref: "main" }, first);
	const continuation = firstResult.details["continuation"];
	assert.ok(typeof continuation === "string");

	// Resume: the pinned SHA is reused, no repos/o/r/commits/main resolution
	// request is issued, and only the failed source is retried.
	const second = requester([
		() => response(JSON.stringify({ statuses: [STATUS] })),
	]);
	const secondResult = await run({ subcommand: "commit checks", repo: "o/r", ref: "main", continuation }, second);
	assert.equal(secondResult.isError, undefined);
	assert.deepEqual(second.requests, [`repos/o/r/commits/${SHA}/status?per_page=${PAGE_SIZE}&page=1`]);
	assert.ok(secondResult.content[0].text.includes("statuses source completed in the earlier invocation") === false);
	assert.ok(secondResult.content[0].text.includes("resumed: true"));
	const dataLine = secondResult.content[0].text.split("data:\n")[1]!;
	const data = JSON.parse(dataLine.trimEnd()) as { check_runs: unknown[] };
	assert.equal(data.check_runs.length, 0, "completed sources are not refetched on resume");
});

test("commit checks: continuation mismatched to the invocation is rejected", async () => {
	const first = requester([
		() => response(JSON.stringify({ sha: SHA })),
		() => response(JSON.stringify({ check_runs: [] })),
		() => error("boom", 500),
	]);
	const firstResult = await run({ subcommand: "commit checks", repo: "o/r", ref: "main" }, first);
	const continuation = firstResult.details["continuation"] as string;
	const mismatched = requester([]);
	const result = await run({ subcommand: "commit checks", repo: "o/r", ref: "other-branch", continuation }, mismatched);
	assert.equal(result.isError, true);
	assert.ok(result.content[0].text.includes("does not match this invocation"));
	assert.equal(mismatched.requests.length, 0, "mismatched continuations never spawn requests");
});

// ── Advisory view ────────────────────────────────────────────────────────────

test("advisory view: GHSA is fetched directly as one object; withdrawn field surfaced", async () => {
	const apiRequester = jsonScript([["advisories", { ghsa_id: "GHSA-2345-6789-cfgh", withdrawn: "2026-01-01T00:00:00Z" }]]);
	const result = await run({ subcommand: "advisory view", id: "GHSA-2345-6789-cfgh" }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.deepEqual(apiRequester.requests, ["advisories/GHSA-2345-6789-cfgh"]);
	assert.ok(result.content[0].text.includes("withdrawn: 2026-01-01T00:00:00Z"));
});

test("advisory view: CVE searches send an explicit reviewed default and report the searched type", async () => {
	const apiRequester = jsonScript([["advisories", [{ ghsa_id: "GHSA-2345-6789-cfgh" }]]]);
	const result = await run({ subcommand: "advisory view", id: "CVE-2026-111943" }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.equal(apiRequester.requests[0], `advisories?cve_id=CVE-2026-111943&type=reviewed&per_page=${PAGE_SIZE}&page=1`);
	assert.ok(result.content[0].text.includes("searched_type: reviewed"));
});

test("advisory view: empty CVE results are successful searches, not proof of global absence", async () => {
	const apiRequester = jsonScript([["advisories", []]]);
	const result = await run({ subcommand: "advisory view", id: "CVE-2026-999999" }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.ok(result.content[0].text.includes("not proof of global absence"));
});

test("advisory view: CVE pagination continuation matches id and type on resume", async () => {
	// Ten linked pages reach the per-invocation page limit and produce a
	// continuation positioned at the next unfetched page.
	const apiRequester = requester(
		Array.from({ length: MAX_PAGES_PER_SOURCE }, (_, i) =>
			() => response(JSON.stringify([{ ghsa_id: "GHSA-2345-6789-cfgh" }]), linkHeader(i + 2, "advisories", `cve_id=CVE-2026-111943&type=reviewed&per_page=${PAGE_SIZE}`)),
		),
	);
	const first = await run({ subcommand: "advisory view", id: "CVE-2026-111943" }, apiRequester);
	const continuation = first.details["continuation"];
	assert.ok(typeof continuation === "string", "page-limit stop yields a continuation");
	assert.equal(first.isError, undefined);

	const second = requester([
		() => response(JSON.stringify([])),
	]);
	const secondResult = await run({ subcommand: "advisory view", id: "CVE-2026-111943", continuation }, second);
	assert.equal(secondResult.isError, undefined);
	assert.equal(second.requests[0], `advisories?cve_id=CVE-2026-111943&type=reviewed&per_page=${PAGE_SIZE}&page=${MAX_PAGES_PER_SOURCE + 1}`);

	const wrongType = requester([]);
	const wrongTypeResult = await run({ subcommand: "advisory view", id: "CVE-2026-111943", type: "malware", continuation }, wrongType);
	assert.equal(wrongTypeResult.isError, true);
	assert.ok(wrongTypeResult.content[0].text.includes("does not match this invocation"));
});

// ── jq wiring and result bounds ──────────────────────────────────────────────

test("jq: applied once to the final fetched batch, never to metadata; failures become errors", async () => {
	const apiRequester = jsonScript([
		["commits", { sha: SHA }],
		["check-runs", { check_runs: [CHECK_RUN] }],
		["status", { statuses: [] }],
	]);
	const documents: string[] = [];
	const result = await run({ subcommand: "commit checks", repo: "o/r", ref: "main", jq: "[.check_runs[].name]" }, apiRequester, {
		jqRun: async (expression, document) => {
			documents.push(document);
			assert.equal(expression, "[.check_runs[].name]");
			return { kind: "result", output: '"build"', outputTruncated: false, outputBytes: 7 };
		},
	});
	assert.equal(result.isError, undefined);
	assert.equal(documents.length, 1);
	const parsed = JSON.parse(documents[0]!) as { check_runs: unknown[] };
	assert.ok(Array.isArray(parsed.check_runs), "the document is the data batch, not the rendered result");
	assert.ok(!documents[0]!.includes("resolved_sha"), "tool metadata is outside filtered data");
	assert.ok(result.content[0].text.trimEnd().endsWith('"build"'));

	const failing = jsonScript([
		["commits", { sha: SHA }],
		["check-runs", { check_runs: [] }],
		["status", { statuses: [] }],
	]);
	const failed = await run({ subcommand: "commit checks", repo: "o/r", ref: "main", jq: "." }, failing, {
		jqRun: async () => ({ kind: "error", reason: "jq exploded" }),
	});
	assert.equal(failed.isError, true);
	assert.ok(failed.content[0].text.includes("jq filtering failed"));
});

test("display cap: oversized results render an explicitly incomplete UTF-8-safe prefix under 50 KiB", async () => {
	const bigEntry = { type: "file", path: "x".repeat(50), size: 10 };
	const entries = Array.from({ length: 2000 }, () => bigEntry);
	const apiRequester = jsonScript([
		["commits", { sha: SHA }],
		["contents", entries],
	]);
	const result = await run({ subcommand: "repo contents", repo: "o/r", path: "", ref: "main" }, apiRequester);
	assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= API_DISPLAY_CAP + 1024, "display text stays near the cap");
	assert.ok(result.content[0].text.includes("incomplete UTF-8-safe prefix, NOT complete JSON"));
	assert.ok(result.content[0].text.includes("Narrow the request"));
	assert.equal(result.details["output_truncated"], true);
	// No hidden full payload: details must not contain the data.
	assert.ok(!JSON.stringify(result.details).includes('"path": "' + "x".repeat(50) + '"'));
});

test("auth errors surface as errors with the HTTP status", async () => {
	const apiRequester = jsonScript([
		["repos", { message: "Bad credentials" }],
	]);
	const forced = requester([
		() => error("Bad credentials", 401),
	]);
	const result = await run({ subcommand: "repo contents", repo: "o/r", path: "f", ref: "main" }, forced);
	void apiRequester;
	assert.equal(result.isError, true);
	assert.ok(result.content[0].text.includes("HTTP 401"));
});

// ── Check-run annotations ─────────────────────────────────────────────────────

function annotation(i: number): Record<string, unknown> {
	return { id: i, path: `src/f${i}.ts`, message: `annotation ${i}`, annotation_level: "warning" };
}

test("check annotations: 0, 99, and 100 items; the notice appears ONLY at exactly 100", async () => {
	for (const count of [0, 99, 100]) {
		const apiRequester = requester([() => response(JSON.stringify(Array.from({ length: count }, (_, i) => annotation(i))))]);
		const result = await run({ subcommand: "check annotations", repo: "o/r", check_run_id: 42 }, apiRequester);
		assert.equal(result.isError, undefined, `count=${count}`);
		const hasNotice = result.content[0].text.includes("only the first page was fetched; the listing may be incomplete");
		assert.equal(hasNotice, count === 100, `count=${count} notice presence`);
		assert.ok(result.content[0].text.includes("check_run_id: 42"));
	}
});

test("check annotations: endpoint is exact and exactly ONE request is made even at 100 items", async () => {
	const apiRequester = requester([() => response(JSON.stringify(Array.from({ length: 100 }, (_, i) => annotation(i))))]);
	const result = await run({ subcommand: "check annotations", repo: "owner/repo", check_run_id: 42 }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.deepEqual(apiRequester.requests, ["repos/owner/repo/check-runs/42/annotations?per_page=100"]);
	assert.ok(!result.details["continuation"], "no continuation machinery for a single-page read");
});

test("check annotations: the incompleteness notice survives jq scalar output and jq-empty output", async () => {
	// jq scalar result.
	const scalar = requester([() => response(JSON.stringify(Array.from({ length: 100 }, (_, i) => annotation(i))))]);
	const scalarResult = await run({ subcommand: "check annotations", repo: "o/r", check_run_id: 42, jq: ".[0]" }, scalar, {
		jqRun: async (expression, document) => {
			assert.equal(expression, ".[0]");
			const parsed = JSON.parse(document) as unknown[];
			assert.equal(parsed.length, 100, "jq sees the ORIGINAL 100-item array");
			return { kind: "result", output: '{"id":0}', outputTruncated: false, outputBytes: 9 };
		},
	});
	assert.equal(scalarResult.isError, undefined);
	assert.ok(scalarResult.content[0].text.includes("only the first page was fetched; the listing may be incomplete"));
	assert.ok(scalarResult.content[0].text.trimEnd().endsWith('{"id":0}'));

	// jq-empty result.
	const empty = requester([() => response(JSON.stringify(Array.from({ length: 100 }, (_, i) => annotation(i))))]);
	const emptyResult = await run({ subcommand: "check annotations", repo: "o/r", check_run_id: 42, jq: ".[]" }, empty, {
		jqRun: async () => ({ kind: "result", output: "", outputTruncated: false, outputBytes: 0 }),
	});
	assert.equal(emptyResult.isError, undefined);
	assert.ok(emptyResult.content[0].text.includes("only the first page was fetched; the listing may be incomplete"));
	assert.ok(emptyResult.content[0].text.includes("jq produced no output values"));
});

test("check annotations: jq is applied exactly once via the jqRun seam", async () => {
	const apiRequester = requester([() => response(JSON.stringify([annotation(1), annotation(2)]))]);
	let jqCalls = 0;
	const result = await run({ subcommand: "check annotations", repo: "o/r", check_run_id: 42, jq: "length" }, apiRequester, {
		jqRun: async () => {
			jqCalls += 1;
			return { kind: "result", output: "2", outputTruncated: false, outputBytes: 1 };
		},
	});
	assert.equal(result.isError, undefined);
	assert.equal(jqCalls, 1);
});

test("check annotations: the notice coexists with the 50 KiB display-truncation overflow notice", async () => {
	// 100 annotations with large paths push the rendered data past the cap.
	const entries = Array.from({ length: 100 }, (_, i) => ({
		...annotation(i),
		message: "x".repeat(1200),
	}));
	const apiRequester = requester([() => response(JSON.stringify(entries))]);
	const result = await run({ subcommand: "check annotations", repo: "o/r", check_run_id: 42 }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.ok(result.content[0].text.includes("only the first page was fetched; the listing may be incomplete"), "incompleteness notice in the metadata head");
	assert.ok(result.content[0].text.includes("incomplete UTF-8-safe prefix, NOT complete JSON"), "overflow notice present");
	assert.ok(result.content[0].text.includes("Narrow the request"));
	assert.equal(result.details["output_truncated"], true);
});

test("check annotations: non-array bodies (object, string, invalid JSON) are errors", async () => {
	const asObject = requester([() => response(JSON.stringify({ message: "not an array" }))]);
	const objectResult = await run({ subcommand: "check annotations", repo: "o/r", check_run_id: 42 }, asObject);
	assert.equal(objectResult.isError, true);
	assert.ok(objectResult.content[0].text.includes("check annotations response was not a JSON array"));

	const asString = requester([() => response('"just a string"')]);
	const stringResult = await run({ subcommand: "check annotations", repo: "o/r", check_run_id: 42 }, asString);
	assert.equal(stringResult.isError, true);
	assert.ok(stringResult.content[0].text.includes("check annotations response was not a JSON array"));

	const asGarbage = requester([() => response("<html>gateway error</html>")]);
	const garbageResult = await run({ subcommand: "check annotations", repo: "o/r", check_run_id: 42 }, asGarbage);
	assert.equal(garbageResult.isError, true);
	assert.ok(garbageResult.content[0].text.includes("check annotations response was not valid JSON"));
});

test("check annotations: HTTP 404 and 403 outcomes pass through verbatim with no retry", async () => {
	const notFound = requester([() => error("Not Found", 404)]);
	const notFoundResult = await run({ subcommand: "check annotations", repo: "o/r", check_run_id: 999999 }, notFound);
	assert.equal(notFoundResult.isError, true);
	assert.ok(notFoundResult.content[0].text.includes("annotations read failed: Not Found (HTTP 404)"), notFoundResult.content[0].text);
	assert.equal(notFound.requests.length, 1, "no retry after an HTTP error outcome");

	const forbidden = requester([() => error("Forbidden", 403)]);
	const forbiddenResult = await run({ subcommand: "check annotations", repo: "o/r", check_run_id: 42 }, forbidden);
	assert.equal(forbiddenResult.isError, true);
	assert.ok(forbiddenResult.content[0].text.includes("HTTP 403"));
	assert.equal(forbidden.requests.length, 1);
});

// ── Repository metadata ──────────────────────────────────────────────────────

test("repo metadata: one request, full flat object passed through verbatim", async () => {
	const repoObject = {
		default_branch: "main",
		description: "d",
		visibility: "public",
		pushed_at: "2026-10-21T20:09:23Z",
		html_url: "https://github.com/o/r",
		clone_url: "https://github.com/o/r.git",
		ssh_url: "git@github.com:o/r.git",
		license: { spdx_id: "MIT" },
		language: "TypeScript",
		archived: false,
		fork: false,
		is_template: false,
		topics: [],
		permissions: { admin: true, push: true, pull: true },
	};
	const apiRequester = requester([() => response(JSON.stringify(repoObject))]);
	const result = await run({ subcommand: "repo metadata", repo: "owner/repo" }, apiRequester);
	assert.equal(result.isError, undefined);
	assert.deepEqual(apiRequester.requests, ["repos/owner/repo"], "exactly one unpaged request");
	const dataLine = result.content[0].text.split("data:\n")[1]!;
	assert.deepEqual(JSON.parse(dataLine.trimEnd()), repoObject, "response passes through unmodified");
	assert.ok(!result.details["continuation"], "no continuation machinery");
	assert.ok(result.content[0].text.includes("permissions reflect the authenticated token"), "viewer-specific fact labeled");
});

test("repo metadata: jq narrows the object; applied exactly once", async () => {
	const apiRequester = requester([() => response(JSON.stringify({ default_branch: "main", description: "d" }))]);
	let jqCalls = 0;
	const result = await run({ subcommand: "repo metadata", repo: "o/r", jq: ".default_branch" }, apiRequester, {
		jqRun: async (expression, document) => {
			assert.equal(expression, ".default_branch");
			JSON.parse(document);
			jqCalls += 1;
			return { kind: "result", output: '"main"', outputTruncated: false, outputBytes: 6 };
		},
	});
	assert.equal(result.isError, undefined);
	assert.equal(jqCalls, 1);
	assert.ok(result.content[0].text.trimEnd().endsWith('"main"'));
});

test("repo metadata: non-object bodies (array, string, invalid JSON) are errors", async () => {
	const asArray = requester([() => response(JSON.stringify([{ id: 1 }]))]);
	const arrayResult = await run({ subcommand: "repo metadata", repo: "o/r" }, asArray);
	assert.equal(arrayResult.isError, true);
	assert.ok(arrayResult.content[0].text.includes("response body was not a JSON object"));

	const asString = requester([() => response('"just a string"')]);
	const stringResult = await run({ subcommand: "repo metadata", repo: "o/r" }, asString);
	assert.equal(stringResult.isError, true);
	assert.ok(stringResult.content[0].text.includes("not a JSON object"));

	const asGarbage = requester([() => response("<html>gateway error</html>")]);
	const garbageResult = await run({ subcommand: "repo metadata", repo: "o/r" }, asGarbage);
	assert.equal(garbageResult.isError, true);
	assert.ok(garbageResult.content[0].text.includes("not valid JSON"));
});

test("repo metadata: HTTP 404 and 403 pass through verbatim with no retry", async () => {
	const notFound = requester([() => error("Not Found", 404)]);
	const notFoundResult = await run({ subcommand: "repo metadata", repo: "o/missing" }, notFound);
	assert.equal(notFoundResult.isError, true);
	assert.ok(notFoundResult.content[0].text.includes("metadata read failed: Not Found (HTTP 404)"), notFoundResult.content[0].text);
	assert.equal(notFound.requests.length, 1);

	const forbidden = requester([() => error("Forbidden", 403)]);
	const forbiddenResult = await run({ subcommand: "repo metadata", repo: "o/private" }, forbidden);
	assert.equal(forbiddenResult.isError, true);
	assert.ok(forbiddenResult.content[0].text.includes("HTTP 403"));
	assert.equal(forbidden.requests.length, 1);
});
