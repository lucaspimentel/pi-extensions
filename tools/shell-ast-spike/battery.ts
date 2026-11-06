/**
 * Reconstructed correctness battery.
 *
 * The 2026-10-20 battery was never written down and its scratch directory is
 * gone, so this rebuilds it from the claims recorded in TODO.md:
 *
 *   1. the typed-node matrix (names corrected to this package's real type
 *      union: IfClause/WhileClause/ForClause/CaseClause, not If/While/For/Case)
 *   2. the five recorded host-tier false-allow constructions, each checked for
 *      the nested executing call the old heuristics missed, alongside what
 *      guard decides for it TODAY (the 2026-10-21 fix should have closed all
 *      five, so this either confirms or refutes that)
 *   3. a fresh malformed-input set (the original six inputs are not enumerated
 *      anywhere), plus one over-cap input for the size-limit kind
 *
 * Synthetic inputs only: unlike the harvested corpus, this file MAY print its
 * own case strings, and does.
 *
 * Usage: node battery.ts --out out/battery.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse, findAll, resolvedCmd, unwrapDeepParsed, wordToLit, ParseSyntaxError, ParseSizeError, ShellAstError } from "@questi0nm4rk/shell-ast";
import { explainHostShellCommand, type PolicyState } from "../../extensions/guard/policy/decision.ts";
import { mergeConfig } from "../../extensions/guard/policy/config.ts";

function argValue(name: string, fallback?: string): string | undefined {
	const argv = process.argv.slice(2);
	const i = argv.indexOf(name);
	if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
	return fallback;
}

/** Every `type` string observed anywhere in the tree. */
function collectTypes(node: unknown, into: Set<string>): void {
	if (Array.isArray(node)) {
		for (const item of node) collectTypes(item, into);
		return;
	}
	if (typeof node !== "object" || node === null) return;
	const obj = node as Record<string, unknown>;
	if (typeof obj.type === "string") into.add(obj.type);
	for (const value of Object.values(obj)) collectTypes(value, into);
}

/**
 * Wrappers that invoke another command but are NOT in the package's unwrapper
 * registry (verified: `command touch probe` and `xargs rm` both unwrap to
 * `kind: "plain"`). Guard has to walk these by hand; the registry subpath is
 * not importable (`exports` allows only "." and "./semantic"), so the
 * recognized list cannot be enumerated from the public surface.
 */
const MANUAL_WRAPPERS = new Set(["command", "xargs", "builtin", "nocache"]);

interface Reach {
	name: string;
	mechanism: "direct-ast" | "unwrapper" | "unwrapper-script" | "manual-arg-walk";
}

/**
 * Every command name reachable from the tree, with the mechanism that reached
 * it: direct CallExprs, the unwrapped layers of every call (this is what
 * catches `command touch probe`, a wrapper rather than a nested CallExpr), the
 * inner AST of a `bash -c "..."` layer, and a manual arg walk for wrappers the
 * registry does not know.
 */
async function reachableCommands(ast: any): Promise<Reach[]> {
	const found: Reach[] = [];
	const add = (name: string | null | undefined, mechanism: Reach["mechanism"]): void => {
		if (typeof name === "string" && name !== "") found.push({ name, mechanism });
	};
	for (const call of findAll(ast, "CallExpr")) {
		add(resolvedCmd(call), "direct-ast");
		for (const layer of await unwrapDeepParsed(call)) {
			if (layer.kind === "wrapped-script") {
				if (layer.innerAst !== undefined) {
					for (const inner of findAll(layer.innerAst, "CallExpr")) add(resolvedCmd(inner), "unwrapper-script");
				}
				continue;
			}
			if (layer.kind === "wrapped") {
				add(layer.cmd, "unwrapper");
				continue;
			}
			// plain: the package sees this word as the command. When it is a
			// wrapper the registry does not know, the inner command is a plain
			// argument and only a hand walk finds it.
			if (MANUAL_WRAPPERS.has(layer.cmd)) {
				const literals = call.args.map((w: any) => wordToLit(w)).filter((v: any) => typeof v === "string") as string[];
				add(literals[1], "manual-arg-walk");
			}
		}
	}
	return found;
}

const MATRIX: { name: string; src: string; types: string[] }[] = [
	{ name: "CallExpr", src: "ls -la", types: ["CallExpr"] },
	{ name: "BinaryCmd", src: "echo a && echo b", types: ["BinaryCmd"] },
	{ name: "IfClause", src: "if [ -f a ]; then cat a; fi", types: ["IfClause"] },
	{ name: "WhileClause", src: "while read l; do echo $l; done", types: ["WhileClause"] },
	{ name: "ForClause", src: "for x in 1 2; do echo $x; done", types: ["ForClause"] },
	{ name: "CaseClause", src: "case $x in a) echo a;; esac", types: ["CaseClause"] },
	{ name: "FuncDecl", src: "f() { echo hi; }; f", types: ["FuncDecl"] },
	{ name: "DeclClause", src: "export A=b", types: ["DeclClause"] },
	{ name: "Redirect", src: "cat > out.txt", types: ["Redirect"] },
	{ name: "CmdSubst", src: "echo $(date)", types: ["CmdSubst"] },
	{ name: "ProcSubst", src: "echo <(date)", types: ["ProcSubst"] },
	{ name: "Block", src: "{ echo a; }", types: ["Block"] },
	{ name: "Subshell", src: "( echo a )", types: ["Subshell"] },
];

