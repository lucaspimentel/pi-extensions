/**
 * Comparator for the shell-ast decision diff.
 *
 * Joins the old-side and new-side JSONL row-for-row (both runners iterate the
 * same corpus order, configs [user, empty], and profiles ALL_PROFILES, so the
 * files are line-aligned; keys are asserted at every step), classifies each
 * cell as unchanged or a transition, attributes each change to a mechanism
 * group, checks internal consistency, and writes the human summary plus the
 * machine-readable transition and fixture-candidate artifacts.
 *
 * Only reads the two side files and the (gitignored) corpus. No guard import,
 * so this stays outside both decision trees.
 *
 * Usage:
 *   node compare.mts [--corpus PATH] [--out DIR]
 */
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { argValue, hashId, readCorpus, writeJson, writeText } from "./lib.mjs";
import { isNewIncomplete, isOldIncomplete, isRule, isTier, isCell } from "./reason-class.mjs";
import { SHAPE_LABELS, SYNTHETIC } from "./shapes.mjs";

const argv = process.argv.slice(2);
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const corpusPath = resolve(argValue(argv, "--corpus", resolve(repoRoot, "tools/shell-ast-spike/corpus/commands.jsonl"))!);
const outDir = resolve(argValue(argv, "--out", resolve(repoRoot, "tools/shell-ast-spike/out/diff"))!);
mkdirSync(outDir, { recursive: true });

const ACTIONS = ["allow", "prompt", "deny", "classify"];
const PROFILES = ["research", "default", "allow-edits", "auto", "trusted", "yolo", "unrestricted"];
const CONFIGS = ["user", "empty"];

// ---------------------------------------------------------------- corpus ----
const CORPUS = readCorpus(corpusPath);
const newManifest = JSON.parse(readFileSync(resolve(outDir, "new-manifest.json"), "utf8"));
const oldManifest = JSON.parse(readFileSync(resolve(outDir, "old-manifest.json"), "utf8"));
const evaluatedReal = newManifest.realRows;
const manifestErrors: string[] = [];
if (JSON.stringify(newManifest.profiles) !== JSON.stringify(oldManifest.profiles)) manifestErrors.push(`profile lists differ: ${JSON.stringify(newManifest.profiles)} vs ${JSON.stringify(oldManifest.profiles)}`);
if (JSON.stringify(newManifest.configs) !== JSON.stringify(oldManifest.configs)) manifestErrors.push(`config lists differ: ${JSON.stringify(newManifest.configs)} vs ${JSON.stringify(oldManifest.configs)}`);
if (newManifest.corpusTotal !== oldManifest.corpusTotal) manifestErrors.push(`corpusTotal differs: ${newManifest.corpusTotal} vs ${oldManifest.corpusTotal}`);
const corpus = CORPUS;
const commandById = new Map<string, { command: string; tool: string }>();
const idMismatches: string[] = [];
for (const row of corpus) {
	if (hashId(row.command) !== row.id && !idMismatches.includes(row.id)) idMismatches.push(row.id);
	commandById.set(row.id, { command: row.command, tool: row.tool });
}
const synthetic = SYNTHETIC.map((command) => ({ id: hashId(command), tool: "synthetic", command }));
for (const row of synthetic) commandById.set(row.id, { command: row.command, tool: "synthetic" });
const realIds = new Set(corpus.map((r) => r.id));
const synthIds = new Set(synthetic.map((r) => r.id));
for (const s of SYNTHETIC) if (!SHAPE_LABELS.has(s)) throw new Error(`synthetic without shape label: ${s}`);

// ------------------------------------------------------------- side rows ----
function zipLines(pathA: string, pathB: string): AsyncGenerator<[string, string]> {
	const ia = createInterface({ input: createReadStream(pathA, { encoding: "utf8" }), crlfDelay: Infinity });
	const ib = createInterface({ input: createReadStream(pathB, { encoding: "utf8" }), crlfDelay: Infinity });
	return (async function* () {
		const a = ia[Symbol.asyncIterator]();
		const b = ib[Symbol.asyncIterator]();
		for (;;) {
			const na = await a.next();
			const nb = await b.next();
			if (na.done || nb.done) {
				if (na.done !== nb.done) throw new Error(`side files differ in length: ${pathA} vs ${pathB}`);
				break;
			}
			if (na.value.trim() === "" && nb.value.trim() === "") continue;
			yield [na.value, nb.value];
		}
	})();
}

