/**
 * Guard-owned hideable dialog overlay for TUI mode.
 *
 * Wraps the native selector contract (resolve the chosen label, or undefined
 * on Esc/cancel) with a full-width, bottom-anchored overlay dialog and a
 * ctrl+] hide/show toggle, so a long approval prompt can be temporarily
 * hidden while the pending decision stays open underneath.
 *
 * Why this does not use `ctx.ui.custom`: the SDK's custom-overlay completion
 * callback always pops the LAST overlay (`TUI.hideOverlay()`). With a foreign
 * overlay stacked above a cancelled guard dialog, that removes the foreign
 * overlay while its promise stays pending and leaves the cancelled guard
 * overlay mounted. Instead this adapter borrows the TUI renderer through a
 * uniquely keyed, zero-height `ui.setWidget` bridge (removed immediately, so
 * no persistent widget entry remains), mounts through the public
 * `TUI.showOverlay`, and owns the returned `OverlayHandle`: `setHidden` for
 * the toggle and `handle.hide()` for final removal, which restores focus to
 * the next visible overlay or the previous target without touching foreign
 * overlays.
 *
 * The details body (everything past the dialog header) is bounded to the
 * terminal height so the choice list, key hints, and the hide hint always
 * stay visible; overflow stays reachable with PgUp/PgDn. When the terminal is
 * too short to show the decision controls at all, approval is disabled: the
 * overlay renders a warning line and only Esc (cancel) is honored.
 *
 * The toggle is registered at the raw terminal level (`ui.onTerminalInput`)
 * because pi-tui does not deliver input to a hidden overlay's handleInput, so
 * a handler inside the component could hide but never re-show. The raw
 * listener only acts while the overlay is focused or hidden, so other
 * overlays keep their keystrokes, and it consumes the key so pi's default
 * ctrl+] editor binding never fires while the dialog is up.
 *
 * The adapter observes only the supplied dialog signal: it never aborts a
 * caller-owned controller, settlement and cleanup are idempotent, late
 * selector callbacks are ignored, and only guard-owned resources (the raw
 * listener, the owned overlay, the selector component) are removed. Non-TUI
 * hosts and hosts missing the required capabilities fall back to the
 * signal-aware native selector before anything is mounted; a failed or
 * cancelled overlay display is never retried.
 */

