/**
 * Web Extension
 *
 * Adds two tools the LLM can call:
 *   - web_fetch:  Fetch a URL and return readable text/markdown
 *   - web_search: Search the web (Tavily / Brave / Serper / DuckDuckGo fallback)
 *
 * Search backend is chosen from environment variables, in order of preference:
 *   - TAVILY_API_KEY   (https://tavily.com)            -- best for agents, free tier
 *   - BRAVE_API_KEY    (https://brave.com/search/api)
 *   - SERPER_API_KEY   (https://serper.dev)
 *   - <none>           -> DuckDuckGo HTML scrape (no key, lower quality)
 *
 * Optional: WEB_SEARCH_BACKEND=tavily|brave|serper|duckduckgo to force a backend.
 * Optional: WEB_FETCH_BACKEND=tavily|raw to force the web_fetch backend (default: tavily when key set).
 *
 * Setup:
 *   cd ~/.pi/agent/extensions/web && npm install
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { convert as htmlToText } from "html-to-text";
import { Type } from "typebox";

// --------------------------- shared helpers ---------------------------

const DEFAULT_UA =
	"Mozilla/5.0 (compatible; pi-coding-agent/web-extension; +https://pi.dev)";

async function doFetch(url: string, signal?: AbortSignal, init?: RequestInit): Promise<Response> {
	return fetch(url, {
		redirect: "follow",
		...init,
		headers: {
			"user-agent": DEFAULT_UA,
			accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"accept-language": "en-US,en;q=0.9",
			...(init?.headers || {}),
		},
		signal,
	});
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	return { text: text.slice(0, max), truncated: true };
}

function htmlToReadable(html: string, baseUrl?: string): string {
	return htmlToText(html, {
		wordwrap: false,
		selectors: [
			{ selector: "script", format: "skip" },
			{ selector: "style", format: "skip" },
			{ selector: "noscript", format: "skip" },
			{ selector: "nav", format: "skip" },
			{ selector: "footer", format: "skip" },
			{ selector: "form", format: "skip" },
			{ selector: "svg", format: "skip" },
			{ selector: "img", format: "skip" },
			{ selector: "a", options: { baseUrl, ignoreHref: false, hideLinkHrefIfSameAsText: true } },
		],
	}).trim();
}

const RAW_PRESERVE_EXTENSIONS = new Set([
	".bash",
	".c",
	".cjs",
	".cpp",
	".cs",
	".css",
	".csv",
	".go",
	".h",
	".hpp",
	".java",
	".js",
	".json",
	".jsonl",
	".jsx",
	".log",
	".markdown",
	".md",
	".mdx",
	".mjs",
	".ps1",
	".py",
	".rb",
	".rs",
	".scss",
	".sh",
	".sql",
	".ts",
	".tsv",
	".tsx",
	".toml",
	".txt",
	".xml",
	".yaml",
	".yml",
	".zsh",
]);

const RAW_PRESERVE_FILENAMES = new Set([
	"code_of_conduct",
	"contributing",
	"changelog",
	"dockerfile",
	"license",
	"makefile",
	"readme",
]);

const CODE_HOST_SOURCE_EXTENSIONS = new Set([".htm", ".html"]);

function lastPathSegment(pathname: string): string {
	const segment = pathname.split("/").filter(Boolean).at(-1) ?? "";
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

function shouldPreserveRaw(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}

	const filename = lastPathSegment(parsed.pathname).toLowerCase();
	if (!filename) return false;

	if (RAW_PRESERVE_FILENAMES.has(filename)) return true;

	const dot = filename.lastIndexOf(".");
	if (dot < 0) return false;

	const extension = filename.slice(dot);
	if (RAW_PRESERVE_EXTENSIONS.has(extension)) return true;

	const hostname = parsed.hostname.toLowerCase();
	const parts = parsed.pathname.split("/").filter(Boolean);
	const isGitHubFileUrl = hostname === "github.com" && (parts[2] === "blob" || parts[2] === "raw");
	const isGitHubRawUrl = hostname === "raw.githubusercontent.com";
	return (isGitHubFileUrl || isGitHubRawUrl) && CODE_HOST_SOURCE_EXTENSIONS.has(extension);
}

function normalizeRawFileUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}

	if (parsed.hostname.toLowerCase() === "github.com") {
		const parts = parsed.pathname.split("/").filter(Boolean);
		// GitHub web UI file links use /owner/repo/blob/ref/path/to/file. Convert
		// them to /owner/repo/raw/ref/path/to/file so raw-preserved source/docs/data
		// URLs return file contents instead of GitHub's HTML page.
		if (parts.length >= 5 && parts[2] === "blob") {
			parts[2] = "raw";
			parsed.pathname = `/${parts.join("/")}`;
			return parsed.toString();
		}
	}

	return url;
}

// --------------------------- web_fetch --------------------------------

const fetchParams = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL to fetch." }),
	format: Type.Optional(
		StringEnum(["markdown", "text", "raw"] as const, {
			description:
				"markdown/text: convert HTML to readable text. raw: return body as-is (e.g. JSON, source).",
		}),
	),
	maxChars: Type.Optional(
		Type.Integer({ minimum: 1000, maximum: 200_000, description: "Max characters to return. Default 30000." }),
	),
	engine: Type.Optional(
		StringEnum(["auto", "tavily", "raw"] as const, {
			description:
				"Fetch backend. 'auto' (default): use Tavily Extract when TAVILY_API_KEY is set, falling back to raw HTTP. 'tavily': force Tavily Extract (requires key, errors on failure). 'raw': always use raw HTTP fetch.",
		}),
	),
	extractDepth: Type.Optional(
		StringEnum(["basic", "advanced"] as const, {
			description:
				"Tavily Extract depth. 'basic' (default, 1 credit per 5 URLs) suits most pages. 'advanced' (2 credits per 5 URLs) handles tables, embedded content, and complex layouts. Tavily only.",
		}),
	),
});

// --------------------------- web_search -------------------------------

const searchParams = Type.Object({
	query: Type.String({ description: "Search query." }),
	maxResults: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 20, description: "Number of results. Default 8." }),
	),
	topic: Type.Optional(
		StringEnum(["general", "news", "finance"] as const, {
			description: "Search topic. 'news' is best for current events, breaking changes, and recent releases. 'finance' for markets/economics. Default: general. Tavily only.",
		}),
	),
	timeRange: Type.Optional(
		StringEnum(["day", "week", "month", "year"] as const, {
			description: "Restrict results to content published/updated within this time window. Useful for time-sensitive queries. Tavily only.",
		}),
	),
	searchDepth: Type.Optional(
		StringEnum(["basic", "advanced", "fast", "ultra-fast"] as const, {
			description: "Latency vs. relevance tradeoff. 'basic' (default, 1 credit) is balanced. 'advanced' (2 credits) gives higher-precision multi-snippet results. 'fast'/'ultra-fast' minimise latency. Tavily only.",
		}),
	),
});

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	score?: number;
}

async function searchTavily(
	q: string,
	n: number,
	signal?: AbortSignal,
	opts?: { topic?: string; timeRange?: string; searchDepth?: string },
): Promise<{ answer?: string; results: SearchResult[] }> {
	const body: Record<string, unknown> = {
		query: q,
		max_results: n,
		search_depth: opts?.searchDepth ?? "basic",
		include_answer: true,
	};
	if (opts?.topic) body.topic = opts.topic;
	if (opts?.timeRange) body.time_range = opts.timeRange;
	const res = await doFetch("https://api.tavily.com/search", signal, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"Authorization": `Bearer ${process.env.TAVILY_API_KEY}`,
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Tavily error ${res.status}: ${await res.text()}`);
	const json = (await res.json()) as {
		answer?: string;
		results?: Array<{ title: string; url: string; content: string; score: number }>;
	};
	return {
		answer: json.answer,
		results: (json.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content, score: r.score })),
	};
}

async function searchBrave(q: string, n: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`;
	const res = await doFetch(url, signal, {
		headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY ?? "", accept: "application/json" },
	});
	if (!res.ok) throw new Error(`Brave error ${res.status}: ${await res.text()}`);
	const json = (await res.json()) as {
		web?: { results?: Array<{ title: string; url: string; description: string }> };
	};
	return (json.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
}

async function searchSerper(q: string, n: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const res = await doFetch("https://google.serper.dev/search", signal, {
		method: "POST",
		headers: { "X-API-KEY": process.env.SERPER_API_KEY ?? "", "content-type": "application/json" },
		body: JSON.stringify({ q, num: n }),
	});
	if (!res.ok) throw new Error(`Serper error ${res.status}: ${await res.text()}`);
	const json = (await res.json()) as {
		organic?: Array<{ title: string; link: string; snippet: string }>;
	};
	return (json.organic ?? []).slice(0, n).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet }));
}

async function searchDuckDuckGo(q: string, n: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
	const res = await doFetch(url, signal);
	if (!res.ok) throw new Error(`DuckDuckGo error ${res.status}`);
	const html = await res.text();

	// Each result block: <a class="result__a" href="...">title</a> ... <a class="result__snippet">snippet</a>
	const results: SearchResult[] = [];
	const blockRe =
		/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
	let m: RegExpExecArray | null;
	while ((m = blockRe.exec(html)) !== null) {
		let href = decodeEntities(m[1]);
		// DDG sometimes wraps links in /l/?uddg=<encoded>
		const uddg = href.match(/[?&]uddg=([^&]+)/);
		if (uddg) href = decodeURIComponent(uddg[1]);
		const title = stripTags(m[2]).trim();
		const snippet = stripTags(m[3]).trim();
		if (href && title) results.push({ title, url: href, snippet });
		if (results.length >= n) break;
	}
	return results;
}

function stripTags(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, ""));
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#x2F;/g, "/")
		.replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(parseInt(d, 10)));
}

function pickFetchBackend(): "tavily" | "raw" {
	const forced = (process.env.WEB_FETCH_BACKEND || "").toLowerCase();
	if (forced === "tavily" || forced === "raw") return forced;
	return process.env.TAVILY_API_KEY ? "tavily" : "raw";
}

async function extractTavily(
	url: string,
	signal?: AbortSignal,
	opts?: { extractDepth?: string; format?: string },
): Promise<{ url: string; content: string; credits?: number }> {
	const res = await doFetch("https://api.tavily.com/extract", signal, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"Authorization": `Bearer ${process.env.TAVILY_API_KEY}`,
		},
		body: JSON.stringify({
			urls: url,
			extract_depth: opts?.extractDepth ?? "basic",
			format: opts?.format ?? "markdown",
			include_usage: true,
		}),
	});
	if (!res.ok) throw new Error(`Tavily Extract error ${res.status}: ${await res.text()}`);
	const json = (await res.json()) as {
		results?: Array<{ url: string; raw_content: string }>;
		failed_results?: Array<{ url: string; error: string }>;
		usage?: { credits: number };
	};
	const result = json.results?.[0];
	if (!result?.raw_content) {
		const reason = json.failed_results?.[0]?.error ?? "empty response";
		throw new Error(`Tavily Extract returned no content for ${url}: ${reason}`);
	}
	return { url: result.url, content: result.raw_content, credits: json.usage?.credits };
}

function pickBackend(): "tavily" | "brave" | "serper" | "duckduckgo" {
	const forced = (process.env.WEB_SEARCH_BACKEND || "").toLowerCase();
	if (forced === "tavily" || forced === "brave" || forced === "serper" || forced === "duckduckgo")
		return forced;
	if (process.env.TAVILY_API_KEY) return "tavily";
	if (process.env.BRAVE_API_KEY) return "brave";
	if (process.env.SERPER_API_KEY) return "serper";
	return "duckduckgo";
}

// --------------------------- tool result detail types ------------------

/** Structured details returned by the web_fetch tool. */
type WebFetchDetails = {
	url: string;
	source: "tavily" | "raw";
	credits?: number;
	status?: number;
	contentType?: string;
	bytes: number;
	truncated: boolean;
	format: "markdown" | "text" | "raw";
};