function attributeGroup(rO: Row, rN: Row): { group: string; subkind: string } {
	const ro = rO.rc;
	const rn = rN.rc;
	if (isNewIncomplete(rn) || isOldIncomplete(ro)) {
		const sub = isNewIncomplete(rn) && isOldIncomplete(ro) ? "both" : isNewIncomplete(rn) ? "new-incomplete" : "old-incomplete";
		return { group: "incompleteness", subkind: sub };
	}
	if (isRule(ro) || isRule(rn)) {
		const sub = isRule(ro) && isRule(rn) ? "rule-changed" : isRule(ro) ? "rule-matched-before-not-now" : "rule-matches-now-not-before";
		return { group: "rule-matching", subkind: sub };
	}
	if (isTier(ro) || isTier(rn)) {
		const sub = isTier(ro) && isTier(rn) ? "tier-changed" : isTier(ro) ? "tier-before-not-now" : "tier-now-not-before";
		return { group: "read-only-tier", subkind: sub };
	}
	if (isCell(ro) || isCell(rn)) return { group: "profile-cell", subkind: "cell" };
	if (ro.startsWith("pwsh.") || rn.startsWith("pwsh.")) return { group: "pwsh", subkind: "pwsh" };
	return { group: "other", subkind: `${ro}->${rn}` };
}

interface Row {
	a: string;
	rc: string;
	c: string | null;
	ext?: boolean;
}

function transitionType(o: Row, n: Row): string {
	if (o.a === n.a) return o.rc === n.rc ? "unchanged" : "same-action-reason-change";
	return `${o.a}->${n.a}`;
}

function isInvolvesRule(rO: Row, rN: Row): boolean {
	return isRule(rO.rc) || isRule(rN.rc);
}

// Aggregates.
const matrix = new Map<string, number>(); // `${cfg}\0${p}\0${oldA}->${newA}` -> count (incl unchanged)
const groupCounts = new Map<string, number>();
const groupByConfig = new Map<string, number>();
const groupActionChanging = new Map<string, number>();
const groupDistinctCommands = new Map<string, Set<string>>();
const groupTransitionTypes = new Map<string, Map<string, number>>();
const cmdRollup = new Map<string, { groups: Set<string>; types: Set<string>; cells: any[] }>();
let changedCells = 0;
let totalRealCells = 0;
let totalSynthCells = 0;
let reasonOnlyChanges = 0;
const consistencyErrors: string[] = [];

function bump(map: Map<string, number>, key: string, by = 1): void {
	map.set(key, (map.get(key) ?? 0) + by);
}

const changesOut: string[] = [];
let lineIndex = 0;
let keys = 0;

function handle(o: Row, n: Row, h: string, cfg: string, p: string): void {
	lineIndex += 1;
	const type = transitionType(o, n);
	// The transition matrix is keyed by ACTION pair, so unchanged cells sit on
	// the diagonal (including same-action reason-only changes).
	bump(matrix, `${cfg}\0${p}\0${o.a}->${n.a}`);
	if (o.ext || n.ext) totalSynthCells += 1;
	else totalRealCells += 1;
	if (type === "unchanged") return;
	changedCells += 1;
	const { group, subkind } = attributeGroup(o, n);
	bump(groupCounts, group);
	bump(groupByConfig, `${group}\0${cfg}`);
	if (o.a !== n.a) bump(groupActionChanging, group);
	else reasonOnlyChanges += 1;
	let gc = groupTransitionTypes.get(group);
	if (gc === undefined) { gc = new Map(); groupTransitionTypes.set(group, gc); }
	bump(gc, type);
	let sd = groupDistinctCommands.get(group);
	if (sd === undefined) { sd = new Set(); groupDistinctCommands.set(group, sd); }
	sd.add(h);
	let roll = cmdRollup.get(h);
	if (roll === undefined) { roll = { groups: new Set(), types: new Set(), cells: [] }; cmdRollup.set(h, roll); }
	roll.groups.add(group);
	roll.types.add(type);
	if (roll.cells.length < 32) roll.cells.push({ cfg, p, oa: o.a, orc: o.rc, oc: o.c, na: n.a, nrc: n.rc, nc: n.c, group, subkind, type });
	const meta = commandById.get(h);
	changesOut.push(JSON.stringify({
		h,
		command: meta?.command ?? "(unknown)",
		tool: meta?.tool ?? "unknown",
		ext: o.ext === true,
		cfg,
		p,
		oldAction: o.a, oldReasonClass: o.rc, oldCause: o.c,
		newAction: n.a, newReasonClass: n.rc, newCause: n.c,
		type,
		group,
		subkind,
	}));
}

