/**
 * stash
 *
 * Save & restore editor drafts on a disk-backed LIFO stack, similar in spirit
 * to `git stash`.
 *
 * Commands:
 *   /stash [name]     Save the current editor text onto the stash and clear
 *                      the editor. Optional `name` gives it a slot you can
 *                      pop by name later; unnamed stashes are anonymous.
 *   /pop [name]        Restore the most recent stash (or a named one) into
 *                      the editor. If the editor already has non-blank text,
 *                      that text is pushed onto the stash first (as an
 *                      anonymous entry) so nothing is lost.
 *   /stash-list        List all stashed entries (index, name, age, preview).
 *   /stash-drop <name> Remove a named entry without restoring it.
 *   /stash-clear       Remove all entries (confirms first when UI is available).
 *
 * Shortcuts:
 *   ctrl+alt+s   Stash the editor text (anonymous) and clear the editor.
 *   ctrl+alt+r   Restore (pop) the most recently stashed entry.
 *
 * Storage:
 *   ~/.pi/agent/pi-stash.json (override with the PI_STASH_FILE env var, e.g.
 *   for tests). The store is user-global so drafts can move between checkouts;
 *   each entry records the `cwd` it was stashed from for reference.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface StashEntry {
	name?: string;
	text: string;
	savedAt: string;
	cwd?: string;
}

export interface StashState {
	version: 1;
	entries: StashEntry[];
}

const MAX_ENTRIES = 50;
const MAX_TEXT = 256 * 1024;
const TRUNCATION_NOTICE = "\n\n[…truncated by pi-stash: entry exceeded max size…]";

export function stashFilePath(home: string = homedir()): string {
	if (process.env.PI_STASH_FILE) return process.env.PI_STASH_FILE;
	return join(home, ".pi", "agent", "pi-stash.json");
}

function emptyState(): StashState {
	return { version: 1, entries: [] };
}

export function loadStash(home: string = homedir()): StashState {
	const path = stashFilePath(home);
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || !Array.isArray(parsed.entries)) return emptyState();
		return { version: 1, entries: parsed.entries };
	} catch {
		return emptyState();
	}
}

export function saveStash(state: StashState, home: string = homedir()): void {
	const path = stashFilePath(home);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
	renameSync(tmp, path);
}

/** Cap total entries, dropping the oldest anonymous entries first, then oldest overall. */
function enforceCap(state: StashState): StashState {
	if (state.entries.length <= MAX_ENTRIES) return state;
	const entries = [...state.entries];
	while (entries.length > MAX_ENTRIES) {
		let dropIdx = entries.findIndex((e) => !e.name);
		if (dropIdx === -1) dropIdx = 0;
		entries.splice(dropIdx, 1);
	}
	return { ...state, entries };
}

