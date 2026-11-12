# intelligent-terminal

Reports the pi session lifecycle to [Microsoft Intelligent Terminal](https://github.com/microsoft/intelligent-terminal) (IT) so its session list and tab metadata show a pi row with live status: Idle, Working, Waiting for input, Error, or Ended.

This mirrors what Microsoft's shipped `wt-agent-hooks` bundle does for Claude Code, Copilot, Codex, Gemini, OpenCode, and Antigravity.

## Requirements

All of these must hold, otherwise the extension registers nothing or emits nothing:

- Windows.
- `WT_COM_CLSID` and `WT_SESSION` are set, i.e. pi runs in a shell pane owned by Intelligent Terminal. Plain Windows Terminal sets `WT_SESSION` but not `WT_COM_CLSID`.
- `ctx.mode` is `tui` or `rpc`, so `-p`/JSON batch runs never create throwaway rows.
- `PI_INTELLIGENT_TERMINAL` is not `0` or `false`.

`wtcli.exe` is resolved once per process: `WTCLI_PATH` (which IT injects), then `PATH`, then `%LOCALAPPDATA%\Microsoft\WindowsApps\wtcli.exe`. If it cannot be resolved, or the first spawn fails with ENOENT, the extension shows one `warning` notification and then stays silent for the rest of the process.

## Mapping

Events go to `wtcli.exe agent-hook --cli-source pi --event <topic>` with the hook JSON on stdin. IT treats an unknown CLI source as a first-class one: the row shows the session's cwd basename and no CLI name.

| pi signal | topic | payload |
| --- | --- | --- |
| `session_start` (any reason, including `reload`) | `agent.session.start` | `session_id`, `cwd` |
| `before_agent_start` with `messageType: "user"` | `agent.session.start` (re-bind) then `agent.prompt.submit` | `session_id`, `cwd` |
| `tool_execution_start`, top-level only | `agent.tool.starting` | `session_id`, `tool_name` |
| `ui_prompt_start` (entering waiting) | `agent.notification` | `session_id`, `message` = prompt title, else `waiting for user input` |
| `ui_prompt_end`, state now working | `agent.prompt.submit` | `session_id`, `cwd` |
| `ui_prompt_end`, state now idle | `agent.stop` | `session_id` |
| `agent_settled`, last `turn_end.outcome === "error"` | `agent.error` | `session_id`, `error` = the assistant's `errorMessage` (capped at 1024 chars) |
| `agent_settled`, otherwise (including `aborted`) | `agent.stop` | `session_id` |
| `session_shutdown`, reason `quit`/`new`/`resume`/`fork` | `agent.session.end` | `session_id`, `reason` |
| `session_shutdown`, reason `reload` | nothing | — |

Every payload also carries an RFC3339 `timestamp`. `session_id` is pi's session id, captured while `ctx` is known live and reused for `session.end` so the shutdown path never touches a possibly-stale ctx. It doubles as IT's `agent_session_id`, because `wtcli` lifts `payload.session_id` for sources it does not know.

`tool_input` is never sent: IT synthesizes its own waiting-for-input notification when `tool_name` is `ask_user_question`, and tool arguments (including question text) stay in pi.

## Verified IT semantics this depends on

Established by reading the IT sources and by live testing against IT 0.3.3083.0:

- If the pane is bound to a *different* live session, every non-`session.start` event is dropped silently. Only `agent.session.start` is exempt, and it demotes that owner. That is why every user prompt re-sends it.
- `agent.error` maps to IT's `ConnectionFailed`, keyed by the pane binding, and Error persists until a new session start or tool start; `agent.stop` cannot clear it. Only a provider/API failure is reported, matching Claude's `StopFailure` mapping.
- `agent.tool.completed`/`tool.finished` are no-ops for non-Copilot sources, so they are never emitted.
- The in-band OSC 9001 `AgentEvent` channel is not usable: the VT parser forwards every OSC as `osc:<param>;<payload>`, so a pane-written sequence can never satisfy IT's `AgentEvent;` check.

## Cost

Each `wtcli` invocation costs ~150-320 ms, dominated by MSIX app-execution-alias process creation, so emits are never awaited. They go through a serialized queue that keeps at most one pending event per topic (a newer event of the same topic replaces the pending one without moving its queue position, and the oldest pending topic is dropped past 8). Serializing matters because IT applies events in receipt order and racing spawns could deliver a stop before the tool start that preceded it.

## Limitations

- A nested interactive `pi` or another agent CLI started inside pi's shell tools inherits the pane and will evict this session's binding. The next prompt's re-bind repairs it; nothing can detect the nesting (no env marker exists).
- A pi crash sends no `session.end`; the row stays live until IT's shell-prompt heuristic or the pane closing corrects it.
- **Do not run `pi-acp` as IT's agent if you want these hooks to be authoritative.** IT's ACP provider enumerates pi's on-disk session list and registers every session it finds as `custom:npx`, including sessions started in ordinary shell panes. IT's `validate_master_hook_source` then refuses to let a hook adopt a raw session id another provider already owns, logging `rejected agent hook source reason="agent hook raw session ID conflicts with another provider"`, and this extension goes permanently silent for those ids while still paying a spawn per emit. Nothing here can detect or prevent it: pi-acp spawns the pi child with `env: process.env` unchanged, and IT gives the pane no master-pipe path to query. Fix it by configuration: point IT's agent pane at a built-in agent instead (its ACP provider id matches its own hooks' `cli_source`, so no collision), then restart IT, because the catalogued rows live only in IT's in-memory registry. Sessions IT has not catalogued, and any session created after a restart, are unaffected. Note that switching the agent pane to a *different* custom command recreates the same trap for that CLI.
- Out of scope: token usage/cost in IT's status bar (ACP-only), `agent.cwd.changed` (pi has no in-session cwd change), session-row titles (IT honours `title` only for OpenCode), and resuming a pi session from IT's UI (no ACP).

