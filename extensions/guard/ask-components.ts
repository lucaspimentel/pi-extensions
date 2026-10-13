/**
 * Guard-owned stage components for the save/deny/compound prompt flows:
 * a text editor stage (rule editing, read-root editing, optional steering)
 * and a checkbox picker stage (compound deny selection). Both run on the
 * shared owned-stage runner (ask-overlay.ts), so every stage keeps ctrl+]
 * hide/show, the dialog-signal contract, idempotent cleanup, and the exact
 * owned-handle removal semantics of the guard selector.
 *
 * Components use public pi-tui API only: Editor and SelectList are
 * constructed directly, focus is set through the public `focused` field, and
 * the host theme is projected onto the public EditorTheme/SelectListTheme
 * shapes. No SDK-private fields, no global dialog coordinator, and no
 * fallbacks: callers must check supportsOwnedStages() and offer native
 * fallbacks or omit save actions BEFORE invoking these stages (a stage that
 * cannot mount is a setup failure, never an ordinary cancellation).
 */

import {
	getKeybindings,
	isKeyRepeat,
	isKeyRelease,
	matchesKey,
	wrapTextWithAnsi,
	visibleWidth,
	truncateToWidth,
	Editor,
	SelectList,
	type Component,
	type EditorTheme,
	type SelectListTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	paddedLine,
	runOwnedStage,
	supportsOwnedStages,
	textContentWidth,
	type GuardAskUI,
	type GuardAskTheme,
} from "./ask-overlay.ts";

