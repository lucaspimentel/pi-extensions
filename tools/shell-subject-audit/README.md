# Canonical Bash subject migration audit

Restores the harvester/redaction helpers from `e4377ed` and adapts the separate
runner/comparison design from `edbff4a:tools/shell-ast-spike/diff/`. This tooling
is not an extension and is never loaded by pi. **Harvested commands are data:
only parse and policy APIs consume them. Never run corpus text in a shell.**

## Freeze and run

Run from the repository root. Choose a new ignored directory for each source
revision; outputs refuse overwrite. Do not put raw config, corpus or reports
in a tracked directory.

```sh
node tools/shell-subject-audit/freeze.mts \
  --out build/shell-subject-audit/run-001 --config <guard.json> \
  --baseline f47aefe
```

This resolves `--baseline` to a commit and freezes it (`git archive`); without
that option it defaults to HEAD. For the canonical-subject migration use the
pre-switch commit `f47aefe`, not the current HEAD. The candidate is the working
tree, including untracked source, and the config is copied explicitly.
It records the requested ref and resolved SHA and hashes both trees and the
config in `source-manifest.json`. The directory
must be inside ignored `build/`. Frozen trees resolve the installed dependencies
through their repository ancestor; the runtime runner hashes the shared WASM
and records both lockfiles. No user config is changed.

Run the frozen harvester and runner on the host whose semantics are measured.
For a Linux/WSL config and corpus, use **Linux Node**, a Linux home and the
original Linux policy cwd, not Windows paths. Git Bash callers of `wsl.exe`
need `MSYS_NO_PATHCONV=1` to prevent rewriting Linux arguments.

```sh
node <run>/candidate/tools/shell-subject-audit/harvest.ts \
  --sessions <sessions> --out <run>/inputs/commands.jsonl \
  --manifest <run>/inputs/harvest.json
node <run>/candidate/tools/shell-subject-audit/run.mts \
  --out <run> --cwd <linux-repo>
```

The harvester deduplicates exact `bash`/`host_bash` tool calls, reports malformed
transcript lines and hashes the source bytes it read. Nested calls inside
codemode are not reconstructed. The frozen corpus, not mutable source
transcripts, is the replay input. Duplicate/hash-mismatched command IDs fail.

For limited observed coverage, an explicitly approved supplementary run may add
labelled config-derived probes. Freeze a new source directory against the same
config snapshot, then run its `probes.mts --out <new-run> --corpus
<old-run>/inputs/commands.jsonl --harvest <old-run>/inputs/harvest.json` instead
of harvesting again. This copies the original corpus, adds `tool: "rule-probe"`
specimens for exact tilde/dollar/quoted forms, and removes only an optional
trailing ` *`. It never invents values for interior globs/regexes or executes
specimens. Origins retain raw config slot/index/text; observed and synthetic
counts/transitions are separate. A probe is NOT evidence of actual usage.

The runner verifies frozen hashes before and after evaluation. It measures all
profiles under user-only and empty config, using full sandbox mode, no lock,
interactive prompts and unresolved classifiers. Every corpus command is judged
as host-shell/host-bash; its original tool name is provenance only. Baseline and
candidate run in separate Node processes and import only their own policy tree.
No classifier, network or corpus-derived process is launched.

## Evidence and limitations

All artifacts below are **private and gitignored**:

- `measurement-manifest.json`: source/corpus/config/harvest/WASM hashes,
  baseline SHA, lockfile hashes, runtime, home and policy cwd. Its SHA identifies
  the measurement cited by any rule rewrite.
- `baseline.jsonl`, `candidate.jsonl`: aligned analysis, all decision cells and
  per-rule eligible matches. `*-complete.json` hashes each output.
- `*-rules.json`: resolved rule slots/zero-based indices/text, raw config source
  indices and config warnings. Duplicate raw rules retain all source indices.
- `rule-coverage.json`: per-rule old/new command counts and lost/gained command
  IDs, including shadowed rules and matches masked by tier authorization.
- `affected.jsonl`: each affected command, old/new subject spellings, decision
  transitions and rule coverage evidence. Never publish this file blindly.
- `summary.json`: text-free totals and consistency checks, safe to summarize
  after reviewing its counts. Absence of observations is not a compatibility
  guarantee: rules with no old/new hits are explicitly reported unexercised.

Coverage counts commands, not occurrences or profile cells. It measures the
rule's syntactically eligible match set independently of list priority and
profile/tier authorization: deny/ask see whole-command and reachable step
spellings; allow sees only complete per-step subjects and enforces redirect
awareness. Actual winning rule identities are recorded separately in cells.
Do not infer a broken allow rule is safe merely because the tier still allows.

Active-expansion eligibility: candidate analyses mark calls whose projected
words carry active shell expansion (kinds `expanding` and `dynamic`). Such
calls are excluded from allow-slot coverage candidacy, mirroring the
evaluator's ineligibility contract; frozen baselines without the flag keep
legacy candidacy so paired comparisons measure exactly the eligibility
change. Unquoted tilde is the one exempt expansion: it is projected as its own
`tilde` kind, stays allow-eligible, and renders as its unquoted source
spelling. `summary.json` reports `markerMatchingAllowRules`: the count of
distinct user-config allow rules whose pattern textually matches an
expansion-marker subject in any candidate row. These rules still compile and
still decide deny/ask, but can no longer authorize expansion-bearing
commands; they are the compatibility boundary of the marker encoding. The same
summary reports the differential eligibility counters
`tildeEligibilityGains` (steps that became allow-eligible and carry only tilde
chain words), `unexplainedEligibilityGains` (the alarm: anything else became
eligible) and `eligibilityLosses` (the tightening direction). Word kinds are
projected for chain arguments only, so assignment-value and redirect-target
tilde gains are counted in neither gain bucket.

Config rewrites are a separate, backed-up operation requiring reviewed
manifest/slot/index/text/command-ID/subject/transition evidence. Do not edit
user rules or regenerate curated fixtures just to hide unexplained differences.

Focused tests: `tests/guard-shell-subject-audit.test.mts`, registered in both
CI and guard scripts. Test-results snapshots under `build/canonical-validation-*`
are not migration evidence and must not be confused with this audit.
