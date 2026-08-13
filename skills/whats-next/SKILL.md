---
name: whats-next
description: "Pick and work on the next incomplete item from TODO.md. Use when the user says 'what's next', 'next task', 'next todo', 'what should I work on', 'what's up next', 'pick a task', 'grab something from the TODO', 'what tasks remain', 'work on the next task', 'what can I tackle next', or any variation of wanting to pick and work on the next incomplete TODO item."
disable-model-invocation: true
---

Read TODO.md to find incomplete tasks (unchecked checkboxes, items not marked done, etc.). If TODO.md doesn't exist, inform the user and suggest creating one with `/skill:add-todo`.

## Step 1 — Present options

List the incomplete tasks ordered by best "bang for the buck" — prioritize items that are high-impact and easy to implement (low-hanging fruit) over items that are low-impact or complex. Use task labels, size estimates, or dependency information if available in the file. If no such metadata is present, present tasks in file order.

Present the numbered list.