import {
	getKeybindings,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";

const HIDE_KEY = "ctrl+]";
const HINT_LABEL = `${HIDE_KEY} hide/show`;

/** Structural subset of the host theme used by the overlay. */
export interface GuardAskTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Minimal component contract for the mounted selector (Component + dispose). */
export interface GuardSelectorLike {
	render(width: number): string[];
	handleInput(data: string): void;
	dispose(): void;
}

/** Subset of ExtensionContext.ui the adapter needs (structurally satisfied by
 * the real TUI context). */
export interface GuardAskUI {
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
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

/** Fixed line budget around the title window inside the selector: two
 * borders, four spacers, the selector's key hint, and the hide hint. */
const CHROME_LINES = 8;

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("guard: dialog cancelled: call aborted");
}

function terminalRows(tui: TUI): number {
	const rows = (tui as { terminal?: { rows?: unknown } }).terminal?.rows;
	return typeof rows === "number" && Number.isFinite(rows) && rows >= 1 ? rows : Number.POSITIVE_INFINITY;
}

/**
 * Build the guardAskSelect helper. TUI hosts with the required capabilities
 * render the hideable bounded overlay; every other host falls back to the
 * plain signal-aware `ui.select` before anything is mounted.
 */
export function createGuardAskSelect(deps: GuardAskOverlayDeps) {
	const { matchesKey, isKeyRelease, isKeyRepeat, ExtensionSelectorComponent } = deps;
	let bridgeCounter = 0;
	return async function guardAskSelect(ui: GuardAskUI, title: string, options: string[], signal: AbortSignal): Promise<string | undefined> {
		if (signal.aborted) throw abortReason(signal);
		if (typeof ui.setWidget !== "function" || typeof ui.onTerminalInput !== "function") {
			return ui.select(title, options, { signal });
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

		// Borrow the renderer and theme through a uniquely keyed zero-height
		// widget; remove the bridge immediately, even when acquisition fails, so
		// no persistent widget entry survives the dialog.
		let tui: TUI | undefined;
		let theme: GuardAskTheme | undefined;
		const key = `guard-dialog-bridge-${++bridgeCounter}`;
		try {
			ui.setWidget(key, (borrowedTui, borrowedTheme) => {
				tui = borrowedTui;
				theme = borrowedTheme;
				return { render: () => [] as string[], invalidate: () => {}, dispose: () => {} };
			});
		} finally {
			try { ui.setWidget(key, undefined); } catch { /* the bridge renders zero lines; removal is best effort */ }
		}
		if (!tui || !theme || typeof tui.showOverlay !== "function") {
			// Missing capability: signal-aware native selector. A failed or
			// cancelled display is never retried.
			try { removeToggle(); } catch { /* unsubscribe is best effort */ }
			return ui.select(title, options, { signal });
		}

		// Settlement machinery: exactly one settle per dialog, late selector
		// callbacks ignored, cleanup removes only owned resources.
		let settled = false;
		let onAbort: (() => void) | null = null;
		let selector: GuardSelectorLike | undefined;
		const cleanup = (): void => {
			if (onAbort) {
				try { signal.removeEventListener("abort", onAbort); } catch { /* never throws on standard signals */ }
				onAbort = null;
			}
			try { removeToggle(); } catch { /* unsubscribe is best effort */ }
			try { handle?.hide(); } catch { /* owned-handle removal is best effort */ }
			try { selector?.dispose(); } catch { /* dispose is best effort */ }
			handle = undefined;
		};
		let settleValue: (value: string | undefined) => void = () => {};
		let settleError: (error: unknown) => void = () => {};

		// Scrolling state for the details window; clamped against the current
		// terminal height on every render.
		let detailOffset = 0;
		let pageLines = 1;
		let approvalDisabled = false;

		selector = new ExtensionSelectorComponent(title, options, (option) => settleValue(option), () => settleValue(undefined), { tui });

		const selectorTitle = selector as unknown as { titleText: { setText(text: string): void } };

		const overlay: Component & { dispose(): void } = {
			render: (width: number): string[] => {
				const padX = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
				const contentWidth = Math.max(1, width - padX * 2);
				const maxTitle = terminalRows(tui as TUI) - CHROME_LINES - options.length;
				if (maxTitle < 1) {
					// Too short to show the decision controls: approval disabled, only
					// cancel remains available.
					approvalDisabled = true;
					return [theme!.fg("error", truncateToWidth(`guard: terminal too short for this dialog; enlarge the terminal or press esc to cancel`, Math.max(1, width)))];
				}
				approvalDisabled = false;
				const wrapped = wrapTextWithAnsi(title.replace(/\t/g, "   "), contentWidth);
				let windowLines: string[];
				if (wrapped.length <= maxTitle) {
					windowLines = wrapped;
					pageLines = Math.max(1, wrapped.length);
				} else if (maxTitle >= 2) {
					const contentCount = maxTitle - 1;
					detailOffset = Math.min(Math.max(0, detailOffset), wrapped.length - contentCount);
					pageLines = contentCount;
					const above = detailOffset;
					const below = wrapped.length - detailOffset - contentCount;
					windowLines = [...wrapped.slice(detailOffset, detailOffset + contentCount), truncateToWidth(theme!.fg("dim", `… ${above} above, ${below} below (PgUp/PgDn to scroll)`), contentWidth)];
				} else {
					// One row of title budget: show the header, no room for an indicator.
					windowLines = [wrapped[0]];
					pageLines = 1;
				}
				selectorTitle.titleText.setText(theme!.fg("accent", theme!.bold(windowLines.join("\n"))));
				const pad = Math.max(0, Math.floor((width - HINT_LABEL.length) / 2));
				return [...selector!.render(width), " ".repeat(pad) + theme!.fg("dim", HINT_LABEL)];
			},
			handleInput: (data: string): void => {
				if (approvalDisabled) {
					// Fail closed: cancel still works, selection and confirm do not.
					if (getKeybindings().matches(data, "tui.select.cancel")) selector?.handleInput(data);
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
				selector?.handleInput(data);
			},
			dispose: (): void => {
				selector?.dispose();
			},
			invalidate: (): void => {
				// The title window is recomputed per render; only the selector caches.
				(selector as { invalidate?: () => void }).invalidate?.();
			},
		};

		try {
			handle = tui.showOverlay(overlay, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: { left: 0, right: 0, bottom: 0 },
			});
		} catch (error) {
			// A genuine mount error fails the dialog; the display is not retried.
			cleanup();
			throw error;
		}

		return await new Promise<string | undefined>((resolve, reject) => {
			settleValue = (value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			};
			settleError = (error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			onAbort = () => settleError(abortReason(signal));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) settleError(abortReason(signal));
		});
	};
}