await (async () => {
	for await (const [oldLine, newLine] of zipLines(resolve(outDir, "old.jsonl"), resolve(outDir, "new.jsonl"))) {
		keys += 1;
		let o: Row, n: Row;
		try {
			o = JSON.parse(oldLine);
			n = JSON.parse(newLine);
		} catch (err) {
			consistencyErrors.push(`line ${keys}: JSON parse failed: ${(err as Error).message}`);
			continue;
		}
		if (o.h !== n.h || o.cfg !== n.cfg || o.p !== n.p) {
			consistencyErrors.push(`line ${keys}: key mismatch old=${o.h}/${o.cfg}/${o.p} new=${n.h}/${n.cfg}/${n.p}`);
			continue;
		}
		if (!PROFILES.includes(o.p) || !CONFIGS.includes(o.cfg)) {
			consistencyErrors.push(`line ${keys}: unexpected cfg/profile ${o.cfg}/${o.p}`);
			continue;
		}
		handle(o, n, o.h, o.cfg, o.p);
	}
})();

writeFileSync(resolve(outDir, "changes.jsonl"), changesOut.length > 0 ? changesOut.join("\n") + "\n" : "", "utf8");

// ---------------------------------------------------------------- checks ----
const uniqueKeys = new Set<string>();
let dupCount = 0;
for (const line of changesOut) {
	const c = JSON.parse(line);
	const k = `${c.h}\0${c.cfg}\0${c.p}`;
	if (uniqueKeys.has(k)) dupCount += 1;
	uniqueKeys.add(k);
}
const expectedPerSide = (evaluatedReal + synthetic.length) * PROFILES.length * CONFIGS.length;
const expectedReal = evaluatedReal * PROFILES.length * CONFIGS.length;
const expectedSynth = synthetic.length * PROFILES.length * CONFIGS.length;
if (keys !== expectedPerSide) consistencyErrors.push(`paired lines ${keys} != expected ${expectedPerSide}`);
if (totalRealCells !== expectedReal) consistencyErrors.push(`real cells ${totalRealCells} != expected ${expectedReal}`);
if (totalSynthCells !== expectedSynth) consistencyErrors.push(`synthetic cells ${totalSynthCells} != expected ${expectedSynth}`);

// -------------------------------------------------------- requirement 2/4 ----
// allow->prompt not explained by incompleteness.
const allowPromptNotInc: any[] = [];
const allowPromptByGroup = new Map<string, number>();
let allowPromptRuleUser = 0;
let allowPromptRuleAnyCfg = 0;
const allowedNowDenied: any[] = [];
const denyToPromptOrAllow: any[] = [];
for (const line of changesOut) {
	const c = JSON.parse(line);
	if (c.oldAction === "allow" && c.newAction === "prompt" && c.group !== "incompleteness") {
		allowPromptNotInc.push(c);
		bump(allowPromptByGroup, c.group);
		if (isRule(c.oldReasonClass) || isRule(c.newReasonClass)) {
			allowPromptRuleAnyCfg += 1;
			if (c.cfg === "user") allowPromptRuleUser += 1;
		}
	}
	if (c.oldAction === "allow" && c.newAction === "deny") allowedNowDenied.push(c);
	if (c.oldAction === "deny" && (c.newAction === "prompt" || c.newAction === "allow")) denyToPromptOrAllow.push(c);
}

// ------------------------------------------------------------------ meta ----
function readJsonlSync(path: string): any[] {
	const text = readFileSync(path, "utf8");
	const out: any[] = [];
	for (const line of text.split("\n")) if (line.trim() !== "") out.push(JSON.parse(line));
	return out;
}
const newMeta = readJsonlSync(resolve(outDir, "new-meta.jsonl"));
const metaById = new Map(newMeta.map((m) => [m.h, m]));

