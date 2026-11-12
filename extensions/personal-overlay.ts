/**
 * Personal Overlay Extension
 *
 * Injects per-repository personal overlay files into the system prompt as a `personal_overlay`
 * section, so a private overlay loads without changing any tracked file in the checkout. The
 * injected text is untrusted checkout input, in the same sense an AGENTS.md is: it is project
 * guidance, not a message from the user.
 *
 * Configuration is user-scoped, at `<agent-dir>/personal-overlay.json` (default
 * `~/.pi/agent/personal-overlay.json`):
 *
 *   { "files": ["AGENTS_PERSONAL.md", "CLAUDE_PERSONAL.md"] }
 *
 * `files` is a list of paths relative to a directory. No files are configured by default, so
 * this extension does nothing until entries are added. Any read or parse failure leaves the
 * run working and simply configures no files. Entries that are absolute paths, escape the
 * repository, or are empty or non-strings are skipped, and one warning on session start names
 * each rejected value with its reason.
 *
 * Discovery starts at the working directory and walks up to the repository root, the nearest
 * ancestor containing a `.git` entry (a directory, or a file in a linked worktree). Every
 * configured relative path is checked in each directory on that walk, root first and working
 * directory last. Files that resolve to the same real path are injected once, so two names that
 * are symlinks to one document do not duplicate it. Remaining files with byte-identical content
 * are grouped under a single header that lists all of their paths, so the body is injected once.
 * Nothing is read when no repository root is found, and the upward walk is bounded, so the walk
 * never leaves the checkout. A configured name that is a symlink can still resolve to a target
 * outside it, which is intentional for a personal overlay linked to a private document; the
 * session-start notification shows that target, so configure only names you control.
 *
 * The section, including its truncation note, is capped at 100 KB. When the cap is reached the
 * overflow group is truncated at a UTF-8 character boundary, and the note names it and every
 * group that was dropped.
 *
 * Set PI_PERSONAL_OVERLAY=0 to disable.
 */

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

const CONFIG_FILE = "personal-overlay.json";
const SECTION_NAME = "personal_overlay";
const MAX_INJECTED_BYTES = 100 * 1024;
const MAX_WALK_DEPTH = 64;
const OVERLAY_INTRO = "Personal overlay files for this repository:\n\n";
const TRUNCATION_NOTE_BUDGET = 512;
const NOTE_SEPARATOR_BYTES = 2;

interface OverlayFile {
	/** Path as found, used for the injected header. */
	path: string;
	/** Resolved real path, used for dedupe and the session-start notification. */
	realPath: string;
	/** Raw bytes, used for content dedupe and rendering. */
	buffer: Buffer;
}

interface OverlayGroup {
	/** Source paths sharing the same bytes, in walk order. */
	paths: string[];
	buffer: Buffer;
}

interface RejectedEntry {
	value: string;
	reason: string;
}

interface ConfigLoad {
	files: string[];
	rejected: RejectedEntry[];
	path: string;
	error?: string;
}

interface FillResult {
	parts: string[];
	used: number;
	truncated: boolean;
	cut?: string;
	omitted: string[];
}

function isDisabled(): boolean {
	const value = process.env.PI_PERSONAL_OVERLAY;
	if (value === undefined) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized === "0" || normalized === "false";
}

/** Render a configured value for a warning, showing an empty string as `""`. */
function describeValue(value: unknown): string {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed || JSON.stringify(value);
	}
	const json = JSON.stringify(value);
	return json === undefined ? String(value) : json;
}

/** Classify a configured entry as a safe relative path, or as a rejected value with a reason. */
function classifyConfiguredPath(value: unknown): { path: string } | { rejected: RejectedEntry } {
	if (typeof value !== "string") {
		return { rejected: { value: describeValue(value), reason: "not a string" } };
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return { rejected: { value: describeValue(value), reason: "empty" } };
	}
	if (isAbsolute(trimmed)) {
		return { rejected: { value: trimmed, reason: "absolute" } };
	}
	const normalized = normalize(trimmed).replace(/\\/g, "/");
	if (normalized === ".." || normalized.startsWith("../")) {
		return { rejected: { value: trimmed, reason: "escapes the repo" } };
	}
	return { path: normalized };
}

/** Read the configured file list. Missing, malformed, or invalid input yields no files. */
function loadConfiguredFiles(configPath: string = join(getAgentDir(), CONFIG_FILE)): ConfigLoad {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch {
		return { files: [], rejected: [], path: configPath };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			files: [],
			rejected: [],
			path: configPath,
			error: `personal-overlay: could not parse ${configPath}`,
		};
	}

	const listed = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object" && Array.isArray((parsed as { files?: unknown }).files)
			? (parsed as { files: unknown[] }).files
			: undefined;
	if (!listed) {
		return {
			files: [],
			rejected: [],
			path: configPath,
			error: `personal-overlay: ${configPath} has no "files" array`,
		};
	}

	const files: string[] = [];
	const rejected: RejectedEntry[] = [];
	for (const entry of listed) {
		const result = classifyConfiguredPath(entry);
		if ("rejected" in result) {
			rejected.push(result.rejected);
			continue;
		}
		if (!files.includes(result.path)) {
			files.push(result.path);
		}
	}
	return { files, rejected, path: configPath };
}

