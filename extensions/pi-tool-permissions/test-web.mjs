// run: node test-web.mjs

import {
	makeTestRunner, normalizeTool, getMatchField, suggestRule,
	decide, makeCfg,
} from "./test-helpers.mjs";

const { test, section, summary } = makeTestRunner();

// ── WebSearch ─────────────────────────────────────────────────────────────

section("WebSearch — getMatchField");

// web_search has no dedicated branch; falls through to JSON.stringify
test("web_search field is JSON of whole input",
	getMatchField("web_search", { query: "typescript glob" }),
	JSON.stringify({ query: "typescript glob" }));
test("WebSearch (PascalCase) same result",
	getMatchField("WebSearch", { query: "hello" }),
	JSON.stringify({ query: "hello" }));

section("WebSearch — rule matching");

const allowAllSearch = makeCfg({ allow: ["WebSearch"], defaultAction: "ask" });
test("bare WebSearch allows any web_search call",
	decide(allowAllSearch, "web_search", { query: "anything at all" }), "allow");
test("bare WebSearch works with PascalCase toolName",
	decide(allowAllSearch, "WebSearch", { query: "anything" }), "allow");

const denyAllSearch = makeCfg({ deny: ["WebSearch"], defaultAction: "allow" });
test("bare WebSearch in deny blocks any web_search call",
	decide(denyAllSearch, "web_search", { query: "anything" }), "deny");

// WebSearch(pattern) — pattern is matched against JSON.stringify(input), not the query string.
// This is intentional: web_search is bare-only; query-level filtering is not supported.
const patternSearch = makeCfg({ deny: ["WebSearch(foo*)"], defaultAction: "allow" });
test("WebSearch(pattern) does NOT filter by query string",
	decide(patternSearch, "web_search", { query: "foo bar" }), "allow");

section("WebSearch — suggestRule");

test("always returns canonical 'WebSearch'",
	suggestRule("web_search", { query: "typescript glob patterns" }), "WebSearch");
test("also returns 'WebSearch' for PascalCase toolName",
	suggestRule("WebSearch", { query: "anything" }), "WebSearch");
test("returns 'WebSearch' regardless of query content",
	suggestRule("web_search", { query: "" }), "WebSearch");

// ── WebFetch ──────────────────────────────────────────────────────────────

section("WebFetch — getMatchField");

test("web_fetch returns input.url",
	getMatchField("web_fetch", { url: "https://github.com/foo/bar" }), "https://github.com/foo/bar");
test("missing url returns empty string",
	getMatchField("web_fetch", {}), "");
test("WebFetch (PascalCase) also works",
	getMatchField("WebFetch", { url: "https://example.com" }), "https://example.com");

section("WebFetch — rule matching");

// Allow-only cfg: github allowed, everything else denied
const wfAllowCfg = makeCfg({ allow: ["WebFetch(https://github.com/*)"], defaultAction: "deny" });
test("WebFetch(https://github.com/*) allows github URL",
	decide(wfAllowCfg, "web_fetch", { url: "https://github.com/microsoft/typescript" }), "allow");
test("WebFetch(https://github.com/*) allows deep github URL",
	decide(wfAllowCfg, "web_fetch", { url: "https://github.com/a/b/c/d/e" }), "allow");
test("WebFetch(https://github.com/*) does NOT match gitlab",
	decide(wfAllowCfg, "web_fetch", { url: "https://gitlab.com/foo/bar" }), "deny");

// ask catch-all wins over allow (deny > ask > allow is the precedence order)
// A WebFetch(*) ask rule fires BEFORE the allow list is checked.
const wfAskCatchAll = makeCfg({ allow: ["WebFetch(https://github.com/*)"], ask: ["WebFetch(*)"], defaultAction: "deny" });
test("WebFetch(*) ask catch-all fires before allow (ask > allow)",
	decide(wfAskCatchAll, "web_fetch", { url: "https://github.com/foo" }), "ask");
test("WebFetch(*) catch-all matches any URL",
	decide(makeCfg({ ask: ["WebFetch(*)"], defaultAction: "allow" }), "web_fetch", { url: "https://random.site.io/page" }), "ask");