// ---- notable differences (the ones a parity gate must surface) ----
const ruleMatchedNowPrompts: any[] = [];
const yoloAskLost: any[] = [];
const askGained: any[] = [];
const recoveries: any[] = [];
const yoloAskCause = new Map<string, number>();
for (const line of changesOut) {
	const c = JSON.parse(line);
	if (c.oldAction === "allow" && c.newAction === "prompt" && c.group === "incompleteness" && isRule(c.oldReasonClass)) ruleMatchedNowPrompts.push(c);
	if (c.group === "rule-matching" && c.oldReasonClass === "rule.ask" && c.newAction === "allow") {
		yoloAskLost.push(c);
		bump(yoloAskCause, metaById.get(c.h)?.cause ?? "unknown");
	}
	if (c.group === "rule-matching" && !isRule(c.oldReasonClass) && c.newReasonClass === "rule.ask") askGained.push(c);
	if ((c.oldAction === "prompt" || c.oldAction === "classify") && c.newAction === "allow") recoveries.push(c);
}
const ruleMatchedNowPromptCmds = new Set(ruleMatchedNowPrompts.map((c) => c.h));
const yoloAskLostCmds = new Set(yoloAskLost.map((c) => c.h));
const askGainedCmds = new Set(askGained.map((c) => c.h));
const recoveryCmds = new Set(recoveries.map((c) => c.h));

// Fixture candidates: one representative per known-hard shape.
const candidates: any[] = [];
const rejectionIds = newMeta.filter((m) => !m.ext && (m.cause === "parse-error" || m.cause === "size-cap")).map((m) => m.h);
const wrapperIds = newMeta.filter((m) => !m.ext && m.wrappers > 0).map((m) => m.h);
const ambiguousIds = [];
for (const line of changesOut) {
	const c = JSON.parse(line);
	if (c.oldReasonClass === "old-incomplete.ambiguous-split") ambiguousIds.push(c.h);
}
const redirectAllowIds = newMeta.filter((m) => !m.ext && m.redirectAware > 0).map((m) => m.h);

function candidate(shape: string, h: string, note: string, toAssert: any): void {
	const meta = commandById.get(h);
	candidates.push({ shape, h, command: meta?.command ?? "(unknown)", tool: meta?.tool ?? "unknown", toAssert, note });
}
// Every decision change is itself a candidate (represent the first cell per command).
for (const [h, roll] of cmdRollup) {
	const c = roll.cells[0];
	candidate("decision-change", h, `changed in ${roll.cells.length} sampled cell(s); groups=${[...roll.groups].join(",")}`, {
		action: c.na, reasonClass: c.nrc, cause: c.nc, cell: { cfg: c.cfg, profile: c.p },
	});
}
// One representative per known-hard corpus shape.
for (const h of rejectionIds.slice(0, 11)) candidate("parse-reject", h, "new parser rejects it (fail-closed)", { action: null, reasonClass: "new-incomplete.parse-error" });
for (const h of wrapperIds.slice(0, 6)) candidate("manual-wrapper", h, "invokes a wrapper the package does not unwrap (command/xargs/builtin/nocache)", {});
for (const h of [...new Set(ambiguousIds)].slice(0, 6)) candidate("ambiguous-compound", h, "old splitter called it ambiguous", {});
for (const h of [...new Set(redirectAllowIds)].slice(0, 6)) candidate("redirect-aware", h, "contains a top-level file redirect; only a redirect-aware allow rule can authorize it", {});
for (const s of SYNTHETIC) {
	const h = hashId(s);
	const meta = metaById.get(h);
	candidate("known-hard-shape", h, SHAPE_LABELS.get(s)!, { action: null, reasonClass: null, cause: meta?.cause ?? null });
}

