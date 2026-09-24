---
name: zsa-layouts
description: Fetch, render, diff, and evaluate ZSA keyboard layouts from Oryx. Use when given a configure.zsa.io layout URL or hash, when the user mentions a Voyager/Moonlander/ErgoDox layout, or asks to fetch, display, compare revisions of, or get feedback on a ZSA keyboard layout.
---

# ZSA layouts

Fetch ZSA keyboard layouts from Oryx's GraphQL API, render them as grids, diff revisions, and evaluate them.

## Steps

1. **Fetch** the layout JSON:

   ```bash
   skills/zsa-layouts/scripts/fetch-layout.sh https://configure.zsa.io/voyager/layouts/<hash>/<revision>/0
   # or, for the latest revision:
   skills/zsa-layouts/scripts/fetch-layout.sh <layoutHash>
   ```

   Add `--out FILE` to save the JSON. The script echoes the resolved revision to stderr.

   **Done when**: the revision hash on stderr matches the requested one (or "latest" was used). **On exit 2**: the requested revision is saved but unpublished; the API silently fell back to an older revision. Tell the user, and offer re-fetching `latest` or retrying later. Never present fallback data as the requested revision.

2. **Render** the layout as grids (pipe fetch straight in):

   ```bash
   skills/zsa-layouts/scripts/fetch-layout.sh <args> | skills/zsa-layouts/scripts/render-layout.sh
   ```

   **Done when**: one aligned split grid prints per layer. If the geometry is unsupported, report the key count and stop rather than guessing positions.

3. **Diff** two revisions when the user asks what changed:

   ```bash
   skills/zsa-layouts/scripts/diff-revisions.sh <url-or-json-a> <url-or-json-b>
   # or by hash: diff-revisions.sh <layoutHash> <revA> <revB>
   ```

   **Done when**: per-key changes print, or "identical".

4. **Evaluate** when the user asks for feedback: run the evaluator, then apply judgement:

   ```bash
   skills/zsa-layouts/scripts/fetch-layout.sh <args> | skills/zsa-layouts/scripts/evaluate-layout.sh
   ```

   The evaluator emits facts only. Apply the rubric below to turn facts into an evaluation, and ask about usage patterns (code vs prose, one-handed needs, layer habits) before recommending changes.

## Reference

### API

`POST https://oryx.zsa.io/graphql`, body `{"query": "...", "variables": {...}}`, no auth for public layouts. Query `layout(hashId, revisionId, geometry)` for `revision { layers { position title keys } combos config }`. The `configure.zsa.io` site is a JS SPA: never scrape its HTML or `web_fetch` it.

### Key data model

- Per layer, `keys` is ordered: left matrix (row-major, 6 cols/row), left thumbs, right matrix, right thumbs. Voyager: 24+2 per half (52 total); Moonlander: 35+3; ErgoDox EZ: 34+4.
- Each key has `tap`/`hold` sub-objects with `code` (QMK keycode), `layer`, `modifier`, `color`, `macro`.
- Both `tap` and `hold` null = transparent (falls through to lower layers). `code: "KC_NO"` = dead key (does nothing). `hold: {code: "MO", layer: N}` = momentary layer; `hold: {code: "TO", layer: N}` = toggle to layer.

### Evaluation rubric (facts in, judgement out)

- **Base-layer punctuation**: comma, period, semicolon, quote, slash, and bracket pairs belong on layer 0 for typing-heavy use; anything frequent exiled to a higher layer costs a hold per keystroke.
- **Dead vs transparent**: `KC_NO` dead keys are wasted or intentional guards; transparent keys inherit lower layers. Flag large dead zones on reachable layers.
- **Thumb cluster**: layers under thumb holds beat thumb-tap modifiers for split boards; mirrored holds on both thumbs give each hand access.
- **Dual-role placement**: tap-hold mods on the home row are standard; bottom-row tap-holds risk misfires on fast rolls. `permissiveHold` in config mitigates dropped taps.
- **Layer reach**: every layer needs an entry; toggle (`TO`) entry risks stranding the user in a layer, but is reasonable when the layer is self-contained and falls through to base elsewhere.
- **Mouse controls**: pointer movement and click buttons work best split across hands; co-located on one half makes click-and-move awkward.
- **Combos**: null combos are untapped capacity; chords on adjacent keys that never roll in normal typing (e.g. non-bigram letter pairs) suit frequent bracket pairs.
- **Duplicates**: repeated keycodes in one layer are usually leftover or intentional redundancy; note position, not intent.
