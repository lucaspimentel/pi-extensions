// Personal overlay extension tests: config loading plus the session_start and
// before_agent_start handlers, driven against a temp agent dir and temp git
// repositories. Covers the no-config default, symlink dedupe, byte-identical
// content grouping, root-first ordering, an unreachable .git, the env kill
// switch, the 100 KB cap and its cut/omitted note, non-empty bodies for
// truncated invalid UTF-8, skipped-entry warning
// reasons, symlink-target notification, UTF-8 boundary safety, malformed
// config, both config shapes, and a linked-worktree .git file.
//
// Run: node --test tests/personal-overlay.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import personalOverlayExtension from "../extensions/personal-overlay.ts";

type Handler = (event: any, ctx: any) => unknown;

function loadExtension(): Record<string, Handler> {
	const handlers: Record<string, Handler> = {};
	const pi: any = {
		on(event: string, handler: Handler) {
			handlers[event] = handler;
			return () => {};
		},
	};
	personalOverlayExtension(pi);
	assert.ok(handlers.session_start, "session_start handler should be registered");
	assert.ok(handlers.before_agent_start, "before_agent_start handler should be registered");
	return handlers;
}

interface Sandbox {
	root: string;
	agentDir: string;
	repo: string;
}

// Isolates the global config: a real ~/.pi/agent/personal-overlay.json must
// never leak in. getAgentDir() reads PI_CODING_AGENT_DIR on every call.
function makeSandbox(t: any): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "personal-overlay-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const repo = join(root, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(repo, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return { root, agentDir, repo };
}

function writeConfig(agentDir: string, value: unknown): void {
	writeFileSync(
		join(agentDir, "personal-overlay.json"),
		typeof value === "string" ? value : JSON.stringify(value),
	);
}

async function drive(
	handlers: Record<string, Handler>,
	cwd: string,
	opts: { disabled?: boolean } = {},
): Promise<{ section?: string; notifications: Array<{ message: string; type?: string }> }> {
	const previous = process.env.PI_PERSONAL_OVERLAY;
	if (opts.disabled) {
		process.env.PI_PERSONAL_OVERLAY = "0";
	} else {
		delete process.env.PI_PERSONAL_OVERLAY;
	}

	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx = {
		cwd,
		ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
	};
	try {
		await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await handlers.before_agent_start(event, ctx);
		return { section: event.systemPromptOptions.sections.personal_overlay, notifications };
	} finally {
		if (previous === undefined) delete process.env.PI_PERSONAL_OVERLAY;
		else process.env.PI_PERSONAL_OVERLAY = previous;
	}
}

test("no config injects nothing even when overlay files exist", async (t) => {
	const { repo } = makeSandbox(t);
	mkdirSync(join(repo, ".git"));
	writeFileSync(join(repo, "AGENTS_PERSONAL.md"), "ROOT\n");

	const { section, notifications } = await drive(loadExtension(), repo);
	assert.equal(section, undefined);
	assert.deepEqual(notifications, []);
});

test("loads configured overlays root-first and dedupes symlinked names", async (t) => {
	const { agentDir, repo } = makeSandbox(t);
	mkdirSync(join(repo, ".git"));
	writeFileSync(join(repo, "shared.md"), "SHARED-CONTENT\n");
	symlinkSync("shared.md", join(repo, "AGENTS_PERSONAL.md"), "file");
	symlinkSync("shared.md", join(repo, "CLAUDE_PERSONAL.md"), "file");
	const sub = join(repo, "sub");
	mkdirSync(sub);
	writeFileSync(join(sub, "AGENTS_PERSONAL.md"), "SUB-CONTENT\n");
	writeConfig(agentDir, { files: ["AGENTS_PERSONAL.md", "CLAUDE_PERSONAL.md"] });

	const { section, notifications } = await drive(loadExtension(), sub);
	assert.equal(typeof section, "string");
	const rootIndex = section!.indexOf("../AGENTS_PERSONAL.md:\n\nSHARED-CONTENT");
	const subIndex = section!.indexOf("AGENTS_PERSONAL.md:\n\nSUB-CONTENT");
	assert.ok(rootIndex >= 0, `root entry missing from:\n${section}`);
	assert.ok(subIndex >= 0, `cwd entry missing from:\n${section}`);
	assert.ok(rootIndex < subIndex, "repo-root entry must precede the cwd entry");
	assert.equal(section!.split("SHARED-CONTENT").length - 1, 1, "symlinked duplicate injected once");
	assert.ok(!section!.includes("CLAUDE_PERSONAL.md"), "deduped name must not add a header");
	assert.equal(notifications.length, 1, "one session_start notification");
});

