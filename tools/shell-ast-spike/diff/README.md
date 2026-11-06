# shell-ast decision diff harness

One-time, throwaway measurement: every guard decision cell (command × profile ×
config) compared between **HEAD** (old shellsplit-based guard) and the
**working tree** (new shell-ast adapter). This is a parity gate, not a test;
nothing here is registered in `test:ci`, nothing under `extensions/guard/**` is
touched, and all outputs are gitignored.

## Run

```sh
cd <repo root>
env -u PI_GUARD_INHERIT node tools/shell-ast-spike/diff/run-all.mts
```

The orchestrator:

1. extracts HEAD read-only with `git archive HEAD | tar -x` into a temp dir
   outside the repo (`--old DIR` reuses one instead);
2. runs `run-new.mts` (working tree) and `run-old.mts` (extracted HEAD) as
   separate node processes, so no process imports both guard trees;
3. runs `compare.mts`.

Options: `--limit N` (smoke), `--corpus PATH`, `--out DIR`, `--old DIR`.
Progress is printed to stderr. A full run is a few minutes; each side is ~350
commands/s and the comparator is ~2 minutes.

Individual stages (after an old tree exists):

```sh
env -u PI_GUARD_INHERIT node tools/shell-ast-spike/diff/run-new.mts
env -u PI_GUARD_INHERIT node tools/shell-ast-spike/diff/run-old.mts --old /tmp/shellast-diff-old
env -u PI_GUARD_INHERIT node tools/shell-ast-spike/diff/compare.mts
```

## Inputs and mapping

- Corpus: `tools/shell-ast-spike/corpus/commands.jsonl` (gitignored, from
  `harvest.ts`), plus 11 synthetic known-hard inputs in `shapes.mjs`.
- Every command is evaluated as a `host-shell` / `host-bash` call, because the
  bash parser only affects that path (`bash` sandboxed-exec ignores the command
  text). The corpus `tool` field (`bash` / `host_bash`) is carried through for
  reporting only.
- Profiles: `ALL_PROFILES` (research, default, allow-edits, auto, trusted,
  yolo, unrestricted).
- Configs: `user` = `mergeConfig(loadUserConfigRaw(home), {}, cwd)` (the real
  `~/.pi/agent/guard.json`, user scope only, so its 338 allow + 2 ask rules);
  `empty` = `mergeConfig({}, {}, cwd)`.
- Policy: `sandboxMode: "full"`, `workspaceLocked: false`, `interactive: true`,
  cwd = the repo root. `decide` is called sync; `"classify"` is left
  unresolved.
- New side calls `await analyzeHostCommand(command)` once per command and passes
  the analysis to `decide(policy, call, analysis)`. Old side calls the 2-argument
  `decide(policy, call)`.

## Outputs (`tools/shell-ast-spike/out/diff/`, gitignored)

| File | Contents |
| --- | --- |
| `new.jsonl`, `old.jsonl` | one row per (command hash, config, profile): action, reason class, cause |
| `new-meta.jsonl`, `old-meta.jsonl` | one row per command: analysis cause, call count, wrapper/redirect flags |
| `new-manifest.json`, `old-manifest.json` | corpus/profile/config counts used for the consistency checks |
| `new-reason-samples.json`, `old-reason-samples.json` | distinct raw reasons per reason class (for auditing) |
| `changes.jsonl` | every changed cell with old/new action+reason class+cause, transition type, mechanism group |
| `changes-by-group.json` | changed commands grouped by mechanism, with all cells |
| `candidates.json` | fixture candidates: every decision change plus one representative per known-hard shape |
| `summary.md` / `summary.json` | the human-readable report and its machine-readable twin |

Raw command text appears in `changes.jsonl`, `changes-by-group.json`,
`candidates.json`, and `summary.md`, all under the gitignored `out/`. It never
appears in source or a tracked file.

## Reason classes and grouping

`reason-class.mjs` maps each side's raw reason text into one vocabulary
(`rule.*`, `tier.*`, `cell.*`, `new-incomplete.*`, `old-incomplete.*`,
`redirect.required`, `state.*`, `pwsh.*`). `compare.mts` attributes each changed
cell, in priority order, to: incompleteness (either side is an incomplete
class), rule matching (either side is a `rule.*` match), read-only tier (either
side is `tier.*` or `redirect.required`), profile cell, pwsh, then other. See
`summary.md` for counts and the exact algorithm.