// ------------------------------------------------------------- summary.md ----
function pct(n: number, d: number): string {
	return d === 0 ? "0.00%" : `${((n / d) * 100).toFixed(2)}%`;
}
function actionGrid(cfg: string, p: string): string {
	const rows: string[] = [];
	rows.push(`| old \\ new | ${ACTIONS.join(" | ")} |`);
	rows.push(`| --- | ${ACTIONS.map(() => "---").join(" | ")} |`);
	for (const oa of ACTIONS) {
		const cells = ACTIONS.map((na) => String(matrix.get(`${cfg}\0${p}\0${oa}->${na}`) ?? 0));
		rows.push(`| ${oa} | ${cells.join(" | ")} |`);
	}
	return rows.join("\n");
}

const lines: string[] = [];
lines.push("# shell-ast decision diff: old (HEAD) vs new (working tree)");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("## Scope and method");
lines.push("");
lines.push(`- Corpus: \`tools/shell-ast-spike/corpus/commands.jsonl\`, **${corpus.length}** real commands (${corpus.filter((r) => r.tool === "bash").length} harvested as \`bash\`, ${corpus.filter((r) => r.tool === "host_bash").length} as \`host_bash\`), plus **${synthetic.length}** synthetic known-hard inputs. Evaluated real rows this run: **${evaluatedReal}**${evaluatedReal === corpus.length ? " (full corpus)" : " (limited)"}.`);
lines.push(`- Mapping: every command is evaluated as a \`host-shell\`/\`host-bash\` call (the parser only affects that path; \`bash\` sandboxed-exec ignores the command text).`);
lines.push(`- Profiles: ${PROFILES.join(", ")} (\`ALL_PROFILES\` from guard).`);
lines.push(`- Configs: \`user\` (real \`~/.pi/agent/guard.json\` through guard's loader and \`mergeConfig\`, ${JSON.parse(readFileSync(resolve(outDir, "new-reason-samples.json"), "utf8")).configs.find((c: any) => c.name === "user")?.allow ?? "?"} allow rules) and \`empty\` (\`mergeConfig({}, {})\`, no hostBash rules).`);
lines.push(`- cwd: \`${JSON.parse(readFileSync(resolve(outDir, "new-reason-samples.json"), "utf8")).cwd}\`; sandboxMode \`full\`, workspaceLocked \`false\`, interactive \`true\`.`);
lines.push(`- Old side: HEAD \`${process.env.DIFF_HEAD ?? "(see old-run.done)"}\` extracted with \`git archive HEAD\`; new side: the working tree.`);
lines.push(`- "classify" cells are reported unresolved, as required.`);
lines.push("");
lines.push("## 1. Totals and internal consistency");
lines.push("");
lines.push(`- expected paired lines: ${expectedPerSide} = (${evaluatedReal} real + ${synthetic.length} synthetic) x ${PROFILES.length} profiles x ${CONFIGS.length} configs.`);
lines.push(`- paired lines read: **${keys}**; real cells **${totalRealCells}** (expected ${expectedReal}); synthetic cells **${totalSynthCells}** (expected ${expectedSynth}).`);
lines.push(`- manifest cross-checks: **${manifestErrors.length}**${manifestErrors.length ? " -> " + manifestErrors.join("; ") : ""}.`);
lines.push(`- duplicate (hash, config, profile) keys in changes: **${dupCount}**.`);
lines.push(`- corpus id != hashId mismatches: **${idMismatches.length}**.`);
lines.push(`- changed cells: **${changedCells}** (${pct(changedCells, keys)} of all cells); of those, action-changing **${changedCells - reasonOnlyChanges}**, same-action reason-class changes **${reasonOnlyChanges}**.`);
lines.push(`- consistency errors: **${consistencyErrors.length}**${consistencyErrors.length ? " -> " + consistencyErrors.slice(0, 10).join("; ") : ""}.`);
lines.push("");
lines.push("### Transition matrices per config and profile");
lines.push("");
for (const cfg of CONFIGS) {
	lines.push(`#### config \`${cfg}\``);
	lines.push("");
	for (const p of PROFILES) {
		lines.push(`**${p}**`);
		lines.push("");
		lines.push(actionGrid(cfg, p));
		lines.push("");
	}
}
lines.push("### Grand total transition matrix (all configs, all profiles)");
lines.push("");
lines.push(`| old \\ new | ${ACTIONS.join(" | ")} |`);
lines.push(`| --- | ${ACTIONS.map(() => "---").join(" | ")} |`);
for (const oa of ACTIONS) {
	const cells = ACTIONS.map((na) => {
		let sum = 0;
		for (const cfg of CONFIGS) for (const p of PROFILES) sum += matrix.get(`${cfg}\0${p}\0${oa}->${na}`) ?? 0;
		return String(sum);
	});
	lines.push(`| ${oa} | ${cells.join(" | ")} |`);
}
lines.push("");
lines.push("## 2. Changes grouped by mechanism");
lines.push("");
lines.push("Attribution algorithm (from old and new reason classes only):");
lines.push("");
lines.push("- **incompleteness** if the new reason class is a new AST cause (`new-incomplete.*`) or the old reason class is a shellsplit incompleteness class (`old-incomplete.*`). This is the accepted tightening plus the heuristic-to-AST replacement.");
lines.push("- **rule-matching** otherwise, if either side's reason class is a rule match (`rule.*`): a rule matched before and not now, or vice versa (canonical subject change).");
lines.push("- **read-only-tier** otherwise, if either side is a tier verdict (`tier.*`, or the redirect gate `redirect.required`).");
lines.push("- **profile-cell** otherwise, if either side is a profile cell (`cell.*`).");
lines.push("- **pwsh** otherwise, if either side is a pwsh class.");
lines.push("- **other** otherwise.");
lines.push("");
lines.push("| group | changed cells | action-changing | distinct commands | transition types |");
lines.push("| --- | --- | --- | --- | --- |");
for (const g of ["incompleteness", "rule-matching", "read-only-tier", "profile-cell", "pwsh", "other"]) {
	const n = groupCounts.get(g) ?? 0;
	if (n === 0) continue;
	const act = groupActionChanging.get(g) ?? 0;
	const distinct = groupDistinctCommands.get(g)?.size ?? 0;
	const types = [...(groupTransitionTypes.get(g) ?? new Map())].map(([t, c]) => `${t}:${c}`).join(", ");
	lines.push(`| ${g} | ${n} | ${act} | ${distinct} | ${types} |`);
}
lines.push("");
lines.push("Sub-attribution (rule/tier direction):");
lines.push("");
const subCounts = new Map<string, number>();
for (const line of changesOut) {
	const c = JSON.parse(line);
	if (c.group === "rule-matching" || c.group === "read-only-tier" || c.group === "incompleteness") bump(subCounts, `${c.group}:${c.subkind}`);
}
for (const [k, v] of [...subCounts].sort()) lines.push(`- \`${k}\`: ${v}`);
lines.push("");
lines.push("Per config:");
lines.push("");
for (const g of ["incompleteness", "rule-matching", "read-only-tier", "profile-cell", "pwsh", "other"]) {
	const u = groupByConfig.get(`${g}\0user`) ?? 0;
	const e = groupByConfig.get(`${g}\0empty`) ?? 0;
	if (u === 0 && e === 0) continue;
	lines.push(`- \`${g}\`: user ${u}, empty ${e}`);
}
lines.push("");
lines.push("## 3. Changed commands");
lines.push("");
lines.push(`Distinct changed commands: **${cmdRollup.size}**. One row per command with its cells (up to 32 sampled); full per-cell detail in \`changes.jsonl\`. Grouped by mechanism below with counts and representatives.`);
lines.push("");
const byGroupCommands = new Map<string, string[]>();
for (const [h, roll] of cmdRollup) {
	for (const g of roll.groups) {
		let arr = byGroupCommands.get(g);
		if (arr === undefined) { arr = []; byGroupCommands.set(g, arr); }
		arr.push(h);
	}
}
for (const g of ["incompleteness", "rule-matching", "read-only-tier", "profile-cell", "other"]) {
	const hashes = byGroupCommands.get(g) ?? [];
	if (hashes.length === 0) continue;
	lines.push(`### ${g} (${hashes.length} distinct commands)`);
	lines.push("");
	for (const h of hashes.slice(0, 40)) {
		const meta = commandById.get(h);
		const roll = cmdRollup.get(h)!;
		const reps = roll.cells.slice(0, 3).map((c) => `${c.cfg}/${c.p}: ${c.oa}(${c.orc}) -> ${c.na}(${c.nrc})`).join("; ");
		lines.push(`- \`${JSON.stringify(meta?.command ?? h)}\` [${meta?.tool ?? "?"}] ${reps}`);
	}
	if (hashes.length > 40) lines.push(`- ... and ${hashes.length - 40} more (see \`changes-by-group.json\`)`);
	lines.push("");
}
lines.push("## 4. Specific answers");
lines.push("");
lines.push(`- **allow -> prompt not explained by the incompleteness rule: ${allowPromptNotInc.length}** cell changes.`);
lines.push(`  - by group: ${[...allowPromptByGroup].map(([g, c]) => `${g}=${c}`).join(", ") || "none"}.`);
lines.push(`  - involving an allow/deny/ask rule match on either side: **${allowPromptRuleAnyCfg}**, of which under the user's real config: **${allowPromptRuleUser}**.`);
lines.push(`- **allow -> deny (a command allowed today that would now be denied): ${allowedNowDenied.length}**.`);
lines.push(`- **deny -> prompt or deny -> allow: ${denyToPromptOrAllow.length}** (${denyToPromptOrAllow.filter((c) => c.newAction === "prompt").length} -> prompt, ${denyToPromptOrAllow.filter((c) => c.newAction === "allow").length} -> allow).`);
lines.push("");
lines.push("### 4b. Notable differences needing review");
lines.push("");
lines.push(`- **rule matched before but now prompts (accepted tightening): ${ruleMatchedNowPrompts.length} cells / ${ruleMatchedNowPromptCmds.size} commands** (user config; an old allow-rule match is now overridden by the incompleteness prompt).`);
lines.push(`- **yolo ask-rule losses: ${yoloAskLost.length} cells / ${yoloAskLostCmds.size} commands.** Old matched an ask rule on a split fragment (prompt); the new whole-command analysis has no call list, so in yolo the command is allowed. This prompt->allow loosening is NOT one of the two pre-approved categories: it needs explicit review.`);
lines.push(`  - by new-analysis cause: ${[...yoloAskCause].map(([k, v]) => `${k}=${v}`).join(", ")}.`);
lines.push(`- **ask rule gained (tightening): ${askGained.length} cells / ${askGainedCmds.size} commands.**`);
lines.push(`- **recoveries (prompt/classify -> allow): ${recoveries.length} cells / ${recoveryCmds.size} commands** (loosening changes that need review/approval).`);
lines.push("");
lines.push("## 5. Fixture candidates");
lines.push("");
lines.push(`Written to \`tools/shell-ast-spike/out/diff/candidates.json\` (gitignored): **${candidates.length}** candidates.`);
lines.push(`- decision-change: ${candidates.filter((c) => c.shape === "decision-change").length}`);
lines.push(`- parse-reject: ${rejectionIds.length} found (first ${Math.min(11, rejectionIds.length)} emitted)`);
lines.push(`- manual-wrapper: ${wrapperIds.length} found (first ${Math.min(6, wrapperIds.length)} emitted)`);
lines.push(`- ambiguous-compound: ${[...new Set(ambiguousIds)].length} found (first ${Math.min(6, [...new Set(ambiguousIds)].length)} emitted)`);
lines.push(`- redirect-aware: ${redirectAllowIds.length} found (first ${Math.min(6, redirectAllowIds.length)} emitted)`);
lines.push(`- known-hard-shape: ${SYNTHETIC.length} (the five false-allows + malformed set)`);
lines.push("");
lines.push("## 6. Evaluation failures");
lines.push("");
lines.push(`- see \`new-reason-samples.json\` / \`old-reason-samples.json\` \`failures\` arrays.`);
lines.push(`- new failures: ${JSON.parse(readFileSync(resolve(outDir, "new-reason-samples.json"), "utf8")).failures.length}; old failures: ${JSON.parse(readFileSync(resolve(outDir, "old-reason-samples.json"), "utf8")).failures.length}.`);
lines.push("");
writeText(resolve(outDir, "summary.md"), lines.join("\n") + "\n");

