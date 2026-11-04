---
description: Fan one task across a named read-only model panel
argument-hint: "<preset> <text>"
---
Preset: $1
Task: ${@:2}

Call `subagent({panel, task})` with panel set to the preset above and task set to the expanded task above. Do not rewrite the expanded task.
If either the preset or task is missing, report the available presets from the subagent tool-description catalog and ask for the missing argument. Never guess a default preset.
If the catalog lists no presets, say that none are configured and that presets belong in the `panels` object of the pi agent directory's `subagent.json` (`~/.pi/agent/subagent.json` by default).

Template expansion preserves parsed argument text, not original quoting or byte-for-byte spacing.
