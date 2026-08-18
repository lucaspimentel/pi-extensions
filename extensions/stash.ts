/**
 * stash
 *
 * Save & restore editor drafts on a disk-backed LIFO stack, similar in spirit
 * to `git stash`.
 *
 * Primary interaction is the shortcuts (typing a slash command only works
 * when the editor holds something other than the draft you want to move):
 *   ctrl+alt+s   Stash the editor text and clear the editor.
 *   ctrl+alt+r   Restore (pop) the most recently stashed entry.
 *
 * Commands (index-addressed; run /stash-list to see current indexes):
 *   /pop [n]           Restore stash entry n (1 = newest, default) into the
 *                        editor. If the editor already has non-blank text,
 *                        that text is pushed onto the stash first so nothing
 *                        is lost — note this shifts indexes.
 *   /stash-list         List all stashed entries, numbered 1 (newest) upward.
 *   /stash-drop <n>     Remove entry n without restoring it.
 *   /stash-clear        Remove all entries (confirms first when UI is available).
 *
 * Indexes are positional and only valid until the next stash/pop/drop —
 * re-run /stash-list after any mutation before addressing by number again.
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

/** Cap total entries, dropping the oldest first. */
function enforceCap(state: StashState): StashState {
	if (state.entries.length <= MAX_ENTRIES) return state;
	return { ...state, entries: state.entries.slice(-MAX_ENTRIES) };
}

function clampText(text: string): string {
	if (text.length <= MAX_TEXT) return text;
	return text.slice(0, MAX_TEXT - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
}

export function pushEntry(state: StashState, text: string, cwd?: string): StashState {
	const entry: StashEntry = { text: clampText(text), savedAt: new Date().toISOString(), cwd };
	return enforceCap({ ...state, entries: [...state.entries, entry] });
}

/**
 * Convert a 1-based display index (1 = newest, per /stash-list) into a 0-based
 * array index. Returns undefined for non-numeric, out-of-range, or missing input.
 */
export function resolveIndex(state: StashState, displayIndex: string | number | undefined): number | undefined {
	if (displayIndex === undefined) return state.entries.length > 0 ? state.entries.length - 1 : undefined;
	const n = typeof displayIndex === "number" ? displayIndex : Number(displayIndex);
	if (!Number.isInteger(n) || n < 1 || n > state.entries.length) return undefined;
	return state.entries.length - n;
}

export function popEntry(state: StashState, arrayIndex?: number): { entry: StashEntry; state: StashState } | undefined {
	if (state.entries.length === 0) return undefined;
	const idx = arrayIndex ?? state.entries.length - 1;
	if (idx < 0 || idx >= state.entries.length) return undefined;
	const entry = state.entries[idx];
	const entries = state.entries.slice(0, idx).concat(state.entries.slice(idx + 1));
	return { entry, state: { ...state, entries } };
}

export function dropEntry(state: StashState, arrayIndex: number): StashState {
	if (arrayIndex < 0 || arrayIndex >= state.entries.length) return state;
	return { ...state, entries: state.entries.slice(0, arrayIndex).concat(state.entries.slice(arrayIndex + 1)) };
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
	const n = state.entries.length;
	const lines = state.entries
		.map((e, i) => {
			const displayIndex = n - i; // newest entry (last in array) is 1
			const lineCount = e.text.split("\n").length;
			return `${displayIndex}. ${relativeAge(e.savedAt, now)}, ${lineCount} line(s): ${firstLinePreview(e.text)}`;
		})
		.reverse(); // newest (displayIndex 1) first
	return `Stash (${n}):\n${lines.join("\n")}\nUse /pop <n> or /stash-drop <n>.`;
}

export default function stash(pi: ExtensionAPI) {
	function updateStatus(ctx: ExtensionContext) {
		const count = loadStash().entries.length;
		ctx.ui.setStatus("stash", count > 0 ? ctx.ui.theme.fg("dim", `📥 ${count}`) : undefined);
	}

	function doStash(ctx: ExtensionContext): void {
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
		state = pushEntry(state, text, ctx.cwd);
		saveStash(state);
		ctx.ui.setEditorText("");
		ctx.ui.notify(`Stashed (${state.entries.length} in stash).`, "info");
		updateStatus(ctx);
	}

	function doPop(ctx: ExtensionContext, displayIndex: string | undefined): void {
		if (!ctx.hasUI) {
			ctx.ui.notify("Pop requires an interactive UI.", "warning");
			return;
		}
		let state = loadStash();
		const arrayIndex = resolveIndex(state, displayIndex);
		if (arrayIndex === undefined) {
			ctx.ui.notify(
				state.entries.length === 0
					? "Stash is empty."
					: `No stash entry ${displayIndex}. Run /stash-list to see indexes.`,
				"warning",
			);
			return;
		}
		const popped = popEntry(state, arrayIndex);
		if (!popped) {
			ctx.ui.notify("Stash is empty.", "warning");
			return;
		}
		state = popped.state;

		const current = ctx.ui.getEditorText();
		let swapNotice = "";
		if (current.trim()) {
			state = pushEntry(state, current, ctx.cwd);
			swapNotice = " (current editor text was stashed first; indexes have shifted)";
		}

		saveStash(state);
		ctx.ui.setEditorText(popped.entry.text);
		ctx.ui.notify(`Restored from stash${swapNotice}.`, "info");
		updateStatus(ctx);
	}

	function indexCompletions(prefix: string) {
		const state = loadStash();
		const n = state.entries.length;
		if (n === 0) return null;
		const items = [];
		for (let i = n; i >= 1; i--) {
			const value = String(i);
			if (!value.startsWith(prefix)) continue;
			const entry = state.entries[n - i];
			items.push({ value, label: value, description: firstLinePreview(entry.text) });
		}
		return items.length > 0 ? items : null;
	}

	pi.registerCommand("pop", {
		description: "Restore stash entry n (1 = newest, default) into the editor",
		getArgumentCompletions: (prefix) => indexCompletions(prefix),
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
		description: "Remove stash entry n without restoring it",
		getArgumentCompletions: (prefix) => indexCompletions(prefix),
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg) {
				ctx.ui.notify("Usage: /stash-drop <n> (see /stash-list)", "warning");
				return;
			}
			const state = loadStash();
			const arrayIndex = resolveIndex(state, arg);
			if (arrayIndex === undefined) {
				ctx.ui.notify(`No stash entry ${arg}. Run /stash-list to see indexes.`, "warning");
				return;
			}
			const preview = firstLinePreview(state.entries[arrayIndex].text);
			const newState = dropEntry(state, arrayIndex);
			saveStash(newState);
			ctx.ui.notify(`Dropped entry ${arg} (${preview}). ${newState.entries.length} left in stash.`, "info");
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
		handler: (ctx) => doStash(ctx),
	});

	pi.registerShortcut("ctrl+alt+r", {
		description: "Restore last stashed draft",
		handler: (ctx) => doPop(ctx, undefined),
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});
}
