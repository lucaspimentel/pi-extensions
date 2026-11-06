/**
 * Guard-owned adapter over `@questi0nm4rk/shell-ast@0.8.0`, the bash parser
 * adopted to replace guard's hand-written command splitting and tokenizing
 * (see TODO.md "Adopt @questi0nm4rk/shell-ast").
 *
 * The adapter projects one parsed command into a `ShellCommandAnalysis`: an
 * ordered list of `ShellExecCall`s (each with the exact matching subject, the
 * unwrapped executing argv, its leading assignment words, and a per-call
 * completeness flag) plus a whole-command completeness flag and a
 * machine-readable cause. It is deliberately narrow: it never decides, never
 * knows a profile or a rule, and never throws past its own boundary.
 *
 * Load contract: the wasm is integrity-checked (pinned sha256) before the
 * module is imported, the import + first parse are single-flighted per
 * process, and any failure resolves to `{ available: false, diagnostic }`
 * with every later analysis `complete: false`. Guard therefore fails closed
 * (a prompt) whenever the parser is missing, corrupt, or rejects the input.
 *
 * Subject contract: `subject` is the raw source slice of the call's whole
 * chain (wrappers, assignment words, args, and its redirect clause) with a
 * leading `timeout` wrapper stripped and line continuations removed, so the
 * deny/ask/allow rule text that matched before the adoption keeps matching.
 * Bare `$VAR`/`${VAR}` expansion no longer authorizes the read-only tier: it
 * is reported per call via `hasParameterExpansion`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	Assign,
	CallExprNode,
	Redirect,
	ShellFile,
	ShellNode,
	Stmt,
	Visitor,
	Word,
} from "@questi0nm4rk/shell-ast";
import { stripLineContinuations, hasTopLevelFileRedirect } from "./bashtier.ts";
import { stripTimeoutPrefix, stripTrailingHarmlessRedirects } from "./shell-text.ts";

type ShellAstModule = typeof import("@questi0nm4rk/shell-ast");
type Command = NonNullable<Stmt["cmd"]>;
type DeclClause = Extract<Command, { type: "DeclClause" }>;
type TestClause = Extract<Command, { type: "TestClause" }>;

/** The pinned wasm digest for `@questi0nm4rk/shell-ast@0.8.0`. */
export const SHELL_AST_WASM_SHA256 = "8c237a53e577642500387cd584d3072d9cd185d94b2a2a9e0c27308ff0e6dcbf";

/** Machine-readable reason codes for an incomplete analysis or call. */
export type ShellAnalysisCause =
	| "parser-unavailable" | "parse-error" | "size-cap"
	| "command-substitution" | "process-substitution"
	| "background" | "grouped" | "subshell" | "heredoc"
	| "function-definition" | "state-change" | "unrecognized-node" | "no-command";

/** Human-readable text for a cause. The policy layer adds no prose. */
const CAUSE_REASON: Record<ShellAnalysisCause, string> = {
	"parser-unavailable": "the bash parser is unavailable",
	"parse-error": "the command could not be parsed as a shell command",
	"size-cap": "the command is too large to parse",
	"command-substitution": "the command uses command substitution",
	"process-substitution": "the command uses process substitution",
	background: "the command runs a step in the background",
	grouped: "the command uses a grouping construct (loop, conditional, or block)",
	subshell: "the command uses a subshell",
	heredoc: "the command uses a heredoc or here-string",
	"function-definition": "the command defines a shell function",
	"state-change": "the command uses a shell state-change construct",
	"unrecognized-node": "the command uses a construct the parser cannot evaluate",
	"no-command": "the command contains no executable command",
};

/**
 * The cause reason for a call or analysis. Authored here so the policy layer
 * routes on the machine cause without inventing prose.
 */
export function shellAnalysisCauseReason(cause: ShellAnalysisCause): string {
	return CAUSE_REASON[cause];
}

/**
 * Constructs that WRAP or SIT BETWEEN calls: no call list can represent them,
 * so they always set the analysis-level cause. Every other flagged construct
 * (command/process substitution, an unrecognized node, a redirect expansion)
 * is inside one call's own span and marks only that call incomplete.
 */
const WHOLE_COMMAND_CAUSES: ReadonlySet<ShellAnalysisCause> = new Set([
	"background", "grouped", "subshell", "heredoc", "function-definition", "state-change",
]);

