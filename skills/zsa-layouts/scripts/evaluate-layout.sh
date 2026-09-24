#!/usr/bin/env bash
# Emit a facts-only report about a ZSA layout for agent-driven evaluation.
# Reads layout JSON (from fetch-layout.sh) on stdin. Prints facts, never verdicts.
set -euo pipefail
# Code is passed with -c so the script's stdin stays free for the JSON input.
python3 -c "$(cat <<'PYEOF'
import json
import sys

data = json.load(sys.stdin)
layout = data.get("data", data)["layout"]
rev = layout["revision"]
layers = sorted(rev["layers"], key=lambda l: l["position"])

FREQUENT_PUNCT = [
    "KC_COMMA", "KC_DOT", "KC_SCLN", "KC_QUOTE", "KC_SLASH",
    "KC_LPRN", "KC_RPRN", "KC_LCBR", "KC_RCBR", "KC_LBRC", "KC_RBRC",
    "KC_MINUS", "KC_EQUAL", "KC_GRAVE",
]

LAYERS = {l["position"]: l["title"] for l in layers}


def position(i, matrix, thumbs):
    """Human-readable position: L/R, row.col (thumb keys as row 4)."""
    half = matrix + thumbs
    side, idx = ("L", i) if i < half else ("R", i - half)
    if idx < matrix:
        return f"{side}{idx // 6}.{idx % 6}"
    return f"{side}4.{idx - matrix}"


def key_part(p):
    """Return a readable label for a tap/hold sub-object, or None."""
    if not p:
        return None
    if p.get("code") is None and p.get("layer") is not None:
        return f"layer({p['layer']}) via {p.get('code', '?')}"
    if p.get("modifier"):
        return p["modifier"]
    if p.get("code") in ("MO", "TO"):
        return f"{p['code']}({p.get('layer')})"
    return p.get("code")


GEOMETRY_SPLITS = {
    "voyager": (24, 2), "moonlander": (35, 3), "ergodox-ez": (34, 4),
}
matrix = thumbs = None
for name, (m, t) in GEOMETRY_SPLITS.items():
    if layout.get("geometry") == name:
        matrix, thumbs = m, t
if matrix is None:
    n = len(layers[0]["keys"])
    print(f"error: unsupported geometry '{layout.get('geometry')}' ({n} keys/layer)",
          file=sys.stderr)
    sys.exit(1)

# --- layer 0 coverage ---
base_codes = set()
for k in layers[0]["keys"]:
    for p in (k.get("tap"), k.get("hold")):
        if p and p.get("code"):
            base_codes.add(p["code"])
missing = [c for c in FREQUENT_PUNCT if c not in base_codes]
print("## Layer 0 (base) coverage")
print(f"characters absent from base layer (tap or hold): "
      f"{', '.join(missing) if missing else 'none of the tracked punctuation'}")
print()

# --- dead vs transparent per layer ---
print("## Dead (KC_NO) vs transparent keys")
for layer in layers:
    dead, transparent = [], []
    for i, k in enumerate(layer["keys"]):
        t, h = k.get("tap"), k.get("hold")
        if t is None and h is None:
            transparent.append(position(i, matrix, thumbs))
        elif (t and t.get("code") == "KC_NO") or (h and h.get("code") == "KC_NO"):
            dead.append(position(i, matrix, thumbs))
    print(f"layer {layer['position']} ({layer['title']}): "
          f"{len(dead)} dead, {len(transparent)} transparent")
    if dead:
        print(f"  dead: {' '.join(dead)}")
print()

# --- dual-role inventory ---
print("## Dual-role and layer keys")
any_duals = False
for layer in layers:
    duals = []
    for i, k in enumerate(layer["keys"]):
        t, h = key_part(k.get("tap")), key_part(k.get("hold"))
        if h and k.get("tap"):
            duals.append(f"{position(i, matrix, thumbs)}={t or '?'}/{h}")
        elif h:
            duals.append(f"{position(i, matrix, thumbs)}={h} (hold-only)")
    if duals:
        any_duals = True
        print(f"layer {layer['position']} ({layer['title']}):")
        for d in duals:
            print(f"  {d}")
if not any_duals:
    print("  none")
print()

# --- combos ---
print("## Combos")
if rev.get("combos"):
    for c in rev["combos"]:
        print(f"  layer {c.get('layerIdx')}: {c.get('name', '?')} "
              f"keys={c.get('keyIndices')} trigger={c.get('trigger')}")
else:
    print("  none defined (combos is null)")
print()

# --- config flags ---
print("## Config")
cfg = rev.get("config") or {}
for k in sorted(cfg):
    if k == "disabledAnimations":
        print(f"  disabledAnimations: {len(cfg[k])} animation(s) disabled")
    else:
        print(f"  {k}: {cfg[k]}")
if not cfg:
    print("  (empty)")
print()

# --- layer reach map ---
print("## Layer reach map (how each layer is entered/exited)")
reach = {}
for layer in layers:
    for i, k in enumerate(layer["keys"]):
        for which, p in (("hold", k.get("hold")), ("tap", k.get("tap"))):
            if p and p.get("code") in ("MO", "TO") and p.get("layer") is not None:
                target = p["layer"]
                entry = "momentary" if p["code"] == "MO" else "toggle"
                reach.setdefault(target, []).append(
                    f"{entry} from layer {layer['position']} at "
                    f"{position(i, matrix, thumbs)} ({which})")
for target in sorted(set(LAYERS) | set(reach)):
    title = LAYERS.get(target, "?")
    entries = reach.get(target)
    if entries:
        for e in entries:
            print(f"  layer {target} ({title}): entered via {e}")
    elif target != 0:
        print(f"  layer {target} ({title}): NO direct entry from any layer")
print()

# --- duplicate keycodes within a layer ---
print("## Duplicate keycodes within a layer (tap+hold combined, KC_NO excluded)")
found_dup = False
for layer in layers:
    seen = {}
    for i, k in enumerate(layer["keys"]):
        for p in (k.get("tap"), k.get("hold")):
            if p and p.get("code") and p["code"] != "KC_NO":
                seen.setdefault(p["code"], []).append(position(i, matrix, thumbs))
    dups = {c: ps for c, ps in seen.items() if len(ps) > 1}
    if dups:
        found_dup = True
        print(f"layer {layer['position']} ({layer['title']}):")
        for c, ps in sorted(dups.items()):
            print(f"  {c}: {' '.join(ps)}")
if not found_dup:
    print("  none")
PYEOF
)"