// changes-by-group.json (distinct commands per group, raw text allowed here).
const byGroup: Record<string, any[]> = {};
for (const [h, roll] of cmdRollup) {
	const meta = commandById.get(h);
	for (const g of roll.groups) {
		(byGroup[g] ??= []).push({ h, command: meta?.command ?? null, tool: meta?.tool ?? null, cells: roll.cells, types: [...roll.types] });
	}
}
writeJson(resolve(outDir, "changes-by-group.json"), byGroup);

// Fill in the to-be-asserted cell for shape representatives that did not carry
// one (the decision-change rows already do).
const candHashes = new Set(candidates.map((c) => c.h));
const newCell = new Map<string, any>();
for (const line of readFileSync(resolve(outDir, "new.jsonl"), "utf8").split("\n")) {
	if (line.trim() === "") continue;
	const r = JSON.parse(line);
	if (!candHashes.has(r.h)) continue;
	if ((r.p === "default" || r.p === "trusted") && (r.cfg === "empty" || r.cfg === "user")) newCell.set(`${r.h}\0${r.cfg}\0${r.p}`, r);
}
for (const cand of candidates) {
	if (cand.shape === "decision-change" && cand.toAssert?.action) continue;
	const r = newCell.get(`${cand.h}\0empty\0default`) ?? newCell.get(`${cand.h}\0user\0default`) ?? newCell.get(`${cand.h}\0empty\0trusted`) ?? newCell.get(`${cand.h}\0user\0trusted`);
	cand.toAssert = { action: r?.a ?? null, reasonClass: r?.rc ?? null, cause: r?.c ?? (typeof r?.rc === "string" && r.rc.startsWith("new-incomplete.") ? r.rc.slice("new-incomplete.".length) : null), cell: r ? { cfg: r.cfg, profile: r.p } : null };
}
writeJson(resolve(outDir, "candidates.json"), candidates);

