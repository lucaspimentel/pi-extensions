/**
 * Guard-owned stage components for the save/deny/compound prompt flows:
 * a text editor stage (rule editing, read-root editing, optional steering)
 * and a checkbox picker stage (compound deny selection and per-step allow
 * step selection, with preselection and unselectable context rows). Both run on the
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
	guardPageKeys,
	paddedLine,
	runDialogStage,
	supportsOwnedStages,
	textContentWidth,
	type GuardAskUI,
	type GuardAskTheme,
	type GuardPageKeys,
	type GuardStageContext,
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
	/** Initial text (e.g. the suggested rules or the suggested root). */
	prefill?: string;
	/** Hint line under the editor. */
	hint?: string;
	/**
	 * Live advisory line under the editor, recomputed from the current editor
	 * text on every render. Purely presentational: it may be absent, it is
	 * dropped when the row budget cannot hold it, and it never affects
	 * validation or submission. A thrown error is treated as no note.
	 */
	noteFor?: (text: string) => string | undefined;
}

export type GuardEditorStage = (ui: GuardAskUI, signal: AbortSignal, options: GuardEditorStageOptions) => Promise<string | undefined>;

/**
 * Create the editor stage factory. Resolves with the submitted text (empty
 * string for an empty submission) or undefined on Esc. Multi-line entries
 * use shift+enter where the terminal supports it, the backslash-enter
 * workaround otherwise, or pasted text. The stage mounts inline in Pi's
 * editor slot by default and through the owned overlay when an overlay is
 * already on screen (runDialogStage); layout uses the stage context's
 * row budget either way.
 */
export function createGuardEditorStage(): GuardEditorStage {
	return function guardEditorStage(ui: GuardAskUI, signal: AbortSignal, options: GuardEditorStageOptions): Promise<string | undefined> {
		return runDialogStage<string | undefined>(ui, signal, {
			build: (ctx) => buildEditorStage(ctx, options),
		});
	};
}