/** The five constructions that were false-allowed on the host tier before 2026-10-21. */
const FALSE_ALLOWS = [
	"echo `touch probe`",
	"echo <(touch probe)",
	"printf x & touch probe",
	"command touch probe",
	"for x in $(touch probe); do echo ok; done",
];

const MALFORMED = [
	"echo 'unterminated",
	"echo $(unclosed",
	"( echo",
	"cat <<EOF",
	"echo a &&",
	"echo `x",
];

async function main(): Promise<void> {
	const outPath = resolve(argValue("--out", "out/battery.json")!);
	const policy: PolicyState = {
		profile: "default",
		config: mergeConfig({}, {}, process.cwd()),
		sandboxMode: "full",
		cwd: process.cwd(),
		workspaceLocked: false,
		interactive: true,
	};

	const vocabulary = new Set<string>();
	const cases: any[] = [];
	let matrixFailures = 0;

	for (const testCase of MATRIX) {
		let ok = false;
		let missing: string[] = [];
		let error: string | null = null;
		try {
			const ast = await parse(testCase.src);
			collectTypes(ast, vocabulary);
			missing = testCase.types.filter((t) => findAll(ast, t as never).length === 0);
			ok = missing.length === 0;
		} catch (err) {
			error = `${(err as Error).constructor?.name}: ${(err as Error).message}`;
		}
		if (!ok) matrixFailures += 1;
		cases.push({ name: testCase.name, src: testCase.src, expected: testCase.types, missing, ok, error });
	}

	const falseAllows: any[] = [];
	let falseAllowFailures = 0;
	for (const src of FALSE_ALLOWS) {
		const ast = await parse(src);
		collectTypes(ast, vocabulary);
		const reach = await reachableCommands(ast);
		const touch = reach.filter((r) => r.name === "touch");
		const directCalls = touch.filter((r) => r.mechanism === "direct-ast");
		const guard = explainHostShellCommand({ kind: "host-shell", shell: "host-bash", command: src }, policy);
		const ok = touch.length > 0;
		if (!ok) falseAllowFailures += 1;
		falseAllows.push({
			src,
			directTouchCalls: directCalls.length,
			unwrappedTouchCalls: touch.length - directCalls.length,
			mechanisms: [...new Set(touch.map((r) => r.mechanism))],
			needsManualArgWalk: touch.some((r) => r.mechanism === "manual-arg-walk"),
			ok,
			guardDecision: guard.decision.action,
			guardReason: guard.decision.reason,
		});
	}

	const malformed: any[] = [];
	let malformedFailures = 0;
	for (const src of MALFORMED) {
		try {
			await parse(src);
			malformedFailures += 1;
			malformed.push({ src, threw: false, errorName: null, kind: null, ok: false });
		} catch (err) {
			const name = (err as Error).constructor?.name ?? "unknown";
			const kind = (err as { kind?: string }).kind ?? null;
			const isShellAstError = err instanceof ShellAstError;
			const syntax = err instanceof ParseSyntaxError;
			if (!syntax) malformedFailures += 1;
			malformed.push({ src, threw: true, errorName: name, kind, isShellAstError, ok: syntax });
		}
	}

	// Size-limit kind: 1 byte over the documented 1 MB default cap.
	let sizeLimit: any;
	try {
		await parse("echo " + "a".repeat(1_000_000));
		sizeLimit = { ok: false, note: "no error for an over-cap input" };
	} catch (err) {
		sizeLimit = {
			ok: err instanceof ParseSizeError,
			errorName: (err as Error).constructor?.name ?? "unknown",
			kind: (err as { kind?: string }).kind ?? null,
			bytes: (err as { bytes?: number }).bytes ?? null,
			limit: (err as { limit?: number }).limit ?? null,
		};
	}

	const result = {
		meta: { generatedAt: new Date().toISOString(), nodeVersion: process.version, guardPolicy: "default profile, empty config" },
		cases,
		falseAllows,
		malformed,
		sizeLimit,
		vocabulary: [...vocabulary].sort(),
		summary: {
			matrixPass: MATRIX.length - matrixFailures,
			matrixTotal: MATRIX.length,
			falseAllowPass: FALSE_ALLOWS.length - falseAllowFailures,
			falseAllowTotal: FALSE_ALLOWS.length,
			malformedPass: MALFORMED.length - malformedFailures,
			malformedTotal: MALFORMED.length,
		},
	};

	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, JSON.stringify(result, null, "\t") + "\n", "utf8");

	console.log(`battery: matrix ${result.summary.matrixPass}/${result.summary.matrixTotal}, false-allows surfaced ${result.summary.falseAllowPass}/${result.summary.falseAllowTotal}, malformed ${result.summary.malformedPass}/${result.summary.malformedTotal}`);
	for (const c of cases) if (!c.ok) console.log(`  FAIL ${c.name}: missing ${c.missing.join(",")} error=${c.error}`);
	for (const f of falseAllows) console.log(`  ${f.src} -> direct=${f.directTouchCalls} unwrapped=${f.unwrappedTouchCalls} via=${f.mechanisms.join("+")}${f.needsManualArgWalk ? " [needs manual arg walk]" : ""}; guard today: ${f.guardDecision}`);
	console.log(`  type vocabulary (${result.vocabulary.length}): ${result.vocabulary.join(", ")}`);
	console.log(`  size-limit kind: ${JSON.stringify(sizeLimit)}`);
	console.log(`  wrote ${outPath}`);
	if (matrixFailures > 0 || falseAllowFailures > 0 || malformedFailures > 0 || !sizeLimit.ok) process.exitCode = 1;
}

await main();