/** One executing command inside a parsed host command. */
export interface ShellExecCall {
	occurrenceId: number;
	/** Raw source slice of the call's whole chain (wrappers + assignment words + argv + redirect clause). */
	subject: string;
	/** subject minus trailing harmless redirects. */
	allowSubject: string;
	/** Unwrapped executing argv (registry unwrap + manual command/xargs/builtin/nocache walk). */
	argv: readonly string[];
	/** Leading assignment words, verbatim. */
	assignments: readonly string[];
	/** True when only a redirect-aware allow rule can authorize the step. */
	requiresRedirectAwareAllow: boolean;
	/** Any ParamExp outside single quotes (the `$` veto). */
	hasParameterExpansion: boolean;
	/** argv empty && assignments present && complete. */
	pureAssignment: boolean;
	complete: boolean;
	cause: ShellAnalysisCause | null;
}

/** The full projection of one host command. */
export interface ShellCommandAnalysis {
	/** Every call is complete and no whole-command construct is present. */
	complete: boolean;
	cause: ShellAnalysisCause | null;
	/** Machine-reason text for `cause`, authored here. */
	reason: string | null;
	calls: readonly ShellExecCall[];
}

export interface ShellAstStatus {
	available: boolean;
	diagnostic: string | null;
}

const MANUAL_WRAPPERS = new Set(["command", "xargs", "builtin", "nocache"]);
const DECL_VARIANTS = new Set(["export", "local", "readonly", "declare", "typeset"]);

interface Loaded {
	module: ShellAstModule | null;
	status: ShellAstStatus;
}

let cache: Loaded | null = null;
let loading: Promise<Loaded> | null = null;
let expectedWasmSha = SHELL_AST_WASM_SHA256;
/** Generation counter: a load that resolves after a reset never re-populates the cache. */
let generation = 0;

/** Test seam: override the pinned digest (null restores it). */
export function setShellAstExpectedWasmShaForTests(sha: string | null): void {
	expectedWasmSha = sha ?? SHELL_AST_WASM_SHA256;
}

/** Warm the parser and compile the wasm ahead of the first command. */
export async function preloadShellAst(): Promise<ShellAstStatus> {
	return (await load()).status;
}

/**
 * The current load status. Callers may ask before any load: that reports
 * unavailable with a "not loaded yet" diagnostic, which is the same
 * fail-closed posture as a load failure.
 */
export function shellAstStatus(): ShellAstStatus {
	return cache?.status ?? { available: false, diagnostic: "the bash parser has not been loaded yet" };
}

/** Test seam: drop the per-process cache (mirrors resetSandboxDetection). */
export function resetShellAstLoad(): void {
	// Bump the generation: an in-flight load started before the reset resolves
	// into a stale generation and neither populates the cache nor clears the
	// loading slot of a load started after it.
	generation++;
	cache = null;
	loading = null;
	expectedWasmSha = SHELL_AST_WASM_SHA256;
}

async function load(): Promise<Loaded> {
	if (cache) return cache;
	if (!loading) {
		const gen = generation;
		loading = doLoad()
			.then((result) => { if (gen === generation) cache = result; return result; })
			.finally(() => { if (gen === generation) loading = null; });
	}
	return loading;
}

async function doLoad(): Promise<Loaded> {
	const integrity = verifyWasmIntegrity();
	if (integrity !== null) return { module: null, status: { available: false, diagnostic: integrity } };
	try {
		const mod = await import("@questi0nm4rk/shell-ast");
		await mod.preloadWasm();
		// Force the wasm compile (and surface a bad binary) now, not on the first
		// guarded command.
		await mod.parse("true");
		return { module: mod, status: { available: true, diagnostic: null } };
	} catch (err) {
		return { module: null, status: { available: false, diagnostic: `the bash parser failed to load (${describeError(err)})` } };
	}
}

/** Resolve the installed package entry and verify the wasm's pinned digest. */
function verifyWasmIntegrity(): string | null {
	try {
		const entry = fileURLToPath(import.meta.resolve("@questi0nm4rk/shell-ast"));
		const wasmPath = join(dirname(entry), "shell-ast.wasm");
		const digest = createHash("sha256").update(readFileSync(wasmPath)).digest("hex");
		if (digest !== expectedWasmSha) {
			return `the bash parser wasm failed its integrity check (sha256 ${digest})`;
		}
		return null;
	} catch (err) {
		return `the bash parser wasm could not be verified (${describeError(err)})`;
	}
}