/** Structured details returned by the web_search tool. */
type WebSearchDetails = {
	backend: "tavily" | "brave" | "serper" | "duckduckgo";
	query?: string;
	results?: SearchResult[];
	answer?: string;
	error?: string;
};

// --------------------------- extension --------------------------------

export default function webExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof fetchParams, WebFetchDetails>({
		name: "web_fetch",
		label: "Fetch URL",
		description:
			"Fetch a web page and return its readable content. When TAVILY_API_KEY is set, uses Tavily Extract for cleaner content (handles JS-rendered pages, tables, embedded content). Markdown, source, and data-file URLs are always fetched with raw HTTP to preserve exact contents. Set format='raw' for JSON APIs or source files, or engine='raw' to skip Tavily entirely.",
		promptSnippet: "Fetch a URL and return readable text content from web pages",
		promptGuidelines: [
			"Use web_fetch when the user provides a URL or when web_search results need to be read in full.",
			"Prefer the default engine for articles, docs, and HTML pages. Markdown, source, and data-file URLs are fetched with raw HTTP automatically; use format='raw' for any other URL where the literal bytes matter.",
		],
		parameters: fetchParams,
		async execute(_id, params, signal) {
			const originalUrl = params.url;
			if (!/^https?:\/\//i.test(originalUrl)) {
				throw new Error("web_fetch only supports http(s) URLs");
			}
			const normalizedUrl = normalizeRawFileUrl(originalUrl);
			const preserveRaw = shouldPreserveRaw(normalizedUrl);
			const url = preserveRaw ? normalizedUrl : originalUrl;
			const format = params.format ?? "markdown";
			const maxChars = params.maxChars ?? 30_000;
			const requestedEngine = params.engine ?? "auto";

			// format:raw and Markdown/source/data URLs always bypass Tavily regardless of engine setting.
			const effectiveEngine: "tavily" | "raw" =
				format === "raw" || preserveRaw ? "raw" :
				requestedEngine === "auto" ? pickFetchBackend() :
				requestedEngine === "tavily" ? "tavily" : "raw";

			if (effectiveEngine === "tavily") {
				try {
					const ex = await extractTavily(url, signal, {
						extractDepth: params.extractDepth,
						format: format === "text" ? "text" : "markdown",
					});
					const { text, truncated } = truncate(ex.content, maxChars);
					const depthLabel = params.extractDepth ?? "basic";
					const creditsLabel = ex.credits !== undefined ? `, credits=${ex.credits}` : "";
					const header = [
						`URL: ${ex.url}`,
						`Source: Tavily Extract (depth=${depthLabel}${creditsLabel})`,
						`Bytes: ${ex.content.length}${truncated ? ` (truncated to ${maxChars} chars)` : ""}`,
					].join("\n");
					return {
						content: [{ type: "text", text: `${header}\n\n${text}` }],
						details: { url: ex.url, source: "tavily", credits: ex.credits, bytes: ex.content.length, truncated, format },
					};
				} catch (err) {
					// engine:tavily was explicit — propagate the error
					if (requestedEngine === "tavily") throw err;
					// engine:auto — fall through to raw fetch
				}
			}

			// ----- Raw fetch path -----
			const res = await doFetch(url, signal);
			const ct = res.headers.get("content-type") || "";
			const ctLower = ct.toLowerCase();
			const body = await res.text();

			let out: string;
			if (format === "raw" || preserveRaw || (!ctLower.includes("html") && !ctLower.includes("xml"))) {
				out = body;
			} else {
				out = htmlToReadable(body, res.url);
			}

			const { text, truncated } = truncate(out, maxChars);
			const header = [
				`URL: ${res.url}`,
				`Status: ${res.status}`,
				`Content-Type: ${ct || "(none)"}`,
				`Bytes: ${body.length}${truncated ? ` (truncated to ${maxChars} chars)` : ""}`,
			].join("\n");

			return {
				content: [{ type: "text", text: `${header}\n\n${text}` }],
				details: {
					url: res.url,
					source: "raw",
					status: res.status,
					contentType: ct,
					bytes: body.length,
					truncated,
					format,
				},
			};
		},
	});

	pi.registerTool<typeof searchParams, WebSearchDetails>({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web and return a ranked list of results (title, URL, snippet). Pair with web_fetch to read full pages. Backend auto-selected from TAVILY_API_KEY / BRAVE_API_KEY / SERPER_API_KEY, falling back to DuckDuckGo (no key).",
		promptSnippet: "Search the web for current information using web_search",
		promptGuidelines: [
			"Use web_search when the user asks about current events, recent docs, or anything outside training data; follow up with web_fetch to read promising results.",
		],
		parameters: searchParams,
		async execute(_id, params, signal) {
			const q = params.query.trim();
			if (!q) throw new Error("query is required");
			const n = params.maxResults ?? 8;
			const backend = pickBackend();

			let results: SearchResult[];
			let tavilyAnswer: string | undefined;
			try {
				switch (backend) {
					case "tavily": {
						const tavily = await searchTavily(q, n, signal, {
							topic: params.topic,
							timeRange: params.timeRange,
							searchDepth: params.searchDepth,
						});
						tavilyAnswer = tavily.answer;
						results = tavily.results;
						break;
					}
					case "brave":
						results = await searchBrave(q, n, signal);
						break;
					case "serper":
						results = await searchSerper(q, n, signal);
						break;
					default:
						results = await searchDuckDuckGo(q, n, signal);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Search failed (backend=${backend}): ${msg}` }],
					details: { backend, error: msg },
					isError: true,
				};
			}

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results (backend=${backend}, query=${q})` }],
					details: { backend, query: q, results: [] },
				};
			}

			const lines = [
				`Backend: ${backend}`,
				`Query: ${q}`,
				`Results: ${results.length}`,
				...(tavilyAnswer ? ["", `Answer: ${tavilyAnswer}`] : []),
				"",
				...results.map(
					(r, i) => {
						const score = r.score !== undefined ? ` [score: ${r.score.toFixed(2)}]` : "";
						return `${i + 1}. ${r.title}${score}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ").slice(0, 400)}`;
					},
				),
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { backend, query: q, results, answer: tavilyAnswer },
			};
		},
	});
}
