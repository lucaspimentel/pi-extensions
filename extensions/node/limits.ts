/**
 * Centralized, documented defaults for the node tool.
 *
 * Two kinds of limits live here:
 *
 * 1. Controller-enforced execution limits (wall time, capture budgets, protocol
 *    framing). These are enforced in the parent Node process.
 * 2. OS-level per-process limits (RLIMIT_AS, RLIMIT_FSIZE, RLIMIT_NOFILE,
 *    RLIMIT_CORE). Unlike the python worker, the node worker cannot set its
 *    own rlimits (no setrlimit API in node), so they are applied by launching
 *    the worker through /usr/bin/prlimit inside the sandbox.
 *
 * None of these establish hard aggregate quotas: RLIMIT_AS caps each process's
 * virtual address space (a process can fork several children, each with its
 * own limit), RLIMIT_FSIZE caps single file size (not the scratch directory
 * quota), and the output budget is per execution. The scratch directory and
 * execution logs grow without an aggregate cap until the session disposes
 * them.
 *
 * Only the execution timeout varies through tool arguments. Everything else is
 * fixed here and is outside model control.
 */

export const LIMITS = {
	/** Maximum UTF-8 size of submitted source code. */
	maxCodeBytes: 64 * 1024,

	/** Default wall time for one execution. */
	defaultTimeoutSeconds: 30,

	/** Maximum wall time a caller may request. */
	maxTimeoutSeconds: 120,

	/** Deadline for worker startup and the ready handshake. */
	startupTimeoutMs: 10_000,

	/** Deadline for sandbox teardown after a forced kill. */
	cleanupTimeoutMs: 5_000,

	/** Combined stdout + stderr budget per execution. Exceeding it kills the sandbox. */
	outputBudgetBytes: 1024 * 1024,

	/** First N bytes of a stream kept in memory for the result excerpt. */
	captureHeadBytes: 32 * 1024,

	/** Last N bytes of a stream kept in memory for the result excerpt. */
	captureTailBytes: 8 * 1024,

	/** Maximum length of the final-expression repr. */
	maxReprBytes: 8 * 1024,

	/** Maximum length of a returned exception traceback. */
	maxTracebackBytes: 16 * 1024,

	/** Maximum size of one protocol frame in either direction. */
	maxFrameBytes: 128 * 1024,

	/** After a result frame, keep draining output pipes until this much time passes without data. */
	drainQuietMs: 300,

	/** Quiet window used when no live sandbox processes could still write. */
	drainQuietIdleMs: 50,

	/** Upper bound on the drain grace period after a result frame. */
	drainMaxMs: 2_000,

	// ── OS-level per-process limits (applied by prlimit before the worker) ──

	/**
	 * Per-process virtual address space. NOT an aggregate resident-memory cap.
	 * Measured on node 26: 512 MiB and 1 GiB kill node at startup (the V8
	 * CodeRange reservation fails before any user code runs); 2 GiB starts
	 * reliably. The JS heap is additionally capped by maxOldSpaceSizeMb below,
	 * so the extra virtual headroom does not translate into unbounded resident
	 * memory. Oversized Buffer allocations throw a catchable RangeError;
	 * extreme heap growth crashes the worker (state loss), like python's
	 * hard-exhaustion path.
	 */
	rlimitAsBytes: 2 * 1024 * 1024 * 1024,

	/**
	 * V8 old-space cap passed to the worker as --max-old-space-size. This is
	 * the effective JS heap ceiling; RLIMIT_AS above it backstops everything
	 * else (native allocations, Buffers, mmaps).
	 */
	maxOldSpaceSizeMb: 512,

	/** Per-file write size. NOT a scratch-directory quota. */
	rlimitFsizeBytes: 16 * 1024 * 1024,

	/** Open file descriptors per process. */
	rlimitNofile: 128,

	/** Core dumps are disabled. */
	coreDisabled: true,
} as const;

/** Read-only mount of the project inside the sandbox. */
export const SANDBOX_PROJECT_PATH = "/workspace";

/** Writable scratch mount inside the sandbox. */
export const SANDBOX_SCRATCH_PATH = "/scratch";

/** Protocol version negotiated in every frame. */
export const PROTOCOL_VERSION = 1;