function clampText(text: string): string {
	if (text.length <= MAX_TEXT) return text;
	return text.slice(0, MAX_TEXT - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
}

export function pushEntry(state: StashState, text: string, name?: string, cwd?: string): StashState {
	const entry: StashEntry = { name, text: clampText(text), savedAt: new Date().toISOString(), cwd };
	let entries = state.entries;
	if (name) {
		entries = entries.filter((e) => e.name !== name);
	}
	entries = [...entries, entry];
	return enforceCap({ ...state, entries });
}

export function popEntry(state: StashState, name?: string): { entry: StashEntry; state: StashState } | undefined {
	if (state.entries.length === 0) return undefined;
	let idx: number;
	if (name) {
		idx = state.entries.findIndex((e) => e.name === name);
		if (idx === -1) return undefined;
	} else {
		idx = state.entries.length - 1;
	}
	const entry = state.entries[idx];
	const entries = state.entries.slice(0, idx).concat(state.entries.slice(idx + 1));
	return { entry, state: { ...state, entries } };
}

export function dropEntry(state: StashState, name: string): StashState {
	return { ...state, entries: state.entries.filter((e) => e.name !== name) };
}

export function clearEntries(state: StashState): StashState {
	return { ...state, entries: [] };
}

function relativeAge(savedAt: string, now: Date): string {
	const ms = now.getTime() - new Date(savedAt).getTime();
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	return `${day}d ago`;
}

function firstLinePreview(text: string, maxLen = 60): string {
	const firstLine = text.split("\n", 1)[0] ?? "";
	const truncated = firstLine.length > maxLen ? `${firstLine.slice(0, maxLen)}…` : firstLine;
	return truncated || "(blank first line)";
}

export function formatList(state: StashState, now: Date = new Date()): string {
	if (state.entries.length === 0) return "Stash is empty.";
	const lines = state.entries
		.map((e, i) => {
			const lineCount = e.text.split("\n").length;
			const label = e.name ? `"${e.name}"` : "(anon)";
			return `${i + 1}. ${label} — ${relativeAge(e.savedAt, now)}, ${lineCount} line(s): ${firstLinePreview(e.text)}`;
		})
		.reverse(); // newest first
	return `Stash (${state.entries.length}):\n${lines.join("\n")}`;
}

export default function stash(pi: ExtensionAPI) {
	function updateStatus(ctx: ExtensionContext) {
		const count = loadStash().entries.length;
		ctx.ui.setStatus("stash", count > 0 ? ctx.ui.theme.fg("dim", `📥 ${count}`) : undefined);
	}

	function doStash(ctx: ExtensionContext, name: string | undefined): void {
		if (!ctx.hasUI) {
			ctx.ui.notify("Stash requires an interactive UI.", "warning");
			return;
		}
		const text = ctx.ui.getEditorText();
		if (!text.trim()) {
			ctx.ui.notify("Editor is empty; nothing to stash.", "warning");
			return;
		}
		let state = loadStash();
		state = pushEntry(state, text, name, ctx.cwd);
		saveStash(state);
		ctx.ui.setEditorText("");
		const label = name ? ` as "${name}"` : "";
		ctx.ui.notify(`Stashed${label} (${state.entries.length} in stash).`, "info");
		updateStatus(ctx);
	}

	function doPop(ctx: ExtensionContext, name: string | undefined): void {
		if (!ctx.hasUI) {
			ctx.ui.notify("Pop requires an interactive UI.", "warning");
			return;
		}
		let state = loadStash();
		const popped = popEntry(state, name);
		if (!popped) {
			ctx.ui.notify(name ? `No stash named "${name}".` : "Stash is empty.", "warning");
			return;
		}
		state = popped.state;

		const current = ctx.ui.getEditorText();
		let swapNotice = "";
		if (current.trim()) {
			state = pushEntry(state, current, undefined, ctx.cwd);
			swapNotice = " (current editor text was stashed first)";
		}

		saveStash(state);
		ctx.ui.setEditorText(popped.entry.text);
		const label = popped.entry.name ? ` "${popped.entry.name}"` : "";
		ctx.ui.notify(`Restored${label} from stash${swapNotice}.`, "info");
		updateStatus(ctx);
	}

	function namedCompletions(prefix: string) {
		const state = loadStash();
		const names = state.entries
			.map((e) => e.name)
			.filter((n): n is string => !!n && n.startsWith(prefix));
		if (names.length === 0) return null;
		return names.map((n) => ({ value: n, label: n }));
	}

	pi.registerCommand("stash", {
		description: "Save the editor text onto the stash and clear the editor (optionally named)",
		handler: async (args, ctx) => {
			doStash(ctx, args.trim() || undefined);
		},
	});

	pi.registerCommand("pop", {
		description: "Restore the most recent (or named) stashed draft into the editor",
		getArgumentCompletions: (prefix) => namedCompletions(prefix),
		handler: async (args, ctx) => {
			doPop(ctx, args.trim() || undefined);
		},
	});

	pi.registerCommand("stash-list", {
		description: "List stashed drafts",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatList(loadStash()), "info");
		},
	});

	pi.registerCommand("stash-drop", {
		description: "Remove a named stash entry without restoring it",
		getArgumentCompletions: (prefix) => namedCompletions(prefix),
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /stash-drop <name>", "warning");
				return;
			}
			const state = loadStash();
			if (!state.entries.some((e) => e.name === name)) {
				ctx.ui.notify(`No stash named "${name}".`, "warning");
				return;
			}
			saveStash(dropEntry(state, name));
			ctx.ui.notify(`Dropped "${name}" from stash.`, "info");
			updateStatus(ctx);
		},
	});

	pi.registerCommand("stash-clear", {
		description: "Remove all stashed drafts",
		handler: async (_args, ctx) => {
			const state = loadStash();
			if (state.entries.length === 0) {
				ctx.ui.notify("Stash is already empty.", "info");
				return;
			}
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Clear stash",
					`Remove all ${state.entries.length} stashed entries? This cannot be undone.`,
				);
				if (!ok) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
			}
			saveStash(clearEntries(state));
			ctx.ui.notify("Stash cleared.", "info");
			updateStatus(ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+s", {
		description: "Stash editor draft",
		handler: (ctx) => doStash(ctx, undefined),
	});

	pi.registerShortcut("ctrl+alt+r", {
		description: "Restore last stashed draft",
		handler: (ctx) => doPop(ctx, undefined),
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});
}
