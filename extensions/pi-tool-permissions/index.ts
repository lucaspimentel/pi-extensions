/**
 * Tool Permissions Extension
 *
 * Adds Claude Code-style configurable allow/deny/ask permissions for tool calls.
 *
 * Rule format:
 *   "ToolName"             - matches any invocation of that tool
 *   "ToolName(pattern)"    - matches when the tool's "match field" matches the glob pattern
 *
 * Match field per tool:
 *   bash             -> command
 *   pwsh             -> command
 *   read/write/edit  -> path
 *   grep/glob/ls     -> path (directory being searched/listed; defaults to cwd when the call omits it)
 *   web_fetch        -> url
 *   web_search       -> (bare rule only — no pattern support)
 *   others           -> JSON.stringify(input)
 *
 * Tool name matching is case-insensitive and underscore-agnostic:
 *   WebSearch, websearch, web_search  →  all equivalent
 *   WebFetch,  webfetch,  web_fetch   →  all equivalent
 *
 * Pattern syntax: simple glob (`*` = any chars, `?` = single char). Case-insensitive.
 * If a rule's pattern starts with `/` and ends with `/`, it is treated as a regex.
 *
 * Config files (merged, project overrides user):
 *   ~/.pi/agent/pi-tool-permissions.json
 *   ~/.pi/tool-permissions.json (legacy fallback when the new user config is absent)
 *   <cwd>/.pi/pi-tool-permissions.local.json
 *   <cwd>/.pi/pi-tool-permissions.json (legacy fallback; auto-migrated on next save)
 *   <cwd>/.pi/tool-permissions.json (older legacy fallback; auto-migrated on next save)
 *
 * Schema:
 *   {
 *     "defaultAction": "allow" | "deny" | "ask",
 *     "allow": ["Bash(npm test)", "Read"],
 *     "deny":  ["Bash(rm -rf*)", "Write(.env*)"],
 *     "ask":   ["Bash(git push*)"],
 *     "toolDefaults": { "write": "ask", "web_fetch": "allow" },
 *     "readAllowCwd": true,
 *     "grepAllowCwd": true,
 *     "globAllowCwd": true,
 *     "lsAllowCwd": true,
 *     "readAllowSkills": true,
 *     "readAllowPiDocs": true,
 *     "readAllowAgentDocs": true,
 *     "bashReadOnlyAllowCwd": true,
 *     "autoMode": {                       // used when the session auto toggle is on
 *       "classifier": { "provider": "anthropic", "model": "claude-haiku-4-5" },
 *       "environment": ["Trusted repo: github.com/lucaspimentel/*"],
 *       "allow":     ["Running tests and linters"],
 *       "soft_deny": ["Force pushing, deleting remote branches", "Creating a pull request or pushing a branch on GitHub via gh, modifying remote state"],
 *       "hard_deny": ["Sending data to third-party APIs or external services for telemetry, analytics, or exfiltration (not normal GitHub dev actions like opening PRs or pushing branches via gh)"],
 *       "classifyAllShell": true
 *     }
 *   }
 *
 * Precedence (first match wins):
 *   deny > ask > allow > toolDefaults > auto (if session toggle on) > defaultAction.
 *
 * Implicit defaults (session-only, never persisted to disk):
 *   readAllowCwd (default: true)
 *     Injects Read(<cwd>/**) into the allow list so every read within the working
 *     directory is silently permitted. Disable with "readAllowCwd": false.
 *   grepAllowCwd (default: true)
 *     Injects Grep(<cwd>/**) so every grep inside the working directory is silently
 *     permitted. Disable with "grepAllowCwd": false.
 *   globAllowCwd (default: true)
 *     Injects Glob(<cwd>/**) so every glob inside the working directory is silently
 *     permitted. Disable with "globAllowCwd": false.
 *   lsAllowCwd (default: true)
 *     Injects Ls(<cwd>/**) so every ls inside the working directory (and ls calls
 *     that omit `path`, which default to cwd) are silently permitted. Disable with
 *     "lsAllowCwd": false.
 *   readAllowAgentDocs (default: true)
 *     Injects exact-path Read rules for AGENTS.md and CLAUDE.md in the working
 *     directory and every ancestor directory up to the filesystem root, so the
 *     agent can read project instruction files that live above cwd without
 *     prompting (they fall outside the Read(<cwd>/**) glob). Exact paths only:
 *     Read(<dir>/AGENTS.md) and Read(<dir>/CLAUDE.md) per directory. Copies in
 *     child directories need no extra rules: Read(<cwd>/**) already covers
 *     them. Other files in parent directories are unaffected; Write/Edit to
 *     these files is unaffected. Disable with "readAllowAgentDocs": false.
 *   readAllowSkills (default: true)
 *     Injects Read/Ls/Glob/Grep rules covering pi's known skill roots so reading,
 *     listing, globbing, or grepping SKILL.md and related files outside cwd doesn't
 *     prompt. Covered roots:
 *       <Read|Ls|Glob|Grep>(<home>/.pi/agent/skills/**)
 *       <Read|Ls|Glob|Grep>(<home>/.pi/agent/git/**\/skills/**)
 *       <Read|Ls|Glob|Grep>(<home>/.agents/skills/**)
 *     Only affects read-only tools; Write/Edit to these paths are unaffected.
 *     Disable with "readAllowSkills": false.
 *   readAllowPiDocs (default: true)
 *     Injects Read/Ls/Glob/Grep rules covering pi's bundled docs and README so the
 *     agent can read, list, glob, and grep pi documentation without prompting.
 *     Covered roots (relative to home):
 *       <Read|Ls|Glob|Grep>(<home>/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/**)  (Windows)
 *       <Read|Ls|Glob|Grep>(<home>/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/**)
 *       <Read|Ls|Glob|Grep>(<home>/.nvm/versions/node/{*}/lib/node_modules/@earendil-works/pi-coding-agent/**)
 *       <Read|Ls|Glob|Grep>(<home>/.volta/tools/image/node/{*}/lib/node_modules/@earendil-works/pi-coding-agent/**)
 *       <Read|Ls|Glob|Grep>(<home>/.local/share/npm/lib/node_modules/@earendil-works/pi-coding-agent/**)
 *       <Read|Ls|Glob|Grep>(<home>/Library/Application Support/npm/lib/node_modules/@earendil-works/pi-coding-agent/**)
 *     Only affects read-only tools; Write/Edit to these paths are unaffected.
 *     System-wide installs (/usr/local/lib/...) are not covered. Disable with
 *     "readAllowPiDocs": false.
 *   bashReadOnlyAllowCwd (default: true)
 *     Silently allows a curated set of read-only bash subcommands (pwd, echo, ls,
 *     cat, head, tail, wc, stat, …) when their path arguments resolve inside cwd.
 *     Commands with top-level *file* output redirections (>, >>, 2>, &>, …) are
 *     never auto-allowed. Descriptor-to-descriptor dups like `2>&1` / `1>&2` are
 *     NOT file writes and stay auto-allowable. Redirects to `/dev/null` (the
 *     Unix null device — writes are discarded) are likewise NOT file writes and
 *     stay auto-allowable, so `cmd 2>/dev/null` is not blocked.
 *     Disable with "bashReadOnlyAllowCwd": false.
 *   bashAllowPureVarAssign (default: true)
 *     Silently allows pure shell variable assignments (e.g. `SKILL_DIR="/path"`,
 *     `PID=130847101`, `export FOO="bar"`) whose RHS contains no command,
 *     process, or arithmetic substitution. Impure forms (`TOKEN=$(ddtool ...)`,
 *     `` X=`pwd` ``, `A=1 echo hi`, `X=$((1+2))`) still fall through to normal
 *     rules. Exempt from auto-mode classifyAllShell (pure assignments are
 *     statically allowed even in auto mode). Explicit deny rules win.
 *     Disable with "bashAllowPureVarAssign": false.
 *   write → ask (automatic)
 *     Unless toolDefaults.write is explicitly set, Write always prompts regardless
 *     of defaultAction. Override with "toolDefaults": { "write": "allow" }.
 *     Explicit Write(<path>) allow rules still win because allow > toolDefaults.
 *
 * Redirected Bash commands (write-risk):
 *   A Bash command containing a top-level *file* output redirection (>, >>, 2>,
 *   &>, n>>, …) is treated as a write-risk operation. A broad allow rule whose
 *   pattern contains no `>` (e.g. `Bash(rg *)`) will NOT auto-allow a redirected
 *   form like `rg x > out.txt` — it falls through to `ask`/toolDefaults/default.
 *   To pre-authorize a redirected command, add an explicit redirect-aware rule
 *   whose pattern includes `>` (e.g. `Bash(rg * > *)`). `deny` and `ask` rules
 *   are redirect-agnostic and always still apply, so safety rules win over a
 *   redirected command. Descriptor-to-descriptor redirects (`2>&1`, `1>&2`,
 *   `>&2`, `>&-`) are NOT file writes and are exempt from this filter. Redirects
 *   to `/dev/null` are likewise exempt (null device, no persistence). pwsh is
 *   out of scope (different syntax) and stays redirect-agnostic.
 *
 * Compound bash commands (&&, ||, |, ;):
 *   When a Bash command contains top-level shell operators, each subcommand is
 *   evaluated independently against the rules, then aggregated:
 *     - any subcommand → deny  ⟹  whole command denied (notification names culprit)
 *     - no deny, any → ask    ⟹  each ask subcommand is confirmed separately
 *     - all → allow           ⟹  whole command allowed
 *   If the command cannot be parsed unambiguously (e.g. unmatched quotes), the
 *   whole command falls back to ask.
 *   POSIX shell line-continuations (`\<LF>` and `\<CRLF>` outside single
 *   quotes) are stripped before parsing, so commands split across multiple
 *   lines are matched against rules as their canonical single-line form.
 *   Structural control-flow keywords are elided from the per-subcommand breakdown
 *   so only real commands in loop/conditional bodies enter the prompt:
 *
 *   Iteration heads (elided entirely — no command runs):
 *     `for VAR in ...`, C-style `for ((...))`, bare `for VAR`
 *     `select VAR in ...`, bare `select VAR`
 *   Pure structural tokens (elided entirely):
 *     `do`, `done`, `then`, `else`, `fi`
 *     A trailing harmless redirect on these (e.g. `done 2>/dev/null`, `fi 2>&1`)
 *     is stripped before the check, so it is still elided. File-target redirects
 *     (`done > out.txt`) are preserved so write-detection still fires.
 *   Prefix keywords (stripped — command after keyword is evaluated):
 *     `while CMD`, `until CMD`, `if CMD`, `elif CMD`
 *     `do CMD`, `then CMD`, `else CMD`
 *
 *   Example: `while true; do sleep 1; done` prompts only on `true` and `sleep 1`.
 *   Example: `if grep foo f; then echo found; fi` prompts on `grep foo f` and `echo found`.
 *   `case` statements are not yet supported (require splitter changes; see TODO.md).
 *
 * Allow-all-edits mode:
 *   A session-only toggle that auto-allows all Write and Edit tool calls without
 *   prompting. Never persisted to disk. Always starts disabled. Explicit deny rules
 *   still take priority even when this mode is on.
 *
 *   Toggle via:
 *     - Ctrl+Alt+E hotkey
 *     - "Allow all edits this session" option in the Write/Edit permission dialog
 *     - /permissions allowalledits [on|off|toggle]
 *
 * Auto mode (session toggle, layered between toolDefaults and defaultAction):
 *   A middle ground between Manual (prompt for everything) and bypassPermissions
 *   (prompt for nothing). Before each tool call that falls through the static-rule
 *   layer AND any toolDefaults, a cheap/fast LLM classifier screens the action
 *   against natural-language `allow` / `soft_deny` / `hard_deny` lists and an
 *   `environment` fact list, then either allows silently, prompts (with the
 *   classifier's reason), or blocks.
 *
 *   Alongside the action, the classifier receives a `Context:` block of
 *   per-call facts (see buildActionContext): the working directory, the
 *   resolved target path, and whether each sits inside a git working tree
 *   (fs-only `.git` probe, no subprocess). Without it, a bare relative path
 *   like `projects.md` gave the model no way to tell the edit was reversible
 *   via git, so repo-local edits got soft-denied. For bash, a leading
 *   `cd <dir>` is honoured so the facts describe the repository actually
 *   being touched rather than the session cwd.
 *
 *   It is a LAYER in the precedence chain, not a `defaultAction` value:
 *     deny > ask > allow > toolDefaults > auto (if toggle on) > defaultAction
 *   `deny` rules block before the classifier is consulted; `ask` rules always
 *   prompt; `toolDefaults` (e.g. the implicit `write → ask` guard) win over the
 *   classifier. The classifier only decides for actions that fall through all of
 *   those — true unknowns.
 *
 *   Verdict mapping: `allow` → allow; `hard_deny` → block; `soft_deny` → prompt
 *   (deny in non-interactive modes); `no_match` → fall through to `defaultAction`
 *   (the classifier ran and had no opinion, so the user's terminal default
 *   applies). When an action matches more than one NL list, the more-severe
 *   verdict wins: `hard_deny > soft_deny > allow` (the classifier emits a single
 *   verdict, so precedence is enforced by the prompt instruction, not by code).
 *   This mirrors the deterministic `deny > ask > allow` chain above. When the
 *   toggle is on but no classifier model is available, the
 *   auto layer stubs to `ask` (safe) rather than applying `defaultAction` —
 *   screening was requested but couldn't be performed.
 *
 *   Auto mode is OFF by default and NEVER persisted — it is a session-only toggle
 *   mirroring allow-all-edits. `defaultAction` is never `"auto"` (legacy configs
 *   that set it are coerced to `"ask"` with a warning). Explicit `deny` rules
 *   always win.
 *
 *   Toggle via:
 *     - Ctrl+Alt+A hotkey
 *     - /permissions auto [on|off|toggle]
 *     - "Switch to auto mode (this session)" option in any permission dialog
 *       (just flips the toggle — same as the hotkey, but contextual).
 *   While on, the status line shows the resolved classifier model id
 *   (`🤖 auto: <model-id>`) so it's visible which model is screening
 *   fallthroughs; when no model is available it reads
 *   `🤖 auto (no classifier)` (fallthroughs stub to `ask`).
 *
 *   Config (`autoMode` block): `classifier` (optional explicit model pin),
 *   `environment`, `allow`, `soft_deny`, `hard_deny` (NL string lists),
 *   `classifyAllShell` (route every bash command through the classifier; compounds
 *   with no static `ask`/`deny` sub are classified as one whole command).
 *   The `allow`/`soft_deny`/`hard_deny` lists and `classifyAllShell` have sane
 *   defaults baked in (see DEFAULT_AUTO_MODE) — a bare `autoMode` block (or none
 *   at all) works out of the box once the toggle is on. User/project lists are
 *   additive on top of the defaults. `classifier` and `environment` have no
 *   defaults (user-specific). See docs/auto-mode-design.md for the full design.
 *
 *   `classifier` can also be picked interactively with
 *   `/permissions auto model` (see below) instead of hand-editing the config —
 *   mirrors idle-summary's `/summary model`. The picker writes
 *   `autoMode.classifier` into the project or user config (same `--user`/
 *   `--project` scoping as `/permissions default`) and takes effect immediately.
 *
 * Slash commands:
 *   /permissions                       - show this help
 *   /permissions help                  - show this help
 *   /permissions list                  - show current rules + allow-all-edits / auto state
 *   /permissions allow <rule>          - add an allow rule (project)
 *   /permissions deny  <rule>          - add a deny rule (project)
 *   /permissions ask   <rule>          - add an ask rule (project)
 *   /permissions remove <rule>         - remove a rule from any list
 *   /permissions default <allow|deny|ask>
 *   /permissions reload                - reload config from disk
 *   /permissions allowalledits [on|off|toggle]
 *   /permissions auto [on|off|toggle]  - toggle auto-mode (LLM classifier) for this session
 *   /permissions auto model [--user]   - pick the classifier model interactively
 *   /permissions auto model clear [--user]  - remove the classifier pin (resume auto-select)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelLabel, pickableModels } from "../shared/model-selection.ts";
import {
	PROJECT_CONFIG_REL,
	autoStatusLabel,
	buildActionContext,
	classifierAttribution,
	classifyAction,
	decide,
	decideCompound,
	dedupe,
	formatBreakdown,
	getMatchField,
	inputForMatching,
	leadingCdTarget,
	loadConfig,
	loadProjectConfigRaw,
	loadUserConfigRaw,
	mcpPreview,
	normalizeTool,
	parseRule,
	pickClassifierModel,
	recomputeBreakdown,
	resolveAgainstCwd,
	saveProjectConfig,
	saveUserConfig,
	shouldClassifyWholeCompound,
	suggestRule,
	userConfigPath,
	verdictToAction,
} from "./rules.ts";
import type { ClassifyResult, DefaultAction, ListAction, ResolvedConfig } from "./rules.ts";

const STATUS_KEY = "tool-permissions";
const STATUS_KEY_AUTO = "tool-permissions-auto";

type Scope = "project" | "user";

function tildify(p: string): string {
	const home = homedir();
	return p === home || p.startsWith(`${home}/`) || p.startsWith(`${home}\\`)
		? `~${p.slice(home.length)}`
		: p;
}

/**
 * Build an optional extra-info line for the pwsh permission prompt showing the
 * working directory and/or timeout when the call provided them. Returns an empty
 * string for non-pwsh tools or when neither field is present, so the generic
 * single-command prompt title is unaffected.
 */