const denyFetch = makeCfg({ deny: ["WebFetch(https://malicious.example/*)"], defaultAction: "allow" });
test("WebFetch deny rule blocks specific domain",
	decide(denyFetch, "web_fetch", { url: "https://malicious.example/payload" }), "deny");
test("WebFetch deny rule does NOT block other domains",
	decide(denyFetch, "web_fetch", { url: "https://safe.example.com/page" }), "allow");

section("WebFetch — suggestRule");

test("extracts origin for standard URL",
	suggestRule("web_fetch", { url: "https://github.com/foo/bar/baz" }), "WebFetch(https://github.com/*)");
test("extracts origin with port",
	suggestRule("web_fetch", { url: "https://example.com:8080/path?q=1" }), "WebFetch(https://example.com:8080/*)");
test("extracts HTTP (not just HTTPS) origin",
	suggestRule("web_fetch", { url: "http://internal.corp/api/data" }), "WebFetch(http://internal.corp/*)");
test("falls back to bare WebFetch for malformed URL",
	suggestRule("web_fetch", { url: "not-a-url" }), "WebFetch");
test("falls back to bare WebFetch for empty URL",
	suggestRule("web_fetch", { url: "" }), "WebFetch");
test("falls back to bare WebFetch for missing URL",
	suggestRule("web_fetch", {}), "WebFetch");

// ── Tool name normalisation round-trip ────────────────────────────────────

section("tool name normalisation round-trip");

test("WebSearch and web_search normalise to same key",
	normalizeTool("WebSearch") === normalizeTool("web_search"), true);
test("WebFetch and web_fetch normalise to same key",
	normalizeTool("WebFetch") === normalizeTool("web_fetch"), true);
test("WEB_SEARCH normalises same as web_search",
	normalizeTool("WEB_SEARCH") === normalizeTool("web_search"), true);

// Regression: rule written as "WebSearch" must match event toolName "web_search"
// (this was the core bug caught during TP-1/TP-2 review)
const regressionCfg = makeCfg({ allow: ["WebSearch"], defaultAction: "ask" });
test("[regression] rule 'WebSearch' matches event toolName 'web_search'",
	decide(regressionCfg, "web_search", { query: "anything" }), "allow");
test("[regression] rule 'WebFetch(https://github.com/*)' matches event 'web_fetch'",
	decide(makeCfg({ allow: ["WebFetch(https://github.com/*)"], defaultAction: "ask" }),
		"web_fetch", { url: "https://github.com/foo" }), "allow");

// ── pwsh (PowerShell) ─────────────────────────────────────────────────────

section("pwsh — getMatchField");

test("pwsh returns input.command (not JSON)",
	getMatchField("pwsh", { command: "Get-NetAdapter | Format-Table" }),
	"Get-NetAdapter | Format-Table");
test("pwsh (PascalCase) also works",
	getMatchField("Pwsh", { command: "Get-Process" }), "Get-Process");
test("missing command returns empty string",
	getMatchField("pwsh", {}), "");

section("pwsh — rule matching");

const pwshAllowCfg = makeCfg({ allow: ["Pwsh(Get-NetAdapter*)"], defaultAction: "deny" });
test("Pwsh(Get-NetAdapter*) allows matching command",
	decide(pwshAllowCfg, "pwsh", { command: "Get-NetAdapter | Select-Object Name" }), "allow");
test("Pwsh(Get-NetAdapter*) does NOT match unrelated command",
	decide(pwshAllowCfg, "pwsh", { command: "Get-Process" }), "deny");

const pwshDenyCfg = makeCfg({ deny: ["Pwsh(Remove-Item*)"], defaultAction: "allow" });
test("Pwsh(Remove-Item*) deny blocks matching command",
	decide(pwshDenyCfg, "pwsh", { command: "Remove-Item -Recurse ./foo" }), "deny");

section("pwsh — suggestRule");

test("uses full command like bash",
	suggestRule("pwsh", { command: "Get-NetAdapter | Format-Table" }), "pwsh(Get-NetAdapter | Format-Table)");
test("empty command falls back to bare tool name",
	suggestRule("pwsh", { command: "" }), "pwsh");

process.exit(summary() > 0 ? 1 : 0);
