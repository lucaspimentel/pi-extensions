/**
 * Hideable ask dialog for large permission prompts.
 *
 * Wraps `ctx.ui.select`'s contract (resolve the chosen label, or undefined on
 * Esc/cancel) with a centered overlay dialog and a ctrl+] hide/show toggle:
 * a prompt that covers most of the screen can be temporarily hidden with
 * ctrl+] and brought back with the same key, while the pending decision stays
 * open underneath.
 *
 * The toggle is registered at the raw terminal level (`ctx.ui.onTerminalInput`)
 * because pi-tui does not deliver input to a hidden overlay's handleInput, so
 * a handler inside the component could hide but never re-show. The raw
 * listener only acts when the overlay is focused or hidden, so other overlays
 * keep their keystrokes, and it consumes the key so pi's default ctrl+]
 * editor binding (tui.editor.jumpForward) never fires while the dialog is up.
 *
 * Runtime dependencies (matchesKey, isKeyRelease, isKeyRepeat,
 * ExtensionSelectorComponent) are injected by index.ts from the host
 * packages, so test-ask-overlay.mjs can exercise this module with stubs
 * without @earendil-works/* being resolvable from the repo.
 */

/** Subset of ExtensionContext used by askSelect (structurally satisfied by the real context). */
export interface AskSelectContext {
	mode: string;
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		custom<T>(
			factory: (
				tui: unknown,
				theme: { fg(color: string, text: string): string },
				keybindings: unknown,
				done: (result: T) => void,
			) => OverlayComponent | Promise<OverlayComponent>,
			options?: {
				overlay?: boolean;
				overlayOptions?: Record<string, unknown>;
				onHandle?: (handle: AskOverlayHandle) => void;
			},
		): Promise<T>;
		onTerminalInput(
			handler: (data: string) => { consume?: boolean; data?: string } | undefined,
		): () => void;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

/** Subset of pi-tui's OverlayHandle used for the hide/show toggle. */
export interface AskOverlayHandle {
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	isFocused(): boolean;
}

/** Minimal component contract for the overlay wrapper (Component + optional dispose). */
export interface OverlayComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
	dispose?(): void;
}

/** Subset of ExtensionSelectorComponent used by the overlay wrapper. */
export interface SelectorLike {
	render(width: number): string[];
	handleInput(data: string): void;
	dispose(): void;
}

/** Host implementations injected by index.ts; stubbed by test-ask-overlay.mjs. */
import type { TUI } from "@earendil-works/pi-tui";

export interface AskOverlayDeps {
	matchesKey(data: string, key: string): boolean;
	isKeyRelease(data: string): boolean;
	isKeyRepeat(data: string): boolean;
	ExtensionSelectorComponent: new (
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: { tui?: TUI },
	) => SelectorLike;
}

const HIDE_KEY = "ctrl+]";
const HINT_LABEL = `${HIDE_KEY} hide/show`;

/**
 * Build the askSelect helper. TUI mode renders a hideable overlay dialog;
 * every other mode (rpc, print, json, or a host without the raw input hook)
 * falls back to plain `ctx.ui.select`.
 */
export function createAskSelect(deps: AskOverlayDeps) {
	const { matchesKey, isKeyRelease, isKeyRepeat, ExtensionSelectorComponent } = deps;
	return async function askSelect(
		ctx: AskSelectContext,
		title: string,
		choices: string[],
	): Promise<string | undefined> {
		if (ctx.mode !== "tui" || typeof ctx.ui.onTerminalInput !== "function") {
			return ctx.ui.select(title, choices);
		}
		let handle: AskOverlayHandle | undefined;
		let announcedHide = false;
		const removeToggleListener = ctx.ui.onTerminalInput((data) => {
			if (!handle) return undefined;
			// Only act while the overlay is focused or hidden: never toggle a
			// dialog from underneath a different overlay that owns input.
			if (!handle.isHidden() && !handle.isFocused()) return undefined;
			if (!matchesKey(data, HIDE_KEY)) return undefined;
			// Kitty-protocol terminals report press, repeat, and release as
			// separate events; toggle only on the initial press.
			if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
			const hidden = !handle.isHidden();
			handle.setHidden(hidden);
			if (hidden && !announcedHide) {
				announcedHide = true;
				ctx.ui.notify(`Prompt hidden: press ${HIDE_KEY} to reopen`, "info");
			}
			return { consume: true };
		});
		try {
			return await ctx.ui.custom<string | undefined>(
				(tui, theme, _keybindings, done) => {
					const selector = new ExtensionSelectorComponent(
						title,
						choices,
						(option) => done(option),
						() => done(undefined),
						{ tui: tui as TUI },
					);
					// Dim hint line under the bordered selector box.
					const hint: OverlayComponent = {
						render: (width: number): string[] => {
							const text = theme.fg("dim", HINT_LABEL);
							const pad = Math.max(0, Math.floor((width - HINT_LABEL.length) / 2));
							return [" ".repeat(pad) + text];
						},
					};
					const children: OverlayComponent[] = [selector, hint];
					return {
						render: (width: number): string[] => children.flatMap((c) => c.render(width)),
						// The wrapper owns focus (pi-tui focuses the overlay's top-level
						// component), so it must delegate keystrokes to the selector.
						handleInput: (data: string): void => selector.handleInput(data),
						dispose: (): void => selector.dispose(),
					};
				},
				{
					overlay: true,
					// Full-width, anchored to the bottom like rpiv-ask-user-question's
					// questionnaire: the dialog reads as a continuation of the chat
					// above it rather than a floating modal.
					overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: { left: 0, right: 0, bottom: 0 } },
					onHandle: (h) => {
						handle = h;
					},
				},
			);
		} finally {
			removeToggleListener();
			handle = undefined;
		}
	};
}