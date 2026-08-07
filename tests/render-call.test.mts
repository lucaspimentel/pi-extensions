// Test harness for the renderCall methods added to the web and slack tools.
//
// Imports the REAL default exports, drives them with a mock `pi` that captures
// registered tool definitions, then calls each tool's renderCall with sample
// args (full, empty/streaming, and non-default options) and a mock theme that
// wraps text with visible role markers so we can assert which roles are used.
//
// Run: node tests/render-call.test.mts
import webExtension from "../extensions/web/index.ts";
import slackExtension from "../extensions/slack-via-claude.ts";

// ── Capture registered tools ──────────────────────────────────────────────────
const tools = new Map<string, any>();

function loadExtension(ext: (pi: any) => void) {
	const pi: any = {
		registerTool(tool: any) {
			if (tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
			tools.set(tool.name, tool);
		},
	};
	ext(pi);
}

loadExtension(webExtension);
loadExtension(slackExtension);

// ── Mock theme: wrap text with visible role markers ───────────────────────────
// fg(role, text) -> ⟨role⟩text⟨/role⟩   so assertions can verify which role was
// used. bold(text) -> **text**.
const theme: any = {
	fg(role: string, text: string) {
		return `⟨${role}⟩${text}⟨/${role}⟩`;
	},
	bold(text: string) {
		return `**${text}**`;
	},
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const WIDTH = 1000; // large enough that no wrapping occurs

function render(name: string, args: any): string {
	const tool = tools.get(name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	if (typeof tool.renderCall !== "function") {
		throw new Error(`tool ${name} has no renderCall`);
	}
	const comp = tool.renderCall(args, theme, undefined as any);
	const lines = comp.render(WIDTH) as string[];
	return lines.map((l) => l.trimEnd()).join("\n");
}

let failures = 0;
function expect(name: string, args: any, expected: string) {
	const actual = render(name, args);
	const label = `${name}${args && Object.keys(args).length ? " " + JSON.stringify(args) : " {}"}`;
	if (actual === expected) {
		console.log(`  ✓ ${label}`);
	} else {
		failures++;
		console.error(`  ✗ ${label}`);
		console.error(`      expected: ${expected}`);
		console.error(`      actual:   ${actual}`);
	}
}

// ── web_fetch ─────────────────────────────────────────────────────────────────
console.log("\n── web_fetch ────────────────────────────────────────────────────");
expect("web_fetch", { url: "https://example.com" },
	"⟨toolTitle⟩**Fetch**⟨/toolTitle⟩ ⟨toolOutput⟩https://example.com⟨/toolOutput⟩");
expect("web_fetch", { url: "https://example.com", format: "raw" },
	"⟨toolTitle⟩**Fetch**⟨/toolTitle⟩ ⟨toolOutput⟩https://example.com⟨/toolOutput⟩⟨muted⟩ (raw)⟨/muted⟩");
expect("web_fetch", { url: "https://example.com", engine: "raw" },
	"⟨toolTitle⟩**Fetch**⟨/toolTitle⟩ ⟨toolOutput⟩https://example.com⟨/toolOutput⟩⟨muted⟩ (raw)⟨/muted⟩");
expect("web_fetch", { url: "https://example.com", format: "markdown" },
	"⟨toolTitle⟩**Fetch**⟨/toolTitle⟩ ⟨toolOutput⟩https://example.com⟨/toolOutput⟩");
// streaming / empty url -> placeholder
expect("web_fetch", {},
	"⟨toolTitle⟩**Fetch**⟨/toolTitle⟩ ⟨toolOutput⟩...⟨/toolOutput⟩");

// ── web_search ───────────────────────────────────────────────────────────────
console.log("\n── web_search ────────────────────────────────────────────────────");
expect("web_search", { query: "hello world" },
	`⟨toolTitle⟩**Web Search**⟨/toolTitle⟩ ⟨toolOutput⟩"hello world"⟨/toolOutput⟩`);
expect("web_search", { query: "hello world", topic: "news", timeRange: "week", maxResults: 12 },
	`⟨toolTitle⟩**Web Search**⟨/toolTitle⟩ ⟨toolOutput⟩"hello world"⟨/toolOutput⟩⟨muted⟩ (news, week, 12 results)⟨/muted⟩`);
// default topic "general" is omitted; default maxResults 8 is omitted
expect("web_search", { query: "x", topic: "general", maxResults: 8 },
	`⟨toolTitle⟩**Web Search**⟨/toolTitle⟩ ⟨toolOutput⟩"x"⟨/toolOutput⟩`);
// only timeRange
expect("web_search", { query: "x", timeRange: "month" },
	`⟨toolTitle⟩**Web Search**⟨/toolTitle⟩ ⟨toolOutput⟩"x"⟨/toolOutput⟩⟨muted⟩ (month)⟨/muted⟩`);
// streaming / empty query -> placeholder
expect("web_search", {},
	`⟨toolTitle⟩**Web Search**⟨/toolTitle⟩ ⟨toolOutput⟩...⟨/toolOutput⟩`);

// ── slack_search ──────────────────────────────────────────────────────────────
console.log("\n── slack_search ──────────────────────────────────────────────────");
expect("slack_search", { query: "deploy failed" },
	`⟨toolTitle⟩**Search Slack**⟨/toolTitle⟩ ⟨toolOutput⟩"deploy failed"⟨/toolOutput⟩`);
expect("slack_search", {},
	`⟨toolTitle⟩**Search Slack**⟨/toolTitle⟩ ⟨toolOutput⟩...⟨/toolOutput⟩`);

// ── slack_read_channel ────────────────────────────────────────────────────────
console.log("\n── slack_read_channel ────────────────────────────────────────────");
expect("slack_read_channel", { channel: "general" },
	`⟨toolTitle⟩**Read Slack**⟨/toolTitle⟩ ⟨toolOutput⟩#general⟨/toolOutput⟩`);
expect("slack_read_channel", { channel: "general", limit: 50 },
	`⟨toolTitle⟩**Read Slack**⟨/toolTitle⟩ ⟨toolOutput⟩#general⟨/toolOutput⟩⟨muted⟩ (limit 50)⟨/muted⟩`);
// default limit (unset) -> no suffix
expect("slack_read_channel", { channel: "general", limit: 20 },
	`⟨toolTitle⟩**Read Slack**⟨/toolTitle⟩ ⟨toolOutput⟩#general⟨/toolOutput⟩⟨muted⟩ (limit 20)⟨/muted⟩`);
// streaming / empty channel -> placeholder
expect("slack_read_channel", {},
	`⟨toolTitle⟩**Read Slack**⟨/toolTitle⟩ ⟨toolOutput⟩...⟨/toolOutput⟩`);

// ── slack_read_thread ──────────────────────────────────────────────────────────
console.log("\n── slack_read_thread ──────────────────────────────────────────────");
expect("slack_read_thread", { channel: "general", thread_ts: "1234567890.123456" },
	`⟨toolTitle⟩**Read Slack thread**⟨/toolTitle⟩ ⟨toolOutput⟩#general⟨/toolOutput⟩⟨muted⟩ @1234567890.123456⟨/muted⟩`);
// streaming channel -> placeholder, no thread suffix
expect("slack_read_thread", {},
	`⟨toolTitle⟩**Read Slack thread**⟨/toolTitle⟩ ⟨toolOutput⟩...⟨/toolOutput⟩`);
// channel present but thread_ts streaming -> no @ suffix
expect("slack_read_thread", { channel: "general" },
	`⟨toolTitle⟩**Read Slack thread**⟨/toolTitle⟩ ⟨toolOutput⟩#general⟨/toolOutput⟩`);

// ── Summary ────────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────────────────────────");
if (failures === 0) {
	console.log(`All renderCall tests passed.`);
} else {
	console.error(`${failures} test(s) FAILED.`);
	process.exit(1);
}
