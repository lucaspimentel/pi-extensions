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
 * The details body (everything past the first title line) is bounded to the
 * terminal height so the choice list, key hints, and the hide hint always
 * stay visible; overflow stays reachable with PgUp/PgDn at any title budget,
 * including a one-line window. The bounded title is rendered by this adapter
 * with public API only: the selector is constructed once with the full title
 * and never mutated; each render measures the real rendered controls at the
 * current width (wrapped option labels and key hints included) through a
 * one-line-title twin instance, verifies that measurement against the
 * computed title wrap, and recomposes the selector's public render output
 * with the windowed title lines. When the controls alone cannot fit the
 * terminal, approval is disabled (only Esc passes) and a warning renders;
 * eligibility is recomputed from the live terminal dimensions on every input,
 * never from a previous paint. If the measurement cannot be verified against
 * the twin (a selector that does not match the standard component's output
 * shape), the adapter falls back to rendering the selector's own output
 * unchanged and applies the same fit check.
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
 * listener, the owned overlay, the selector components) are removed. Every
 * setup failure (bridge removal, acquisition, selector construction,
 * mounting) runs the same owned-resource cleanup and propagates the genuine
 * error; the display is never retried. Non-TUI hosts and hosts missing the
 * required capabilities fall back to the signal-aware native selector before
 * anything is mounted. Bridge removal is verified with a canary removal
 * before the bridge is borrowed, which filters hosts that refuse every
 * deletion; a host that fails only the populated bridge's deletion still
 * fails the dialog with its genuine error while the owned-resource cleanup
 * retries that deletion best-effort, so a permanently refusing host is the
 * only case where an entry can remain.
 */

import {
	getKeybindings,
	truncateToWidth,
	visibleWidth,
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

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("guard: dialog cancelled: call aborted");
}

function terminalMetric(tui: TUI, metric: "rows" | "columns"): number {
	const value = (tui as unknown as { terminal?: { rows?: unknown; columns?: unknown } }).terminal?.[metric];
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : Number.POSITIVE_INFINITY;
}

/** Text component padding math, mirrored from the public pi-tui Text so the
 * computed title wrap matches the selector's own rendering exactly. */
function textContentWidth(width: number): number {
	const padX = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
	return Math.max(1, width - padX * 2);
}

/** One rendered title/hint line, padded to the full width like Text does. */
function paddedLine(line: string, width: number): string {
	const padX = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
	const text = " ".repeat(padX) + line;
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
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
		// Verify the host's widget-removal path before borrowing the renderer:
		// a host whose removal fails for every key fails this dialog before any
		// entry exists. This preflight cannot guarantee that deleting the later
		// populated bridge succeeds, so the bridge key stays inside the
		// owned-resource cleanup boundary, which retries the deletion.
		const canaryKey = `guard-dialog-bridge-${++bridgeCounter}-canary`;
		try {
			ui.setWidget(canaryKey, undefined);
		} catch (error) {
			throw error instanceof Error ? error : new Error(String(error));
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

		// Settlement machinery: exactly one settle per dialog, late selector
		// callbacks ignored, cleanup removes only owned resources. Every setup
		// failure below runs the same cleanup and propagates the genuine error.
		let settled = false;
		let onAbort: (() => void) | null = null;
		let selector: GuardSelectorLike | undefined;
		let twin: GuardSelectorLike | undefined;
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
			try { selector?.dispose(); } catch { /* dispose is best effort */ }
			try { twin?.dispose(); } catch { /* dispose is best effort */ }
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
		let settleValue: (value: string | undefined) => void = () => {};
		let settleError: (error: unknown) => void = () => {};

		// Scrolling state for the details window; clamped against the current
		// terminal height on every layout computation.
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

		let tui: TUI | undefined;
		let theme: GuardAskTheme | undefined;
		const hintLines = (width: number): string[] => {
			return wrapTextWithAnsi(HINT_LABEL, Math.max(1, width)).map((line) => {
				const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
				return " ".repeat(pad) + theme!.fg("dim", line);
			});
		};

		try {
			// Borrow the renderer and theme through a uniquely keyed zero-height
			// widget; remove the bridge immediately, even when acquisition fails, so
			// no persistent widget entry survives the dialog. A removal failure is a
			// genuine setup error: the dialog fails instead of mounting, and the
			// bridge key stays owned so cleanup retries the deletion.
			const key = `guard-dialog-bridge-${++bridgeCounter}`;
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
				// Missing capability: signal-aware native selector. A failed or
				// cancelled display is never retried.
				cleanup();
				return ui.select(title, options, { signal });
			}

			// The selector keeps the full title and is never mutated; the twin
			// (one-line title) measures the real rendered controls at each width.
			selector = new ExtensionSelectorComponent(title, options, (option) => settleValue(option), () => settleValue(undefined), { tui });
			twin = new ExtensionSelectorComponent("x", options, () => {}, () => {}, { tui });

			/**
			 * Compute the layout state at the given width from live measurements.
			 * Shared by render and input handling so eligibility never depends on
			 * an earlier paint.
			 */
			const planLayout = (width: number): { mode: "full" | "degraded" | "fallback"; maxTitle: number; titleLines: number } | "blocked" => {
				const rows = terminalMetric(tui as TUI, "rows");
				const hint = hintLines(width);
				const titleLines = wrappedTitle(width).length;
				const fullCount = selector!.render(width).length;
				const twinCount = twin!.render(width).length;
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
					? truncateToWidth(theme!.fg("dim", `… ${detailOffset} above, ${wrapped.length - detailOffset - contentCount} below (PgUp/PgDn to scroll)`), textContentWidth(width))
					: null;
				return { body, indicator };
			};

			const blockedLines = (width: number, rows: number): string[] => {
				const message = "guard: terminal too short for this dialog; enlarge the terminal or press esc to cancel";
				return wrapTextWithAnsi(message, Math.max(1, width))
					.slice(0, Math.max(1, rows))
					.map((line) => theme!.fg("error", line));
			};

			const overlay: Component & { dispose(): void } = {
				render: (width: number): string[] => {
					const plan = planLayout(width);
					const rows = terminalMetric(tui as TUI, "rows");
					let lines: string[];
					if (plan === "blocked") {
						approvalDisabled = true;
						return blockedLines(width, rows);
					}
					const hint = hintLines(width);
					const fullRendered = selector!.render(width);
					if (plan.mode === "full") {
						approvalDisabled = false;
						const window = windowLines(wrappedTitle(width), plan.maxTitle, width);
						const windowBlock = [...window.body.map((line) => paddedLine(theme!.fg("accent", theme!.bold(line)), width))];
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
						// Belt and suspenders: never emit more lines than the terminal has.
						approvalDisabled = true;
						return blockedLines(width, rows);
					}
					return lines;
				},
				handleInput: (data: string): void => {
					// Recompute eligibility from the live terminal dimensions; never
					// trust a cached flag from a previous paint.
					const livePlan = planLayout(terminalMetric(tui as TUI, "columns"));
					approvalDisabled = livePlan === "blocked" || livePlan.mode === "degraded";
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
					twin?.dispose();
				},
				invalidate: (): void => {
				// The title window is recomputed per render; only the selectors cache.
					(selector as { invalidate?: () => void }).invalidate?.();
					(twin as { invalidate?: () => void }).invalidate?.();
				},
			};

			handle = tui.showOverlay(overlay, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: { left: 0, right: 0, bottom: 0 },
			});
		} catch (error) {
			// A genuine setup error fails the dialog after removing only owned
			// resources; the display is not retried.
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
