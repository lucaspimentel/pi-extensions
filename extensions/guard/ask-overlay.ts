/**
 * Guard-owned dialog presentation for TUI mode: an inline editor-slot stage
 * by default, with the guard-owned hideable overlay as the stacking fallback.
 *
 * Inline presentation (the default): the stage mounts through
 * `ui.custom(..., { overlay: false })` in Pi's editor slot, the same place
 * Pi's own selectors mount, so the transcript above stays visible and
 * scrolling while a prompt is open (the reason the overlay existed was to
 * guarantee visibility; inline achieves it without covering anything). The
 * inline stage caps its layout at `max(12, floor(rows * 0.7))` rows because
 * the host clips the editor slot from the bottom; stage components receive
 * that budget through the stage context's `rowsFor()` instead of reading the
 * terminal directly. ctrl+] collapses the prompt to a one-line hint (the
 * component keeps focus, so the same key re-expands; Esc still cancels while
 * collapsed).
 *
 * When an overlay is already on screen at mount time, an inline prompt would
 * paint underneath it (focus would reach a question the user cannot see), so
 * the inline factory yields and the stage re-mounts through the owned
 * overlay path below, stacking on top of the foreign overlay. The overlay
 * path is also the fallback for hosts without `ui.custom`.
 *
 * The owned overlay wraps the native selector contract (resolve the chosen
 * label, or undefined on Esc/cancel) with a full-width, bottom-anchored
 * overlay dialog and a ctrl+] hide/show toggle, so a long approval prompt
 * can be temporarily hidden while the pending decision stays open
 * underneath.
 *
 * Why the overlay path does not use `ctx.ui.custom` overlay mode: the SDK's
 * custom-overlay completion callback historically popped the LAST overlay
 * (`TUI.hideOverlay()`); pi 1.3.0 fixed that (#10648), but the owned-handle
 * path is kept because it predates the fix, its tests cover it, and it gives
 * guard direct ownership of the `OverlayHandle` for the hide/show toggle.
 * It borrows the TUI renderer through a uniquely keyed, zero-height
 * `ui.setWidget` bridge (removed immediately, so
 * no persistent widget entry remains), mounts through the public
 * `TUI.showOverlay`, and owns the returned `OverlayHandle`: `setHidden` for
 * the toggle and `handle.hide()` for final removal, which restores focus to
 * the next visible overlay or the previous target without touching foreign
 * overlays.
 *
 * The shared overlay lifecycle (canary widget-removal preflight, raw ctrl+]
 * toggle listener, bridge acquisition/removal, settle machinery, owned-resource
 * cleanup) is extracted in `runOwnedStage` so the overlay path for every stage
 * (rule editor, step picker, steering; see ask-components.ts) reuses exactly
 * the same ownership semantics. Stage components built by the caller receive a
 * context with `settle`/`fail`/`own`/`rowsFor` and the borrowed renderer/theme;
 * the runner keeps the ctrl+] toggle, abort settlement, idempotent cleanup, and
 * genuine-error propagation identical for every stage. Inline mounts share the
 * stage components through `runDialogStage`, which tries the inline editor slot
 * first and falls back to `runOwnedStage` when it yields.
 *
 * The selector's details body (everything past the first title line) is
 * bounded to the terminal height so the choice list, key hints, and the hide
 * hint always stay visible; overflow stays reachable with PgUp/PgDn at any
 * title budget, including a one-line window. The bounded title is rendered
 * by this adapter with public API only: the selector is constructed once
 * with the full title and never mutated; each render measures the real
 * rendered controls at the current width (wrapped option labels and key
 * hints included) through a one-line-title twin instance, verifies that
 * measurement against the computed title wrap, and recomposes the selector's
 * public render output with the windowed title lines. When the controls
 * alone cannot fit the terminal, approval is disabled (only Esc passes) and
 * a warning renders; eligibility is recomputed from the live terminal
 * dimensions on every input, never from a previous paint. If the measurement
 * cannot be verified against the twin (a selector that does not match the
 * standard component's output shape), the adapter falls back to rendering
 * the selector's own output unchanged and applies the same fit check.
 *
 * The toggle is registered at the raw terminal level (`ui.onTerminalInput`)
 * because pi-tui does not deliver input to a hidden overlay's handleInput, so
 * a handler inside the component could hide but never re-show. The raw
 * listener only acts while the overlay is focused or hidden, so other
 * overlays keep their keystrokes, and it consumes the key so pi's default
 * ctrl+] editor binding never fires while the dialog is up.
 *
 * The runner observes only the supplied dialog signal: it never aborts a
 * caller-owned controller, settlement and cleanup are idempotent, late stage
 * callbacks are ignored, and only guard-owned resources (the raw listener,
 * the owned overlay, the stage components) are removed. Every setup failure
 * (bridge removal, acquisition, stage construction, mounting) runs the same
 * owned-resource cleanup and propagates the genuine error; the display is
 * never retried. Non-TUI hosts and hosts missing the required capabilities
 * must fall back to signal-aware native dialogs BEFORE calling the runner
 * (see supportsOwnedStages); the runner itself fails closed. Bridge removal
 * is verified with a canary removal before the bridge is borrowed, which
 * filters hosts that refuse every deletion; a host that fails only the
 * populated bridge's deletion still fails the dialog with its genuine error
 * while the owned-resource cleanup retries that deletion best-effort; an
 * entry can only remain if both deletion attempts fail.
 */