/** Build the editor stage component over a stage context (inline or overlay). */
function buildEditorStage(
	ctx: GuardStageContext<string | undefined>,
	options: GuardEditorStageOptions,
): Component & { dispose(): void; invalidate(): void } {
	const { tui, theme } = ctx;
	const hint = options.hint ?? "enter submit \u00b7 esc cancel";
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
	const noteLinesOf = (width: number, text: string): string[] => {
		if (!options.noteFor) return [];
		let note: string | undefined;
		try {
			note = options.noteFor(text);
		} catch {
			note = undefined;
		}
		if (!note) return [];
		return wrapTextWithAnsi(note, textContentWidth(width)).map((line) => theme.fg("dim", line));
	};
	const blockedLines = (width: number, rows: number): string[] => {
		const message = "guard: terminal too short for this dialog; enlarge the terminal or press esc to cancel";
		return wrapTextWithAnsi(message, Math.max(1, width))
			.slice(0, Math.max(1, rows))
			.map((line) => theme.fg("error", line));
	};
	return {
		render: (width: number): string[] => {
			const rows = ctx.rowsFor();
			const title = titleLines(width);
			const hints = hintLinesOf(width);
			// Measure the editor's own public render output at this width;
			// never crop or shrink it: when it does not fit with the chrome,
			// the stage blocks (Esc still works) instead of hiding cursor rows.
			const editorLines = editor.render(width);
			if (title.length + editorLines.length + hints.length > rows || title.length + 1 >= rows) {
				return blockedLines(width, rows);
			}
			// The advisory is best-effort chrome: shown only when the remaining
			// row budget holds it, and deliberately excluded from the fit checks
			// here and in handleInput so a dropped note can never disable
			// submission.
			const note = noteLinesOf(width, editor.getText());
			const body = title.length + editorLines.length + note.length + hints.length <= rows
				? [...editorLines, ...note]
				: editorLines;
			return [...title.map((line) => paddedLine(theme.fg("accent", theme.bold(line)), width)), ...body, ...hints];
		},
		handleInput: (data: string): void => {
			// Recompute the fit from the live dimensions; never trust a
			// cached flag from a previous paint. Advisory rows are excluded on
			// purpose: the note must never turn a valid submission into a
			// blocked stage, so it degrades by being dropped instead.
			const width = (tui as unknown as { terminal?: { columns?: number } }).terminal?.columns ?? 80;
			const fits = titleLines(width).length + editor.render(width).length + hintLinesOf(width).length <= ctx.rowsFor();
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
}

/** One row in the checkbox picker (deny saves and per-step allow saves). */
export interface GuardPickerStep {
	occurrenceId: number;
	/** The step's display text (full text is kept reachable in the detail window). */
	label: string;
	/** The step's decision summary (shown as the list description). */
	detail: string;
	/** False marks an unselectable context row (space does nothing); default true. */
	selectable?: boolean;
}

export interface GuardPickerStageOptions {
	title: string;
	steps: readonly GuardPickerStep[];
	/** Hint line; defaults to the toggle/continue/cancel help. */
	hint?: string;
	/** Occurrence IDs that start checked; ignored for missing or unselectable steps. */
	preselectedOccurrenceIds?: readonly number[];
	/** False lets Enter continue with zero selections; default true (deny behavior). */
	requireSelection?: boolean;
}

export type GuardPickerStage = (ui: GuardAskUI, signal: AbortSignal, options: GuardPickerStageOptions) => Promise<number[] | undefined>;

/**
 * Create the checkbox picker stage factory for compound deny saves and
 * per-step allow saves. Deny behavior (the default): nothing is preselected,
 * space toggles the highlighted step, enter continues with at least one
 * selected occurrence ID, and Esc cancels the save. Per-step allow saves
 * pass preselectedOccurrenceIds (the prompting steps), mark already-allowed
 * rows unselectable (space never checks them and preselection ignores them),
 * and set requireSelection false so confirming the preselection continues
 * even with zero deselections. Duplicate command text keeps distinct
 * identities (selections are occurrence IDs). The full highlighted step text
 * is reachable in a detail window when the list itself fits the terminal;
 * when the list overflows, list scrolling takes priority and the detail
 * window shows one line.
 */
export function createGuardPickerStage(): GuardPickerStage {
	return function guardPickerStage(ui: GuardAskUI, signal: AbortSignal, options: GuardPickerStageOptions): Promise<number[] | undefined> {
		if (options.steps.length === 0) {
			return Promise.reject(new Error("guard: the deny picker requires at least one step"));
		}
		const requireSelection = options.requireSelection !== false;
		const selectableIds = new Set(options.steps.filter((step) => step.selectable !== false).map((step) => step.occurrenceId));
		return runDialogStage<number[] | undefined>(ui, signal, {
			build: (ctx) => buildPickerStage(ctx, options, { requireSelection, selectableIds }),
		});
	};
}

/** Build the checkbox picker stage component over a stage context (inline or overlay). */
function buildPickerStage(
	ctx: GuardStageContext<number[] | undefined>,
	options: GuardPickerStageOptions,
	behavior: { requireSelection: boolean; selectableIds: Set<number> },
): Component & { dispose(): void; invalidate(): void } {
	const { tui, theme } = ctx;
	const requireSelection = behavior.requireSelection;
	const selectableIds = behavior.selectableIds;
	const hint = options.hint
		?? (requireSelection
			? "space toggle \u00b7 enter continue (select at least one) \u00b7 esc cancel save"
			: "space toggle \u00b7 enter continue \u00b7 esc back to the action menu");
	const checked = new Set<number>([...(options.preselectedOccurrenceIds ?? [])].filter((id) => selectableIds.has(id)));
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
	// Resolved live from the presentation and the current mode (see ask-overlay.ts).
	const pageKeys = (): GuardPageKeys => guardPageKeys(ctx.presentation, tui.mode);
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
			if (requireSelection && checked.size === 0) return; // continue requires at least one selection
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
		return { body: [wrapped[detailOffset]], indicator: wrapped.length > 1 ? theme.fg("dim", `\u2026 ${detailOffset}/${wrapped.length - 1} (${pageKeys().label})`) : null, pageLines: 1 };
	};

	return {
		render: (width: number): string[] => {
			const rows = ctx.rowsFor();
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
			const rows = ctx.rowsFor();
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
			// Unselectable context rows never toggle.
			if (!isKeyRelease(data) && !isKeyRepeat(data) && matchesKey(data, "space")) {
				const step = options.steps[highlightIndex];
				if (!step || step.selectable === false) return;
				if (checked.has(step.occurrenceId)) checked.delete(step.occurrenceId);
				else checked.add(step.occurrenceId);
				return;
			}
			const keys = pageKeys();
			if (matchesKey(data, keys.up)) {
				detailOffset = Math.max(0, detailOffset - detailPageLines);
				return;
			}
			if (matchesKey(data, keys.down)) {
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
}
