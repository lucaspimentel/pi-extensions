---
description: Fan one task across a named read-only model panel
argument-hint: "<preset> <text>"
---
Preset: $1
Task: ${@:2}

Call `subagent({panel, task})` with panel set to the preset above and task set to the expanded task above. Do not rewrite the expanded task.
If either the preset or task is missing, report the available presets from the subagent tool-description catalog and ask for the missing argument. Never guess a default preset.

Template expansion preserves parsed argument text, not original quoting or byte-for-byte spacing.