## Debugging

`wtcli agent-hook` writes nothing and always exits 0, and IT drops invalid or unowned events silently. The authoritative trace is IT's master log:

```
%LOCALAPPDATA%\Packages\Microsoft.IntelligentTerminal_8wekyb3d8bbwe\LocalCache\Local\IntelligentTerminal\logs\<version>\wta-main_master.<date>.log
```

Look for `processed COM agent hook hook_event="…" session_key="…" final_status=Some(…)`.

To see what IT actually holds, ask the running master for its registry. Take the pipe from the **newest** `wta-master starting` line in that log: `master-pipe.txt` in IT's `LocalState\IntelligentTerminal` is not updated by every master and has pointed at a long-dead one here.

```powershell
$dir  = "$env:LOCALAPPDATA\Packages\Microsoft.IntelligentTerminal_8wekyb3d8bbwe\LocalCache\Local\IntelligentTerminal\logs"
$log  = (Get-ChildItem "$dir\*\wta-main_master.*.log" | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
$pipe = (Select-String -Path $log -Pattern 'wta-master starting' | Select-Object -Last 1).Line -replace '.*pipe_name=(\S+).*', '$1'
& "$env:LOCALAPPDATA\Microsoft\WindowsApps\wta.exe" sessions list --master $pipe --json   # one JSON row per line (NDJSON)
```

Each row carries `provider_id`, `status`, `pane_session_id`, `title` and `cli_source`, so a healthy session reads `provider_id=pi` bound to the pane's `WT_SESSION`. Three things to know when reading it:

- The registry is in memory. Rows disappear when IT restarts, which is also what clears a `custom:npx` catalog created by an earlier pi-acp agent selection.
- There is no CLI to delete a row; `wta sessions` offers only `list` and `refresh`.
- A rejection logs the reason but **not** the session id. To attribute one, match its timestamp against the helper log (`wta-main_helper-*.log`), where this extension's own emits appear as `SessionStarted assigning pane_session_id (first bind) … cli=Unknown("pi")`.
