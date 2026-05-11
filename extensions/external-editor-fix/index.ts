/**
 * external-editor-fix
 *
 * Replaces pi's Ctrl+G external-editor path with a variant that waits for
 * GUI editors before reading and deleting the temp file. This fixes VS Code /
 * Cursor / Zed-style launchers that otherwise return immediately.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CustomEditor, type AppKeybinding, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";

const EXTERNAL_EDITOR_ACTION = "app.editor.external" as AppKeybinding;
const WAIT_FLAG = "--wait";
const SHORT_WAIT_FLAG = "-w";

const DOUBLE_DASH_WAIT_EDITORS = new Set([
	"code",
	"code-insiders",
	"cursor",
	"windsurf",
	"zed",
]);

const SHORT_WAIT_EDITORS = new Set([
	"subl",
	"sublime_text",
]);

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

function splitCommand(command: string): string[] {
	const parts: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(command)) !== null) {
		parts.push(match[1] ?? match[2] ?? match[3] ?? "");
	}

	return parts;
}

function editorBaseName(editor: string): string {
	return path.basename(editor).toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
}

function hasWaitFlag(args: string[]): boolean {
	return args.some((arg) => arg === WAIT_FLAG || arg === SHORT_WAIT_FLAG);
}

function addWaitFlagIfNeeded(editor: string, args: string[]): string[] {
	if (hasWaitFlag(args)) return args;

	const base = editorBaseName(editor);
	if (DOUBLE_DASH_WAIT_EDITORS.has(base)) return [...args, WAIT_FLAG];
	if (SHORT_WAIT_EDITORS.has(base)) return [...args, SHORT_WAIT_FLAG];
	return args;
}

function describeSpawnFailure(result: ReturnType<typeof spawnSync>): string | undefined {
	if (result.error) {
		return result.error.message;
	}
	if (result.signal) {
		return `editor exited due to signal ${result.signal}`;
	}
	if (result.status !== 0) {
		return `editor exited with status ${result.status ?? "unknown"}`;
	}
	return undefined;
}

class ExternalEditorFixEditor extends CustomEditor {
	private readonly appKeybindings: KeybindingsManager;
	private readonly appTui: TUI;
	private readonly notify: Notify;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, notify: Notify, options?: EditorOptions) {
		super(tui, theme, keybindings, options);
		this.appTui = tui;
		this.appKeybindings = keybindings;
		this.notify = notify;
	}

	handleInput(data: string): void {
		if (this.appKeybindings.matches(data, EXTERNAL_EDITOR_ACTION)) {
			this.openFixedExternalEditor();
			return;
		}

		super.handleInput(data);
	}

	private openFixedExternalEditor(): void {
		const editorCmd = (process.env.VISUAL || process.env.EDITOR)?.trim();
		if (!editorCmd) {
			this.notify("No editor configured. Set $VISUAL or $EDITOR environment variable.", "warning");
			return;
		}

		const commandParts = splitCommand(editorCmd);
		const [editor, ...configuredArgs] = commandParts;
		if (!editor) {
			this.notify("No editor configured. Set $VISUAL or $EDITOR environment variable.", "warning");
			return;
		}

		const currentText = this.getExpandedText();
		const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}-${randomUUID()}.pi.md`);
		let stopped = false;
		let warning: string | undefined;

		try {
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			this.appTui.stop();
			stopped = true;

			const editorArgs = addWaitFlagIfNeeded(editor, configuredArgs);
			const result = spawnSync(editor, [...editorArgs, tmpFile], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});

			if (result.status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.setText(newContent);
			} else {
				warning = describeSpawnFailure(result) ?? "editor exited without saving";
			}
		} catch (error) {
			warning = error instanceof Error ? error.message : String(error);
		} finally {
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors.
			}

			if (stopped) {
				this.appTui.start();
				this.appTui.requestRender(true);
			} else {
				this.appTui.requestRender();
			}

			if (warning) {
				this.notify(`External editor failed: ${warning}`, "warning");
			}
		}
	}
}

export default function externalEditorFix(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			return new ExternalEditorFixEditor(
				tui,
				theme,
				keybindings,
				(message, type) => ctx.ui.notify(message, type),
			);
		});
	});
}
