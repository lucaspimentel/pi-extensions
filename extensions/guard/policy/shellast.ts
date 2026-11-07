/**
 * Guard-owned adapter over `@questi0nm4rk/shell-ast@0.8.0`, the bash parser
 * adopted to replace guard's hand-written command splitting and tokenizing
 * (see docs/guard-design.md, final measurement and retirement record).
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
 * Subject contract: complete calls render their pre-unwrap chain from AST
 * words, assignments, and redirects. Literal words have one quoted spelling;
 * words with unquoted expansion syntax use a reserved, source-encoded marker.
 * Declarations, arrays and tests retain source spelling. Incomplete calls have
 * no canonical subject. `previousSubject` and `rawSubject` preserve the prior
 * projections for deny/ask, never allow. `tierNoopCdSubject` preserves the old
 * no-op-cd input separately.
 * Bare `$VAR`/`${VAR}` expansion still vetoes the read-only tier.
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
	WordPart,
} from "@questi0nm4rk/shell-ast";
import { stripLineContinuations, hasWritableRedirect, type StructuredRedirect } from "./bashtier.ts";
import { stripTimeoutPrefix, stripTrailingHarmlessRedirects } from "./shell-text.ts";
import { isActiveExpansionWord, renderCanonicalJoin, renderRuleSubject, type ShellSourceSpan, type ShellRuleWord, type ShellAssignmentSubject, type ShellRedirectSubject } from "./shell-subject.ts";

type ShellAstModule = typeof import("@questi0nm4rk/shell-ast");
type Command = NonNullable<Stmt["cmd"]>;
type DeclClause = Extract<Command, { type: "DeclClause" }>;
type TestClause = Extract<Command, { type: "TestClause" }>;
// `ArithmExp`/`BraceExp` are not re-exported by the package's `index.d.ts`;
// they are reachable through the exported `WordPart` union.
type ArithmExpNode = Extract<WordPart, { type: "ArithmExp" }>;
type BraceExpNode = Extract<WordPart, { type: "BraceExp" }>;

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

/** One structured redirect on a call: the operator and its statically resolved target. */
export interface ShellRedirect extends StructuredRedirect {}

/** One executing command inside a parsed host command. */
export interface ShellExecCall {
	occurrenceId: number;
	/** Canonical pre-unwrap chain, null when the call cannot be projected. */
	subject: string | null;
	/** Prior canonical subject, used only as a deny/ask safety spelling. */
	previousSubject: string | null;
	/** Canonical subject minus trailing harmless redirects. */
	allowSubject: string | null;
	/** Legacy normalized raw slice, for deny/ask matching and display only. */
	rawSubject: string;
	sourceSpan: ShellSourceSpan;
	chainArgv: readonly ShellRuleWord[];
	/** The unchanged input to the tier's string-based no-op-cd exception. */
	tierNoopCdSubject: string;
	/** Unwrapped executing argv (registry unwrap + manual command/xargs/builtin/nocache walk). */
	argv: readonly string[];
	/** Leading assignment words, verbatim. */
	assignments: readonly string[];
	/** The call's redirects (op + resolved target), for the tier's write/input gates. */
	redirects: readonly ShellRedirect[];
	/** True when only a redirect-aware allow rule can authorize the step (no writeRoots here: the policy layer refines with the config roots). */
	requiresRedirectAwareAllow: boolean;
	/** Any ParamExp outside single quotes (the `$` veto). */
	hasParameterExpansion: boolean;
	/** True when any projected word (chain arg, assignment value, redirect target) carries active expansion; such steps are ineligible for allow-rule authorization. */
	hasActiveExpansion: boolean;
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
	/** Null for incomplete or unrepresentable structure (including comments and negation). */
	canonicalJoin: string | null;
	/** Prior canonical join, used only as a deny/ask safety spelling. */
	previousCanonicalJoin: string | null;
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
	return analyzeParsed(mod, slice, file, src);
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
	return { complete: false, cause, reason, calls, canonicalJoin: null, previousCanonicalJoin: null };
}