/** Nearest ancestor of `startDir` (inclusive) containing a `.git` entry, if any. */
function findRepoRoot(startDir: string): string | undefined {
	let dir = resolve(startDir);
	for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
		try {
			if (existsSync(join(dir, ".git"))) {
				return dir;
			}
		} catch {
			return undefined;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
	return undefined;
}

/** Directories from the repository root down to `startDir`, for an overlay lookup order. */
function walkDirectories(startDir: string, repoRoot: string): string[] {
	const dirs: string[] = [];
	let dir = resolve(startDir);
	for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
		dirs.unshift(dir);
		if (dir === repoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return dirs;
}

/**
 * Overlay files found on the walk, root first and working directory last, deduped by real path.
 * Returns nothing when no repository root is reachable.
 */
function collectOverlayFiles(startDir: string, names: string[]): OverlayFile[] {
	const repoRoot = findRepoRoot(startDir);
	if (!repoRoot) {
		return [];
	}

	const files: OverlayFile[] = [];
	const seen = new Set<string>();

	for (const dir of walkDirectories(startDir, repoRoot)) {
		for (const name of names) {
			const candidate = join(dir, name);
			try {
				if (!statSync(candidate).isFile()) {
					continue;
				}
			} catch {
				continue;
			}

			let realPath = candidate;
			try {
				realPath = realpathSync(candidate);
			} catch {
				// Fall back to the unresolved path for dedupe.
			}
			const key = process.platform === "win32" ? realPath.toLowerCase() : realPath;
			if (seen.has(key)) {
				continue;
			}

			let buffer: Buffer;
			try {
				buffer = readFileSync(candidate);
			} catch {
				continue;
			}

			seen.add(key);
			files.push({ path: candidate, realPath, buffer });
		}
	}

	return files;
}

/** Fold files with byte-identical content into one group, preserving first-occurrence order. */
function groupOverlayFiles(files: OverlayFile[]): OverlayGroup[] {
	const groups: OverlayGroup[] = [];
	for (const file of files) {
		const existing = groups.find((group) => group.buffer.equals(file.buffer));
		if (existing) {
			existing.paths.push(file.path);
		} else {
			groups.push({ paths: [file.path], buffer: file.buffer });
		}
	}
	return groups;
}

/**
 * Longest prefix of `text`, in whole code points, whose UTF-8 encoding fits in `maxBytes`.
 * Iterating a string yields code points, so surrogate pairs are never split, and budgeting on
 * the encoded length keeps a decoded body from exceeding the byte cap when it contains
 * replacement characters.
 */
function truncateToBytes(text: string, maxBytes: number): string {
	let bytes = 0;
	let result = "";
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) {
			break;
		}
		result += char;
		bytes += size;
	}
	return result;
}

function displayPath(cwd: string, target: string): string {
	const rel = relative(cwd, target);
	if (!rel) {
		return target.replace(/\\/g, "/");
	}
	return rel.replace(/\\/g, "/");
}

/** Comma-joined display paths for a group, used in its header and in the truncation note. */
function groupLabel(group: OverlayGroup, cwd: string): string {
	return group.paths.map((file) => displayPath(cwd, file)).join(", ");
}

/** Describe a loaded file, naming the resolved target when a symlink points elsewhere. */
function describeLoadedFile(cwd: string, file: OverlayFile): string {
	const shown = displayPath(cwd, file.path);
	const differs =
		process.platform === "win32"
			? file.realPath.toLowerCase() !== file.path.toLowerCase()
			: file.realPath !== file.path;
	return differs ? `${shown} -> ${file.realPath.replace(/\\/g, "/")}` : shown;
}

/**
 * Fill groups in order under `budget` bytes of headers, bodies, and inter-group separators.
 * A group whose body crosses the budget is cut at a UTF-8 boundary; every later group is
 * omitted. `used` is the exact byte length of `parts.join("\n")`.
 */
