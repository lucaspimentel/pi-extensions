#!/usr/bin/env bash
# Render a ZSA layout (JSON from fetch-layout.sh) as ASCII split grids, one per layer.
# Reads JSON on stdin, prints grids on stdout.
set -euo pipefail
# Code is passed with -c so the script's stdin stays free for the JSON input.
python3 -c "$(cat <<'PYEOF'
import json
import sys

# Per-half matrix size and thumb count. voyager is verified against real data;
# moonlander and ergodox-ez sizes follow ZSA's published hardware and may need
# adjustment if grids misalign.
SPLITS = {
    "voyager": (24, 2),     # 4 rows x 6 cols + 2 thumbs per half
    "moonlander": (35, 3),  # 5 rows x 7 cols + 3 thumbs per half
    "ergodox-ez": (34, 4),  # 5 rows x 7/6 cols + 4 thumbs per half
}

ALIAS = {
    "KC_ESCAPE": "ESC", "KC_GRAVE": "`", "KC_MINUS": "-", "KC_EQUAL": "=",
    "KC_LEFT_BRACKET": "[", "KC_RIGHT_BRACKET": "]", "KC_BACKSLASH": "\\",
    "KC_SEMICOLON": ";", "KC_SCLN": ";", "KC_QUOTE": "'", "KC_COMMA": ",", "KC_DOT": ".",
    "KC_SLASH": "/", "KC_ENTER": "ENT", "KC_DELETE": "DEL",
    "KC_BACKSPACE": "BKSP", "KC_TAB": "TAB", "KC_SPACE": "SPC",
    "KC_LEFT_SHIFT": "SHFT", "KC_RIGHT_SHIFT": "SHFT",
    "KC_LEFT_CTRL": "CTRL", "KC_RIGHT_CTRL": "CTRL",
    "KC_LEFT_ALT": "ALT", "KC_RIGHT_ALT": "ALT",
    "KC_LEFT_GUI": "GUI", "KC_RIGHT_GUI": "GUI",
    "KC_LEFT": "\u2190", "KC_RIGHT": "\u2192", "KC_UP": "\u2191", "KC_DOWN": "\u2193",
    "KC_NO": "--", "KC_CAPS": "CAPS", "KC_PSCR": "PRTSC",
    "KC_PAGE_UP": "PGUP", "KC_PGDN": "PGDN", "KC_HOME": "HOME", "KC_END": "END",
    "KC_INSERT": "INS", "KC_LCBR": "{", "KC_RCBR": "}", "KC_LPRN": "(",
    "KC_RPRN": ")", "KC_LBRC": "[", "KC_RBRC": "]", "KC_LABK": "<",
    "KC_RABK": ">", "KC_PIPE": "|", "KC_QUES": "?", "KC_TILD": "~", "KC_BSLS": "\\",
    "QK_BOOT": "BOOT", "RGB_VAI": "RGB+", "RGB_VAD": "RGB-",
    "KC_AUDIO_MUTE": "MUTE", "KC_AUDIO_VOL_UP": "VOL+", "KC_AUDIO_VOL_DOWN": "VOL-",
    "KC_MS_BTN1": "M1", "KC_MS_BTN2": "M2", "KC_MS_BTN3": "M3",
    "KC_MS_LEFT": "MS\u2190", "KC_MS_RIGHT": "MS\u2192",
    "KC_MS_UP": "MS\u2191", "KC_MS_DOWN": "MS\u2193",
    "KC_MS_WH_UP": "W\u2191", "KC_MS_WH_DOWN": "W\u2193",
    "DM_PLY1": "DM\u25b6", "DM_REC1": "DM\u25cf", "DM_RSTP": "DM\u25a0",
}


def keyname(s):
    if s is None:
        return "?"
    return ALIAS.get(s, s.replace("KC_", ""))


def part(p):
    """Render one tap/hold sub-object as a label, or None."""
    if not p:
        return None
    if p.get("code") is None and p.get("layer") is not None:
        return f"\u03bb{p['layer']}"
    if p.get("modifier"):
        return keyname(p["modifier"])
    if p.get("code") == "MO":
        return f"\u03bb{p.get('layer')}"
    if p.get("code") == "TO":
        return f"TO:{p.get('layer')}"
    return keyname(p.get("code"))


def label(k):
    t = part(k.get("tap")) or "\u00b7"
    h = part(k.get("hold"))
    return f"{t}:{h}" if h else t


def render_layer(layer, matrix, thumbs):
    keys = layer["keys"]
    w = max(len(label(k)) for k in keys) + 2
    hs = matrix + thumbs          # keys per half
    rows = matrix // 6
    left = [label(k) for k in keys[:hs]]
    right = [label(k) for k in keys[hs:]]
    title = f"Layer {layer['position']}: {layer['title']}"
    print(f"=== {title} " + "=" * max(2, 60 - len(title)))
    for r in range(rows):
        lrow = "".join(f"{x:>{w}}" for x in left[r * 6:(r + 1) * 6])
        rrow = "".join(f"{x:>{w}}" for x in right[r * 6:(r + 1) * 6])
        print(f"{lrow}  |  {rrow}")
    lt = "".join(f"{x:>{w}}" for x in left[matrix:hs])
    rt = "".join(f"{x:>{w}}" for x in right[matrix:matrix + thumbs])
    pad = " " * (w * (6 - thumbs))
    print(f"{lt}{pad}  |  {rt}")
    print()


data = json.load(sys.stdin)
layout = data.get("data", data)["layout"]
revision = layout["revision"]
geometry = layout.get("geometry", "")
if geometry not in SPLITS:
    n = len(revision["layers"][0]["keys"])
    print(f"error: unknown geometry '{geometry}' ({n} keys/layer); "
          f"supported: {', '.join(SPLITS)}", file=sys.stderr)
    sys.exit(1)
matrix, thumbs = SPLITS[geometry]
for layer in sorted(revision["layers"], key=lambda l: l["position"]):
    if len(layer["keys"]) != 2 * (matrix + thumbs):
        print(f"error: layer {layer['position']} has {len(layer['keys'])} keys, "
              f"expected {2 * (matrix + thumbs)} for geometry '{geometry}'",
              file=sys.stderr)
        sys.exit(1)
    render_layer(layer, matrix, thumbs)
PYEOF
)"
