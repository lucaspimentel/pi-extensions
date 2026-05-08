# TODO

- [ ] Add a new pi extension that shows a session summary after the agent has been idle for ~30 seconds.
  - Context: root `package.json` exposes extensions through the `pi.extensions` array; add the new extension path there (likely under `extensions/`).
  - Context: pi extension examples show `agent_end` as the “ready for input” hook (`examples/extensions/notify.ts`), with timers cleared on `agent_start`/`session_shutdown` (`examples/extensions/titlebar-spinner.ts`).
  - Context: `examples/extensions/summarize.ts` already demonstrates extracting conversation text from `ctx.sessionManager.getBranch()`, calling a model with `complete/getModel`, and displaying Markdown in transient custom UI.