test("groups byte-identical files under one comma-separated header", async (t) => {
	const { agentDir, repo } = makeSandbox(t);
	mkdirSync(join(repo, ".git"));
	writeFileSync(join(repo, "AGENTS_PERSONAL.md"), "SHARED-CONTENT\n");
	writeFileSync(join(repo, "CLAUDE_PERSONAL.md"), "SHARED-CONTENT\n");
	writeConfig(agentDir, { files: ["AGENTS_PERSONAL.md", "CLAUDE_PERSONAL.md"] });

	const { section } = await drive(loadExtension(), repo);
	assert.equal(typeof section, "string");
	assert.ok(
		section!.includes("AGENTS_PERSONAL.md, CLAUDE_PERSONAL.md:\n\nSHARED-CONTENT"),
		section,
	);
	assert.equal(section!.split("SHARED-CONTENT").length - 1, 1, "body injected once");
});

test("reads nothing when no repository root is reachable", async (t) => {
	const { agentDir, root } = makeSandbox(t);
	const deep = join(root, "nogit", "a", "b");
	mkdirSync(deep, { recursive: true });
	writeFileSync(join(deep, "AGENTS_PERSONAL.md"), "NOGIT\n");
	writeConfig(agentDir, { files: ["AGENTS_PERSONAL.md"] });

	const { section, notifications } = await drive(loadExtension(), deep);
	assert.equal(section, undefined);
	assert.deepEqual(notifications, []);
});

test("PI_PERSONAL_OVERLAY=0 disables injection and notification", async (t) => {
	const { agentDir, repo } = makeSandbox(t);
	mkdirSync(join(repo, ".git"));
	writeFileSync(join(repo, "AGENTS_PERSONAL.md"), "DISABLED\n");
	writeConfig(agentDir, { files: ["AGENTS_PERSONAL.md"] });

	const { section, notifications } = await drive(loadExtension(), repo, { disabled: true });
	assert.equal(section, undefined);
	assert.deepEqual(notifications, []);
});

test("caps the injected section at 100 KB and names the cut and omitted files", async (t) => {
	const { agentDir, repo } = makeSandbox(t);
	mkdirSync(join(repo, ".git"));
	writeFileSync(join(repo, "AGENTS_PERSONAL.md"), "x".repeat(150 * 1024));
	writeFileSync(join(repo, "CLAUDE_PERSONAL.md"), "SMALL\n");
	writeConfig(agentDir, { files: ["AGENTS_PERSONAL.md", "CLAUDE_PERSONAL.md"] });

	const { section } = await drive(loadExtension(), repo);
	assert.equal(typeof section, "string");
	assert.ok(section!.includes("cut AGENTS_PERSONAL.md"), section!.slice(-160));
	assert.ok(section!.includes("omitted CLAUDE_PERSONAL.md"), section!.slice(-160));
	assert.ok(
		Buffer.byteLength(section!, "utf8") <= 100 * 1024,
		`section is ${Buffer.byteLength(section!, "utf8")} bytes`,
	);
});

test("keeps a non-empty body and respects the cap for a truncated invalid-UTF-8 file", async (t) => {
	const { agentDir, repo } = makeSandbox(t);
	mkdirSync(join(repo, ".git"));
	writeFileSync(join(repo, "AGENTS_PERSONAL.md"), Buffer.alloc(150 * 1024, 0xe9));
	writeConfig(agentDir, { files: ["AGENTS_PERSONAL.md"] });

	const { section } = await drive(loadExtension(), repo);
	assert.equal(typeof section, "string");
	assert.ok(section!.includes("cut AGENTS_PERSONAL.md"), section!.slice(-160));
	const marker = "AGENTS_PERSONAL.md:\n\n";
	const body = section!.slice(section!.indexOf(marker) + marker.length);
	assert.ok(body.length > 1000, `body should not be empty, was ${body.length} chars`);
	assert.ok(
		Buffer.byteLength(section!, "utf8") <= 100 * 1024,
		`section is ${Buffer.byteLength(section!, "utf8")} bytes`,
	);
});

