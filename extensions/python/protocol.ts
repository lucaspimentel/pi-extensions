/**
 * Protocol types, framing, and validation for the python tool worker.
 *
 * Framing is line-delimited JSON:
 *   requests  (parent -> worker, worker fd 0):  one JSON object per line
 *   responses (worker -> parent, worker fd 3):  one JSON object per line
 *
 * User code cannot corrupt the protocol: its stdout/stderr are separate pipes,
 * stdin is /dev/null, and subprocesses do not inherit the response fd. Still,
 * every worker message is treated as untrusted input: frames are size-bounded
 * before parsing and field-validated after parsing. Malformed, oversized,
 * duplicate, or mismatched frames are reported as protocol violations.
 */

import { LIMITS, PROTOCOL_VERSION } from "./limits.ts";

/** Exception details returned for ordinary Python errors. */
export interface PythonExceptionInfo {
	type: string;
	message: string;
	traceback: string;
}

/** Worker -> parent: startup handshake. */
export interface ReadyFrame {
	type: "ready";
	protocol: number;
	pythonVersion: string;
}

/** Worker -> parent: one executed request finished without killing the worker. */
export interface ResultFrame {
	type: "result";
	protocol: number;
	id: number;
	status: "ok" | "python_error";
	repr: string | null;
	reprTruncated: boolean;
	exception: PythonExceptionInfo | null;
	/** Live non-zombie processes in the sandbox besides pid 1 and the worker. */
	sandboxProcesses: number;
}

/** Worker -> parent: protocol-level problem (worker stays alive; parent decides). */
export interface ErrorFrame {
	type: "error";
	protocol: number;
	id: number | null;
	message: string;
}

export type WorkerFrame = ReadyFrame | ResultFrame | ErrorFrame;

/** Parent -> worker request. Only exec exists in v1. */
export interface ExecRequest {
	type: "exec";
	protocol: number;
	id: number;
	code: string;
}

export type FrameDecodeResult =
	| { ok: true; frame: WorkerFrame }
	| { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes;
}

/**
 * Validate and decode one response frame line (no trailing newline).
 * Returns ok:false with a reason for anything malformed or oversized.
 */
export function decodeFrame(line: string): FrameDecodeResult {
	if (Buffer.byteLength(line, "utf8") > LIMITS.maxFrameBytes) {
		return { ok: false, error: `frame exceeds ${LIMITS.maxFrameBytes} byte limit` };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return { ok: false, error: "frame is not valid JSON" };
	}
	if (!isPlainObject(raw)) return { ok: false, error: "frame is not a JSON object" };
	if (raw.protocol !== PROTOCOL_VERSION) {
		return { ok: false, error: `unsupported protocol version ${JSON.stringify(raw.protocol)}` };
	}
	switch (raw.type) {
		case "ready": {
			if (!isBoundedString(raw.pythonVersion, 128)) {
				return { ok: false, error: "ready frame has invalid pythonVersion" };
			}
			return {
				ok: true,
				frame: { type: "ready", protocol: PROTOCOL_VERSION, pythonVersion: raw.pythonVersion },
			};
		}
		case "result": {
			if (!Number.isInteger(raw.id) || (raw.id as number) < 0) {
				return { ok: false, error: "result frame has invalid id" };
			}
			if (raw.status !== "ok" && raw.status !== "python_error") {
				return { ok: false, error: "result frame has invalid status" };
			}
			if (raw.repr !== null && !isBoundedString(raw.repr, LIMITS.maxReprBytes)) {
				return { ok: false, error: "result frame repr missing or over limit" };
			}
			if (typeof raw.reprTruncated !== "boolean") {
				return { ok: false, error: "result frame has invalid reprTruncated" };
			}
			const sandboxProcesses = raw.sandboxProcesses === undefined ? 0 : raw.sandboxProcesses;
			if (!Number.isInteger(sandboxProcesses) || (sandboxProcesses as number) < 0) {
				return { ok: false, error: "result frame has invalid sandboxProcesses" };
			}
			let exception: PythonExceptionInfo | null = null;
			if (raw.exception !== null) {
				const e = raw.exception;
				if (
					!isPlainObject(e) ||
					!isBoundedString(e.type, 128) ||
					!isBoundedString(e.message, 8192) ||
					!isBoundedString(e.traceback, LIMITS.maxTracebackBytes)
				) {
					return { ok: false, error: "result frame has invalid exception payload" };
				}
				exception = {
					type: e.type,
					message: e.message,
					traceback: e.traceback,
				};
			}
			return {
				ok: true,
				frame: {
					type: "result",
					protocol: PROTOCOL_VERSION,
					id: raw.id as number,
					status: raw.status,
					repr: raw.repr as string | null,
					reprTruncated: raw.reprTruncated as boolean,
					exception,
					sandboxProcesses: sandboxProcesses as number,
				},
			};
		}
		case "error": {
			if (raw.id !== null && (!Number.isInteger(raw.id) || (raw.id as number) < 0)) {
				return { ok: false, error: "error frame has invalid id" };
			}
			if (!isBoundedString(raw.message, 8192)) {
				return { ok: false, error: "error frame has invalid message" };
			}
			return {
				ok: true,
				frame: {
					type: "error",
					protocol: PROTOCOL_VERSION,
					id: raw.id === null ? null : (raw.id as number),
					message: raw.message,
				},
			};
		}
		default:
			return { ok: false, error: `unknown frame type ${JSON.stringify(raw.type)}` };
	}
}