/** Project the borrowed host theme onto the public editor/list themes. */
function editorThemeFrom(theme: GuardAskTheme): EditorTheme {
	const selectList: SelectListTheme = {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("dim", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("error", text),
	};
	return {
		borderColor: (text: string) => theme.fg("border", text),
		selectList,
	};
}

export interface GuardEditorStageOptions {
	/** Full dialog title (may be multi-line; wrapped into the top budget). */
	title: string;
	/** Initial text (e.g. the exact suggestion bundle or the suggested root). */
	prefill?: string;
	/** Hint line under the editor. */
	hint?: string;
}

export type GuardEditorStage = (ui: GuardAskUI, signal: AbortSignal, options: GuardEditorStageOptions) => Promise<string | undefined>;

/**
 * Create the editor stage factory. Resolves with the submitted text (empty
 * string for an empty submission) or undefined on Esc. Multi-line entries
 * use shift+enter where the terminal supports it, the backslash-enter
 * workaround otherwise, or pasted text.
 */
export function createGuardEditorStage(): GuardEditorStage {
	return function guardEditorStage(ui: GuardAskUI, signal: AbortSignal, options: GuardEditorStageOptions): Promise<string | undefined> {
		const hint = options.hint ?? "enter submit \u00b7 esc cancel";
		return runOwnedStage<string | undefined>(ui, signal, (ctx) => {
			const { tui, theme } = ctx;
			const editor = new Editor(tui, editorThemeFrom(theme), { paddingX: 1 });
			editor.focused = true;
			if (options.prefill !== undefined && options.prefill !== "") editor.setText(options.prefill);
			editor.onSubmit = (text: string) => ctx.settle(text);
			const titleLines = (width: number): string[] => wrapTextWithAnsi(options.title.replace(/\t/g, "   "), textContentWidth(width));
			const hintLinesOf = (width: number): string[] =>
				wrapTextWithAnsi(hint, Math.max(1, width)).map((line) => {
					const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
					return " ".repeat(pad) + theme.fg("dim", line);
				});
			const blockedLines = (width: number, rows: number): string[] => {
				const message = "guard: terminal too short for this dialog; enlarge the terminal or press esc to cancel";
				return wrapTextWithAnsi(message, Math.max(1, width))
					.slice(0, Math.max(1, rows))
					.map((line) => theme.fg("error", line));
			};
			const overlay: Component & { dispose(): void; invalidate(): void } = {
				render: (width: number): string[] => {
					const rows = (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? Number.POSITIVE_INFINITY;
					const title = titleLines(width);
					const hints = hintLinesOf(width);
					// Measure the editor's own public render output at this width;
					// never crop or shrink it: when it does not fit with the chrome,
					// the stage blocks (Esc still works) instead of hiding cursor rows.
					const editorLines = editor.render(width);
					if (title.length + editorLines.length + hints.length > rows || title.length + 1 >= rows) {
						return blockedLines(width, rows);
					}
					return [...title.map((line) => paddedLine(theme.fg("accent", theme.bold(line)), width)), ...editorLines, ...hints];
				},
				handleInput: (data: string): void => {
					// Recompute the fit from the live dimensions; never trust a
					// cached flag from a previous paint.
					const width = (tui as unknown as { terminal?: { columns?: number } }).terminal?.columns ?? 80;
					const rows = (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? Number.POSITIVE_INFINITY;
					const fits = titleLines(width).length + editor.render(width).length + hintLinesOf(width).length <= rows;
					if (!fits) {
						// Fail closed: cancel still works, submission does not.
						if (getKeybindings().matches(data, "tui.select.cancel")) ctx.settle(undefined);
						return;
					}
					if (getKeybindings().matches(data, "tui.select.cancel")) {
						ctx.settle(undefined);
						return;
					}
					editor.handleInput(data);
				},
				dispose: (): void => {
					editor.onSubmit = undefined;
				},
				invalidate: (): void => {
					editor.invalidate();
				},
			};
			return overlay;
		});
	};
}

/** One selectable step in the deny picker. */
export interface GuardPickerStep {
	occurrenceId: number;
	/** The step's display text (full text is kept reachable in the detail window). */
	label: string;
	/** The step's decision summary (shown as the list description). */
	detail: string;
}

export interface GuardPickerStageOptions {
	title: string;
	steps: readonly GuardPickerStep[];
	/** Hint line; defaults to the toggle/continue/cancel help. */
	hint?: string;
}

export type GuardPickerStage = (ui: GuardAskUI, signal: AbortSignal, options: GuardPickerStageOptions) => Promise<number[] | undefined>;

/**
 * Create the checkbox picker stage factory for compound deny saves. Nothing
 * is preselected; space toggles the highlighted step, enter continues with
 * at least one selected occurrence ID, and Esc cancels the save. Duplicate
 * command text keeps distinct identities (selections are occurrence IDs).
 * The full highlighted step text is reachable in a detail window when the
 * list itself fits the terminal; when the list overflows, list scrolling
 * takes priority and the detail window shows one line.
 */
export function createGuardPickerStage(): GuardPickerStage {
	return function guardPickerStage(ui: GuardAskUI, signal: AbortSignal, options: GuardPickerStageOptions): Promise<number[] | undefined> {
		if (options.steps.length === 0) {
			return Promise.reject(new Error("guard: the deny picker requires at least one step"));
		}
		const hint = options.hint ?? "space toggle \u00b7 enter continue (select at least one) \u00b7 esc cancel save";
		return runOwnedStage<number[] | undefined>(ui, signal, (ctx) => {
			const { tui, theme } = ctx;
			const checked = new Set<number>();
			let highlightIndex = 0;
			// Mutable item objects: SelectList keeps the array by reference, so
			// toggling mutates the label in place and invalidates.
			const items = options.steps.map((step) => ({
				value: String(step.occurrenceId),
				label: `\u25cb ${step.label}`,
				description: step.detail,
			}));
			const applyCheckmarks = (): void => {
				for (const [index, step] of options.steps.entries()) {
					items[index].label = `${checked.has(step.occurrenceId) ? "\u25c9" : "\u25cb"} ${step.label}`;
				}
			};
			const selectListTheme = editorThemeFrom(theme).selectList;
			const terminalRows = (): number => (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? Number.POSITIVE_INFINITY;
			const terminalWidth = (): number => (tui as unknown as { terminal?: { columns?: number } }).terminal?.columns ?? 80;
			const titleLines = (width: number): string[] => wrapTextWithAnsi(options.title.replace(/\t/g, "   "), textContentWidth(width));
			const hintLinesOf = (width: number): string[] =>
				wrapTextWithAnsi(hint, Math.max(1, width)).map((line) => {
					const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
					return " ".repeat(pad) + theme.fg("dim", line);
				});
			const blockedLines = (width: number, rows: number): string[] => {
				const message = "guard: terminal too short for this dialog; enlarge the terminal or press esc to cancel";
				return wrapTextWithAnsi(message, Math.max(1, width))
					.slice(0, Math.max(1, rows))
					.map((line) => theme.fg("error", line));
			};

			let list: SelectList | undefined;
			let lastMaxVisible = -1;
			// Detail window state for the highlighted step's full text.
			let detailOffset = 0;
			let detailPageLines = 1;
			let listOverflows = false;

			const detachList = (instance: SelectList): void => {
				instance.onSelect = undefined;
				instance.onCancel = undefined;
				instance.onSelectionChange = undefined;
			};
			const buildList = (maxVisible: number): SelectList => {
				const instance = new SelectList(items, Math.max(1, maxVisible), selectListTheme);
				instance.setSelectedIndex(highlightIndex);
				instance.onSelect = (item) => {
					if (checked.size === 0) return; // continue requires at least one selection
					ctx.settle([...checked].map(Number));
				};
				instance.onCancel = () => ctx.settle(undefined);
				instance.onSelectionChange = (item) => {
					const index = items.findIndex((candidate) => candidate.value === item.value);
					if (index >= 0) highlightIndex = index;
					detailOffset = 0;
				};
				return instance;
			};

			const detailText = (width: number): { body: string[]; indicator: string | null; pageLines: number } => {
				const step = options.steps[highlightIndex];
				const wrapped = wrapTextWithAnsi(step.label, textContentWidth(width));
				if (listOverflows || wrapped.length <= 1) {
					detailOffset = 0;
					return { body: [truncateToWidth(step.label, textContentWidth(width))], indicator: null, pageLines: 1 };
				}
				detailOffset = Math.min(Math.max(0, detailOffset), wrapped.length - 1);
				return { body: [wrapped[detailOffset]], indicator: wrapped.length > 1 ? theme.fg("dim", `\u2026 ${detailOffset}/${wrapped.length - 1} (PgUp/PgDn)`) : null, pageLines: 1 };
			};

			const overlay: Component & { dispose(): void; invalidate(): void } = {
				render: (width: number): string[] => {
					const rows = terminalRows();
					const title = titleLines(width);
					const hints = hintLinesOf(width);
					const availableForList = rows - title.length - hints.length - 1; // -1 detail line
					if (availableForList < 2) return blockedLines(width, rows);
					listOverflows = options.steps.length > availableForList - 1;
					const maxVisible = Math.max(1, Math.min(options.steps.length, availableForList - (listOverflows ? 1 : 0)));
					if (!list || lastMaxVisible !== maxVisible) {
						// Resize: rebuild with the new row budget, preserving highlight
						// and checkmarks (items are mutated in place).
						if (list) detachList(list);
						list = buildList(maxVisible);
						lastMaxVisible = maxVisible;
					}
					applyCheckmarks();
					list.invalidate();
					const detail = detailText(width);
					const listLines = list.render(width);
					const lines = [
						...title.map((line) => paddedLine(theme.fg("accent", theme.bold(line)), width)),
						paddedLine(theme.fg("text", detail.body[0] ?? ""), width),
						...(detail.indicator ? [paddedLine(detail.indicator, width)] : []),
						...listLines,
						...hints,
					];
					if (lines.length > rows) return blockedLines(width, rows);
					return lines;
				},
				handleInput: (data: string): void => {
					const width = terminalWidth();
					const rows = terminalRows();
					const title = titleLines(width);
					const hints = hintLinesOf(width);
					const availableForList = rows - title.length - hints.length - 1;
					if (availableForList < 2) {
						// Fail closed: cancel still works, selection does not.
						if (getKeybindings().matches(data, "tui.select.cancel")) ctx.settle(undefined);
						return;
					}
					if (getKeybindings().matches(data, "tui.select.cancel")) {
						ctx.settle(undefined);
						return;
					}
					// Kitty releases must not toggle; space toggles the highlighted step.
					if (!isKeyRelease(data) && !isKeyRepeat(data) && matchesKey(data, "space")) {
						const step = options.steps[highlightIndex];
						if (step && checked.has(step.occurrenceId)) checked.delete(step.occurrenceId);
						else if (step) checked.add(step.occurrenceId);
						return;
					}
					if (matchesKey(data, "pageUp")) {
						detailOffset = Math.max(0, detailOffset - detailPageLines);
						return;
					}
					if (matchesKey(data, "pageDown")) {
						detailOffset = Math.min(detailOffset + detailPageLines, Math.max(0, (wrapTextWithAnsi(options.steps[highlightIndex]?.label ?? "", textContentWidth(width)).length) - 1));
						return;
					}
					list?.handleInput(data);
				},
				dispose: (): void => {
					if (list) detachList(list);
					list = undefined;
				},
				invalidate: (): void => {
					list?.invalidate();
				},
			};
			return overlay;
		});
	};
}