writeJson(resolve(outDir, "summary.json"), {
	generatedAt: new Date().toISOString(),
	corpus: { real: corpus.length, evaluatedReal, bash: corpus.filter((r) => r.tool === "bash").length, hostBash: corpus.filter((r) => r.tool === "host_bash").length, synthetic: synthetic.length },
	expectedPairedLines: expectedPerSide,
	pairedLines: keys,
	realCells: totalRealCells,
	syntheticCells: totalSynthCells,
	changedCells,
	actionChangingCells: changedCells - reasonOnlyChanges,
	reasonOnlyChanges,
	duplicateKeys: dupCount,
	consistencyErrors,
	groupTotals: Object.fromEntries(groupCounts),
	groupActionChanging: Object.fromEntries(groupActionChanging),
	groupDistinctCommands: Object.fromEntries([...groupDistinctCommands].map(([g, s]) => [g, s.size])),
	groupTransitionTypes: Object.fromEntries([...groupTransitionTypes].map(([g, m]) => [g, Object.fromEntries(m)])),
	allowPromptNotIncomplete: allowPromptNotInc.length,
	allowPromptNotIncompleteByGroup: Object.fromEntries(allowPromptByGroup),
	allowPromptRuleAnyCfg,
	allowPromptRuleUser,
	allowedNowDenied: allowedNowDenied.length,
	denyToPromptOrAllow: denyToPromptOrAllow.length,
	denyToPrompt: denyToPromptOrAllow.filter((c) => c.newAction === "prompt").length,
	denyToAllow: denyToPromptOrAllow.filter((c) => c.newAction === "allow").length,
	ruleMatchedNowPrompts: { cells: ruleMatchedNowPrompts.length, commands: ruleMatchedNowPromptCmds.size },
	yoloAskLost: { cells: yoloAskLost.length, commands: yoloAskLostCmds.size, byCause: Object.fromEntries(yoloAskCause) },
	askGained: { cells: askGained.length, commands: askGainedCmds.size },
	recoveries: { cells: recoveries.length, commands: recoveryCmds.size },
	candidates: candidates.length,
});
writeText(resolve(outDir, "compare.done"), `changed=${changedCells} errors=${consistencyErrors.length}\n`);
console.error(`[compare] ${keys} paired lines, ${changedCells} changed cells, ${consistencyErrors.length} consistency errors`);
console.error(`[compare] allow->prompt not-incompleteness=${allowPromptNotInc.length} (rule-involved user=${allowPromptRuleUser}), allow->deny=${allowedNowDenied.length}, deny->prompt/allow=${denyToPromptOrAllow.length}`);
console.error(`[compare] groups: ${[...groupCounts].map(([g, c]) => `${g}=${c}`).join(", ")}`);