/** Encode a request frame. Throws if the frame would exceed the protocol limit. */
export function encodeRequest(request: ExecRequest): Buffer {
	const line = JSON.stringify(request) + "\n";
	const buf = Buffer.from(line, "utf8");
	if (buf.length > LIMITS.maxFrameBytes) {
		throw new Error(`request frame exceeds ${LIMITS.maxFrameBytes} byte limit`);
	}
	return buf;
}

/**
 * Incremental line splitter for a response pipe. Feeding arbitrary chunks
 * yields complete lines; an over-limit line is reported once as a violation
 * and its remainder is discarded up to the next newline.
 */
export class FrameStream {
	private buf: Buffer = Buffer.alloc(0);
	private discarding = false;
	private discardLen = 0;
	private readonly onLine: (line: string) => void;

	constructor(onLine: (line: string) => void) {
		this.onLine = onLine;
	}

	/** Feed one chunk. Returns a violation description, or null. */
	push(chunk: Buffer): string | null {
		const next = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
		this.buf = next;
		for (;;) {
			const nl = this.buf.indexOf(0x0a);
			if (nl === -1) {
				if (this.buf.length > LIMITS.maxFrameBytes) {
					this.discarding = true;
					this.discardLen = this.buf.length;
					this.buf = Buffer.alloc(0);
					return `frame exceeded ${LIMITS.maxFrameBytes} byte limit before newline`;
				}
				return null;
			}
			const line = this.buf.subarray(0, nl);
			this.buf = this.buf.subarray(nl + 1);
			if (this.discarding) {
				// Remainder of the over-limit line: swallowed, single violation already reported.
				this.discarding = false;
				continue;
			}
			if (line.length > LIMITS.maxFrameBytes) {
				this.discardLen = line.length;
				return `frame of ${line.length} bytes exceeds ${LIMITS.maxFrameBytes} byte limit`;
			}
			this.onLine(line.toString("utf8"));
		}
	}

	/** Bytes discarded by the most recent over-limit violation (diagnostics only). */
	get lastDiscardedBytes(): number {
		return this.discardLen;
	}
}

/**
 * Bound the tail of a string, keeping the end (tracebacks and errors carry
 * their meaning at the end). Returns the bounded string and whether it was cut.
 */
export function boundTail(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	let cut = text;
	while (cut.length > 0 && Buffer.byteLength(cut, "utf8") > maxBytes) {
		cut = cut.slice(1);
	}
	return { text: `...[truncated]\n${cut}`, truncated: true };
}

/** Bound the head of a string, keeping the start (messages carry meaning at the front). */
export function boundHead(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	const buf = Buffer.from(text, "utf8");
	return { text: buf.subarray(0, maxBytes).toString("utf8") + "...[truncated]", truncated: true };
}
