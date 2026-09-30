---
name: grill-me
description: "A relentless interview about a design that continues until no ambiguities remain. Invoke explicitly by name when you want a plan, architecture, API, or design stress-tested with questions before implementation."
disable-model-invocation: true
---

Interview the user relentlessly about the design under discussion until there are no ambiguities left. Map the design as a **design tree**: every decision branches into the decisions that hang off it.

## Rounds

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you have not heard yet. Ask the whole frontier in one round, then wait for the user's answers before the next round.

## How to ask

If the `ask_user_question` / `AskUserQuestion` tool is available, ask every round through it:

- One call per round when the frontier fits; batch the frontier into sequential calls of up to 4 questions when it does not. Still one round: no frontier recomputation until all answers are in.
- Give each question 2-4 concrete options, your recommended answer first, its label ending in "(Recommended)". Keep option labels short; put nuance in descriptions.
- A 16-character `header` per question forces you to sharpen the question title; the body carries the detail.
- The tool appends a free-text row automatically, so options never need an "Other" entry.

Only when the tool is unavailable (non-interactive session, tool refused), fall back to numbered markdown:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round of answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Before the first round, read the design material the user pointed at (docs, issues, code, prior discussion) and fold what you learn into the tree as either settled facts or questions.

## What to ask

Probe for ambiguity, not for opinions you could have guessed. The recurring ambiguity hotspots in a design:

- Scope: what is explicitly out of scope, and what happens at the boundaries
- Contracts: exact shapes of interfaces, payloads, error responses, return values
- State and data: ownership, lifecycle, persistence, concurrency
- Failure: what each component does when its inputs, dependencies, or invariants break
- Constraints: performance, compatibility, security, cost, rollout and migration

## Facts are yours; decisions are theirs

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

## Done

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Then write up the settled design as you now understand it, and wait for the user to confirm you have reached a shared understanding. Do not act on the design until the user confirms.