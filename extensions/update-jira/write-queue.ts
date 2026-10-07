/**
 * Per-site/ticket mutation serialization for the update-jira extension.
 *
 * All mutations for one normalized site/ticket key run sequentially, including
 * their enumeration and dedupe reads. Different tickets and sites stay
 * concurrent, and read-only calls never enter the queue. Cancellation of
 * queued (not yet started) work prevents any remote dispatch; the queue
 * releases ownership on every completion path.
 *
 * Pure module.
 */

/** Sentinel rejection used when queued work is cancelled before it starts. */
export class QueuedCancelledError extends Error {
	constructor() {
		super("the queued mutation was cancelled before it was dispatched");
		this.name = "QueuedCancelledError";
	}
}

export interface QueueToken {
	readonly cancelled: boolean;
}

interface PendingToken {
	cancelled: boolean;
}

export class WriteQueue {
	private chains = new Map<string, Promise<unknown>>();
	private pending = new Map<string, Set<PendingToken>>();

	private static key(site: string, ticket: string): string {
		return `${site}|${ticket}`;
	}

	/**
	 * Run `task` exclusively for the given site/ticket. The token passed to the
	 * task reports queued cancellation; a task that has already started is
	 * responsible for honoring its own abort signal.
	 */
	enqueue<T>(site: string, ticket: string, task: (token: QueueToken) => Promise<T>): Promise<T> {
		const key = WriteQueue.key(site, ticket);
		const token: PendingToken = { cancelled: false };
		let set = this.pending.get(key);
		if (!set) {
			set = new Set();
			this.pending.set(key, set);
		}
		set.add(token);

		const previous = this.chains.get(key);
		const run = async (): Promise<T> => {
			set?.delete(token);
			if (set && set.size === 0) this.pending.delete(key);
			if (token.cancelled) throw new QueuedCancelledError();
			return task(token);
		};
		const next = previous ? previous.then(run, run) : run();
		// The chain itself never rejects; callers observe `next` directly.
		this.chains.set(
			key,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	/**
	 * Cancel every queued (not yet started) task for a site/ticket. Returns the
	 * number of tasks that will fail with QueuedCancelledError instead of
	 * dispatching anything remotely.
	 */
	cancelPending(site: string, ticket: string): number {
		const set = this.pending.get(WriteQueue.key(site, ticket));
		if (!set) return 0;
		let count = 0;
		for (const token of set) {
			if (!token.cancelled) {
				token.cancelled = true;
				count += 1;
			}
		}
		return count;
	}
}