interface ConstructEvent {
	offset: number;
	cause: ShellAnalysisCause;
	node: ShellNode;
}

function analyzeParsed(mod: ShellAstModule, slice: ByteSlicer, file: ShellFile, source: string): ShellCommandAnalysis {
	const events = detectConstructs(mod, file);
	const raw = collectCalls(mod, slice, file);
	markConstructBearingCalls(raw, events);
	const calls: ShellExecCall[] = raw.map((entry, index) => ({
		occurrenceId: index,
		subject: entry.complete ? entry.subject : null,
		previousSubject: entry.complete ? entry.previousSubject : null,
		allowSubject: !entry.complete ? null : entry.requiresRedirectAwareAllow ? entry.subject : stripTrailingHarmlessRedirects(entry.subject, true),
		rawSubject: entry.rawSubject,
		sourceSpan: { start: entry.start, end: entry.end },
		chainArgv: entry.chainArgv,
		tierNoopCdSubject: entry.rawSubject,
		argv: entry.argv,
		assignments: entry.assignments,
		redirects: entry.redirects,
		requiresRedirectAwareAllow: entry.requiresRedirectAwareAllow,
		hasParameterExpansion: entry.hasParameterExpansion,
		hasActiveExpansion: entry.hasActiveExpansion,
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
	let representable = file.last.length === 0;
	mod.walk(file, { Stmt: (stmt) => { if (stmt.negated || stmt.comments.length > 0) representable = false; } });
	return {
		complete: true, cause: null, reason: null, calls,
		canonicalJoin: renderCanonicalJoin(source, calls, representable),
		previousCanonicalJoin: renderCanonicalJoin(source, calls.map((call) => ({ sourceSpan: call.sourceSpan, subject: call.previousSubject })), representable),
	};
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

/**
 * The traversal-coverage guarantee: every node type `@questi0nm4rk/shell-ast`
 * can emit is classified exactly once, and `buildConstructVisitor` derives the
 * construct walk from this table. `Record<ShellNode["type"], NodeDisposition>`
 * makes the classification exhaustive at COMPILE time (a package bump that adds
 * a node type breaks `tsc`), and `buildConstructVisitor` additionally treats any
 * node type absent from the table as an `unrecognized-node` cause at RUNTIME,
 * so a type the walk would otherwise silently treat as a leaf makes the call
 * incomplete instead of hiding a construct. `tests/guard-shellast.test.mts`
 * pins the table against the shipped type definitions and induces one command
 * per type.
 *
 * Coverage buckets:
 *   - "descend":  the analysis visits its children (the package walk, or an
 *                 explicit `manualRecurse` for a walker leaf that still holds
 *                 child nodes);
 *   - "leaf":     a terminal node whose meaning the analysis represents
 *                 elsewhere (e.g. ParamExp -> hasParameterExpansion) or which
 *                 carries no executable semantics (a literal, a comment);
 *   - "cause":    visiting it makes the enclosing call (or the whole command)
 *                 unprovable, so the policy layer prompts.
 */
export type NodeCoverage = "descend" | "leaf" | "cause";

export interface NodeDisposition {
	coverage: NodeCoverage;
	/** For `coverage: "cause"`: the incompleteness cause the node raises. */
	cause?: ShellAnalysisCause;
	/** For a walker-leaf `descend` node: how to walk its hidden children. */
	manualRecurse?: (mod: ShellAstModule, node: ShellNode, visitor: Visitor) => void;
}

export const NODE_DISPOSITIONS: Record<ShellNode["type"], NodeDisposition> = {
	// Containers the package walk descends into. No analysis action here; Stmt
	// and DeclClause add a conditional cause in buildConstructVisitor.
	File: { coverage: "descend" },
	Stmt: { coverage: "descend" },
	Redirect: { coverage: "descend" },
	Word: { coverage: "descend" },
	Assign: { coverage: "descend" },
	CallExpr: { coverage: "descend" },
	BinaryCmd: { coverage: "descend" },
	TestClause: { coverage: "descend" }, // projected as a `[[` call
	DeclClause: { coverage: "descend" },
	DblQuoted: { coverage: "descend" },
	BinaryArithm: { coverage: "descend" },
	UnaryArithm: { coverage: "descend" },
	ParenArithm: { coverage: "descend" },
	BinaryTest: { coverage: "descend" },
	UnaryTest: { coverage: "descend" },
	ParenTest: { coverage: "descend" },
	CaseItem: { coverage: "descend" },
	WordIter: { coverage: "descend" },
	ArrayExpr: { coverage: "descend" },
	ArrayElem: { coverage: "descend" },
	// Terminal nodes whose meaning the analysis represents elsewhere, or which
	// carry no executable semantics at all.
	Lit: { coverage: "leaf" },
	SglQuoted: { coverage: "leaf" },
	ExtGlob: { coverage: "leaf" }, // a glob pattern; no expansion/exec semantics
	ParamExp: { coverage: "leaf" }, // the `$` veto is ShellExecCall.hasParameterExpansion
	CStyleLoop: { coverage: "leaf" }, // only reachable under a ForClause (grouped) cause
	Comment: { coverage: "leaf" }, // never on the walk; no executable semantics
	// Constructs that make the enclosing call (or the whole command) unprovable.
	CmdSubst: { coverage: "cause", cause: "command-substitution" },
	ProcSubst: { coverage: "cause", cause: "process-substitution" },
	Subshell: { coverage: "cause", cause: "subshell" },
	IfClause: { coverage: "cause", cause: "grouped" },
	WhileClause: { coverage: "cause", cause: "grouped" },
	ForClause: { coverage: "cause", cause: "grouped" },
	CaseClause: { coverage: "cause", cause: "grouped" },
	Block: { coverage: "cause", cause: "grouped" },
	TestDecl: { coverage: "cause", cause: "grouped" },
	ArithmCmd: { coverage: "cause", cause: "grouped" },
	FuncDecl: { coverage: "cause", cause: "function-definition" },
	LetClause: { coverage: "cause", cause: "state-change" },
	TimeClause: { coverage: "cause", cause: "unrecognized-node" },
	CoprocClause: { coverage: "cause", cause: "unrecognized-node" },
	// Walker leaves that hide child nodes: recurse explicitly so a construct
	// nested inside `$((...))` / `{a,$(cmd)}` stays flagged (fail closed).
	ArithmExp: { coverage: "descend", manualRecurse: (m, n, v) => { m.walk((n as ArithmExpNode).x, v); } },
	BraceExp: { coverage: "descend", manualRecurse: (m, n, v) => { for (const e of (n as BraceExpNode).elems) m.walk(e, v); } },
};

type NodeHandler = (node: ShellNode) => void;

/**
 * Build the construct visitor from NODE_DISPOSITIONS. Every table entry gets a
 * handler (even a no-op), so the Proxy can distinguish a known node type from
 * an unknown one: an unknown `node.type` is pushed as `unrecognized-node`
 * (fail closed) instead of the package walk silently treating it as a leaf.
 */
export function buildConstructVisitor(mod: ShellAstModule, push: (node: ShellNode, cause: ShellAnalysisCause) => void): Visitor {
	const handlers: Record<string, NodeHandler> = {};
	for (const type of Object.keys(NODE_DISPOSITIONS) as Array<ShellNode["type"]>) {
		const disposition = NODE_DISPOSITIONS[type];
		if (type === "Stmt") {
			handlers[type] = (node) => {
				const stmt = node as Stmt;
				if (stmt.background) push(stmt, "background");
				for (const r of stmt.redirs) if (isHeredocRedirect(r)) push(r, "heredoc");
			};
			continue;
		}
		if (type === "DeclClause") {
			handlers[type] = (node) => { if (!isPureAssignmentDecl(node as DeclClause)) push(node, "state-change"); };
			continue;
		}
		if (disposition.coverage === "cause") {
			const cause = disposition.cause ?? "unrecognized-node";
			handlers[type] = (node) => push(node, cause);
			continue;
		}
		if (disposition.manualRecurse !== undefined) {
			const recurse = disposition.manualRecurse;
			handlers[type] = (node) => { recurse(mod, node, visitor); };
			continue;
		}
		// "descend" (the walker recurses) or "leaf": a no-op handler keeps the
		// type known while changing nothing about the traversal.
		handlers[type] = () => {};
	}
	const visitor = new Proxy(handlers, {
		get(target, prop, receiver) {
			if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			return (node: ShellNode) => push(node, "unrecognized-node");
		},
	});
	return visitor as unknown as Visitor;
}

/** Constructs anywhere in the tree that make the whole command unprovable. */
function detectConstructs(mod: ShellAstModule, file: ShellFile): ConstructEvent[] {
	const events: ConstructEvent[] = [];
	const push = (node: ShellNode, cause: ShellAnalysisCause) => { events.push({ offset: node.pos.offset, cause, node }); };
	mod.walk(file, buildConstructVisitor(mod, push));
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
	previousSubject: string;
	rawSubject: string;
	chainArgv: ShellRuleWord[];
	argv: string[];
	assignments: string[];
	redirects: ShellRedirect[];
	requiresRedirectAwareAllow: boolean;
	hasParameterExpansion: boolean;
	hasActiveExpansion: boolean;
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
	const rawSubject = stripTimeoutPrefix(span.text);
	// Capture the chain before either registry or manual wrapper unwrapping.
	const chainArgv = call.args.map((w) => projectRuleWord(mod, slice, w));
	const assignmentSubjects = call.assigns.map((a) => projectAssignment(mod, slice, a));
	const redirectSubjects = stmt.redirs.map((r) => projectRedirect(mod, slice, r));
	const previousWords = call.args.map((w) => projectRuleWord(mod, slice, w, true));
	const previousAssignments = call.assigns.map((a) => projectAssignment(mod, slice, a, true));
	const previousRedirects = stmt.redirs.map((r) => projectRedirect(mod, slice, r, true));
	const subject = assignmentSubjects.some((a) => a === null)
		? span.text
		: renderRuleSubject(chainArgv, assignmentSubjects as ShellAssignmentSubject[], redirectSubjects);
	const previousSubject = previousAssignments.some((a) => a === null)
		? span.text
		: renderRuleSubject(previousWords, previousAssignments as ShellAssignmentSubject[], previousRedirects, true);
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
	const redirects = redirectsOf(mod, slice, stmt);
	// Current projections only: the previous spellings keep the old rendering
	// on purpose, so deny/ask safety matching stays untouched.
	const hasActiveExpansion = chainArgv.some(isActiveExpansionWord)
		|| assignmentSubjects.some((a) => a !== null && isActiveExpansionWord(a.value))
		|| redirectSubjects.some((r) => isActiveExpansionWord(r.target));
	return {
		subject,
		previousSubject,
		rawSubject,
		chainArgv,
		argv,
		assignments,
		redirects,
		requiresRedirectAwareAllow: hasWritableRedirect(redirects),
		hasParameterExpansion: hasParamExpansion(mod, stmt),
		hasActiveExpansion,
		complete,
		cause,
		start: span.start,
		end: span.end,
	};
}

function makeDeclCall(mod: ShellAstModule, slice: ByteSlicer, stmt: Stmt, decl: DeclClause): RawCall {
	const span = spanOf(slice, stmt, decl);
	const subject = span.text;
	const assignments = decl.args.filter((a) => a.name !== null).map((a) => slice(a.pos.offset, a.end.offset));
	const redirects = redirectsOf(mod, slice, stmt);
	return {
		subject,
		previousSubject: subject,
		rawSubject: stripTimeoutPrefix(span.text),
		chainArgv: [],
		argv: [],
		assignments,
		redirects,
		requiresRedirectAwareAllow: hasWritableRedirect(redirects),
		hasParameterExpansion: hasParamExpansion(mod, stmt),
		hasActiveExpansion: decl.args.some((a) => a.value !== null && isActiveExpansionWord(projectRuleWord(mod, slice, a.value, false, true))),
		complete: true,
		cause: null,
		start: span.start,
		end: span.end,
	};
}

/** `[[ ... ]]` is a read-only conditional expression; preserve the old tier's `[[` allow. */
function makeTestCall(mod: ShellAstModule, slice: ByteSlicer, stmt: Stmt, test: TestClause): RawCall {
	const span = spanOf(slice, stmt, test);
	const subject = span.text;
	const redirects = redirectsOf(mod, slice, stmt);
	return {
		subject,
		previousSubject: subject,
		rawSubject: stripTimeoutPrefix(span.text),
		chainArgv: [],
		argv: ["[["],
		assignments: [],
		redirects,
		requiresRedirectAwareAllow: hasWritableRedirect(redirects),
		hasParameterExpansion: hasParamExpansion(mod, stmt),
		hasActiveExpansion: hasTestClauseExpansion(mod, test),
		complete: true,
		cause: null,
		start: span.start,
		end: span.end,
	};
}

/**
 * Conservative `[[ ... ]]` scan: any expansion node (parameter, command,
 * arithmetic, process) or unquoted glob/tilde metacharacter in a Lit part
 * flags the call. False positives merely prompt (the safe direction); the
 * test clause keeps its source-spelling subject, so per-word kinds do not
 * apply here.
 */
function hasTestClauseExpansion(mod: ShellAstModule, test: TestClause): boolean {
	let expansion = false;
	const visitor: Visitor = {
		ParamExp: () => { expansion = true; },
		CmdSubst: () => { expansion = true; },
		ArithmExp: () => { expansion = true; },
		ProcSubst: () => { expansion = true; },
		Lit: (part) => {
			for (let i = 0; i < part.value.length; i++) {
				if (part.value[i] === "\\") { i++; continue; }
				if ("*?[{~".includes(part.value[i])) { expansion = true; return; }
			}
		},
	};
	mod.walk(test, visitor);
	return expansion;
}

/** Literal decoding is quote-context aware; the package's wordToLit retains escapes. */
function literalRuleValue(slice: ByteSlicer, parts: readonly WordPart[], doubleQuoted = false): string {
	return parts.map((part): string => {
		switch (part.type) {
			case "Lit": return doubleQuoted
				? part.value.replace(/\\([$`"\\\n])/g, "$1")
				: part.value.replace(/\\([\s\S])/g, "$1");
			case "SglQuoted": return part.value;
			case "DblQuoted": return literalRuleValue(slice, part.parts, true);
			// These are literal for this rule contract, not runtime shell expansions.
			case "ExtGlob": case "BraceExp": return slice(part.pos.offset, part.end.offset);
			default: return slice(part.pos.offset, part.end.offset);
		}
	}).join("");
}

function projectRuleWord(mod: ShellAstModule, slice: ByteSlicer, word: Word, previous = false, assignment = false): ShellRuleWord {
	const source = slice(word.pos.offset, word.end.offset);
	const span = { start: word.pos.offset, end: word.end.offset };
	let dynamic = false;
	let preserveSource = false;
	const visitor: Visitor = {
		SglQuoted: (part) => { if (part.dollar) preserveSource = true; },
		DblQuoted: (part) => { if (part.dollar) preserveSource = true; },
		ParamExp: () => { dynamic = true; },
		CmdSubst: () => { dynamic = true; },
		ArithmExp: () => { dynamic = true; },
		ProcSubst: () => { dynamic = true; },
		BraceExp: (node) => { for (const elem of node.elems) mod.walk(elem, visitor); },
	};
	mod.walk(word, visitor);
	// The parser represents unquoted glob, tilde and many brace patterns as
	// Lit nodes. Examine only top-level parts: quoted/escaped metacharacters
	// are literals. Conservative detection may also encode inert syntax.
	if (!previous && word.parts.some((part, index) => (!assignment && (part.type === "ExtGlob" || part.type === "BraceExp")) ||
		(part.type === "Lit" && hasUnquotedExpansionSyntax(part.value, index === 0, assignment)))) return { kind: "expanding", source, span };
	return dynamic ? { kind: "dynamic", source, span }
		: preserveSource ? { kind: "source", source, span }
		: { kind: "literal", value: literalRuleValue(slice, word.parts), source, span };
}

function hasUnquotedExpansionSyntax(value: string, firstPart: boolean, assignment: boolean): boolean {
	for (let i = 0; i < value.length; i++) {
		if (value[i] === "\\") { i++; continue; }
		if ((!assignment && "*?[{".includes(value[i])) || (value[i] === "~" && (assignment || (firstPart && i === 0)))) return true;
	}
	return false;
}

function projectAssignment(mod: ShellAstModule, slice: ByteSlicer, assignment: Assign, previous = false): ShellAssignmentSubject | null {
	if (assignment.name === null || assignment.array !== null || assignment.index !== null) return null;
	const span = { start: assignment.pos.offset, end: assignment.end.offset };
	return {
		name: assignment.name.value,
		append: assignment.append,
		value: assignment.value === null
			? { kind: "literal", value: "", source: "", span: { start: span.end, end: span.end } }
			: projectRuleWord(mod, slice, assignment.value, previous, true),
		span,
	};
}

function projectRedirect(mod: ShellAstModule, slice: ByteSlicer, redirect: Redirect, previous = false): ShellRedirectSubject {
	return {
		descriptor: redirect.n?.value ?? null,
		op: redirect.op,
		target: projectRuleWord(mod, slice, redirect.word, previous),
		span: { start: redirect.pos.offset, end: redirect.end.offset },
	};
}

/** Project a statement's redirects to op + statically resolved target. */
function redirectsOf(mod: ShellAstModule, slice: ByteSlicer, stmt: Stmt): ShellRedirect[] {
	return stmt.redirs.map((r) => ({
		op: r.op,
		target: projectRuleWord(mod, slice, r.word).kind === "expanding" ? null : mod.wordToLit(r.word),
	}));
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
		// `command -v X` / `command -V X` are plain introspection queries, NOT
		// wrappers: unwrapping `command` to `X` would judge the queried name as
		// if it ran. Leave the whole argv so the tier sees `command` (which is
		// deliberately not read-only) and prompts.
		if (root === "command" && commandQueryFlags(current.slice(1))) return current;
		current = current.slice(1);
		while (current.length > 0 && current[0].startsWith("-")) current = current.slice(1);
	}
	return current;
}

/**
 * True when a `command` invocation carries a `-v`/`-V` (possibly clustered)
 * flag: `command -v X`, `command -V X`, `command -pv X`. Such a call queries a
 * name instead of executing it. Flags stop at the first non-flag token or `--`.
 */
function commandQueryFlags(args: readonly string[]): boolean {
	for (const tok of args) {
		if (tok === "--" || !tok.startsWith("-") || tok.length < 2) break;
		if (/[vV]/.test(tok.slice(1))) return true;
	}
	return false;
}

function hasParamExpansion(mod: ShellAstModule, node: ShellNode): boolean {
	let found = false;
	// A `$`-expansion is a ParamExp, an arithmetic expansion `$((...))`, or a
	// nested one under either. The package's walk treats ArithmExp and BraceExp
	// as leaves, so recurse into those explicitly; otherwise `$((...))` and
	// `{a,$X}` would report no expansion and defeat the host `$` veto.
	const visitor: Visitor = {
		ParamExp: () => { found = true; },
		ArithmExp: () => { found = true; },
		BraceExp: (n) => { for (const e of n.elems) mod.walk(e, visitor); },
	};
	mod.walk(node, visitor);
	return found;
}
