#!/usr/bin/env bash
# Fetch a ZSA keyboard layout from Oryx's GraphQL API.
#
# Usage:
#   fetch-layout.sh <configure.zsa.io URL> [--out FILE]
#   fetch-layout.sh <layoutHash> [revisionHash] [--out FILE]
#
# Outputs layout JSON to stdout. Prints the resolved revision hash to stderr.
# Exits non-zero when the API falls back to a different revision than requested
# (happens when a revision is saved but not yet published).
set -euo pipefail

API="https://oryx.zsa.io/graphql"

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

die() { echo "error: $*" >&2; exit 1; }

geometry=""
hash=""
rev=""
out=""

while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      [ $# -ge 2 ] || die "--out requires a file path"
      out="$2"; shift 2 ;;
    -h|--help)
      usage ;;
    https://*|http://*)
      # https://configure.zsa.io/<geometry>/layouts/<hash>/<revision>/<layerIdx>
      if [[ "$1" =~ ^https://[^/]+/([^/]+)/layouts/([^/]+)(/([^/]+))? ]]; then
        geometry="${BASH_REMATCH[1]}"
        hash="${BASH_REMATCH[2]}"
        rev="${BASH_REMATCH[4]:-}"
      else
        die "unrecognized layout URL: $1"
      fi
      shift ;;
    -*)
      die "unknown option: $1" ;;
    *)
      if [ -z "$hash" ]; then hash="$1"
      elif [ -z "$rev" ]; then rev="$1"
      else die "unexpected argument: $1 (only layout hash and revision accepted)"
      fi
      shift ;;
  esac
done

[ -n "$hash" ] || usage
requested_rev="${rev:-latest}"
[ -n "$geometry" ] || geometry="null"

body=$(python3 - "$hash" "$requested_rev" "$geometry" <<'EOF'
import json, sys
hash_id, rev, geometry = sys.argv[1], sys.argv[2], sys.argv[3]
query = """
query getLayout($hashId: String!, $revisionId: String!, $geometry: String) {
  layout(hashId: $hashId, geometry: $geometry, revisionId: $revisionId) {
    hashId privacy geometry title
    revision {
      hashId createdAt model qmkVersion config
      combos { keyIndices layerIdx name trigger }
      layers { position title color keys }
    }
  }
}
"""
geometry_var = None if geometry == "null" else geometry
print(json.dumps({
    "query": query,
    "variables": {"hashId": hash_id, "revisionId": rev, "geometry": geometry_var},
}))
EOF
)

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
http_code=$(curl -sS -o "$tmp" -w "%{http_code}" -X POST "$API" \
  -H "Content-Type: application/json" -d "$body")

[ "$http_code" = "200" ] || die "HTTP $http_code from $API"

python3 - "$tmp" "$hash" "$requested_rev" <<'EOF'
import json, sys
path, requested_layout, requested_rev = sys.argv[1], sys.argv[2], sys.argv[3]
resp = json.load(open(path))

if "errors" in resp:
    msgs = "; ".join(e.get("message", "?") for e in resp["errors"])
    print(f"error: GraphQL errors: {msgs}", file=sys.stderr)
    sys.exit(1)

layout = resp.get("data", {}).get("layout")
if not layout:
    print("error: layout not found (bad hash or private layout)", file=sys.stderr)
    sys.exit(1)

revision = layout["revision"]
returned_rev = revision["hashId"]

if requested_rev != "latest" and returned_rev != requested_rev:
    print(
        f"error: requested revision {requested_rev} is not resolvable; "
        f"the API fell back to revision {returned_rev} "
        f"(created {revision.get('createdAt', '?')}). "
        f"The revision was likely saved but not yet published. "
        f"Retry later, or fetch 'latest' explicitly.",
        file=sys.stderr,
    )
    sys.exit(2)

print(
    f"layout {layout['hashId']} ({layout['geometry']}, '{layout['title']}') "
    f"revision {returned_rev} created {revision.get('createdAt', '?')}",
    file=sys.stderr,
)
EOF

if [ -n "$out" ]; then
  cp "$tmp" "$out"
  echo "saved to $out" >&2
else
  cat "$tmp"
fi