function pwshExtraInfo(toolName: string, input: Record<string, unknown>): string {
	if (normalizeTool(toolName) !== "pwsh") return "";
	const parts: string[] = [];
	const cwd = input.cwd;
	if (typeof cwd === "string" && cwd) parts.push(`cwd: ${cwd}`);
	const timeout = input.timeout;
	if (typeof timeout === "number") parts.push(`timeout: ${timeout}s`);
	return parts.length ? `\n  ${parts.join(", ")}` : "";
}

export default function (pi: ExtensionAPI) {
	let cfg: ResolvedConfig = loadConfig(process.cwd());
	let allowAllEdits = false;
	// Auto-mode session toggle (off by default, never persisted). When on,
	// fallthroughs that reach the auto layer (between `toolDefaults` and
	// `defaultAction`) are screened by the classifier; if no classifier model
	// is available they fall back to `ask` (safe stub). Mirrors `allowAllEdits`.
	let autoModeEnabled = false;
	// Debug session toggle (off by default, never persisted). When on, every
	// classifier call (not just ones that end in `ask`/`deny`) notifies with the
	// model id, verdict, and reason — including silent `allow`/`no_match` calls
	// that otherwise leave no trace. Mirrors `autoModeEnabled`.
	let classifierDebugEnabled = false;
	// Per-session classifier verdict cache (keyed by toolName+input+ruleset). Bounds
	// token cost when the same action repeats in a loop. See classifierCacheKey().
	const verdictCache = new Map<string, ClassifyResult>();
	// Last model id shown in the auto-mode status line. The auto-select can
	// resolve differently mid-session (auth changes, scoped models change), and
	// toggling on when no model is authed yet can resolve later, so the tool_call
	// handler refreshes the status when the resolved id drifts from this.
	let lastAutoStatusId: string | undefined = undefined;

	// ── Deny-with-message helper ─────────────────────────────────────────────

	/**
	 * After a tool is denied, optionally prompt the user to send a steering
	 * message to the AI (e.g. "please use a different approach").
	 * If the user leaves the field empty, nothing is sent.
	 */
	async function promptSteerMessage(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const text = await ctx.ui.input(
			"Send a message to the AI? (leave empty to skip)",
			"e.g. please do this differently...",
		);
		if (text && text.trim()) {
			pi.sendUserMessage(text.trim(), { deliverAs: "steer" });
		}
	}

	// ── Allow-all-edits helpers ──────────────────────────────────────────────

	function applyAllowAllEdits(value: boolean, ctx: ExtensionContext, notify = true): void {
		allowAllEdits = value;
		if (value) {
			ctx.ui.setStatus(STATUS_KEY, "✏️ all edits allowed");
			if (notify) ctx.ui.notify("Allow all edits: ON (this session only)", "info");
		} else {
			ctx.ui.setStatus(STATUS_KEY, "");
			if (notify) ctx.ui.notify("Allow all edits: OFF", "info");
		}
	}

	// ── Auto-mode helpers ─────────────────────────────────────────────────────

	/**
	 * Resolve the classifier model from the session ctx (explicit pin, or
	 * auto-select from the available pool preferring the current model's
	 * provider). Factored from the `tool_call` handler so `applyAutoMode` can
	 * resolve at toggle time for the status line. `ExtensionContext` carries
	 * `modelRegistry` / `model` / `scopedModels` (see pi docs/extensions.md).
	 */
	function resolveClassifierModelFromCtx(ctx: ExtensionContext): Model<Api> | undefined {
		return pickClassifierModel(
			ctx.scopedModels.length > 0 ? ctx.scopedModels.map((s) => s.model) : ctx.modelRegistry.getAvailable(),
			ctx.model?.provider,
			(m) => ctx.modelRegistry.hasConfiguredAuth(m),
			cfg.autoMode.classifier,
			(provider, modelId) => ctx.modelRegistry.find(provider, modelId),
		);
	}

	function applyAutoMode(value: boolean, ctx: ExtensionContext, notify = true): void {
		autoModeEnabled = value;
		if (value) {
			const model = resolveClassifierModelFromCtx(ctx);
			lastAutoStatusId = model?.id;
			ctx.ui.setStatus(STATUS_KEY_AUTO, autoStatusLabel(model));
			if (notify) ctx.ui.notify("Auto mode: ON (this session only)", "info");
		} else {
			lastAutoStatusId = undefined;
			ctx.ui.setStatus(STATUS_KEY_AUTO, "");
			if (notify) ctx.ui.notify("Auto mode: OFF", "info");
		}
	}

	function applyClassifierDebug(value: boolean, ctx: ExtensionContext, notify = true): void {
		classifierDebugEnabled = value;
		if (notify) ctx.ui.notify(`Classifier debug: ${value ? "ON" : "OFF"} (this session only)`, "info");
	}

	/**
	 * Opt-in trace of a single classifier call, fired regardless of verdict —
	 * including `allow`/`no_match`, which otherwise return silently with no
	 * indication the classifier ran at all. No-op unless `classifierDebugEnabled`.
	 */
	function notifyClassifierDebug(
		ctx: ExtensionContext,
		toolName: string,
		input: Record<string, unknown>,
		modelId: string,
		result: ClassifyResult,
	): void {
		if (!classifierDebugEnabled || !ctx.hasUI) return;
		const desc = suggestRule(toolName, input);
		const reason = result.reason ? `: ${result.reason}` : "";
		ctx.ui.notify(`[classifier] ${modelId} -> ${result.verdict}${reason} (${desc})`, "info");
	}

	// ── Session lifecycle ────────────────────────────────────────────────────

	const reload = (cwd: string, ctx?: ExtensionContext) => {
		cfg = loadConfig(cwd);
		ctx?.ui.notify(
			`Tool permissions reloaded (default=${cfg.defaultAction}, allow=${cfg.allow.length}, deny=${cfg.deny.length}, ask=${cfg.ask.length}, toolDefaults=${Object.keys(cfg.toolDefaults).length})`,  
			"info",
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		cfg = loadConfig(ctx.cwd);
		// Always reset allow-all-edits and auto-mode at session start — never persisted.
		allowAllEdits = false;
		autoModeEnabled = false;
		classifierDebugEnabled = false;
		lastAutoStatusId = undefined;
		ctx.ui.setStatus(STATUS_KEY, "");
		ctx.ui.setStatus(STATUS_KEY_AUTO, "");
	});

	// ── Tool call gating ─────────────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const matchInput = inputForMatching(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
		const nonInteractive = ctx.mode === "print" || ctx.mode === "json";
		const autoActive = autoModeEnabled;
		// Pick the classifier model (explicit pin, or auto-select from the pool
		// preferring the currently selected model's provider). Mirrors idle-summary.
		const classifierModel = autoActive ? resolveClassifierModelFromCtx(ctx) : undefined;
		// Keep the status line in sync with the resolved model. The auto-select
		// can drift mid-session (auth changes, scoped models change), and the
		// toggle may have come on when nothing was authed yet, so refresh when
		// the resolved id (or its absence) differs from what we last showed.
		if (autoActive && ctx.hasUI) {
			const currentId = classifierModel?.id;
			if (currentId !== lastAutoStatusId) {
				lastAutoStatusId = currentId;
				ctx.ui.setStatus(STATUS_KEY_AUTO, autoStatusLabel(classifierModel));
			}
		}
		const autoEngaged = autoActive && classifierModel !== undefined;
		// Pass `autoActive` (session toggle), not `autoEngaged`: the "auto" sentinel
		// should surface whenever the toggle is on so the loop below can stub it to
		// `ask` when no classifier model is available (rather than silently applying
		// `defaultAction`).
		const compound = decideCompound(cfg, event.toolName, matchInput, autoActive);
		let { action, isCompound, ambiguous, breakdown } = compound;
		let classifierReason = "";
		// Model id of the classifier that produced the verdict for this call.
		// Undefined when the classifier didn't run for this verdict (a static
		// rule matched, or the no-model stub), so the model is only surfaced in
		// the deny block / ask dialogs when the classifier actually screened
		// the action — not merely because the auto toggle is on.
		let classifierModelId: string | undefined;

		// Resolve a fallthrough "auto" sentinel. For single/ambiguous commands we
		// classify up front. For compound commands we ALSO classify the whole
		// command at once when no sub matched a static `ask` rule — this lets the
		// classifier judge the full compound context instead of each sub in
		// isolation (the common case where every sub is an `allow`/`auto` fall-
		// through). Compounds that DO contain a static `ask` sub keep the per-sub
		// prompt loop below so user-authored "always prompt" rules still fire;
		// static `deny` already won inside `decideCompound` before we got here.
		// When the toggle is on but no classifier model is available
		// (`!autoEngaged`), stub to `ask` (safe) rather than applying `defaultAction`.
		if (action === "auto") {
			const hasAskSub = isCompound && !shouldClassifyWholeCompound(breakdown);
			if (autoEngaged && classifierModel && (!isCompound || !hasAskSub)) {
				const result = await classifyAction(
					(m, c) => ctx.modelRegistry.complete(m, c),
					classifierModel,
				event.toolName,
				matchInput,
				cfg.autoMode,
				verdictCache,
				buildActionContext(event.toolName, matchInput, cfg.cwd),
			);
				classifierReason = result.reason;
				classifierModelId = classifierModel.id;
				notifyClassifierDebug(ctx, event.toolName, matchInput, classifierModel.id, result);
				action = verdictToAction(result.verdict, nonInteractive, cfg.defaultAction);
				// Treat the verdict as a single-command decision: the rest of the
				// handler renders the single-command prompt for `ask`, blocks for
				// `deny`, returns for `allow` — instead of entering the per-sub
				// breakdown loop.
				isCompound = false;
				breakdown = [];
			} else if (!autoEngaged || isCompound) {
				// Stub (no model) or compound with a static `ask` sub (loop handles
				// per-sub).
				action = "ask";
			}
		}

		if (action === "allow") return undefined;

		// Explicit deny rules always win, even over allow-all-edits
		if (action === "deny") {
			const culprit = isCompound ? breakdown.find((b) => b.action === "deny") : null;
			const base = culprit
				? `Blocked ${event.toolName}: '${culprit.sub}' matched a deny rule`
				: `Blocked ${event.toolName} by tool-permissions deny rule`;
			const attr = classifierAttribution(classifierModelId, classifierReason);
			const message = attr ? `${base} (${attr})` : base;
			if (ctx.hasUI) {
				ctx.ui.notify(message, "warning");
			}
			return { block: true, reason: message };
		}

		// action === "ask" from here on

		const toolNorm = normalizeTool(event.toolName);
		const isWriteOrEdit = toolNorm === "write" || toolNorm === "edit";

		// Allow-all-edits short-circuits the ask for write/edit tools only
		if (allowAllEdits && isWriteOrEdit) {
			return undefined;
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `tool-permissions: '${event.toolName}' requires confirmation but no UI is available`,
			};
		}

		// Hide pi's animated "⠋ Working..." loader while the permission dialog is on
		// screen. Tall dialogs push the spinner above the visible region, where its
		// redraws break terminal scrolling. Restored on any return/throw below.
		ctx.ui.setWorkingVisible(false);
		// Report blocked to herdr while the dialog is up (pane would otherwise show
		// "working"). Ignored outside herdr; released in the finally below.
		pi.events.emit("herdr:blocked", {
			active: true,
			label: `awaiting permission: ${event.toolName}`,
		});
		try {
			// ── Compound bash command: confirm each ask subcommand separately ──────
			// Note: decideCompound() short-circuits any compound containing a `deny`
			// subcommand before we reach this loop (see the `culprit` block above),
			// so the loop below only iterates over `ask` items. Compounds with no
			// static `ask`/`deny` sub are classified as a whole up-front and
			// downgraded to a single-command decision (`isCompound = false` above),
			// so they also bypass this loop — it now only runs for compounds that
			// had a static `ask` sub (or auto off / no classifier model).
			if (isCompound) {
				const fullCmd = String((event.input as Record<string, unknown>).command ?? "");
				const truncated = fullCmd.length > 200 ? `${fullCmd.slice(0, 197)}...` : fullCmd;
				// A leading `cd <dir>` applies to every later subcommand, so classify each
				// sub as if it ran there (otherwise the git-repo facts would describe the
				// session cwd rather than the repository actually being touched).
				const cdPrefix = leadingCdTarget(fullCmd);
				const subCwd = cdPrefix ? resolveAgainstCwd(cdPrefix, cfg.cwd) : cfg.cwd;
	
				// Loop-scoped (this Bash invocation only — not session-wide): when set,
				// every remaining `ask` step is silently allowed without re-prompting
				// and without saving any rule. Resets when this handler returns.
				let allowAllStepsOnce = false;
	
				// Snapshot of the per-subcommand decisions that the dialog renders.
				// Mutated after each rule-save so downstream icons reflect the new cfg.
				let currentBreakdown = breakdown;
	
				// Iterate over the original `ask`/`auto` subcommands, but re-decide each one
				// against the current `cfg` right before prompting so newly saved
				// allow/deny rules apply to the rest of *this* compound command.
				const askSubs = breakdown.filter((b) => b.action === "ask" || b.action === "auto").map((b) => b.sub);
	
				for (const sub of askSubs) {
					// User intent (`Allow ALL steps once`) beats any rule-driven decision:
					// a freshly saved deny must not override an explicit one-shot allow.
					if (allowAllStepsOnce) continue;
	
					let liveAction = decide(cfg, "bash", { command: sub }, autoActive);
					let subReason = "";
					let subClassifierModelId: string | undefined;
					// Auto fallthrough: run the classifier for this subcommand.
					if (liveAction === "auto") {
						if (autoEngaged && classifierModel) {
							const result = await classifyAction(
								(m, c) => ctx.modelRegistry.complete(m, c),
								classifierModel,
								"bash",
								{ command: sub },
								cfg.autoMode,
								verdictCache,
								buildActionContext("bash", { command: sub }, subCwd),
							);
							subReason = result.reason;
							subClassifierModelId = classifierModel.id;
							notifyClassifierDebug(ctx, "bash", { command: sub }, classifierModel.id, result);
							liveAction = verdictToAction(result.verdict, nonInteractive, cfg.defaultAction);
						} else {
							liveAction = "ask";
						}
					}
					if (liveAction === "allow") continue;
					if (liveAction === "deny") {
						// No steer prompt here — this branch is only reached for static deny rules
						// and classifier hard_deny verdicts (neither is user-initiated). The
						// classifier's model + reason are already in the block message; user
						// denies steer via the Deny-once / Deny-always choice branches below.
						const reason = subClassifierModelId
							? `Blocked by classifier ${subClassifierModelId} (subcommand: ${sub})${subReason ? `: ${subReason}` : ""}`
							: `Blocked by tool-permissions deny rule (subcommand: ${sub})`;
						return { block: true, reason };
					}
	
					const suggested = suggestRule("Bash", { command: sub });
					const breakdownLines = formatBreakdown(currentBreakdown, sub);
	
					const subAttr = classifierAttribution(subClassifierModelId, subReason);
					const reasonNote = subAttr ? `\n\n  ${subAttr}` : "";
					const title = `Allow Bash subcommand?\n\nFull command:\n  ${truncated}\n\nBreakdown:\n${breakdownLines}${reasonNote}`;
					// "Allow ALL steps once" only makes sense when more than one step
					// in this compound actually needs human approval; with a single
					// ask sub it's identical to "Allow once", so omit it.
					const choices = [
						"Allow once",
						...(askSubs.length > 1 ? ["Allow ALL steps once"] : []),
						"Allow always (save rule)",
						"Deny once",
						"Deny always (save rule)",
						...(!autoActive ? ["Switch to auto mode (this session)"] : []),
					];
					const choice = await ctx.ui.select(title, choices);
	
					if (choice === "Allow once") continue;
	
					if (choice === "Allow ALL steps once") {
						allowAllStepsOnce = true;
						continue;
					}
	
					if (choice === "Switch to auto mode (this session)") {
						applyAutoMode(true, ctx);
						// Let the rest of this compound finish without re-prompting; future
						// tool calls go through the classifier. (Any `deny` sub was already
						// blocked by decideCompound before this loop runs.)
						allowAllStepsOnce = true;
						continue;
					}
	
					if (choice === "Deny once" || !choice) {
						if (choice === "Deny once") await promptSteerMessage(ctx);
						return { block: true, reason: `Denied by user (subcommand: ${sub})` };
					}
					if (choice === "Allow always (save rule)") {
						const edited = await ctx.ui.editor("Edit rule before saving:", suggested);
						if (!edited) continue;
						const scope = await promptScope(ctx);
						// Cancelling scope == cancelling the save (matches editor-cancel above).
						if (!scope) continue;
						addRule(scope, ctx.cwd, "allow", edited.trim());
						cfg = loadConfig(ctx.cwd);
						currentBreakdown = recomputeBreakdown(breakdown, cfg, autoActive);
						const autoCount = currentBreakdown.filter(
							(b) => b.sub !== sub && askSubs.includes(b.sub) && b.action === "allow",
						).length;
						const suffix = autoCount > 0 ? ` (auto-allows ${autoCount} remaining step${autoCount === 1 ? "" : "s"})` : "";
						ctx.ui.notify(`Saved allow rule (${scope}): ${edited.trim()}${suffix}`, "info");
						continue;
					}
					if (choice === "Deny always (save rule)") {
						const edited = await ctx.ui.editor("Edit rule before saving:", suggested);
						if (!edited) {
							await promptSteerMessage(ctx);
							return { block: true, reason: `Denied by user (subcommand: ${sub})` };
						}
						const scope = await promptScope(ctx);
						// Cancelling scope == treating as deny-once (no rule saved, but command still blocked).
						if (!scope) {
							await promptSteerMessage(ctx);
							return { block: true, reason: `Denied by user (subcommand: ${sub})` };
						}
						addRule(scope, ctx.cwd, "deny", edited.trim());
						cfg = loadConfig(ctx.cwd);
						currentBreakdown = recomputeBreakdown(breakdown, cfg, autoActive);
						ctx.ui.notify(`Saved deny rule (${scope}): ${edited.trim()}`, "info");
						await promptSteerMessage(ctx);
						return { block: true, reason: `Blocked by tool-permissions deny rule (${edited.trim()})` };
					}
				}
				return undefined;
			}
	
			// ── Single or ambiguous command ask ────────────────────────────────────
			const suggested = suggestRule(event.toolName, event.input as Record<string, unknown>);
			const matchField = getMatchField(event.toolName, event.input as Record<string, unknown>);
			const isMcp = normalizeTool(event.toolName) === "mcp";
			// MCP calls arrive as toolName "mcp" with the real tool name in input.tool;
			// render a human-readable preview of the parsed args instead of raw JSON.
			const preview = isMcp
				? mcpPreview(event.input as Record<string, unknown>)
				: (matchField.length > 200 ? `${matchField.slice(0, 197)}...` : matchField);
			const titleHeader = isMcp
				? `Allow MCP tool ${String((event.input as Record<string, unknown>).tool ?? "")}?`
				: `Allow ${event.toolName}?`;
			const ambiguousNote = ambiguous ? "\n\n(complex command — could not be split for per-subcommand checks)" : "";
			const extraInfo = pwshExtraInfo(event.toolName, event.input as Record<string, unknown>);
			const attr = classifierAttribution(classifierModelId, classifierReason);
			const reasonNote = attr ? `\n\n  ${attr}` : "";
			const title = `${titleHeader}\n\n  ${preview}${extraInfo}${ambiguousNote}${reasonNote}`;
	
			// Extra "allow all edits" option only for write/edit dialogs; "Switch to
			// auto mode" appears for every dialog when auto mode isn't already active,
			// as the last choice (so "Allow once" stays the default cursor position).
			const autoSwitch = !autoActive ? ["Switch to auto mode (this session)"] : [];
			const choices = isWriteOrEdit
				? [
						"Allow once",
						"Allow all edits this session",
						"Allow always (save rule)",
						"Deny once",
						"Deny always (save rule)",
						...autoSwitch,
				  ]
				: ["Allow once", "Allow always (save rule)", "Deny once", "Deny always (save rule)", ...autoSwitch];
	
			const choice = await ctx.ui.select(title, choices);
	
			if (choice === "Allow once") return undefined;
	
			if (choice === "Allow all edits this session") {
				applyAllowAllEdits(true, ctx);
				return undefined;
			}
	
			if (choice === "Switch to auto mode (this session)") {
				applyAutoMode(true, ctx);
				return undefined;
			}
	
			if (choice === "Deny once" || !choice) {
				if (choice === "Deny once") await promptSteerMessage(ctx);
				return { block: true, reason: "Denied by user" };
			}
			if (choice === "Allow always (save rule)") {
				const edited = await ctx.ui.editor("Edit rule before saving:", suggested);
				if (!edited) return undefined;
				const scope = await promptScope(ctx);
				// Cancelling scope == cancelling the save (matches editor-cancel above).
				if (!scope) return undefined;
				addRule(scope, ctx.cwd, "allow", edited.trim());
				cfg = loadConfig(ctx.cwd);
				ctx.ui.notify(`Saved allow rule (${scope}): ${edited.trim()}`, "info");
				return undefined;
			}
			if (choice === "Deny always (save rule)") {
				const edited = await ctx.ui.editor("Edit rule before saving:", suggested);
				if (!edited) {
					await promptSteerMessage(ctx);
					return { block: true, reason: "Denied by user" };
				}
				const scope = await promptScope(ctx);
				// Cancelling scope == treating as deny-once (no rule saved, but command still blocked).
				if (!scope) {
					await promptSteerMessage(ctx);
					return { block: true, reason: "Denied by user" };
				}
				addRule(scope, ctx.cwd, "deny", edited.trim());
				cfg = loadConfig(ctx.cwd);
				ctx.ui.notify(`Saved deny rule (${scope}): ${edited.trim()}`, "info");
				await promptSteerMessage(ctx);
				return { block: true, reason: `Blocked by tool-permissions deny rule (${edited.trim()})` };
			}
			return { block: true, reason: "Denied by user" };
		} finally {
			ctx.ui.setWorkingVisible(true);
			pi.events.emit("herdr:blocked", { active: false });
		}
	});

	// ── Hotkey ───────────────────────────────────────────────────────────────

	// Note: ctrl+alt+e (not ctrl+shift+e) because most terminals can't distinguish
	// ctrl+shift+<letter> from ctrl+<letter> — both emit the same control byte
	// unless the terminal supports the Kitty keyboard protocol. Alt is sent as an
	// ESC prefix, so ctrl+alt+e is reliably distinguishable from ctrl+e.
	pi.registerShortcut("ctrl+alt+e", {
		description: "Toggle allow-all-edits mode (this session only)",
		handler: async (ctx) => {
			applyAllowAllEdits(!allowAllEdits, ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+a", {
		description: "Toggle auto permissions mode (this session only)",
		handler: async (ctx) => {
			applyAutoMode(!autoModeEnabled, ctx);
		},
	});

	// ── Rule helpers ─────────────────────────────────────────────────────────

	function addRule(scope: Scope, cwd: string, action: ListAction, rule: string): void {
		const cfg = scope === "user" ? loadUserConfigRaw() : loadProjectConfigRaw(cwd);
		const list = cfg[action] ?? [];
		if (!list.includes(rule)) list.push(rule);
		cfg[action] = dedupe(list);
		if (scope === "user") saveUserConfig(cfg);
		else saveProjectConfig(cwd, cfg);
	}

	function removeRule(scope: Scope, cwd: string, rule: string): boolean {
		const cfg = scope === "user" ? loadUserConfigRaw() : loadProjectConfigRaw(cwd);
		let removed = false;
		for (const key of ["allow", "deny", "ask"] as const) {
			const list = cfg[key];
			if (!list) continue;
			const idx = list.indexOf(rule);
			if (idx >= 0) {
				list.splice(idx, 1);
				removed = true;
			}
		}
		if (removed) {
			if (scope === "user") saveUserConfig(cfg);
			else saveProjectConfig(cwd, cfg);
		}
		return removed;
	}

	function setDefault(scope: Scope, cwd: string, action: DefaultAction): void {
		const cfg = scope === "user" ? loadUserConfigRaw() : loadProjectConfigRaw(cwd);
		cfg.defaultAction = action;
		if (scope === "user") saveUserConfig(cfg);
		else saveProjectConfig(cwd, cfg);
	}

	// Persist an explicit classifier model pin into `autoMode.classifier` for
	// the given scope (mirrors idle-summary's /summary model persistence, but
	// reuses the project/user config files and scoping this extension already
	// has instead of a separate global file).
	function setClassifier(scope: Scope, cwd: string, provider: string, model: string): void {
		const cfg = scope === "user" ? loadUserConfigRaw() : loadProjectConfigRaw(cwd);
		cfg.autoMode = { ...(cfg.autoMode ?? {}), classifier: { provider, model } };
		if (scope === "user") saveUserConfig(cfg);
		else saveProjectConfig(cwd, cfg);
	}

	// Remove the classifier pin from the given scope's config, if present.
	// Returns false when there was nothing to remove (no notification needed).
	function clearClassifier(scope: Scope, cwd: string): boolean {
		const cfg = scope === "user" ? loadUserConfigRaw() : loadProjectConfigRaw(cwd);
		if (!cfg.autoMode?.classifier) return false;
		const { classifier: _classifier, ...restAuto } = cfg.autoMode;
		cfg.autoMode = restAuto;
		if (scope === "user") saveUserConfig(cfg);
		else saveProjectConfig(cwd, cfg);
		return true;
	}

	// Interactive scope picker used by Allow/Deny-always prompts. Returns null on Esc.
	async function promptScope(ctx: ExtensionContext): Promise<Scope | null> {
		const projectPath = tildify(join(ctx.cwd, PROJECT_CONFIG_REL));
		const userPath = tildify(userConfigPath());
		const projectLabel = `Project (${projectPath})`;
		const userLabel = `User (${userPath})`;
		const choice = await ctx.ui.select("Save rule where?", [projectLabel, userLabel]);
		if (!choice) return null;
		return choice === userLabel ? "user" : "project";
	}

	// ── Slash command ────────────────────────────────────────────────────────

	pi.registerCommand("permissions", {
		description: "Manage tool permissions (allow/deny/ask/auto) and allow-all-edits / auto modes",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["help", "list", "allow", "deny", "ask", "remove", "default", "reload", "allowalledits", "auto"];
			const items = subs.map((s) => ({ value: s, label: s }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = (args ?? "").trim();
			if (!trimmed || trimmed === "help") {
				const helpLines = [
					"pi-tool-permissions — usage",
					"",
					"Subcommands:",
					"  /permissions                  Show this help",
					"  /permissions help             Show this help",
					"  /permissions list             Show current rules + allow-all-edits / auto state",
					"  /permissions allow <rule> [--user]   Add an allow rule (default: project)",
					"  /permissions deny  <rule> [--user]   Add a deny rule",
					"  /permissions ask   <rule> [--user]   Add an ask rule",
					"  /permissions remove <rule> [--user]  Remove a rule from any list",
					"  /permissions default <allow|deny|ask> [--user]",
					"  /permissions reload           Reload config from disk",
					"  /permissions allowalledits [on|off|toggle]",
					"  /permissions auto [on|off|toggle]   Toggle auto-mode (LLM classifier) for this session",
					"  /permissions auto debug [on|off|toggle]   Toggle classifier debug notifications for this session",
					"  /permissions auto model [--user]   Pick the classifier model interactively",
					"  /permissions auto model clear [--user]   Remove the classifier pin (resume auto-select)",
					"",
					"Rule syntax:  ToolName  or  ToolName(pattern)",
					"  Patterns are case-insensitive globs (* = any chars, ? = one char).",
					"  A ' *' pair is optional, so Bash(git status *) matches 'git status' too.",
					"  Wrap in slashes for regex: Bash(/^git (push|tag) /)",
					"",
					"Precedence (first match wins):  deny > ask > allow > toolDefaults > defaultAction",
					"",
					"Session toggles (off by default, never persisted):",
					"  allow-all-edits  — auto-approve every Write/Edit  (Ctrl+Alt+E)",
					"  auto mode       — classifier screens fallthroughs   (Ctrl+Alt+A)",
					"    Only active when defaultAction === \"auto\". See docs/auto-mode-design.md.",
					"  classifier debug — notify on every classifier call, including silent allows",
					"",
					"Config files (project overrides user for defaultAction; lists concat):",
					"  ~/.pi/agent/pi-tool-permissions.json          (user)",
					"  <cwd>/.pi/pi-tool-permissions.local.json      (project, machine-local)",
				];
				ctx.ui.notify(helpLines.join("\n"), "info");
				return;
			}

			if (trimmed === "list") {
				const implicitAllowSet = new Set(cfg.implicit.allow);
				const implicitTDKeys = new Set(Object.keys(cfg.implicit.toolDefaults));
				const tdEntries = Object.entries(cfg.toolDefaults);
				// Re-read both raw files so we can tag each merged rule with its source.
				const userRaw = loadUserConfigRaw();
				const projectRaw = loadProjectConfigRaw(ctx.cwd);
				const sourceTag = (action: "allow" | "deny" | "ask", rule: string): string => {
					const inUser = userRaw[action]?.includes(rule) ?? false;
					const inProject = projectRaw[action]?.includes(rule) ?? false;
					if (inUser && inProject) return "[user+project]";
					if (inUser) return "[user]";
					if (inProject) return "[project]";
					return "";
				};
				const formatRule = (action: "allow" | "deny" | "ask", r: string, implicitSet?: Set<string>): string => {
					if (implicitSet?.has(r)) return `  [implicit] ${r}`;
					const tag = sourceTag(action, r);
					return tag ? `  ${tag} ${r}` : `  - ${r}`;
				};
				const lines = [
					`default: ${cfg.defaultAction}`,
					`readAllowCwd: ${cfg.implicit.readAllowCwd}`,
					`grepAllowCwd: ${cfg.implicit.grepAllowCwd}`,
					`globAllowCwd: ${cfg.implicit.globAllowCwd}`,
					`lsAllowCwd: ${cfg.implicit.lsAllowCwd}`,
					`readAllowSkills: ${cfg.implicit.readAllowSkills}`,
					`readAllowPiDocs: ${cfg.implicit.readAllowPiDocs}`,
					`readAllowAgentDocs: ${cfg.implicit.readAllowAgentDocs}`,
					`bashReadOnlyAllowCwd: ${cfg.implicit.bashReadOnlyAllowCwd}`,
					`bashAllowPureVarAssign: ${cfg.implicit.bashAllowPureVarAssign}`,
					`allowNoopCd: ${cfg.implicit.allowNoopCd}`,
					`allow all edits (this session): ${allowAllEdits ? "ON" : "OFF"}`,
				`auto mode (this session): ${autoModeEnabled ? "ON" : "OFF"}`,
				`classifier debug (this session): ${classifierDebugEnabled ? "ON" : "OFF"}`,
				`autoMode.classifier: ${cfg.autoMode.classifier ? `${cfg.autoMode.classifier.provider}/${cfg.autoMode.classifier.model}` : "(auto-select)"}`,
				`autoMode.classifyAllShell: ${cfg.autoMode.classifyAllShell}`,
				`autoMode.environment (${cfg.autoMode.environment.length}):`,
				...cfg.autoMode.environment.map((r) => `  - ${r}`),
				`autoMode.allow (${cfg.autoMode.allow.length}):`,
				...cfg.autoMode.allow.map((r) => `  - ${r}`),
				`autoMode.soft_deny (${cfg.autoMode.soft_deny.length}):`,
				...cfg.autoMode.soft_deny.map((r) => `  - ${r}`),
				`autoMode.hard_deny (${cfg.autoMode.hard_deny.length}):`,
				...cfg.autoMode.hard_deny.map((r) => `  - ${r}`),
					`allow (${cfg.allow.length}):`,
					...cfg.allow.map((r) => formatRule("allow", r, implicitAllowSet)),
					`deny (${cfg.deny.length}):`,
					...cfg.deny.map((r) => formatRule("deny", r)),
					`ask (${cfg.ask.length}):`,
					...cfg.ask.map((r) => formatRule("ask", r)),
					`toolDefaults (${tdEntries.length}):`,
					...tdEntries.map(([k, v]) =>
						implicitTDKeys.has(k) ? `  [implicit] ${k} -> ${v}` : `  - ${k} -> ${v}`
					),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const [sub, ...restAll] = trimmed.split(/\s+/);
			// Allow `--user` anywhere after the subcommand to target the user-global config.
			let scope: Scope = "project";
			const rest = restAll.filter((tok) => {
				if (tok === "--user") { scope = "user"; return false; }
				if (tok === "--project") { scope = "project"; return false; }
				return true;
			});
			const value = rest.join(" ").trim();

			switch (sub) {
				case "help":
					// Bare /permissions and /permissions help are handled above; this covers
					// `/permissions help <anything>` by just re-showing help.
					ctx.ui.notify("Use /permissions to see help, or /permissions help.", "info");
					return;
				case "reload":
					reload(ctx.cwd, ctx);
					return;
				case "default": {
					if (!isDefaultAction(value)) {
						ctx.ui.notify(`Usage: /permissions default <allow|deny|ask> [--user] (use \`/permissions auto on\` for auto mode)`, "warning");
						return;
					}
					setDefault(scope, ctx.cwd, value);
					reload(ctx.cwd, ctx);
					ctx.ui.notify(`Set default (${scope}): ${value}`, "info");
					return;
				}
				case "allowalledits": {
					const normalized = value.toLowerCase();
					if (!normalized || normalized === "toggle") {
						applyAllowAllEdits(!allowAllEdits, ctx);
					} else if (normalized === "on") {
						applyAllowAllEdits(true, ctx);
					} else if (normalized === "off") {
						applyAllowAllEdits(false, ctx);
					} else {
						ctx.ui.notify(`Usage: /permissions allowalledits [on|off|toggle]`, "warning");
					}
					return;
				}
				case "auto": {
				const [first, ...restTokens] = value.split(/\s+/);
				if (first?.toLowerCase() === "debug") {
					const debugValue = restTokens.join(" ").trim().toLowerCase();
					if (!debugValue || debugValue === "toggle") {
						applyClassifierDebug(!classifierDebugEnabled, ctx);
					} else if (debugValue === "on") {
						applyClassifierDebug(true, ctx);
					} else if (debugValue === "off") {
						applyClassifierDebug(false, ctx);
					} else {
						ctx.ui.notify(`Usage: /permissions auto debug [on|off|toggle]`, "warning");
					}
					return;
				}
				if (first?.toLowerCase() === "model") {
					const modelArg = restTokens.join(" ").trim().toLowerCase();
					if (modelArg && modelArg !== "clear") {
						ctx.ui.notify(`Usage: /permissions auto model [--user] | auto model clear [--user]`, "warning");
						return;
					}
					if (modelArg === "clear") {
						const removed = clearClassifier(scope, ctx.cwd);
						if (!removed) {
							ctx.ui.notify(`No classifier pin set in ${scope} config.`, "info");
							return;
						}
						reload(ctx.cwd, ctx);
						if (autoModeEnabled && ctx.hasUI) {
							const model = resolveClassifierModelFromCtx(ctx);
							lastAutoStatusId = model?.id;
							ctx.ui.setStatus(STATUS_KEY_AUTO, autoStatusLabel(model));
						}
						ctx.ui.notify(`Classifier pin cleared (${scope}); resuming auto-select.`, "info");
						return;
					}
					if (!ctx.hasUI) {
						ctx.ui.notify("/permissions auto model needs an interactive UI; run it in the TUI.", "warning");
						return;
					}
					const pool = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((s) => s.model) : ctx.modelRegistry.getAvailable();
					const hasAuth = (m: Model<Api>) => ctx.modelRegistry.hasConfiguredAuth(m);
					const pickable = pickableModels(pool, hasAuth);
					if (pickable.length === 0) {
						ctx.ui.notify("No models with configured auth are available.", "warning");
						return;
					}
					// Put the effective current classifier first so it is pre-highlighted.
					const current = resolveClassifierModelFromCtx(ctx);
					const ordered = current
						? [current, ...pickable.filter((m) => modelLabel(m) !== modelLabel(current))]
						: pickable;
					const labels = ordered.map(modelLabel);

					const choice = await ctx.ui.select("Classifier model:", labels, { signal: ctx.signal });
					if (!choice) return; // cancelled

					const slash = choice.indexOf("/");
					const provider = choice.slice(0, slash);
					const modelId = choice.slice(slash + 1);
					setClassifier(scope, ctx.cwd, provider, modelId);
					reload(ctx.cwd, ctx);
					if (autoModeEnabled && ctx.hasUI) {
						const model = resolveClassifierModelFromCtx(ctx);
						lastAutoStatusId = model?.id;
						ctx.ui.setStatus(STATUS_KEY_AUTO, autoStatusLabel(model));
					}
					ctx.ui.notify(`Classifier model set to ${choice} (${scope})`, "info");
					return;
				}
				const normalized = value.toLowerCase();
				if (!normalized || normalized === "toggle") {
					applyAutoMode(!autoModeEnabled, ctx);
				} else if (normalized === "on") {
					applyAutoMode(true, ctx);
				} else if (normalized === "off") {
					applyAutoMode(false, ctx);
				} else {
					ctx.ui.notify(`Usage: /permissions auto [on|off|toggle] | auto debug [on|off|toggle] | auto model [--user] [clear]`, "warning");
				}
				return;
			}
			case "allow":
				case "deny":
				case "ask": {
					if (!value) {
						ctx.ui.notify(`Usage: /permissions ${sub} <rule> [--user]`, "warning");
						return;
					}
					if (!parseRule(value)) {
						ctx.ui.notify(`Invalid rule: ${value}. Expected ToolName or ToolName(pattern).`, "warning");
						return;
					}
					addRule(scope, ctx.cwd, sub, value);
					reload(ctx.cwd, ctx);
					ctx.ui.notify(`Added ${sub} rule (${scope}): ${value}`, "info");
					return;
				}
				case "remove": {
					if (!value) {
						ctx.ui.notify(`Usage: /permissions remove <rule> [--user]`, "warning");
						return;
					}
					const removed = removeRule(scope, ctx.cwd, value);
					if (removed) {
						reload(ctx.cwd, ctx);
						ctx.ui.notify(`Removed rule (${scope}): ${value}`, "info");
					} else {
						ctx.ui.notify(`Rule not found in ${scope} config: ${value}`, "warning");
					}
					return;
				}
				default:
					ctx.ui.notify(
						`Unknown subcommand: ${sub}. Use: help | list | allow | deny | ask | remove | default | reload | allowalledits | auto`,
						"warning",
					);
			}
		},
	});
}

function isDefaultAction(s: string): s is DefaultAction {
	return s === "allow" || s === "deny" || s === "ask";
}