function describeError(err: unknown): string {
	if (typeof err === "object" && err !== null && "message" in err && typeof (err as { message: unknown }).message === "string") {
		return (err as { message: string }).message;
	}
	return String(err);
}

/**
 * Analyse one host command. Never throws: a parser that is unavailable, over
 * its size cap, or unable to parse the input yields an incomplete analysis
 * with the matching cause, which the policy layer turns into a fail-closed
 * prompt.
 */
export async function analyzeHostCommand(command: string): Promise<ShellCommandAnalysis> {
	const loaded = await load();
	if (loaded.module === null) {
		return incomplete("parser-unavailable", loaded.status.diagnostic ?? CAUSE_REASON["parser-unavailable"], []);
	}
	const mod = loaded.module;
	// Line continuations join physical lines in bash; parse the joined form so
	// node offsets index into the same string we slice subjects from. The
	// parser strips a leading BOM itself, so strip it here too: every offset
	// stays relative to the exact string that was parsed.
	const stripped = stripLineContinuations(command);
	const src = stripped.charCodeAt(0) === 0xfeff ? stripped.slice(1) : stripped;
	// The parser's node positions are UTF-8 BYTE offsets (mvdan/sh Pos.Offset),
	// not JS string indices. Slice a Buffer of the same UTF-8 encoding so a
	// multibyte command is never mis-sliced; using src.slice with these offsets
	// would corrupt every subject and assignment that follows a multibyte
	// character (and silently defeat deny/ask rules that match them).
	const bytes = Buffer.from(src, "utf8");
	const slice: ByteSlicer = (start, end) => bytes.subarray(start, end).toString("utf8");
	let file: ShellFile;
	try {
		file = await mod.parse(src);
	} catch (err) {
		return parseFailureAnalysis(mod, err);
	}
	return analyzeParsed(mod, slice, file);
}

/** Slice the parsed source by UTF-8 byte offsets into the matching JS substring. */
type ByteSlicer = (startByte: number, endByte: number) => string;

function parseFailureAnalysis(mod: ShellAstModule, err: unknown): ShellCommandAnalysis {
	if (err instanceof mod.ParseSyntaxError) return incomplete("parse-error", CAUSE_REASON["parse-error"], []);
	if (err instanceof mod.ParseSizeError) return incomplete("size-cap", CAUSE_REASON["size-cap"], []);
	if (err instanceof mod.WasmLoadError || err instanceof mod.WasmRuntimeError) {
		return incomplete("parser-unavailable", CAUSE_REASON["parser-unavailable"], []);
	}
	if (err instanceof mod.ShellAstError) return incomplete("unrecognized-node", CAUSE_REASON["unrecognized-node"], []);
	return incomplete("parser-unavailable", describeError(err), []);
}

function incomplete(cause: ShellAnalysisCause, reason: string, calls: ShellExecCall[]): ShellCommandAnalysis {
	return { complete: false, cause, reason, calls };
}

interface ConstructEvent {
	offset: number;
	cause: ShellAnalysisCause;
	node: ShellNode;
}

function analyzeParsed(mod: ShellAstModule, slice: ByteSlicer, file: ShellFile): ShellCommandAnalysis {
	const events = detectConstructs(mod, file);
	const raw = collectCalls(mod, slice, file);
	markConstructBearingCalls(raw, events);
	const calls: ShellExecCall[] = raw.map((entry, index) => ({
		occurrenceId: index,
		subject: entry.subject,
		allowSubject: entry.requiresRedirectAwareAllow ? entry.subject : stripTrailingHarmlessRedirects(entry.subject),
		argv: entry.argv,
		assignments: entry.assignments,
		requiresRedirectAwareAllow: entry.requiresRedirectAwareAllow,
		hasParameterExpansion: entry.hasParameterExpansion,
		pureAssignment: entry.argv.length === 0 && entry.assignments.length > 0 && entry.complete,
		complete: entry.complete,
		cause: entry.cause,
	}));

	// The analysis-level cause is reserved for failures where no reliable call
	// list exists: a whole-command construct, or any flagged construct that
	// falls outside every call's span. A construct inside one call's own span
	// marks only that call incomplete, so its complete siblings stay decidable.
	const analysisEvent = events.find((e) =>
		WHOLE_COMMAND_CAUSES.has(e.cause) || !raw.some((c) => e.offset >= c.start && e.offset <= c.end));
	if (analysisEvent !== undefined) return incomplete(analysisEvent.cause, CAUSE_REASON[analysisEvent.cause], calls);
	if (file.stmts.length === 0 || calls.length === 0) {
		return incomplete("no-command", CAUSE_REASON["no-command"], calls);
	}
	return { complete: true, cause: null, reason: null, calls };
}

