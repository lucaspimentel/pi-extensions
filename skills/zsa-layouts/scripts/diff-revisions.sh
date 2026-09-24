#!/usr/bin/env bash
# Diff two revisions of a ZSA layout.
#
# Usage (each side may be a configure.zsa.io URL, "hash revision" pair, or a
# path/pipe to JSON saved from fetch-layout.sh):
#   diff-revisions.sh <url-or-json-a> [revision-a] <url-or-json-b> [revision-b]
#
# Simplest forms:
#   diff-revisions.sh https://.../layouts/HASH/REV_A/0 https://.../layouts/HASH/REV_B/0
#   diff-revisions.sh rev_a.json rev_b.json
#   fetch-layout.sh HASH REV_A | diff-revisions.sh - HASH REV_B
#
# Prints per-key changes, plus combos and config diffs. "identical" if no change.
set -euo pipefail

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

if [ $# -eq 0 ]; then
  usage
fi

# Two JSON files/pipes: diff-revisions.sh fileA.json fileB.json
if [ $# -eq 2 ] && { [ -f "$1" ] || [ "$1" = "-" ]; } && { [ -f "$2" ] || [ "$2" = "-" ]; }; then
  [ "$1" = "-" ] && [ "$2" = "-" ] && die "cannot read both sides from stdin"
  A=$(cat "$1")
  B=$(cat "$2")
# stdin + live fetch: diff-revisions.sh - <hash> <revision>
elif [ $# -eq 3 ] && [ "$1" = "-" ]; then
  SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  A=$(cat)
  B=$("$SCRIPT_DIR/fetch-layout.sh" "$2" "$3" 2>/dev/null)
# fetch two revisions live: diff-revisions.sh HASH REV_A REV_B
elif [ $# -eq 3 ] && [[ "$1" != -* ]] && [[ "$2" != -* ]] && [[ "$3" != -* ]]; then
  SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  A=$("$SCRIPT_DIR/fetch-layout.sh" "$1" "$2" 2>/dev/null)
  B=$("$SCRIPT_DIR/fetch-layout.sh" "$1" "$3" 2>/dev/null)
# two URLs: diff-revisions.sh urlA urlB
elif [ $# -eq 2 ] && [[ "$1" == https:* ]] && [[ "$2" == https:* ]]; then
  SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  A=$("$SCRIPT_DIR/fetch-layout.sh" "$1" 2>/dev/null)
  B=$("$SCRIPT_DIR/fetch-layout.sh" "$2" 2>/dev/null)
else
  usage
fi

python3 - "$A" "$B" <<'EOF'
import json
import sys

a_raw, b_raw = sys.argv[1], sys.argv[2]
a = json.loads(a_raw)["data"]["layout"]["revision"]
b = json.loads(b_raw)["data"]["layout"]["revision"]
print(f"a: revision {a['hashId']} ({a.get('createdAt', '?')})")
print(f"b: revision {b['hashId']} ({b.get('createdAt', '?')})")
print()


def norm(rev):
    out = {}
    for layer in rev["layers"]:
        for i, k in enumerate(layer["keys"]):
            def clean(p):
                if not p:
                    return None
                return {f: p[f] for f in ("code", "layer", "modifier") if p.get(f) is not None} or None
            out[(layer["position"], i)] = (clean(k.get("tap")), clean(k.get("hold")))
    return out


A, B = norm(a), norm(b)
keys = sorted(set(A) | set(B))
changes = 0
for key in keys:
    if key in A and key in B and A[key] == B[key]:
        continue
    changes += 1
    pos, idx = key
    old = A.get(key, "<absent>")
    new = B.get(key, "<absent>")
    print(f"L{pos} key#{idx}: {old} -> {new}")

if a["combos"] != b["combos"]:
    changes += 1
    print(f"combos: {a['combos']} -> {b['combos']}")

cfg_keys = set(a.get("config") or {}) | set(b.get("config") or {})
cfg_diff = {k: ((a.get("config") or {}).get(k), (b.get("config") or {}).get(k))
            for k in cfg_keys
            if (a.get("config") or {}).get(k) != (b.get("config") or {}).get(k)}
for k, (old, new) in sorted(cfg_diff.items()):
    changes += 1
    print(f"config {k}: {old} -> {new}")

if changes == 0:
    print("identical")
else:
    print(f"\n{changes} change(s)")
EOF