import {
	getKeybindings,
	isKeyRepeat,
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";

const HIDE_KEY = "ctrl+]";
const HINT_LABEL = `${HIDE_KEY} hide/show`;

/** Structural subset of the host theme used by guard's overlay stages. */
export interface GuardAskTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Minimal component contract for a mounted stage (Component + dispose). */
export interface GuardSelectorLike {
	render(width: number): string[];
	handleInput(data: string): void;
	dispose(): void;
}

/** Subset of ExtensionContext.ui the adapter needs (structurally satisfied by
 * the real TUI context). `custom` is the inline editor-slot mount; every TUI
 * host provides it, so it gates the inline-first presentation. */
export interface GuardAskUI {
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	custom<T>(
		factory: (
			tui: TUI,
			theme: GuardAskTheme,
			keybindings: unknown,
			done: (result: T) => void,
		) => Component & { dispose?(): void },
		options?: { overlay?: boolean },
	): Promise<T>;
	setWidget(
		key: string,
		content: ((tui: TUI, theme: GuardAskTheme) => Component & { dispose?(): void }) | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Host implementations injected by index.ts so tests can substitute them. */
export interface GuardAskOverlayDeps {
	matchesKey(data: string, key: string): boolean;
	isKeyRelease(data: string): boolean;
	isKeyRepeat(data: string): boolean;
	ExtensionSelectorComponent: new (
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: { tui?: TUI },
	) => GuardSelectorLike;
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("guard: dialog cancelled: call aborted");
}

function terminalMetric(tui: TUI, metric: "rows" | "columns"): number {
	const value = (tui as unknown as { terminal?: { rows?: unknown; columns?: unknown } }).terminal?.[metric];
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : Number.POSITIVE_INFINITY;
}

/** Text component padding math, mirrored from the public pi-tui Text so the
 * computed title wrap matches the selector's own rendering exactly. */
export function textContentWidth(width: number): number {
	const padX = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
	return Math.max(1, width - padX * 2);
}

/** One rendered title/hint line, padded to the full width like Text does. */
export function paddedLine(line: string, width: number): string {
	const padX = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
	const text = " ".repeat(padX) + line;
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** True when the host can borrow the renderer and register the raw toggle. */
export function supportsOwnedStages(ui: GuardAskUI): boolean {
	return typeof ui.setWidget === "function" && typeof ui.onTerminalInput === "function";
}

/** Context handed to a stage component factory by runOwnedStage. */
export interface GuardStageContext<T> {
	tui: TUI;
	theme: GuardAskTheme;
	/** Rows the stage may lay out in: the full terminal (overlay) or the
	 * budgeted editor-slot window (inline). Stages must never read the
	 * terminal's rows directly. */
	rowsFor(): number;
	isHidden(): boolean;
	setHidden(hidden: boolean): void;
	/** Settle the stage with a value (idempotent; the first settle wins). */
	settle(value: T): void;
	/** Fail the stage with a genuine error (idempotent; the first settle wins). */
	fail(error: unknown): void;
	/** Register an owned disposable removed during cleanup (best effort). */
	own(disposable: { dispose?(): void }): void;
}

/** Unique keys for the canary and bridge widgets across all stages. */
let stageCounter = 0;

// ── Inline presentation ───────────────────────────────────────────────

/** Inline row budget. A component in Pi's editor slot only receives a width,
 * and the host clips the slot from the bottom when the dock outgrows the
 * screen, so the inline stage caps itself at the same idiom rpiv-ask-user-
 * question uses: `max(12, floor(rows * 0.7))`. Past the cap, the stage's own
 * degraded/blocked modes take over. */
const INLINE_ROW_RATIO = 0.7;
const INLINE_MIN_ROWS = 12;

/** Map the terminal's row count to the rows an inline stage may render. */
export function inlineRowBudget(terminalRows: number): number {
	return Math.min(terminalRows, Math.max(INLINE_MIN_ROWS, Math.floor(terminalRows * INLINE_ROW_RATIO)));
}

/** Sentinel resolved by an inline mount that found an overlay already on
 * screen: the caller remounts the stage through the owned overlay path. */
const YIELD_TO_OVERLAY = Symbol("guard: inline slot yields to an open overlay");

/** Inert component returned by an inline mount that resolved before mounting
 * (pi discards it unmounted). */
const INERT_INLINE: Component & { dispose(): void } = {
	render: () => [] as string[],
	invalidate: () => {},
	handleInput: () => {},
	dispose: () => {},
};

/** Wrap a stage component with the inline ctrl+] collapse behavior: collapsed
 * renders one dim hint line; ctrl+] (press only) toggles; Esc while collapsed
 * still cancels; every other key reaches the stage only while expanded. */
function withInlineCollapse<T>(
	inner: Component & { dispose?(): void; invalidate?(): void },
	stage: { theme: GuardAskTheme; settle(value: T | undefined): void },
): Component & { dispose(): void; invalidate(): void } {
	let collapsed = false;
	return {
		render(width: number): string[] {
			if (!collapsed) return inner.render(width);
			const text = `guard: prompt collapsed \u00b7 ${HIDE_KEY} expand \u00b7 esc cancel`;
			return [paddedLine(stage.theme.fg("dim", truncateToWidth(text, Math.max(1, width))), width)];
		},
		handleInput(data: string): void {
			if (matchesKey(data, HIDE_KEY)) {
				// Kitty-protocol terminals report press, repeat, and release
				// separately; toggle only on the initial press.
				if (!isKeyRelease(data) && !isKeyRepeat(data)) collapsed = !collapsed;
				return;
			}
			if (collapsed) {
				// Cancel still works while collapsed (fail open for user control).
				if (getKeybindings().matches(data, "tui.select.cancel")) stage.settle(undefined);
				return;
			}
			inner.handleInput?.(data);
		},
		dispose: () => inner.dispose?.(),
		invalidate: () => inner.invalidate?.(),
	};
}

/**
 * Mount one stage inline in Pi's editor slot via `ui.custom({ overlay: false })`.
 * Resolves with the stage value, or the YIELD sentinel when an overlay was
 * already on screen at mount (the caller then remounts through the owned
 * overlay path). An abort settles the host mount first (the host restores the
 * editor and disposes the component) and then rejects with the same abort
 * error shape as the overlay path, so callers see identical cancellation
 * semantics in both presentations.
 */
function runInlineStage<T>(
	ui: GuardAskUI,
	signal: AbortSignal,
	build: (ctx: GuardStageContext<T>) => Component & { dispose?(): void; invalidate?(): void },
): Promise<T | typeof YIELD_TO_OVERLAY> {
	return new Promise<T | typeof YIELD_TO_OVERLAY>((resolve, reject) => {
		let aborted = false;
		let done: ((result: T | typeof YIELD_TO_OVERLAY) => void) | undefined;
		const onAbort = (): void => {
			aborted = true;
			// Settle the host mount too: the host restores the editor and disposes
			// the component only after done() resolves it. A second abort-settle
			// is a no-op (the stage's own settle already ran or the host is gone).
			try { done?.(undefined as T); } catch { /* host already settled */ }
		};
		signal.addEventListener("abort", onAbort, { once: true });
		const removeListener = (): void => {
			try { signal.removeEventListener("abort", onAbort); } catch { /* never throws on standard signals */ }
		};
		let customPromise: Promise<T | typeof YIELD_TO_OVERLAY>;
		try {
			customPromise = ui.custom<T | typeof YIELD_TO_OVERLAY>((tui, theme, _keybindings, hostDone) => {
				done = hostDone;
				const overlayTui = tui as unknown as { hasOverlay?: () => boolean };
				if (typeof overlayTui.hasOverlay === "function" && overlayTui.hasOverlay()) {
					// An overlay owns the screen: an inline prompt would paint under it
					// while input reaches a question the user cannot see.
					done(YIELD_TO_OVERLAY);
					return INERT_INLINE;
				}
				const rowsFor = (): number => {
					const rows = terminalMetric(tui, "rows");
					return Math.min(rows, inlineRowBudget(rows));
				};
				const ctx: GuardStageContext<T> = {
					tui,
					theme,
					rowsFor,
					isHidden: () => false,
					setHidden: () => {},
					settle: (value) => done?.(value),
					// Stage builders must not call fail after mount; setup-time errors
					// surface by throwing from the factory, which rejects the mount.
					fail: (error) => { throw error; },
					own: () => {},
				};
				return withInlineCollapse(build(ctx), { theme, settle: (value) => done?.(value as T) });
			}, { overlay: false });
		} catch (error) {
			removeListener();
			reject(error);
			return;
		}
		customPromise.then(
			(result) => {
				removeListener();
				if (aborted) {
					reject(abortReason(signal));
					return;
				}
				resolve(result);
			},
			(error) => {
				removeListener();
				reject(error);
			},
		);
	});
}

/** Options for runDialogStage. */
export interface DialogStageOptions<T> {
	build(ctx: GuardStageContext<T>): Component & { dispose?(): void; invalidate?(): void };
	/** Called when the host cannot render the stage at all (no custom mount and
	 * no owned overlay). Selector dialogs keep the signal-aware native fallback;
	 * stages that REQUIRE guard delivery omit this and the runner fails closed. */
	fallbackWhenUnusable?: (ui: GuardAskUI, signal: AbortSignal) => Promise<T>;
}

/**
 * Run one guard prompt stage with the inline-first presentation: mount in
 * Pi's editor slot when the host provides `ui.custom`; when an overlay is
 * already on screen at mount (the inline factory yields) or the host lacks
 * `ui.custom`, remount through the owned overlay path. Genuine setup errors
 * propagate after cleanup; the display is never retried.
 */
export async function runDialogStage<T>(ui: GuardAskUI, signal: AbortSignal, options: DialogStageOptions<T>): Promise<T> {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	if (typeof ui.custom === "function") {
		const inline = await runInlineStage<T>(ui, signal, options.build);
		if (inline !== YIELD_TO_OVERLAY) return inline;
		if (!supportsOwnedStages(ui)) {
			if (options.fallbackWhenUnusable) return options.fallbackWhenUnusable(ui, signal);
			throw new Error("guard: an overlay is open and the host cannot stack the dialog");
		}
	} else if (!supportsOwnedStages(ui)) {
		if (options.fallbackWhenUnusable) return options.fallbackWhenUnusable(ui, signal);
		throw new Error("guard: owned dialog stages require ui.custom or the setWidget and onTerminalInput capabilities");
	}
	return runOwnedStage<T>(ui, signal, options.build, {
		fallbackWhenUnusable: options.fallbackWhenUnusable,
	});
}

/** Options for runOwnedStage. */
export interface OwnedStageOptions<T> {
	/**
	 * Called when the borrowed renderer is unusable (the bridge yielded no TUI
	 * with showOverlay). Runs after full owned-resource cleanup and before
	 * anything is mounted. Selector dialogs keep the signal-aware native
	 * fallback; stage components that REQUIRE owned delivery omit this and the
	 * runner fails closed instead.
	 */
	fallbackWhenUnusable?: (ui: GuardAskUI, signal: AbortSignal) => Promise<T>;
}

/**
 * Run one guard-owned overlay stage. The factory receives the borrowed
 * renderer/theme plus the settle/fail/own context and returns the overlay
 * component; the runner owns the ctrl+] toggle, the FIFO-compatible owned
 * overlay handle, abort settlement, and idempotent cleanup of only
 * guard-owned resources. Setup failures run cleanup and propagate the
 * genuine error; the display is never retried.
 */
export function runOwnedStage<T>(
	ui: GuardAskUI,
	signal: AbortSignal,
	build: (ctx: GuardStageContext<T>) => Component & { dispose?(): void },
	options: OwnedStageOptions<T> = {},
): Promise<T> {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	if (!supportsOwnedStages(ui)) {
		return Promise.reject(new Error("guard: owned overlay stages require setWidget and onTerminalInput capabilities"));
	}

	// Verify the host's widget-removal path before borrowing the renderer:
	// a host whose removal fails for every key fails this dialog before any
	// entry exists. This preflight cannot guarantee that deleting the later
	// populated bridge succeeds, so the bridge key stays inside the
	// owned-resource cleanup boundary, which retries the deletion.
	const canaryKey = `guard-dialog-bridge-${++stageCounter}-canary`;
	try {
		ui.setWidget(canaryKey, undefined);
	} catch (error) {
		return Promise.reject(error instanceof Error ? error : new Error(String(error)));
	}

	// Operation-scoped raw toggle listener. Registered before the synchronous
	// setup so ctrl+] during setup is handled consistently (no handle yet:
	// pass through). Acts only while the overlay is focused or hidden.
	let handle: OverlayHandle | undefined;
	let announcedHide = false;
	const removeToggle = ui.onTerminalInput((data) => {
		if (!handle) return undefined;
		// Never toggle a dialog from underneath a different overlay that owns input.
		if (!handle.isHidden() && !handle.isFocused()) return undefined;
		if (!matchesKey(data, HIDE_KEY)) return undefined;
		// Kitty-protocol terminals report press, repeat, and release as
		// separate events; toggle only on the initial press.
		if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
		const hidden = !handle.isHidden();
		handle.setHidden(hidden);
		if (hidden && !announcedHide) {
			announcedHide = true;
			try { ui.notify(`guard: prompt hidden; press ${HIDE_KEY} to reopen`, "info"); } catch { /* cosmetic */ }
		}
		return { consume: true };
	});

	// Settlement machinery: exactly one settle per stage, late callbacks
	// ignored, cleanup removes only owned resources.
	let settled = false;
	let onAbort: (() => void) | null = null;
	let component: (Component & { dispose?(): void }) | undefined;
	const owned: Array<{ dispose?(): void }> = [];
	// The borrowed bridge key stays owned from the acquisition attempt until a
	// deletion is observed, so every failure path retries the deletion.
	let bridgeKey: string | undefined;
	let bridgeCleared = false;
	const cleanup = (): void => {
		if (onAbort) {
			try { signal.removeEventListener("abort", onAbort); } catch { /* never throws on standard signals */ }
			onAbort = null;
		}
		try { removeToggle(); } catch { /* unsubscribe is best effort */ }
		try { handle?.hide(); } catch { /* owned-handle removal is best effort */ }
		try { component?.dispose?.(); } catch { /* dispose is best effort */ }
		for (const disposable of owned) {
			try { disposable.dispose?.(); } catch { /* dispose is best effort */ }
		}
		if (bridgeKey !== undefined && !bridgeCleared) {
			// Bounded, idempotent retry: an entry can only remain if both deletion
			// attempts fail, and this cleanup failure must never mask the
			// original diagnostic.
			try {
				ui.setWidget(bridgeKey, undefined);
				bridgeCleared = true;
			} catch { /* best effort; the genuine error propagates unchanged */ }
		}
		handle = undefined;
	};
	let settleWithValue: (value: T) => void = () => {};
	let settleWithError: (error: unknown) => void = () => {};

	// Borrow the renderer and theme through a uniquely keyed zero-height
	// widget; remove the bridge immediately, even when acquisition fails, so
	// no persistent widget entry survives the dialog. A removal failure is a
	// genuine setup error: the stage fails instead of mounting, and the bridge
	// key stays owned so cleanup retries the deletion.
	let tui: TUI | undefined;
	let theme: GuardAskTheme | undefined;
	try {
		const key = `guard-dialog-bridge-${++stageCounter}`;
		bridgeKey = key;
		let acquisitionError: unknown;
		try {
			ui.setWidget(key, (borrowedTui, borrowedTheme) => {
				tui = borrowedTui;
				theme = borrowedTheme;
				return { render: () => [] as string[], invalidate: () => {}, dispose: () => {} };
			});
		} catch (error) {
			acquisitionError = error;
		}
		let removalError: unknown;
		try {
			ui.setWidget(key, undefined);
			bridgeCleared = true;
		} catch (error) {
			removalError = error;
		}
		if (acquisitionError) throw acquisitionError;
		if (removalError) throw removalError;
		if (!tui || !theme || typeof tui.showOverlay !== "function") {
			// Missing capability: run the caller's fallback (selector dialogs fall
			// back to the signal-aware native selector before anything is mounted;
			// a failed or cancelled display is never retried). Stages that require
			// owned delivery provide no fallback and fail closed.
			cleanup();
			if (options.fallbackWhenUnusable) return options.fallbackWhenUnusable(ui, signal);
			throw new Error("guard: the host did not provide a TUI renderer for the dialog");
		}
		const borrowedTui: TUI = tui;
		const borrowedTheme: GuardAskTheme = theme;
		component = build({
			tui: borrowedTui,
			theme: borrowedTheme,
			rowsFor: () => terminalMetric(borrowedTui, "rows"),
			isHidden: () => handle?.isHidden() ?? false,
			setHidden: (hidden: boolean) => handle?.setHidden(hidden),
			settle: (value: T) => settleWithValue(value),
			fail: (error: unknown) => settleWithError(error),
			own: (disposable: { dispose?(): void }) => { owned.push(disposable); },
		});
		handle = borrowedTui.showOverlay(component, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: { left: 0, right: 0, bottom: 0 },
		});
	} catch (error) {
		// A genuine setup error fails the stage after removing only owned
		// resources; the display is not retried.
		cleanup();
		return Promise.reject(error);
	}

	return new Promise<T>((resolve, reject) => {
		settleWithValue = (value) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		settleWithError = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		onAbort = () => settleWithError(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) settleWithError(abortReason(signal));
	});
}

// The runner's key predicates come from pi-tui directly (the same public
// functions index.ts injects into the selector adapter).

/**
 * Build one guard selector stage component: the ExtensionSelectorComponent
 * plus guard's bounded-title window, fit checks, and key hints. Shared by the
 * inline and overlay presentations; `rowsFor` supplies the layout budget (the
 * full terminal for the overlay, the budgeted editor-slot window inline).
 */
function buildSelectorStage(
	deps: GuardAskOverlayDeps,
	tui: TUI,
	theme: GuardAskTheme,
	title: string,
	options: string[],
	stage: { settle(value: string | undefined): void; rowsFor(): number },
): Component & { dispose(): void; invalidate(): void } {
	const { matchesKey, ExtensionSelectorComponent } = deps;

	// Scrolling state for the details window; clamped against the current
	// layout budget on every layout computation.
	let detailOffset = 0;
	let pageLines = 1;
	// Fail closed until a layout computation proves the decision controls fit.
	let approvalDisabled = true;

	// One-entry wrap cache: the title wrap depends only on the width.
	let wrappedCacheWidth = -1;
	let wrappedCache: string[] = [];
	const wrappedTitle = (width: number): string[] => {
		if (width !== wrappedCacheWidth) {
			wrappedCache = wrapTextWithAnsi(title.replace(/\t/g, "   "), textContentWidth(width));
			wrappedCacheWidth = width;
		}
		return wrappedCache;
	};

	const hintLines = (theme: GuardAskTheme, width: number): string[] => {
		return wrapTextWithAnsi(HINT_LABEL, Math.max(1, width)).map((line) => {
			const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
			return " ".repeat(pad) + theme.fg("dim", line);
		});
	};

	const selector = new ExtensionSelectorComponent(title, options, (option) => stage.settle(option), () => stage.settle(undefined), { tui });
	const twin = new ExtensionSelectorComponent("x", options, () => {}, () => {}, { tui });

	/**
	 * Compute the layout state at the given width from live measurements.
	 * Shared by render and input handling so eligibility never depends on
	 * an earlier paint.
	 */
	const planLayout = (width: number): { mode: "full" | "degraded" | "fallback"; maxTitle: number; titleLines: number } | "blocked" => {
		const rows = stage.rowsFor();
		const hint = hintLines(theme, width);
		const titleLines = wrappedTitle(width).length;
		const fullCount = selector.render(width).length;
		const twinCount = twin.render(width).length;
		if (fullCount - twinCount === titleLines - 1 && fullCount >= titleLines + 2) {
			// Verified standard shape: [border, spacer, title..., spacer, ...].
			// Recompose the public render output with the bounded title.
			const chrome = fullCount - titleLines;
			const maxTitle = rows - chrome - hint.length;
			if (maxTitle >= 1) return { mode: "full", maxTitle, titleLines };
			// No room for even one title line: keep the controls visible
			// without the details and disable approval.
			if (chrome + hint.length <= rows) return { mode: "degraded", maxTitle: 0, titleLines };
			return "blocked";
		}
		// Unverifiable shape: render the selector's own output unchanged and
		// apply the same fit check.
		if (fullCount + hint.length <= rows) return { mode: "fallback", maxTitle: titleLines, titleLines };
		return "blocked";
	};

	const windowLines = (wrapped: string[], maxTitle: number, width: number): { body: string[]; indicator: string | null } => {
		if (wrapped.length <= maxTitle) {
			detailOffset = 0;
			pageLines = Math.max(1, wrapped.length);
			return { body: wrapped, indicator: null };
		}
		// Scrollable: reserve one row for the indicator when there is room;
		// a one-line window pages through the details without an indicator.
		const contentCount = maxTitle >= 2 ? maxTitle - 1 : 1;
		detailOffset = Math.min(Math.max(0, detailOffset), wrapped.length - contentCount);
		pageLines = contentCount;
		const body = [...wrapped.slice(detailOffset, detailOffset + contentCount)];
		const indicator = maxTitle >= 2
			? truncateToWidth(theme.fg("dim", `… ${detailOffset} above, ${wrapped.length - detailOffset - contentCount} below (PgUp/PgDn to scroll)`), textContentWidth(width))
			: null;
		return { body, indicator };
	};

	const blockedLines = (width: number, rows: number): string[] => {
		const message = "guard: terminal too short for this dialog; enlarge the terminal or press esc to cancel";
		return wrapTextWithAnsi(message, Math.max(1, width))
			.slice(0, Math.max(1, rows))
			.map((line) => theme.fg("error", line));
	};

	const overlay: Component & { dispose(): void; invalidate(): void } = {
		render: (width: number): string[] => {
			const plan = planLayout(width);
			const rows = stage.rowsFor();
			let lines: string[];
			if (plan === "blocked") {
				approvalDisabled = true;
				return blockedLines(width, rows);
			}
			const hint = hintLines(theme, width);
			const fullRendered = selector.render(width);
			if (plan.mode === "full") {
				approvalDisabled = false;
				const window = windowLines(wrappedTitle(width), plan.maxTitle, width);
				const windowBlock = [...window.body.map((line) => paddedLine(theme.fg("accent", theme.bold(line)), width))];
				if (window.indicator !== null) windowBlock.push(paddedLine(window.indicator, width));
				lines = [...fullRendered.slice(0, 2), ...windowBlock, ...fullRendered.slice(2 + plan.titleLines), ...hint];
			} else if (plan.mode === "degraded") {
				// Controls fit, details do not: no title window, approval disabled.
				approvalDisabled = true;
				lines = [...fullRendered.slice(0, 2), ...fullRendered.slice(2 + plan.titleLines), ...hint];
			} else {
				approvalDisabled = false;
				lines = [...fullRendered, ...hint];
			}
			if (lines.length > rows) {
				// Belt and suspenders: never emit more lines than the layout allows.
				approvalDisabled = true;
				return blockedLines(width, rows);
			}
			return lines;
		},
		handleInput: (data: string): void => {
			// Recompute eligibility from the live dimensions; never trust a cached
			// flag from a previous paint.
			const livePlan = planLayout(terminalMetric(tui, "columns"));
			approvalDisabled = livePlan === "blocked" || livePlan.mode === "degraded";
			if (approvalDisabled) {
				// Fail closed: cancel still works, selection and confirm do not.
				if (getKeybindings().matches(data, "tui.select.cancel")) selector.handleInput(data);
				return;
			}
			if (matchesKey(data, "pageup")) {
				detailOffset = Math.max(0, detailOffset - pageLines);
				return;
			}
			if (matchesKey(data, "pagedown")) {
				detailOffset = Math.max(0, detailOffset + pageLines);
				return;
			}
			selector.handleInput(data);
		},
		dispose: (): void => {
			selector.dispose();
			twin.dispose();
		},
		invalidate: (): void => {
			// The title window is recomputed per render; only the selectors cache.
			(selector as { invalidate?: () => void }).invalidate?.();
			(twin as { invalidate?: () => void }).invalidate?.();
		},
	};
	return overlay;
}

/**
 * Build the guardAskSelect helper. TUI hosts mount the selector inline in
 * Pi's editor slot (the transcript stays visible and scrolling); when an
 * overlay is already on screen at mount, the stage stacks through the owned
 * hideable overlay instead. Hosts without the required capabilities fall
 * back to the plain signal-aware `ui.select` before anything is mounted.
 */
export function createGuardAskSelect(deps: GuardAskOverlayDeps) {
	const { isKeyRelease, isKeyRepeat } = deps;
	void isKeyRelease;
	void isKeyRepeat;
	return function guardAskSelect(ui: GuardAskUI, title: string, options: string[], signal: AbortSignal): Promise<string | undefined> {
		return runDialogStage<string | undefined>(ui, signal, {
			build: (ctx) => buildSelectorStage(deps, ctx.tui, ctx.theme, title, options, ctx),
			// Missing renderer capability: signal-aware native selector (the
			// pre-existing fallback; never retried after a failure).
			fallbackWhenUnusable: (fallbackUi, fallbackSignal) => fallbackUi.select(title, options, { signal: fallbackSignal }),
		});
	};
}
