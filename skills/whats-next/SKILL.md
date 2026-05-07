---
name: whats-next
description: "Pick and work on the next incomplete item from TODO.md. Use when the user says 'what's next', 'next task', 'next todo', 'what should I work on', 'what's up next', 'pick a task', 'grab something from the TODO', 'what tasks remain', 'work on the next task', 'what can I tackle next', or any variation of wanting to pick and work on the next incomplete TODO item."
---

Read TODO.md to find incomplete tasks (unchecked checkboxes, items not marked done, etc.). If TODO.md doesn't exist, inform the user and suggest creating one with `/skill:add-todo`.

## Step 1 — Present options

List the incomplete tasks ordered by best "bang for the buck" — prioritize items that are high-impact and easy to implement (low-hanging fruit) over items that are low-impact or complex. Use task labels, size estimates, or dependency information if available in the file. If no such metadata is present, present tasks in file order.

Present the numbered list and ask the user which item to work on.

## Step 2 — Plan and execute

Create an implementation plan for the selected task. Include tests in the plan when the task involves code changes. Present the plan and wait for user approval before implementing.

## Step 3 — Wrap up

After implementation is complete:

1. Update TODO.md — mark the completed item as done.
2. Run `/skill:update-docs` to update documentation if the changes warrant it.
3. Run `/skill:update-changelog` to update the changelog if the changes warrant it.
