---
description: Scout, grill me on the design, plan, then implement here in the main session (no worker subagent)
argument-hint: "<task>"
---
Task: $@

If the task above is empty, ask me for it before doing anything else.

This is deliberately not a subagent chain: reconnaissance and planning are delegated to subagents, while the interview and the implementation stay in this session. Work the stages in order.

1. **Scout.** Call the `subagent` tool in single mode with agent `scout` to find the code relevant to the task: files, entry points, existing patterns and conventions, tests, and any constraint a design decision could depend on. Keep the report; the interview and the plan both need it.

2. **Grill me.** Follow the `grill-me` skill: it is listed in your skills, so read its `SKILL.md` and work the interview as it describes. If your skill list does not include it, run the same interview inline: put the current frontier of decisions to me through `ask_user_question` (recommended answer first, label ending in "(Recommended)"), wait for the answers, recompute the frontier, and repeat until no decision is left silently assumed. Treat the scout report as settled facts rather than re-asking what you can read. Facts you still need mid-interview are your job: dispatch a scout or researcher subagent for them instead of asking me. When the frontier is empty, write the settled design down and wait for my explicit confirmation before continuing.

3. **Plan.** Call the `subagent` tool in single mode with agent `planner`, handing it the scout report plus the settled design, and ask for an implementation plan. Show me the plan.

4. **Implement here, yourself.** Do not delegate this: no `subagent` call with agent `worker` for the implementation. Follow the plan, verify with the build, tests, or the checks the plan names, and report what changed and what was verified.

Do not start stage 3 or 4 before I confirm the settled design. Stage 4 is the point of this command: implementation happens in the main session so I can watch and steer it.
