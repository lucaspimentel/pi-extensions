---
name: update-docs
description: "Update project documentation based on recent changes and current codebase state. Use when the user says 'update docs', 'update readme', 'sync docs', 'docs are stale', 'update CLAUDE.md', 'refresh documentation', or any variation of wanting documentation updated."
---

Verify and update project documentation so it accurately reflects the current state of the codebase.
Do not commit or push the changes to git unless also asked to do so.
Do not include volatile metrics (test counts, coverage percentages, line counts) that become stale quickly.

## Step 1 — Orient

Glob for `**/*.md` to find all doc files. Read each one.

## Step 2 — Verify

For each doc file, spot-check its claims against the codebase using Glob and Grep — focus on things likely to have changed (skill lists, plugin names, file paths, commands). Skip claims that are obviously stable.

## Step 3 — Apply fixes

Edit files directly. Do not produce a report first.

Treat `CLAUDE.md` and `README.md` in the same directory as a pair — they cover the same component from different angles. Update both when updating one.

### CLAUDE.md (any level — root or nested)
- Check for `./CLAUDE.md`, `./.claude/CLAUDE.md`, `./AGENTS.md` and any nested `CLAUDE.md` files in subdirectories
- If CLAUDE.md only references AGENTS.md, update AGENTS.md instead
- Keep it **minimal and AI-agent focused**: imperative instructions, key conventions, non-obvious commands, critical patterns
- Omit directory structure (agents can run `ls`), obvious language conventions, and anything the agent can trivially discover
- Cross-reference its sibling README.md for content that belongs there

### README.md (any level — root or nested)
- Focus on **humans**: end-users and contributors
- Include: overview, setup/installation, usage, feature list
- Omit: AI-agent instructions, internal conventions, implementation details
- Cross-reference its sibling CLAUDE.md if one exists