/**
 * A call whose own source span contains a flagged construct is not evaluable
 * on its own. This keeps the per-call completeness honest and gives a prompt
 * an offending step to name (which may also be the analysis-level cause when
 * that construct wraps the call).
 */
function markConstructBearingCalls(raw: RawCall[], events: readonly ConstructEvent[]): void {
	for (const entry of raw) {
		const event = events.find((e) => e.offset >= entry.start && e.offset <= entry.end);
		if (event === undefined) continue;
		entry.complete = false;
		entry.cause = entry.cause ?? event.cause;
	}
}

/** Constructs anywhere in the tree that make the whole command unprovable. */
function detectConstructs(mod: ShellAstModule, file: ShellFile): ConstructEvent[] {
	const events: ConstructEvent[] = [];
	const push = (node: ShellNode, cause: ShellAnalysisCause) => { events.push({ offset: node.pos.offset, cause, node }); };
	const visitor: Visitor = {
		CmdSubst: (n) => { push(n, "command-substitution"); },
		ProcSubst: (n) => { push(n, "process-substitution"); },
		Subshell: (n) => { push(n, "subshell"); },
		IfClause: (n) => { push(n, "grouped"); },
		WhileClause: (n) => { push(n, "grouped"); },
		ForClause: (n) => { push(n, "grouped"); },
		CaseClause: (n) => { push(n, "grouped"); },
		Block: (n) => { push(n, "grouped"); },
		TestDecl: (n) => { push(n, "grouped"); },
		ArithmCmd: (n) => { push(n, "grouped"); },
		FuncDecl: (n) => { push(n, "function-definition"); },
		LetClause: (n) => { push(n, "state-change"); },
		TimeClause: (n) => { push(n, "unrecognized-node"); },
		CoprocClause: (n) => { push(n, "unrecognized-node"); },
		DeclClause: (n) => { if (!isPureAssignmentDecl(n)) push(n, "state-change"); },
		Stmt: (n) => {
			if (n.background) push(n, "background");
			for (const r of n.redirs) if (isHeredocRedirect(r)) push(r, "heredoc");
		},
	};
	mod.walk(file, visitor);
	events.sort((a, b) => a.offset - b.offset);
	return events;
}

function isHeredocRedirect(r: Redirect): boolean {
	return r.op === "<<" || r.op === "<<-" || r.op === "<<<";
}

/** A leading `NAME=value`/`NAME`-only assignment that runs no command. */
function isAssignmentOnly(a: Assign): boolean {
	return a.name !== null && !a.naked && !a.array;
}

/**
 * A variable-only `export`/`readonly`/`declare`/`local`/`typeset`: leading
 * flag assignments (`declare -r`) are skipped, then every remaining argument
 * must be a plain assignment. Mirrors the deleted isPureVariableAssignment.
 */
function isPureAssignmentDecl(decl: DeclClause): boolean {
	if (!DECL_VARIANTS.has(decl.variant.value)) return false;
	const args = decl.args;
	let i = 0;
	while (i < args.length && args[i].name === null) i++;
	if (i >= args.length) return false;
	for (; i < args.length; i++) {
		if (!isAssignmentOnly(args[i])) return false;
	}
	return true;
}

interface RawCall {
	subject: string;
	argv: string[];
	assignments: string[];
	requiresRedirectAwareAllow: boolean;
	hasParameterExpansion: boolean;
	complete: boolean;
	cause: ShellAnalysisCause | null;
	/** The call's source span in UTF-8 byte offsets (construct containment only). */
	start: number;
	end: number;
}

function collectCalls(mod: ShellAstModule, slice: ByteSlicer, file: ShellFile): RawCall[] {
	const out: RawCall[] = [];
	const visitStmt = (stmt: Stmt): void => {
		const cmd = stmt.cmd;
		if (cmd === null) return;
		if (cmd.type === "CallExpr") { out.push(makeCall(mod, slice, stmt, cmd)); return; }
		if (cmd.type === "BinaryCmd") { visitStmt(cmd.x); visitStmt(cmd.y); return; }
		if (cmd.type === "DeclClause" && isPureAssignmentDecl(cmd)) { out.push(makeDeclCall(mod, slice, stmt, cmd)); return; }
		if (cmd.type === "TestClause") { out.push(makeTestCall(mod, slice, stmt, cmd)); return; }
		// Any other command is a construct: reported as an event, not a step.
	};
	for (const stmt of file.stmts) visitStmt(stmt);
	return out;
}

