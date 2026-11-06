# shell-ast spike

Measurement spike (not an extension, not shipped): is `@questi0nm4rk/shell-ast@0.8.0`
viable as a replacement for guard's hand-written bash parsing?

Subject: `extensions/guard/policy/shellsplit.ts` (the splitter) and the
tokenizer/heuristic paths of `extensions/guard/policy/bashtier.ts`, consumed by
`extensions/guard/policy/decision.ts`. Tracked as the "Replace guard's
hand-written shell parsing with a real Bash AST parser" item in the repo
`TODO.md`.

## Hard boundary

- No changes to `extensions/guard/**`. Guard's runtime behavior is unchanged.
- No root `package.json` / lockfile change, no new runtime dependency.
- No adapter module and no `policy/shellast.ts`. This spike measures only; the
  adapter is the downstream step.
- No `test:ci` registration.

## Layout

| File | Role |
| --- | --- |
| `harvest.ts` | Reads local session transcripts, dedupes bash/host_bash commands |
| `redact.ts` | Hash + text-free shape descriptors (the only command-string reader) |
| `counts.json` | Committed, text-free harvest totals |
| `corpus/commands.jsonl` | Raw commands, **local only** (gitignored) |
| `bench.ts` | Warm comparison: both baselines vs shell-ast, same corpus |
| `probe.ts` | Cold probe loaded into a fresh `pi -p` process |
| `cold.ts` | Three-arm cold runner (no import / import / import + first parse) |
| `battery.ts` | Reconstructed correctness battery |
| `fidelity.ts` | Whole-corpus pass: parser rejects, `bash -n` agreement, wrapper coverage |
| `report.ts` | Merges `out/*.json` into `results.md` / `results.json` |
| `run-all.sh` | The exact end-to-end run, detached-friendly |
| `results.md` / `results.json` | Committed numbers (text-free) + pending verdict |

## Run

```sh
npm install                                  # needs network
# everything below in one go (bench alone is tens of minutes):
setsid nohup bash run-all.sh < /dev/null > /dev/null 2>&1 &   # progress -> out/run.log

# or step by step
node harvest.ts                              # local transcripts -> corpus/ + counts.json
node bench.ts --limit 50                     # smoke
node bench.ts                                # full warm comparison (~20 min over 35k commands)
node cold.ts                                 # 30 fresh pi boots
node battery.ts
node fidelity.ts                             # whole-corpus rejects + wrapper coverage
node report.ts                               # writes results.md / results.json
```

## Methodology

- Corpus: every `bash`/`host_bash` command found in local pi session
  transcripts, deduped by exact string. All tiers. Bash calls nested inside
  `codemode` blocks are not harvested.
- Baselines, both labelled: **parser-only** (`splitTopLevelShell`) and
  **end-to-end** (`explainHostShellCommand`, exactly as guard calls it; note
  that the TODO's `hostTierAllowReason` is an internal, non-exported function).
- Warm: 3 warmup iterations, then 30 timed iterations per command, per arm.
  Reproduces p50/p95/p99 plus median and spread.
- Cold: three arms in fresh headless `pi -p` processes, measured as offsets
  from each process's own time origin, so pi's startup cancels. Arm 0 = no
  shell-ast import, arm 1 = imported but never parsed, arm 2 = first parse
  executed. Headline = arm2 - arm0; arm1 - arm0 isolates module cost from wasm
  compile. 10 boots per arm. Note: pi routes extension `console.log` output to
  **stderr** in `-p` mode (stdout carries the answer), so the runner searches
  both streams.
- Fidelity (`fidelity.ts`): unique commands the parser rejects, whether `bash -n`
  agrees those are malformed, and how often a command invokes a wrapper the
  package does not unwrap. These are counts of *commands*; `warm.json`'s
  `errors` map counts *timed iterations* (30 per failing command) and must not
  be read as a command count.
- RSS: steady (`process.memoryUsage().rss`) and peak
  (`process.resourceUsage().maxRSS`) per boot; only arm deltas are signal.
- Thresholds are deliberately **not** fixed here. The adopt / do-not-adopt bar
  is set by the reviewer after seeing the numbers.

## Findings (2026-11-06)

The numbers live in `results.md`, which also records the verdict: **ADOPT
`@questi0nm4rk/shell-ast@0.8.0`** (2026-11-06), scoped to the pinned version
only. Headline facts, all from the committed artifacts:

- Warm, over 34,969 real commands: shell-ast `parse` 0.2956 ms median of
  per-command medians, vs 0.4994 ms for today's end-to-end
  `explainHostShellCommand` path (0.59x) and 0.0022 ms for
  `splitTopLevelShell` alone (136x). The comparison is not uniform: the
  per-command ratio against today's path is p50 0.52, p95 6.18, max 92.5.
- Cold: the first guarded command pays 36.28 ms (1.37 ms module import +
  34.91 ms wasm compile and first parse), and steady RSS grows 17.91 MiB at
  that first parse. The arm split shows the wasm compiles on first parse, not at
  import.
- Coverage: 11/34,969 commands raise `ParseSyntaxError`, and `bash -n` rejects
  9 of those too, leaving 2 pure parser gaps. 274/34,969 commands use a wrapper
  the package does not unwrap (`command` 191, `xargs` 83); the registry is not
  reachable through the package `exports` map, so the adapter must walk those
  itself.
- Correctness: typed-node matrix 13/13 (against the real type names:
  `IfClause`/`WhileClause`/`ForClause`/`CaseClause`), 6/6 malformed inputs raise
  `ParseSyntaxError`, an over-cap input raises `ParseSizeError`, and all five
  recorded false-allow constructions are surfaced by the AST while guard already
  prompts on all five today.
- Package facts re-verified: `dependencies: {}`, 4,389,634 B unpacked with a
  4,228,590 B wasm, `engines: node>=18`, `parse()` genuinely async. The license
  discrepancy is real on both sides: npm metadata and the tarball say MIT, while
  upstream `LICENSE` at `main` (sha `8cfa1f1`) is the 374-line MPL-2.0 text.

Not measured here: the adapter's own cost and the retirement of `shellsplit.ts`
/ `bashtier.ts`. The adopt decision covers the pinned 0.8.0 only; it does not
authorize the adapter or a version bump.

## Out of scope

- The license: `0.8.0` (what this spike installed and pinned) is MIT in the
  registry metadata, the tarball `package.json`, and the MIT `LICENSE` file the
  tarball ships. The repo was relicensed to MPL-2.0 on 2026-10-12 (commit
  `f46a0044`) and `0.8.1-beta.0` (2026-10-14) is MPL-2.0 in those same three
  places, so any bump leaves MIT terms. That is a version split, not a metadata
  conflict, and it does not gate the performance verdict.
- The adapter and the retirement of `shellsplit.ts` / `bashtier.ts` (TODO
  adoption steps 3-7).
- Committed report content: hashes and shape counts only, never command text.