function fillGroups(groups: OverlayGroup[], cwd: string, budget: number): FillResult {
	const parts: string[] = [];
	const omitted: string[] = [];
	let used = 0;
	let truncated = false;
	let cut: string | undefined;

	for (let index = 0; index < groups.length; index++) {
		const group = groups[index];
		const label = groupLabel(group, cwd);
		const header = `${label}:\n\n`;
		const headerBytes = Buffer.byteLength(header, "utf8");
		const separatorBytes = parts.length > 0 ? 1 : 0;
		const available = budget - used - separatorBytes - headerBytes;
		if (available <= 0) {
			truncated = true;
			omitted.push(...groups.slice(index).map((entry) => groupLabel(entry, cwd)));
			break;
		}

		const content = group.buffer.toString("utf8");
		const contentBytes = Buffer.byteLength(content, "utf8");
		if (contentBytes > available) {
			const body = truncateToBytes(content, available);
			parts.push(header + body);
			used += separatorBytes + headerBytes + Buffer.byteLength(body, "utf8");
			cut = label;
			truncated = true;
			omitted.push(...groups.slice(index + 1).map((entry) => groupLabel(entry, cwd)));
			break;
		}

		parts.push(header + content);
		used += separatorBytes + headerBytes + contentBytes;
	}

	return { parts, used, truncated, cut, omitted };
}

/** Build a truncation note within `budget` bytes, shortening the omitted list when needed. */
function truncationNote(cut: string | undefined, omitted: string[], budget: number): string {
	const prefix = `[personal overlay truncated at ${MAX_INJECTED_BYTES / 1024} KB`;
	const render = (shownCut: string | undefined, shown: string[], hidden: number): string => {
		const pieces: string[] = [];
		if (shownCut) {
			pieces.push(`cut ${shownCut}`);
		}
		if (shown.length > 0 || hidden > 0) {
			const list = shown.join(", ");
			pieces.push(`omitted ${list}${hidden > 0 ? `${list ? ", " : ""}and ${hidden} more` : ""}`);
		}
		return `${prefix}${pieces.length > 0 ? `: ${pieces.join("; ")}` : ""}]`;
	};

	for (let keep = omitted.length; keep >= 0; keep--) {
		const attempt = render(cut, omitted.slice(0, keep), omitted.length - keep);
		if (Buffer.byteLength(attempt, "utf8") <= budget) {
			return attempt;
		}
	}
	return render(undefined, [], 0);
}

/** Render the overlay section, capped, with a header per group and a note when truncated. */
function renderOverlay(groups: OverlayGroup[], cwd: string): string {
	const introBytes = Buffer.byteLength(OVERLAY_INTRO, "utf8");
	const contentBudget = MAX_INJECTED_BYTES - introBytes;
	const initial = fillGroups(groups, cwd, contentBudget);
	if (initial.parts.length === 0) {
		return "";
	}
	if (!initial.truncated) {
		return `${OVERLAY_INTRO}${initial.parts.join("\n")}`;
	}

	// Reserve room for the note so the section, note included, stays within the cap.
	const reducedBudget = Math.max(0, contentBudget - TRUNCATION_NOTE_BUDGET - NOTE_SEPARATOR_BYTES);
	const fill = fillGroups(groups, cwd, reducedBudget);
	if (fill.parts.length === 0) {
		return "";
	}
	const note = truncationNote(fill.cut, fill.omitted, TRUNCATION_NOTE_BUDGET);
	return `${OVERLAY_INTRO}${fill.parts.join("\n")}\n\n${note}`;
}

export default function personalOverlayExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			if (isDisabled()) {
				return;
			}
			const config = loadConfiguredFiles();
			if (config.error) {
				ctx.ui.notify(config.error, "warning");
			}
			if (config.rejected.length > 0) {
				const details = config.rejected
					.map((entry) => `${entry.value} (${entry.reason})`)
					.join(", ");
				ctx.ui.notify(
					`personal-overlay: ignored ${config.rejected.length} entries in ${config.path}: ${details}`,
					"warning",
				);
			}
			if (config.files.length === 0) {
				return;
			}
			const files = collectOverlayFiles(ctx.cwd, config.files);
			if (files.length > 0) {
				const names = files.map((file) => describeLoadedFile(ctx.cwd, file)).join(", ");
				ctx.ui.notify(`Personal overlay loaded: ${names}`, "info");
			}
		} catch {
			// Never break a session start over overlay discovery.
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (isDisabled()) {
				delete event.systemPromptOptions.sections[SECTION_NAME];
				return;
			}
			const config = loadConfiguredFiles();
			const content =
				config.files.length === 0
					? ""
					: renderOverlay(groupOverlayFiles(collectOverlayFiles(ctx.cwd, config.files)), ctx.cwd);
			if (content) {
				event.systemPromptOptions.sections[SECTION_NAME] = content;
			} else {
				delete event.systemPromptOptions.sections[SECTION_NAME];
			}
		} catch {
			// Leave the section absent rather than failing the run.
			try {
				delete event.systemPromptOptions.sections[SECTION_NAME];
			} catch {
				// Ignore.
			}
		}
	});
}