test("does not split a UTF-8 character at the cap", async (t) => {
	const { agentDir, repo } = makeSandbox(t);
	mkdirSync(join(repo, ".git"));
	writeFileSync(join(repo, "AGENTS_PERSONAL.md"), "\u20ac".repeat(60 * 1024));
	writeConfig(agentDir, { files: ["AGENTS_PERSONAL.md"] });

	const { section } = await drive(loadExtension(), repo);
	assert.equal(typeof section, "string");
	assert.ok(!section!.includes("\uFFFD"), "replacement character in the truncated section");
});

test("skips unusable config entries and warns with a reason for each", async (t) => {
	const { agentDir, repo } = makeSandbox(t);
	mkdirSync(join(repo, ".git"));
	writeFileSync(join(repo, "AGENTS_PERSONAL.md"), "VALID\n");
	writeConfig(agentDir, {
		files: ["AGENTS_PERSONAL.md", "/abs/evil.md", "../escape.md", "", 42, "also\\ok.md"],
	});

	const { section, notifications } = await drive(loadExtension(), repo);
	assert.equal(typeof section, "string");
	assert.ok(section!.includes("VALID"));
	assert.ok(!section!.includes("escape"));
	const warnings = notifications.filter((entry) => entry.type === "warning");
	assert.equal(warnings.length, 1, JSON.stringify(notifications));
	assert.ok(warnings[0].message.includes("absolute"), warnings[0].message);
	assert.ok(warnings[0].message.includes("escapes the repo"), warnings[0].message);
	assert.ok(warnings[0].message.includes("empty"), warnings[0].message);
	assert.ok(warnings[0].message.includes("not a string"), warnings[0].message);
});

test("warns once and injects nothing when the config cannot be parsed", async (t) => {
	const { agentDir, repo } = makeSandbox(t);
	mkdirSync(join(repo, ".git"));
	writeFileSync(join(repo, "AGENTS_PERSONAL.md"), "X\n");
	writeConfig(agentDir, "{not json");

	const { section, notifications } = await drive(loadExtension(), repo);
	assert.equal(section, undefined);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "warning");
});

test("accepts a top-level array config", async (t) => {
	const { agentDir, repo } = makeSandbox(t);
	mkdirSync(join(repo, ".git"));
	writeFileSync(join(repo, "AGENTS_PERSONAL.md"), "ARRAY-FORM\n");
	writeConfig(agentDir, ["AGENTS_PERSONAL.md"]);

	const { section } = await drive(loadExtension(), repo);
	assert.ok(typeof section === "string" && section.includes("ARRAY-FORM"));
});

test("treats a .git file (linked worktree) as the repository root", async (t) => {
	const { agentDir, repo } = makeSandbox(t);
	writeFileSync(join(repo, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
	writeFileSync(join(repo, "AGENTS_PERSONAL.md"), "WORKTREE\n");
	writeConfig(agentDir, { files: ["AGENTS_PERSONAL.md"] });

	const { section } = await drive(loadExtension(), repo);
	assert.ok(typeof section === "string" && section.includes("WORKTREE"));
});

test("shows the resolved target when a configured symlink points elsewhere", async (t) => {
	const { agentDir, repo } = makeSandbox(t);
	mkdirSync(join(repo, ".git"));
	writeFileSync(join(repo, "target-doc.md"), "LINKED\n");
	symlinkSync("target-doc.md", join(repo, "CLAUDE_PERSONAL.md"), "file");
	writeConfig(agentDir, { files: ["CLAUDE_PERSONAL.md"] });

	const { section, notifications } = await drive(loadExtension(), repo);
	assert.ok(typeof section === "string" && section.includes("LINKED"));
	const info = notifications.find((entry) => entry.type === "info");
	assert.ok(info, JSON.stringify(notifications));
	assert.ok(info!.message.includes("->"), info!.message);
	assert.ok(info!.message.includes("target-doc.md"), info!.message);
});