interface Span { text: string; start: number; end: number }

/** The contiguous source span of a call plus its redirects (leading or trailing). */
function spanOf(slice: ByteSlicer, stmt: Stmt, node: { pos: { offset: number }; end: { offset: number } }): Span {
	let start = node.pos.offset;
	let end = node.end.offset;
	for (const r of stmt.redirs) {
		start = Math.min(start, r.pos.offset);
		end = Math.max(end, r.end.offset);
	}
	return { text: slice(start, end).trim(), start, end };
}

function makeCall(mod: ShellAstModule, slice: ByteSlicer, stmt: Stmt, call: CallExprNode): RawCall {
	const span = spanOf(slice, stmt, call);
	const subject = stripTimeoutPrefix(span.text);
	const assignments = call.assigns.map((a) => slice(a.pos.offset, a.end.offset));
	const deepest = deepestLayer(mod, call);
	let argv: string[];
	let complete = true;
	let cause: ShellAnalysisCause | null = null;
	if (deepest && deepest.kind === "wrapped") {
		// innerRaw carries the inner command's FULL argv (flags included); the
		// layer's `args` is flag-stripped and would lose `duckdb -c`, `find
		// -delete`, and similar tier inputs.
		argv = resolveArgs(mod, deepest.innerRaw.args);
	} else {
		argv = resolveArgs(mod, call.args);
		if (deepest && (deepest.kind === "wrapped-script" || deepest.kind === "wrapped-opaque")) {
			complete = false;
			cause = "unrecognized-node";
		}
	}
	argv = manualWrapWalk(argv);
	return {
		subject,
		argv,
		assignments,
		requiresRedirectAwareAllow: hasTopLevelFileRedirect(subject),
		hasParameterExpansion: hasParamExpansion(mod, stmt),
		complete,
		cause,
		start: span.start,
		end: span.end,
	};
}

function makeDeclCall(mod: ShellAstModule, slice: ByteSlicer, stmt: Stmt, decl: DeclClause): RawCall {
	const span = spanOf(slice, stmt, decl);
	const subject = stripTimeoutPrefix(span.text);
	const assignments = decl.args.filter((a) => a.name !== null).map((a) => slice(a.pos.offset, a.end.offset));
	return {
		subject,
		argv: [],
		assignments,
		requiresRedirectAwareAllow: hasTopLevelFileRedirect(subject),
		hasParameterExpansion: hasParamExpansion(mod, stmt),
		complete: true,
		cause: null,
		start: span.start,
		end: span.end,
	};
}

/** `[[ ... ]]` is a read-only conditional expression; preserve the old tier's `[[` allow. */
function makeTestCall(mod: ShellAstModule, slice: ByteSlicer, stmt: Stmt, test: TestClause): RawCall {
	const span = spanOf(slice, stmt, test);
	const subject = stripTimeoutPrefix(span.text);
	return {
		subject,
		argv: ["[["],
		assignments: [],
		requiresRedirectAwareAllow: hasTopLevelFileRedirect(subject),
		hasParameterExpansion: hasParamExpansion(mod, stmt),
		complete: true,
		cause: null,
		start: span.start,
		end: span.end,
	};
}

function deepestLayer(mod: ShellAstModule, call: CallExprNode) {
	const layers = mod.unwrapDeep(call);
	return layers.length > 0 ? layers[layers.length - 1] : null;
}

function resolveArgs(mod: ShellAstModule, args: readonly Word[]): string[] {
	return args.map((w) => {
		const lit = mod.wordToLit(w);
		return lit !== null ? lit : "<dynamic>";
	});
}

/** Strip manual wrappers (`command`, `xargs`, `builtin`, `nocache`) and their leading flags. */
function manualWrapWalk(argv: string[]): string[] {
	let current = argv;
	for (let guard = 0; guard < 16; guard++) {
		if (current.length === 0) return current;
		const root = basename(current[0]);
		if (!MANUAL_WRAPPERS.has(root)) return current;
		current = current.slice(1);
		while (current.length > 0 && current[0].startsWith("-")) current = current.slice(1);
	}
	return current;
}

function hasParamExpansion(mod: ShellAstModule, node: ShellNode): boolean {
	let found = false;
	mod.walk(node, { ParamExp: () => { found = true; } });
	return found;
}
