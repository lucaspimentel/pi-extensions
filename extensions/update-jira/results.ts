/**
 * Result contract for the update-jira extension.
 *
 * Both tools return a `ResultEnvelope` as `structuredContent` and a bounded
 * model-facing `content` text. The complete text is capped at a fixed 16 KiB
 * UTF-8 budget; oversized results spill the full envelope as JSON into a
 * private session-local directory under the OS temporary location.
 *
 * Pure module: no pi-runtime imports. Filesystem effects are injected.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TEXT_BUDGET_BYTES = 16 * 1024;

/** Description cap for get digests (characters, not bytes). */
export const DIGEST_DESCRIPTION_CAP = 1500;

export const ERROR_KINDS = [
	"not_authenticated",
	"tool_unavailable",
	"invalid_input",
	"not_found",
	"rejected",
	"no_ticket",
	"invalid_key",
	"ambiguous_key",
	"config_invalid",
	"permission_denied",
	"subprocess_failed",
	"transport_error",
	"invalid_response",
	"cancelled",
	"write_outcome_unknown",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface ErrorInfo {
	kind: ErrorKind;
	message: string;
	/** Original MCP response / failure evidence, kept complete. */
	evidence?: unknown;
}

export interface ResultEnvelope {
	tool: "jira_read" | "jira_update";
	action: string;
	/** Normalized site origin with a trailing slash, as configured. */
	site: string;
	ticket?: string;
	ok: boolean;
	data?: unknown;
	error?: ErrorInfo;
	spillPath?: string;
}

export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Build the model-facing text for an envelope. The caller is responsible for
 * the 16 KiB budget: this returns the full (unbounded) text.
 */
export function buildFullText(envelope: ResultEnvelope): string {
	const target = envelope.ticket ? `${envelope.action} ${envelope.ticket}` : envelope.action;
	const header = `${envelope.tool} ${target}${envelope.ok ? ": ok" : ": error"}`;
	if (!envelope.ok && envelope.error) {
		const lines = [`error ${envelope.error.kind}: ${envelope.error.message}`];
		if (envelope.error.evidence !== undefined) {
			try {
				lines.push(JSON.stringify(envelope.error.evidence, null, 1));
			} catch {
				lines.push("(evidence could not be serialized)");
			}
		}
		return lines.join("\n");
	}
	let body: string;
	try {
		body = JSON.stringify(envelope.data, null, 1) ?? "(no data)";
	} catch {
		body = "(data could not be serialized)";
	}
	return `${header}\n${body}`;
}

/** Bounded text identifying the action/target and pointing at the spill file. */
export function buildSpillText(envelope: ResultEnvelope, spillPath: string): string {
	const target = envelope.ticket ? `${envelope.action} ${envelope.ticket}` : envelope.action;
	return (
		`${envelope.tool} ${target}: the complete result exceeded the ${TEXT_BUDGET_BYTES} byte text budget. ` +
		`The full structured result was saved to ${spillPath}; read that file for complete details.`
	);
}

/** Bounded text used when spilling itself failed. */
export function buildSpillFailureText(envelope: ResultEnvelope, reason: string): string {
	const target = envelope.ticket ? `${envelope.action} ${envelope.ticket}` : envelope.action;
	return (
		`${envelope.tool} ${target}: the result exceeded the ${TEXT_BUDGET_BYTES} byte text budget and the ` +
		`spill file could not be created (${reason}). The complete result is still available in the ` +
		`structured output of this tool result; it was not lost.`
	);
}

export interface SpillFsDeps {
	/** Root directory for spills; defaults to the OS temporary location. */
	tmpRoot?: string;
	mkdirTmpRoot?: (path: string, mode: number) => void;
	mkdirSessionDir?: (path: string, mode: number) => void;
	writeFile?: (path: string, data: string) => void;
	chmod?: (path: string, mode: number) => void;
	rmDir?: (path: string) => void;
}

export interface SpillManager {
	/**
	 * Write the envelope as JSON and return the spill path, or null when the
	 * write failed (the reason is reported through the callback result).
	 */
	write(envelope: ResultEnvelope): { path: string } | { error: string };
	/** Remember the session-local directory for cleanup. */
	readonly sessionDirs: readonly string[];
	/** Best-effort, idempotent removal of every spill directory this manager created. */
	cleanup(): void;
}

/**
 * Create a spill writer for one session. The session-local directory is
 * created lazily on the first spill, never at registration time. POSIX
 * permissions are owner-only (0700 directory, 0600 file) where supported.
 */
export function createSpillManager(deps: SpillFsDeps = {}, sessionKey: string): SpillManager {
	const tmpRoot = deps.tmpRoot ?? os.tmpdir();
	const root = path.join(tmpRoot, "update-jira-spill");
	const sanitized = sessionKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "session";
	const sessionDir = path.join(root, sanitized);
	const sessionDirs: string[] = [];
	let counter = 0;

	return {
		sessionDirs,
		write(envelope: ResultEnvelope): { path: string } | { error: string } {
			try {
				if (!sessionDirs.includes(sessionDir)) {
					deps.mkdirTmpRoot ? deps.mkdirTmpRoot(root, 0o700) : fs.mkdirSync(root, { mode: 0o700 });
					deps.mkdirSessionDir
						? deps.mkdirSessionDir(sessionDir, 0o700)
						: fs.mkdirSync(sessionDir, { mode: 0o700 });
					if (process.platform !== "win32") {
						deps.chmod ? deps.chmod(sessionDir, 0o700) : fs.chmodSync(sessionDir, 0o700);
					}
					sessionDirs.push(sessionDir);
				}
				counter += 1;
				const file = path.join(sessionDir, `spill-${Date.now()}-${counter}-${envelope.tool}-${envelope.action}.json`);
				const withPath: ResultEnvelope = { ...envelope, spillPath: file };
				deps.writeFile ? deps.writeFile(file, JSON.stringify(withPath, null, 1)) : fs.writeFileSync(file, JSON.stringify(withPath, null, 1));
				if (process.platform !== "win32") {
					deps.chmod ? deps.chmod(file, 0o600) : fs.chmodSync(file, 0o600);
				}
				return { path: file };
			} catch (err) {
				return { error: err instanceof Error ? err.message : String(err) };
			}
		},
		cleanup(): void {
			for (const dir of sessionDirs) {
				try {
					deps.rmDir ? deps.rmDir(dir) : fs.rmSync(dir, { recursive: true, force: true });
				} catch {
					// Best effort; leftovers are disclosed in the README.
				}
			}
			sessionDirs.length = 0;
		},
	};
}
