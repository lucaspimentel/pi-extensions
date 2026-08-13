---
name: add-todo
description: "Create or append tasks to TODO.md in the current working directory. Use when the user says 'add todo', 'add a task', 'TODO:', 'new task', 'track this', 'note this down', 'add to the backlog', 'before I forget', or any variation of wanting to capture new items. Also applies when the user finishes work and mentions follow-up items to save for later. Not appropriate for reading, viewing, checking off, removing, or reorganizing TODO.md."
disable-model-invocation: true
---

Add one or more tasks to TODO.md in the current working directory.

## Step 1 — Understand the task

Identify the task(s) the user wants to add from their message. If the request is vague, ask a brief clarifying question — but if the intent is clear enough, just proceed.

If the task references codebase artifacts, do minimal research (1-2 tool calls) to include useful context in the TODO entry. For example, if the user says "add a task to refactor the auth module", skim relevant source files to note key file paths and considerations. Skip research for self-contained tasks that need no codebase context. This context helps whoever picks up the task later (via the `whats-next` skill or otherwise) get started quickly without re-discovering the same information.

Add each task as a single item. Do not break tasks into sub-items unless the user explicitly requests it.

## Step 2 — Read existing TODO.md (if it exists)

If TODO.md exists, read it to understand the current format (checkbox style, numbered list, headings, etc.) and where new items should go. Preserve the existing format exactly.

If TODO.md does not exist, create it with this default format:

```markdown
# TODO

- [ ] <task>
```

## Step 3 — Append the new task(s)

Add the new item(s) to the end of the list, matching the file's existing format. If there are section headings, infer the appropriate section from context; if ambiguous, add to the last section.

Before adding, check for existing items that are very similar to avoid duplicates. If a near-duplicate exists, inform the user and ask whether to add anyway or skip.

Mark new items as incomplete (e.g., `- [ ]` for checkbox format). Include the research context gathered in Step 1 as indented sub-bullets under the main task entry.

## Step 4 — Confirm

Briefly confirm what was added — e.g., "Added 2 tasks to TODO.md." Keep it short.
