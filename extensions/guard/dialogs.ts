/**
 * FIFO gate that serializes every dialog guard owns: execution approvals,
 * read-grant prompts, the /guard profile picker, and /guard migrate
 * confirmation. Pi's TUI keeps at most one extension selector alive; a second
 * concurrent `ctx.ui.select` orphans the first and its promise never settles.
 * Unlike a plain promise-chain mutex, the gate removes aborted queued requests
 * promptly and cancels the open dialog through the selector's AbortSignal.
 *
 * The gate is deliberately independent of GuardRuntime's execution queue:
 * dialogs never hold the queue, and already-authorized executor work proceeds
 * while another call awaits a dialog. Scope is guard-local: unrelated
 * extensions can still open competing selectors, and RPC clients decide
 * whether a cancelled dialog's display closes on their side.
 */

interface Entry {
	/** Private cancellation signal handed to the dialog body. */
	controller: AbortController;
	/** "queued" until the gate starts the body, then "open" until it settles. */
	state: "queued" | "open";
	/** True once the caller's promise has settled (early or normally). */
	settled: boolean;
	/** Settles the caller's promise early while the request is still queued. */
	settleEarly: ((error: unknown) => void) | null;
	/** Removes listeners and gate ownership; idempotent. */
	release: () => void;
}

/** Reason passed to AbortSignal when the caller's own signal aborted. */
function callerAbortReason(signal: AbortSignal): unknown {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	return new Error("guard: dialog cancelled: call aborted");
}

export interface DialogGateOptions {
	/**
	 * The owning operation's signal. The gate never aborts this controller;
	 * it only listens. Aborting it cancels the request, promptly while queued
	 * and through the dialog signal while open.
	 */
	signal?: AbortSignal;
}

export class DialogGate {
	/** Tail of the FIFO chain; every turn settles before the next body runs. */
	private tail: Promise<void> = Promise.resolve();
	/** Queued and open requests, so invalidation can cancel all of them. */
	private readonly pending = new Set<Entry>();

	/**
	 * Cancel every queued request and abort the open dialog's signal,
	 * synchronously. Called at policy and lifecycle boundaries. Safe to call
	 * repeatedly and when nothing is pending. Does not wait for bodies to
	 * settle: an open body that observes its signal settles on its own, and
	 * the lease is held until it does.
	 */
	invalidate(reason: string): void {
		const error = new Error(`guard: dialog cancelled: ${reason}`);
		for (const entry of [...this.pending]) {
			if (entry.state === "queued" && !entry.settled) {
				entry.settled = true;
				entry.release();
				entry.settleEarly?.(error);
			} else {
				entry.controller.abort(error);
			}
		}
	}

	/**
	 * Run one dialog body under the gate. The body receives the gate's private
	 * cancellation signal (already combined with the caller's signal) and must
	 * pass it to UI calls and honor it around its own awaits. The lease is
	 * held until the body settles; a body that ignores cancellation keeps the
	 * gate blocked, so a second selector can never replace it. A body that
	 * resolves after cancellation has an obsolete answer: the caller gets the
	 * cancellation error instead.
	 */
	run<T>(options: DialogGateOptions = {}, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const caller = options.signal;
		if (caller?.aborted) return Promise.reject(callerAbortReason(caller));
		const entry: Entry = {
			controller: new AbortController(),
			state: "queued",
			settled: false,
			settleEarly: null,
			release: () => {},
		};
		let resolveCaller!: (value: T) => void;
		let rejectCaller!: (error: unknown) => void;
		const result = new Promise<T>((resolve, reject) => { resolveCaller = resolve; rejectCaller = reject; });
		const release = (): void => {
			caller?.removeEventListener("abort", onCallerAbort);
			this.pending.delete(entry);
		};
		entry.release = release;
		// Invalidation uses this to settle a still-queued caller promptly.
		entry.settleEarly = (error) => rejectCaller(error);
		const onCallerAbort = (): void => {
			// Never touch the caller-owned controller; only our private one.
			const reason = callerAbortReason(caller as AbortSignal);
			if (entry.state === "queued" && !entry.settled) {
				entry.settled = true;
				release();
				rejectCaller(reason);
			} else {
				entry.controller.abort(reason);
			}
		};
		caller?.addEventListener("abort", onCallerAbort, { once: true });
		this.pending.add(entry);
		const turn = this.tail.then(async () => {
			if (entry.settled) return; // cancelled while queued: caller already settled
			entry.state = "open";
			try {
				const value = await body(entry.controller.signal);
				// An answer arriving after cancellation is obsolete; reject it.
				if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
				resolveCaller(value);
			} catch (error) {
				rejectCaller(error);
			} finally {
				entry.settled = true;
				release();
			}
		});
		// A failed turn must not poison the chain: later requests still run.
		this.tail = turn.then(() => undefined, () => undefined);
		return result;
	}
}
