/**
 * PowerShell Tool Extension
 *
 * Registers a `pwsh` tool the LLM can call to execute PowerShell commands.
 * Intended for Windows-native object-pipeline work where bash + jq is awkward:
 * JSON/XML parsing, registry, WMI/CIM, .NET types, Get-* cmdlets.
 *
 * Mirrors pi's built-in `bash` tool ergonomics:
 *   - Tail-truncates output to 50KB / 2000 lines (whichever hits first)
 *   - Dumps full output to a temp file when truncated, and reports the path
 *   - Honors AbortSignal for cancellation
 *   - Per-call timeout (default 60s)
 *
 * Executable resolution (auto-detected once at module load):
 *   1. pwsh         (PowerShell 7+, faster startup, cross-platform)
 *   2. powershell   (Windows PowerShell 5.1, fallback on Windows)
 */

import { Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExtensionAPI,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Executable detection (cached) ───────────────────────────────────────────

let resolvedExe: string | null | undefined; // undefined = not probed, null = none

function detectPowerShell(): string | null {
	for (const candidate of ["pwsh", "powershell"]) {
		try {
			const r = spawnSync(
				candidate,
				["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
				{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 10_000 },
			);
			if (r.status === 0) return candidate;
		} catch {
			// ENOENT etc. — try next candidate
		}
	}
	return null;
}

function getExe(): string | null {
	if (resolvedExe === undefined) resolvedExe = detectPowerShell();
	return resolvedExe;
}

// ── Tool definition ─────────────────────────────────────────────────────────

const pwshTool = defineTool({
	name: "pwsh",
	label: "PowerShell",
	description:
		"Execute a PowerShell command. Prefer this over `bash` on Windows for: " +
		"JSON/XML parsing (ConvertFrom-Json / ConvertTo-Json), object pipelines " +
		"(Where-Object, Select-Object, ForEach-Object), native Windows paths " +
		"(C:\\\\...), the registry, WMI/CIM (Get-CimInstance), .NET types, and " +
		"Get-* cmdlets. Use `bash` for POSIX tools, git, jq, and shell scripts. " +
		"Output is captured tail-first and truncated to 50KB / 2000 lines; " +
		"when truncated, the full output is written to a temp file whose path " +
		"is included in the result.",
	promptSnippet:
		"Run PowerShell commands on Windows for object-pipeline work using pwsh",
	promptGuidelines: [
		"On Windows, prefer `pwsh` over `bash` for JSON parsing (ConvertFrom-Json), object pipelines (Where-Object, Select-Object), Windows paths, registry, WMI/CIM, and .NET types.",
		"Prefer `bash` for git, POSIX tools, jq, and shell scripts that don't need Windows-native APIs.",
		"When output is truncated, read the reported temp-file path with the `read` tool to see the full output.",
	],
	parameters: Type.Object({
		command: Type.String({ description: "PowerShell command(s) to execute." }),
		cwd: Type.Optional(
			Type.String({ description: "Working directory. Defaults to session cwd." }),
		),
		timeout: Type.Optional(
			Type.Number({ description: "Seconds before the process is killed. Default 60." }),
		),
	}),

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const exe = getExe();
		if (!exe) {
			return {
				content: [
					{
						type: "text",
						text:
							"PowerShell is not available on PATH. " +
							"Install PowerShell 7+ (https://aka.ms/powershell) or ensure " +
							"`pwsh` / `powershell` is reachable.",
					},
				],
				details: { exe: null },
				isError: true,
			};
		}

		const cwd = params.cwd ?? ctx?.cwd ?? process.cwd();
		const timeoutSec = params.timeout ?? 60;
		const startedAt = Date.now();

		// Already aborted before we even started
		if (signal?.aborted) {
			return {
				content: [{ type: "text", text: "Aborted before execution." }],
				details: { exe, aborted: true },
				isError: true,
			};
		}

		const child = spawn(
			exe,
			[
				"-NoProfile",
				"-NonInteractive",
				"-OutputFormat",
				"Text",
				"-Command",
				params.command,
			],
			{
				cwd,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				signal: signal ?? undefined,
			},
		);

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
		child.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, Math.max(1, timeoutSec) * 1000);

		const { exitCode, spawnErr } = await new Promise<{
			exitCode: number | null;
			spawnErr?: Error;
		}>((resolve) => {
			child.on("error", (err: NodeJS.ErrnoException) => {
				clearTimeout(timer);
				// AbortError surfaces here when signal aborts
				resolve({ exitCode: null, spawnErr: err });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ exitCode: code });
			});
		});

		const durationMs = Date.now() - startedAt;
		const stdout = Buffer.concat(stdoutChunks).toString("utf8");
		const stderr = Buffer.concat(stderrChunks).toString("utf8");

		// Build combined output (mirror bash tool: stdout, then stderr, then footer)
		const sections: string[] = [];
		if (stdout.length > 0) sections.push(stdout.replace(/\r\n/g, "\n").replace(/\s+$/, ""));
		if (stderr.length > 0) {
			sections.push(
				`--- stderr ---\n${stderr.replace(/\r\n/g, "\n").replace(/\s+$/, "")}`,
			);
		}

		let footer: string;
		if (signal?.aborted) {
			footer = `--- aborted after ${durationMs}ms ---`;
		} else if (timedOut) {
			footer = `--- timed out after ${timeoutSec}s (killed, ${durationMs}ms) ---`;
		} else if (spawnErr) {
			footer = `--- spawn error: ${spawnErr.message} (${durationMs}ms) ---`;
		} else {
			footer = `--- exit ${exitCode ?? "null"} (${durationMs}ms) ---`;
		}
		sections.push(footer);

		const fullText = sections.join("\n\n");

		// Truncate (tail-first; we want to see the last output / error message)
		const truncation = truncateTail(fullText, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		let displayText = truncation.content;
		let fullOutputPath: string | undefined;

		if (truncation.truncated) {
			try {
				const fname = `pi-pwsh-${Date.now()}-${randomBytes(4).toString("hex")}.txt`;
				fullOutputPath = path.join(os.tmpdir(), fname);
				writeFileSync(fullOutputPath, fullText, "utf8");
				const notice =
					`[Output truncated: kept last ${formatSize(truncation.outputBytes)} of ` +
					`${formatSize(truncation.totalBytes)} (${truncation.totalLines} lines total). ` +
					`Full output: ${fullOutputPath}]`;
				displayText = `${notice}\n\n${displayText}`;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				displayText =
					`[Output truncated (failed to dump full output: ${msg})]\n\n${displayText}`;
			}
		}

		const isError =
			timedOut ||
			signal?.aborted === true ||
			spawnErr !== undefined ||
			(exitCode !== 0 && exitCode !== null);

		return {
			content: [{ type: "text", text: displayText }],
			details: {
				exe,
				cwd,
				exitCode,
				timedOut,
				aborted: signal?.aborted === true,
				durationMs,
				truncation,
				fullOutputPath,
				spawnError: spawnErr?.message,
			},
			isError,
		};
	},
});

// ── Extension entry point ───────────────────────────────────────────────────

export default function pwshExtension(pi: ExtensionAPI) {
	pi.registerTool(pwshTool);
}
