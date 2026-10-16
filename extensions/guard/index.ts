/** Guard owns four executors. All other tool decisions remain observe-only. */
import { createBashTool, ExtensionSelectorComponent, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type ToolAnnotations, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createGuardAskSelect, supportsOwnedStages } from "./ask-overlay.ts";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { GuardRuntime, validateReadGrant, validateReadRootSave } from "./runtime.ts";
import { DialogGate } from "./dialogs.ts";
import { FAILURE_STATUSES as PYTHON_FAILURES } from "./tools/python/session.ts";
import { FAILURE_STATUSES as NODE_FAILURES } from "./tools/node/session.ts";
import { createGuardShellOperations, SANDBOX_FAILURE_HINT, SHELL_SANDBOX_FAILURE_HINT, sandboxFailureHint } from "./tools/shell.ts";
import type { MountEntry } from "./sandbox/bwrap.ts";
import { createShellRenderCall, nativeBashRenderResult } from "./tools/shell-render.ts";
import { filterSearchResult, type SearchResultEvent } from "./filter.ts";
import { detectSandboxMode } from "./sandbox/detect.ts";
import { PROTECTED_TOP_LEVEL } from "./sandbox/spec.ts";
import { clearUserClassifierPin, loadConfig, loadUserConfigRaw, projectClassifierPin, resolvedClassifierConfig, setUserClassifierPin, dedupe, type ResolvedGuardConfig } from "./policy/config.ts";
import { decide, explainHostShellCommand, pathInsideWriteRoots, resolveDecision, type Decision, type GuardCall, type HostShellExplanation, type PolicyState } from "./policy/decision.ts";
import { makeIsProtectedPath } from "./policy/protected.ts";
import { isOwnedExecutor, type OwnedExecutor } from "./policy/classes.ts";
import { computeMigration } from "./policy/migrate.ts";
import { pickClassifierModel, classifyAction } from "./policy/classifier.ts";
import { addToConfigScope, effectiveAllowSuggestion, readGrantSuggestion } from "./policy/suggest.ts";
import { parseReadRootInput, parseShellRuleLines, planAllowSave, planDenyRules, validateShellSave } from "./policy/save.ts";
import { runExecutionPrompt, runReadGrantPrompt, runWriteEditPrompt, type PromptFlowIO } from "./prompt-flow.ts";
import { createGuardEditorStage, createGuardPickerStage } from "./ask-components.ts";
import { ackWorkspaceLock, createSessionState, footerLabel, lockWorkspace, mapToolCallToGuardCall, profileEventPayload, profileChangeAllowed, releaseResearchHold, requestResearchHold, setProfile, toPolicyState, type GuardSessionState } from "./policy/state.ts";
import { constraintFromParse, INHERIT_ENV, parseInheritance, type InheritanceConstraint, type InheritanceContract } from "./policy/inheritance.ts";
import { isProfile, ALL_PROFILES, PROFILE_LADDER, nextProfile, type Profile } from "./policy/profiles.ts";
import { modelLabel, pickableModels } from "../shared/model-selection.ts";

const DEFAULT_CYCLE_SHORTCUT = "ctrl+alt+g";

/** Hideable, bounded dialog overlay for guard's four TUI dialogs (see ask-overlay.ts). */
const askSelect = createGuardAskSelect({ ExtensionSelectorComponent, matchesKey, isKeyRelease, isKeyRepeat });

/** Owned stage components for the save/deny/compound prompt flows. */
const editorStage = createGuardEditorStage();
const pickerStage = createGuardPickerStage();

/** Shape of the step-5 snapshot/contract ack payloads this extension emits. */
interface SubagentAckBase {
	version: 1;
	ok: boolean;
	reason?: string;
}

function isSubagentRequest(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return keys.every((key) => typeof record[key] === "string" && (record[key] as string).length > 0);
}

function ackId(request: Record<string, unknown> | null): string | null {
	return request && typeof request.id === "string" && request.id ? request.id : null;
}

function ackNonce(request: Record<string, unknown> | null): string | null {
	return request && typeof request.nonce === "string" && request.nonce ? request.nonce : null;
}
const workerParameters = Type.Object({
	action: Type.Optional(Type.Union([Type.Literal("execute"), Type.Literal("status"), Type.Literal("reset")])),
	code: Type.Optional(Type.String()),
	timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })),
});

export default function guard(pi: ExtensionAPI) {
	// Step 5: parse the subagent inheritance contract once per process. Later
	// environment changes must not relax an already-initialized child, and an
	// explicitly present but invalid contract blocks the session instead of
	// falling back to an ordinary default-profile runtime.
	const parsedInheritance = parseInheritance(process.env[INHERIT_ENV]);
	const inheritedConstraint: InheritanceConstraint | null = constraintFromParse(parsedInheritance);
	const inheritedContract: InheritanceContract | null = parsedInheritance.ok ? parsedInheritance.contract : null;
	let state: GuardSessionState | null = null;
	let config: ResolvedGuardConfig | null = null;
	let runtime: GuardRuntime | null = null;
	// One gate per factory serializes every guard-owned dialog. It is never
	// replaced: a stale selector may still own the TUI's single dialog slot
	// during a session change, so only its requests are invalidated.
	const dialogs = new DialogGate();
	let lastCtx: ExtensionContext | null = null;
	let debugEnabled = false;
	let sessionReadRoots: string[] = [];
	let annotationSnapshot: Array<{ name: string; annotations?: ToolAnnotations }> | null = null;
	const classifierCache = new Map<string, { verdict: "allow" | "soft_deny" | "hard_deny" | "no_match"; reason: string }>();

	function getAnnotations(name: string): ToolAnnotations | undefined {
		if (annotationSnapshot === null) annotationSnapshot = pi.getAllTools().map((t) => ({ name: t.name, annotations: t.annotations }));
		return annotationSnapshot.find((t) => t.name === name)?.annotations;
	}
	function effectiveConfig(): ResolvedGuardConfig {
		if (!config) throw new Error("guard session state not initialized");
		return { ...config, readRoots: [...new Set([...config.readRoots, ...sessionReadRoots])] };
	}
	function policyFor(ctx: ExtensionContext): PolicyState {
		if (!state || !runtime) throw new Error("guard session state not initialized");
		if (runtime.policy.cwd !== ctx.cwd) throw new Error("guard cwd changed; awaiting session replacement");
		return { ...runtime.policy, interactive: ctx.hasUI };
	}
	function updateFooter(ctx: ExtensionContext): void {
		try {
			const label = [state ? footerLabel(state) : "", runtime?.teardownFailure ? "execution blocked (unresolved teardown)" : ""].filter(Boolean).join(" | ");
			ctx.ui.setStatus("guard", label ? ctx.ui.theme.fg(state?.profile === "unrestricted" ? "error" : "warning", `guard: ${label}`) : undefined);
		} catch { /* best effort */ }
	}
	function emitProfile(ctx: ExtensionContext): void {
		if (state && config) pi.events.emit("guard:profile", profileEventPayload(state, effectiveConfig(), ctx.cwd));
	}
	function publish(ctx: ExtensionContext): void { updateFooter(ctx); emitProfile(ctx); }
	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" = "info"): void {
		try { ctx.ui.notify(message, level); } catch { /* notification does not weaken enforcement */ }
	}
	/**
	 * Open one guard dialog selector. Presentation routing only: TUI hosts
	 * render the guard-owned hideable overlay (ask-overlay.ts); hosts or modes
	 * without the required capabilities fall back to the plain signal-aware
	 * native selector inside the adapter.
	 */
	async function gatedSelect(ctx: ExtensionContext, title: string, options: string[], signal: AbortSignal): Promise<string | undefined> {
		if (ctx.mode !== "tui") return ctx.ui.select(title, options, { signal });
		return askSelect(ctx.ui, title, options, signal);
	}
	/**
	 * Wrap one admitted guard interaction (every stage of a dialog: selector,
	 * editor, picker, preview, steering input) so the TUI working spinner is
	 * hidden once for the complete body and `herdr:blocked` spans the whole
	 * lease instead of flashing between stages. Visibility failures are
	 * cosmetic and never change the interaction's result; restoration always
	 * passes true because the UI API has no visibility getter. RPC and print
	 * have no terminal spinner (the RPC setter is a no-op) but still emit the
	 * herdr events, matching the previous per-selector coverage.
	 */
	async function admittedDialog<T>(ctx: ExtensionContext, body: () => Promise<T>): Promise<T> {
		// Report blocked to herdr while a guard dialog awaits user input (the
		// pane would otherwise show "working"). Ignored outside herdr; released
		// in the finally below on every settle path.
		pi.events.emit("herdr:blocked", { active: true, label: "guard: awaiting user input" });
		try {
			if (ctx.mode !== "tui") return await body();
			try { ctx.ui.setWorkingVisible(false); } catch { /* cosmetic; the dialog outcome is unaffected */ }
			try { return await body(); } finally {
				try { ctx.ui.setWorkingVisible(true); } catch { /* cosmetic; never masks the dialog's result or error */ }
			}
		} finally {
			pi.events.emit("herdr:blocked", { active: false });
		}
	}
	/** True when the host can mount the owned editor/picker stages (full save contract). */
	function ownedStagesFor(ctx: ExtensionContext): boolean {
		return ctx.mode === "tui" && supportsOwnedStages(ctx.ui);
	}
	/** The prompt-flow IO surface for one dialog body, bound to this context. */
	function promptIO(ctx: ExtensionContext): PromptFlowIO {
		const owned = ownedStagesFor(ctx);
		return {
			select: (title, options, signal) => gatedSelect(ctx, title, options, signal),
			editor: owned ? (title, prefill, signal) => editorStage(ctx.ui, signal, { title, prefill }) : undefined,
			picker: owned ? (title, steps, signal) => pickerStage(ctx.ui, signal, { title, steps }) : undefined,
			inputText: (title, signal) => ctx.ui.input(title, undefined, { signal }),
			notify: (message, level) => notify(ctx, message, level),
		};
	}
	function configDestination(ctx: ExtensionContext, scope: "project" | "user"): string {
		return scope === "project" ? `${ctx.cwd}/.pi/guard.local.json` : `${homedir()}/.pi/agent/guard.json`;
	}
	function classifierModel(ctx: ExtensionContext): Model<Api> | undefined {
		return pickClassifierModel(ctx.scopedModels.length ? ctx.scopedModels.map((s) => s.model) : ctx.modelRegistry.getAvailable(), ctx.model?.provider, (m) => ctx.modelRegistry.hasConfiguredAuth(m), config?.classifier, (provider, modelId) => ctx.modelRegistry.find(provider, modelId));
	}
	/** Recompute the session's classifier label after a config change, then publish: startSession only computes it once, so a /guard reload or a /guard model write would otherwise leave a stale label in the footer. */
	function refreshClassifierLabel(ctx: ExtensionContext): void {
		if (!state) return;
		try { state.classifierLabel = classifierModel(ctx)?.id ?? null; } catch { state.classifierLabel = null; }
		publish(ctx);
	}
	async function classify(call: GuardCall, ctx: ExtensionContext) {
		const model = classifierModel(ctx);
		if (!model || !config) return { verdict: "no_match" as const, reason: "no classifier model available" };
		const tool = call.kind === "host-shell" ? call.shell === "pwsh" ? "pwsh" : "HostBash" : "tool" in call ? call.tool : call.kind === "web-fetch" ? "webfetch" : "unknown";
		const input = call.kind === "host-shell" || call.kind === "sandboxed-exec" ? { command: call.command ?? "" } : call.kind === "local-read" || call.kind === "local-write" ? { path: call.path ?? "" } : call.kind === "web-fetch" ? { url: call.url } : call.kind === "remote-write" ? call.input ?? {} : {};
		return { ...await classifyAction((m, cc) => ctx.modelRegistry.streamSimple(m, cc).result(), model, tool, input, resolvedClassifierConfig(config), classifierCache), modelId: String(model.id) };
	}
	function mappedCall(name: string, input: Record<string, unknown>) {
		return mapToolCallToGuardCall(name, input, effectiveConfig(), getAnnotations);
	}
	async function decisionFor(name: string, input: Record<string, unknown>, ctx: ExtensionContext, policy = policyFor(ctx)): Promise<Decision> {
		return resolveDecision({ ...policy, interactive: ctx.hasUI }, mappedCall(name, input).call, (call) => classify(call, ctx));
	}
	/**
	 * Revalidate a captured dialog context immediately before display and
	 * after answering: operation cancellation is checked separately through
	 * the gate's dialog signal (throwIfAborted), this covers runtime identity,
	 * epoch, availability, unresolved teardown, and cwd compatibility.
	 */
	function assertDialogCurrent(rt: GuardRuntime, epoch: number, ctx: ExtensionContext, cwd: string, expired: string): void {
		if (rt !== runtime || epoch !== rt.epoch || rt.teardownFailure) throw new Error(expired);
		rt.assertAvailable();
		if (rt.policy.cwd !== cwd || ctx.cwd !== cwd) throw new Error("guard cwd changed; awaiting session replacement");
	}
	function configSignature(cfg: ResolvedGuardConfig): string {
		const { warnings: _warnings, ...policy } = cfg as ResolvedGuardConfig & { warnings?: string[] };
		return JSON.stringify(policy);
	}
	/** The effective policy state for a freshly loaded config, including session read roots. */
	function policyWithSessionRoots(ctx: ExtensionContext, cfg: ResolvedGuardConfig): PolicyState {
		if (!state || !runtime) throw new Error("guard session state not initialized");
		return toPolicyState(state, { ...cfg, readRoots: [...new Set([...cfg.readRoots, ...sessionReadRoots])] }, ctx.cwd, ctx.hasUI);
	}
	/**
	 * Deliver post-denial steering through the existing SDK handoff. The
	 * captured owner (call signal, runtime identity, cwd, and the owning commit
	 * epoch recorded synchronously in beforeCommit) is checked immediately
	 * before the synchronous dispatch; invalid ownership suppresses dispatch.
	 * Once handed to pi.sendUserMessage, existing SDK semantics apply: the call
	 * returns void and input handlers or SDK processing can delay delivery
	 * beyond a later abort. Guard owns the pre-dispatch checks only; there is
	 * no post-dispatch cancellation, ownership binding, or rollback.
	 */
	function deliverSteering(text: string | undefined, signal: AbortSignal | undefined, rt: GuardRuntime, owningEpoch: number, cwd: string): void {
		if (!text) return;
		if (rt !== runtime || rt.teardownFailure) return;
		if (rt.epoch !== owningEpoch || rt.policy.cwd !== cwd) return;
		if (signal?.aborted) return;
		pi.sendUserMessage(text, { deliverAs: "steer" });
	}
	async function transition(next: GuardSessionState, cfg: ResolvedGuardConfig, ctx: ExtensionContext, persistence?: { epoch: number; beforeCommit: () => ResolvedGuardConfig }, commandGuard?: { epoch: number; check: () => void }): Promise<void> {
		if (!runtime) throw new Error("guard session state not initialized");
		// A policy boundary invalidates every queued or open dialog
		// synchronously, before the first await. A dialog that produced this
		// transition already left the gate, so a successful save, grant, or
		// profile choice cannot cancel itself; other pending dialogs fail closed.
		dialogs.invalidate("approval expired after a policy change");
		const rt = runtime;
		const baseState = state;
		let committedConfig = cfg;
		const policy = toPolicyState(next, { ...cfg, readRoots: [...new Set([...cfg.readRoots, ...sessionReadRoots])] }, ctx.cwd, ctx.hasUI);
		await rt.transition(policy, next.sandbox ?? detectSandboxMode(), () => {
			state = { ...next, workspaceLocked: rt.policy.workspaceLocked, workspaceLockReason: rt.policy.workspaceLocked ? state?.workspaceLockReason ?? next.workspaceLockReason : null };
			config = committedConfig;
			annotationSnapshot = null;
			classifierCache.clear();
			publish(ctx);
		}, () => {
			if (rt !== runtime || state !== baseState) throw new Error("guard: stale policy transition; retry the request");
		}, persistence ? { preempt: true, invalidateWorkers: true, expectedEpoch: persistence.epoch, beforeCommit: () => {
			// Command-only final commit guard: recheck the captured owner signal
			// after all asynchronous teardown, immediately before persistence or
			// policy assignment. Never a general cancellation framework.
			commandGuard?.check();
			committedConfig = persistence.beforeCommit();
			return toPolicyState(next, { ...committedConfig, readRoots: [...new Set([...committedConfig.readRoots, ...sessionReadRoots])] }, ctx.cwd, ctx.hasUI);
		} } : commandGuard ? { expectedEpoch: commandGuard.epoch, beforeCommit: commandGuard.check } : undefined);
	}

	async function startSession(ctx: ExtensionContext, fresh: boolean): Promise<void> {
		if (runtime) {
			dialogs.invalidate("approval expired after a session replacement");
			await runtime.dispose(fresh ? "session replacement" : "session tree/cwd replacement");
		}
		lastCtx = ctx;
		if (fresh || !state || !config) {
			config = loadConfig(ctx.cwd);
			sessionReadRoots = [];
			state = createSessionState({ config, sandbox: detectSandboxMode(), cwd: ctx.cwd, interactive: ctx.hasUI, inherited: inheritedConstraint });
		} else if (config.cwd !== ctx.cwd) {
			config = loadConfig(ctx.cwd);
		}
		annotationSnapshot = null;
		classifierCache.clear();
		if (inheritedConstraint && "error" in inheritedConstraint) {
			// Invalid inheritance: keep the explicit blocked state, never an
			// executable default-profile runtime. Owned executors fail closed
			// because policyFor() and authorize() require a runtime.
			state.classifierLabel = null;
			notify(ctx, `guard: subagent inheritance is invalid; guard is blocked for this session: ${inheritedConstraint.error}`, "warning");
			publish(ctx);
			return;
		}
		try { state.classifierLabel = classifierModel(ctx)?.id ?? null; } catch { state.classifierLabel = null; }
		runtime = new GuardRuntime({
			policy: toPolicyState(state, effectiveConfig(), ctx.cwd, ctx.hasUI), detection: state.sandbox ?? detectSandboxMode(),
			// Audit locking advances the epoch without the central transition
			// wrapper, so invalidation happens here, synchronously in the callback.
			onLock: (reason) => { dialogs.invalidate("approval expired; the workspace locked"); if (state) { lockWorkspace(state, reason); updateFooter(ctx); } },
			onWarning: (message) => { updateFooter(ctx); notify(ctx, message, "warning"); },
			onLockSettled: () => publish(ctx),
		});
		for (const warning of (config as ResolvedGuardConfig & { warnings?: string[] }).warnings ?? []) notify(ctx, warning, "warning");
		publish(ctx);
	}
	pi.on("session_start", async (_event, ctx) => { await startSession(ctx, true); });
	pi.on("session_tree", async (_event, ctx) => { await startSession(ctx, false); });
	pi.on("session_shutdown", async () => {
		dialogs.invalidate("approval expired during shutdown");
		if (runtime) await runtime.dispose();
		runtime = null;
		lastCtx = null;
	});

	pi.on("tool_call", async (event, ctx) => {
		const owned = isOwnedExecutor(event.toolName);
		// Write/edit on non-owned tools is enforced (settled 2026-10-16 design):
		// block on deny, approval dialog on prompt. Everything else stays
		// observe-only. Captured outside the try so failures fail closed.
		const enforceWriteEdit = !owned && (event.toolName.toLowerCase() === "write" || event.toolName.toLowerCase() === "edit");
		try {
			const input = (event.input ?? {}) as Record<string, unknown>;
			const policy = policyFor(ctx);
			const mapped = mappedCall(event.toolName, input);
			// No classifier or dialog here for owned tools: execute is authoritative.
			const decision = owned ? decide({ ...policy, interactive: ctx.hasUI }, mapped.call) : await decisionFor(event.toolName, input, ctx, policy);
			// Pathless local writes (memory_write, scratchpad, ...) stay observe-only.
			const enforced = enforceWriteEdit && mapped.call.kind === "local-write" && mapped.call.path !== undefined;
			pi.events.emit("guard:decision", { toolName: event.toolName, class: mapped.cls, call: mapped.call, ...decision, enforcement: owned || enforced });
			if (debugEnabled) notify(ctx, `[guard ${owned || enforced ? "enforce" : "observe"}] ${event.toolName}: ${decision.action} (${decision.reason})`);
			if (owned && (decision.action === "deny" || runtime?.teardownFailure)) return { block: true, reason: runtime?.teardownFailure ?? decision.reason };
			if (enforced && runtime) return await enforceLocalWrite(runtime, event.toolName, input, ctx, decision);
		} catch (err) {
			if (owned) return { block: true, reason: `guard: authorization failed closed: ${String(err)}` };
			if (enforceWriteEdit) return { block: true, reason: `guard: write/edit authorization failed closed: ${String(err)}` };
			// Observation errors never block unrelated tools.
		}
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "grep" && event.toolName !== "ffgrep") return;
		try { return filterSearchResult(event as unknown as SearchResultEvent, { profile: state?.profile ?? "default", cwd: ctx.cwd, config: effectiveConfig() }); }
		catch { return { content: [{ type: "text" as const, text: "Search result suppressed by guard: unable to safely filter masked files." }], details: undefined, isError: true }; }
	});

	function assertCallActive(signal?: AbortSignal): void {
		if (signal?.aborted) throw new Error("guard: call aborted; nothing saved or executed");
	}
	/**
	 * Enforce one write/edit decision for a non-owned tool (settled 2026-10-16
	 * design): deny blocks with the reason, allow runs, prompt opens the
	 * approval dialog inside the tool_call hook. The SDK holds the tool call
	 * while this awaits; per-batch preparation is sequential and the DialogGate
	 * serializes across batches. In-root non-protected targets in the default
	 * profile additionally offer the switch to the allow-edits rung, applied
	 * AFTER the dialog lease releases: the profile transition invalidates open
	 * dialogs synchronously, so applying it inside the lease would cancel its
	 * own dialog. Post-answer staleness (runtime identity, epoch, cwd) denies,
	 * mirroring authorize. Subagent children run with -p (print mode), so the
	 * ctx.hasUI check covers the child contract: prompts deny.
	 */
	async function enforceLocalWrite(rt: GuardRuntime, toolName: string, input: Record<string, unknown>, ctx: ExtensionContext, decision: Decision): Promise<{ block: true; reason: string } | undefined> {
		rt.assertAvailable();
		const epoch = rt.epoch;
		const cwd = rt.policy.cwd;
		if (decision.action === "deny") return { block: true, reason: `guard: ${decision.reason}` };
		if (decision.action === "allow") return undefined;
		if (!ctx.hasUI) return { block: true, reason: "guard: headless write/edit prompts deny" };
		const mapped = mappedCall(toolName, input);
		if (mapped.call.kind !== "local-write" || mapped.call.path === undefined) return undefined;
		const policy = policyFor(ctx);
		const offerSwitch = state?.profile === "default"
			&& pathInsideWriteRoots(mapped.call.path, policy.config)
			&& !makeIsProtectedPath(policy.config)(mapped.call.path);
		const outcome = await dialogs.run({}, async (dialogSignal) => {
			dialogSignal.throwIfAborted();
			assertDialogCurrent(rt, epoch, ctx, cwd, "guard: approval expired; nothing saved or executed");
			const result = await admittedDialog(ctx, () => runWriteEditPrompt({
				io: promptIO(ctx),
				signal: dialogSignal,
				toolName,
				path: mapped.call.kind === "local-write" ? mapped.call.path! : "",
				decision,
				offerSwitch,
			}));
			dialogSignal.throwIfAborted();
			assertDialogCurrent(rt, epoch, ctx, cwd, "guard: approval expired; nothing saved or executed");
			return result;
		});
		// The lease has been released: the switch transition below can no longer
		// cancel its own dialog.
		if (outcome.kind === "allow-once") return undefined;
		if (outcome.kind === "deny-once") {
			deliverSteering(outcome.steering, undefined, rt, epoch, cwd);
			return { block: true, reason: "guard: write/edit denied" };
		}
		// switch-to-allow-edits: land the rung through the same transition path
		// as the profile commands (research holds and inherited restrictions are
		// honored), then approve the current call. A refused or failed transition
		// denies the call.
		if (rt !== runtime || epoch !== rt.epoch || !state || !config || rt.teardownFailure) throw new Error("guard: approval expired after a policy change");
		const next = { ...state };
		const applied = setProfile(next, "allow-edits");
		if (!applied.ok) return { block: true, reason: `guard: ${applied.notice}` };
		try {
			await transition(next, config, ctx);
			notify(ctx, "Profile: allow-edits (this session only)");
			return undefined;
		} catch (err) {
			return { block: true, reason: `guard: profile transition failed; write/edit denied: ${String(err)}` };
		}
	}
	/**
	 * Ownership of one interactive command operation (profile picker, migrate
	 * confirmation). The initiating context's signal is captured once: it is a
	 * live getter that later returns the current agent operation's signal or
	 * undefined when idle, so rereading it after the dialog would transfer or
	 * drop ownership, and an operation that began without a signal must never
	 * attach itself to a later one. The cancelled marker is a per-operation
	 * Error instance: only identity against it classifies a failure as
	 * expected command cancellation, never a signal that merely happens to be
	 * aborted at the same time as a genuine failure.
	 */
	interface CommandOwnership {
		signal: AbortSignal | undefined;
		cancelled: Error;
	}
	function assertOwnerLive(ownership: CommandOwnership): void {
		if (ownership.signal?.aborted) throw ownership.cancelled;
	}
	/** Return an epoch-bound once token. Never hold the runtime queue in a dialog. */
	async function authorize(rt: GuardRuntime, name: OwnedExecutor, input: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal): Promise<number> {
		rt.assertAvailable();
		assertCallActive(signal);
		const epoch = rt.epoch;
		const decision = await decisionFor(name, input, ctx);
		assertCallActive(signal);
		rt.assertAvailable();
		if (rt !== runtime || epoch !== rt.epoch || rt.teardownFailure) throw new Error("guard: approval expired after a policy change");
		if (decision.action === "deny") throw new Error(`guard: ${decision.reason}`);
		if (decision.action === "allow") return epoch;
		if (!ctx.hasUI) throw new Error("guard: headless prompts deny");
		const policy = policyFor(ctx);
		const mapped = mappedCall(name, input).call;
		// Raw/degraded bash is a host shell for routing and saving, too.
		const call: GuardCall = mapped.kind === "sandboxed-exec" && name === "bash" ? { kind: "host-shell", shell: "host-bash", command: String(input.command ?? "") } : mapped;
		const shellCall = call.kind === "host-shell" ? call : null;
		const explanation = shellCall ? explainHostShellCommand(shellCall, policy) : null;
		// Persistent saves require the owned editor stages. Capability-limited
		// hosts keep the once actions; missing capabilities are detected BEFORE
		// the dialog so save actions are never offered and then fail.
		const ownedStages = ownedStagesFor(ctx);
		const allowPlan = shellCall && explanation && ownedStages ? planAllowSave(shellCall, policy, explanation) : null;
		const denySaveSupported = shellCall !== null && ownedStages;
		const commandText = shellCall ? shellCall.command : typeof input.code === "string" ? input.code : "";
		// The gate holds the UI lease only across pre-display validation, the
		// complete interaction, and post-answer validation. Persistence and
		// execution happen after the lease is released, so the transition this
		// choice triggers cannot cancel its own dialog.
		const cwd = rt.policy.cwd;
		const outcome = await dialogs.run({ signal }, async (dialogSignal) => {
			dialogSignal.throwIfAborted();
			assertDialogCurrent(rt, epoch, ctx, cwd, "guard: approval expired; nothing saved or executed");
			const result = await admittedDialog(ctx, () => runExecutionPrompt({
				io: promptIO(ctx),
				signal: dialogSignal,
				toolName: name,
				command: commandText,
				decision,
				explanation,
				allowPlan,
				denySaveSupported,
				shell: shellCall?.shell ?? "host-bash",
				scopes: ["project", "user"],
				parseRules: (text) => parseShellRuleLines(text, shellCall?.shell ?? "host-bash"),
				validateRules: (intent, rules) => shellCall
					? validateShellSave(shellCall, policy, intent, rules)
					: { ok: false as const, error: "only host-shell calls support rule saves" },
				denyRulesFor: (ids) => shellCall && explanation ? planDenyRules(shellCall, explanation, ids) : [],
				destination: (scope) => configDestination(ctx, scope),
			}));
			dialogSignal.throwIfAborted();
			assertDialogCurrent(rt, epoch, ctx, cwd, "guard: approval expired; nothing saved or executed");
			return result;
		});
		assertCallActive(signal);
		if (outcome.kind === "allow-once") return epoch;
		if (outcome.kind === "deny-once") {
			deliverSteering(outcome.steering, signal, rt, epoch, cwd);
			throw new Error("guard: execution denied");
		}
		if (outcome.kind === "save-allow") {
			if (!shellCall) throw new Error("guard: only host-shell calls support rule saves");
			// Re-read current config and revalidate the ACTUAL reviewed patch
			// (never a regenerated suggestion) against the latest effective policy.
			const diskConfig = loadConfig(ctx.cwd);
			const latestCheck = validateShellSave(shellCall, policyWithSessionRoots(ctx, diskConfig), "allow", outcome.rules);
			if (!latestCheck.ok) throw new Error(`guard: the reviewed rules no longer authorize the complete call (${latestCheck.error}); nothing saved or executed`);
			const target = { ...diskConfig, hostBash: { ...diskConfig.hostBash, allow: dedupe([...diskConfig.hostBash.allow, ...outcome.rules]) } };
			let owningEpoch = epoch;
			await transition({ ...state! }, target, ctx, { epoch, beforeCommit: () => {
				assertCallActive(signal);
				if (configSignature(loadConfig(ctx.cwd)) !== configSignature(diskConfig)) throw new Error("guard: config changed while waiting; nothing saved or executed");
				const fresh = loadConfig(ctx.cwd);
				const freshCheck = validateShellSave(shellCall, policyWithSessionRoots(ctx, fresh), "allow", outcome.rules);
				if (!freshCheck.ok) throw new Error(`guard: the reviewed rules no longer authorize the complete call (${freshCheck.error}); nothing saved`);
				// Record the owning commit epoch synchronously (no await between the
				// final checks and the write) for the steering/execution ownership checks.
				owningEpoch = rt.epoch;
				addToConfigScope(outcome.scope, { hostBash: { allow: outcome.rules } }, { cwd: ctx.cwd });
				return loadConfig(ctx.cwd);
			} });
			return rt.epoch;
		}
		if (!shellCall) throw new Error("guard: only host-shell calls support rule saves");
		// save-deny: the steering was collected inside the flow before the commit.
		const diskConfig = loadConfig(ctx.cwd);
		const latestCheck = validateShellSave(shellCall, policyWithSessionRoots(ctx, diskConfig), "deny", outcome.rules);
		if (!latestCheck.ok) throw new Error(`guard: the reviewed rules no longer deny the complete call (${latestCheck.error}); nothing saved`);
		const target = { ...diskConfig, hostBash: { ...diskConfig.hostBash, deny: dedupe([...diskConfig.hostBash.deny, ...outcome.rules]) } };
		let owningEpoch = epoch;
		await transition({ ...state! }, target, ctx, { epoch, beforeCommit: () => {
			assertCallActive(signal);
			if (configSignature(loadConfig(ctx.cwd)) !== configSignature(diskConfig)) throw new Error("guard: config changed while waiting; nothing saved or executed");
			const fresh = loadConfig(ctx.cwd);
			const freshCheck = validateShellSave(shellCall, policyWithSessionRoots(ctx, fresh), "deny", outcome.rules);
			if (!freshCheck.ok) throw new Error(`guard: the reviewed rules no longer deny the complete call (${freshCheck.error}); nothing saved`);
			owningEpoch = rt.epoch;
			addToConfigScope(outcome.scope, { hostBash: { deny: outcome.rules } }, { cwd: ctx.cwd });
			return loadConfig(ctx.cwd);
		} });
		// Committed: keep the saved rule; suppress steering if ownership went
		// invalid between the commit and the handoff.
		deliverSteering(outcome.steering, signal, rt, owningEpoch, cwd);
		throw new Error("guard: execution denied");
	}

	function appendWarnings(result: AgentToolResult<any>, warnings: string[]): AgentToolResult<any> {
		if (!warnings.length) return result;
		return { ...result, content: [...result.content, { type: "text", text: warnings.join("\n") }] };
	}
	async function executeShell(name: "bash" | "host_bash", id: string, input: { command: string; timeout?: number }, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext): Promise<AgentToolResult<any>> {
		const rt = runtime;
		if (!rt) throw new Error("guard session state not initialized");
		const epoch = await authorize(rt, name, input, ctx, signal);
		const outcome = await rt.run(async (policy) => {
			if (rt !== runtime || rt.epoch !== epoch) return false;
			const decision = await decisionFor(name, input, ctx, policy);
			return decision.action !== "deny";
		}, async (execution) => {
			const host = name === "host_bash" || execution.policy.sandboxMode === "degraded" || (!execution.policy.workspaceLocked && (execution.policy.profile === "yolo" || execution.policy.profile === "unrestricted"));
			let mountedPaths: MountEntry[] | undefined;
			const tool = createBashTool(ctx.cwd, { operations: createGuardShellOperations(execution, host, (paths) => { mountedPaths = paths; }), exposeSessionEnvironment: false });
			const run = () => tool.execute(id, input, execution.signal, onUpdate);
			try {
				const result = host ? await run() : await rt.sandboxBoundary(run, execution.warnings);
				if (!host && result.isError) return appendWarnings(result, [sandboxFailureHint(input.command, mountedPaths)]);
				return result;
			} catch (err) {
				if (!host) throw new Error(`${err instanceof Error ? err.message : String(err)}\n${SHELL_SANDBOX_FAILURE_HINT}`);
				throw err;
			}
		}, signal);
		return appendWarnings(outcome.result, outcome.warnings);
	}
	const bash = createBashTool(process.cwd(), { exposeSessionEnvironment: false });
	for (const name of ["bash", "host_bash"] as const) pi.registerTool({
		...bash, name, label: name,
		description: name === "bash"
			? `Sandboxed: no network, no host credentials, and only the workspace, granted read roots, and toolchain dirs are visible. ${bash.description} Guard sandboxed except in raw profiles: no network and no host credentials, so commands that need either (gh, curl, ssh, git push/fetch, package installs) fail here; use host_bash for those. Only the workspace, the shared scratch directory, configured read roots, and standard toolchain directories are mounted: other host paths (for example ~/.pi or other repositories) are not visible, and commands that need them fail; use host_bash for those. Shared real-path scratch. For persistent sandbox read access outside the mounts, request a grant with the request_read_access tool.`
			: `${bash.description} Runs on the host with full network access and host credentials; use it for network or auth commands (gh, curl, ssh, git push/fetch, package installs), and for host paths outside the sandbox mounts (for example ~/.pi or other repositories). Subject to HostBash rules and guard profile.`,
		renderCall: createShellRenderCall(name),
		// The wrapped tool definition carries no renderers; without this, host_bash has no
		// built-in renderer fallback and its results never show the Elapsed/Took line.
		renderResult: nativeBashRenderResult,
		execute: (id, input, signal, onUpdate, ctx) => executeShell(name, id, input, signal, onUpdate, ctx),
	});
	for (const name of ["python", "node"] as const) pi.registerTool({
		name, label: name, parameters: workerParameters, outputSchema: Type.Any(),
		// Static capability metadata for the registered tool: the interpreters
		// execute arbitrary code and can write, so they are declared write-capable
		// and open-world (raw profiles expose the host; sandboxed profiles
		// constrain it at execution time, which annotations do not describe).
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		description: `Persistent ${name} interpreter managed by guard. Sandboxed workers use throwaway workspace overlays, no network and shared real-path scratch. action=reset discards state, not scratch; action=status never starts a worker. Raw profiles expose the host. Unavailable in degraded mode.`,
		execute: async (_id, input, signal, _onUpdate, ctx) => {
			const rt = runtime;
			if (!rt) throw new Error("guard session state not initialized");
			const epoch = await authorize(rt, name, input, ctx, signal);
			const outcome = await rt.run(async (policy) => rt === runtime && rt.epoch === epoch && (await decisionFor(name, input, ctx, policy)).action === "allow", (execution) => rt.worker(name, input, execution), signal);
			let data = outcome.result as Record<string, any>;
			if (data.status === "permission_needed" && typeof data.permissionPath === "string") {
				const grant = await requestReadGrant(rt, name, String(data.permissionPath), ctx, signal, "worker");
				// Project the typed outcome into the existing worker response fields
				// (diagnostic/stateLost/stateLostReason), byte-identical to the former
				// handleReadGrant payloads. An empty refusal diagnostic is the no-UI
				// passthrough: no field changes.
				if (grant.kind === "granted") data = { ...data, stateLost: true, stateLostReason: "read roots changed", diagnostic: `Read-only grant added: ${grant.root}. Worker state discarded. Code was not replayed; run it again explicitly.` };
				else if (grant.kind === "denied") data = { ...data, diagnostic: "Read request denied." };
				else if (grant.diagnostic !== "") data = { ...data, diagnostic: grant.diagnostic };
			}
			const failed = (name === "python" ? PYTHON_FAILURES : NODE_FAILURES).has(data.status);
			const text = [data.stdout, data.stderr, data.repr ?? data.value, data.exception ? JSON.stringify(data.exception) : "", data.diagnostic, data.stateLost ? `Interpreter state lost: ${data.stateLostReason ?? "worker stopped"}. Scratch retained.` : "", !data.status ? JSON.stringify(data) : `status: ${data.status}`, failed && rt.policy.profile !== "yolo" && rt.policy.profile !== "unrestricted" ? SANDBOX_FAILURE_HINT : ""].filter(Boolean).join("\n");
			return appendWarnings({ content: [{ type: "text", text }], details: data, structuredContent: data, isError: failed }, outcome.warnings);
		},
	});

	// Model-callable read-access request. NOT an owned executor and never
	// routed through rt.run or the execution queue: execute runs one
	// guard-internal decisionFor self-check, then opens the same read-grant
	// dialog the workers use through the shared requestReadGrant helper. The
	// dialog is the consent surface: an allow decision still opens it (never
	// an automatic grant), and the dialog discloses the request path,
	// suggested root, and scope being authorized. readOnlyHint is false
	// because the tool mutates guard authorization state (persistent saves
	// write the guard config and applying a grant stops interpreter workers).
	pi.registerTool({
		name: "request_read_access",
		label: "request_read_access",
		parameters: Type.Object({ path: Type.String({ description: "Absolute path to the file or directory to read" }) }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		description: "Opens a guard dialog asking the user for read-only access to an absolute host path outside the sandbox mounts: a session grant or a persistent read root saved to the guard config. Mutates guard authorization state; applying a grant stops running interpreter workers. Requires an interactive session; non-interactive contexts refuse. Never re-runs anything: nothing is executed or replayed here, and no read happens; re-run the read yourself after a grant.",
		execute: async (_id, input, signal, _onUpdate, ctx) => {
			const errorResult = (text: string): AgentToolResult<any> => ({ content: [{ type: "text", text }], details: undefined, isError: true });
			const rt = runtime;
			if (!rt) throw new Error("guard session state not initialized");
			if (signal?.aborted) return errorResult("No read grant: call aborted.");
			const requestPath = typeof input.path === "string" ? input.path : "";
			// The read-grant primitives resolve rather than reject relative input,
			// so the entry enforces isAbsolute itself: no dialog, no policy
			// evaluation, and the request is judged only on the resolved location.
			if (!isAbsolute(requestPath)) return errorResult("request_read_access requires an absolute path; resolve the path first.");
			const cwd = rt.policy.cwd;
			// Captured before the decisionFor self-check: the classifier call can
			// take seconds, and an epoch advance that keeps the same runtime
			// instance (for example /guard reload) must invalidate the verdict
			// before any UI.
			const epoch = rt.epoch;
			const decision = await decisionFor("request_read_access", { path: requestPath }, ctx);
			// Post-await recheck before opening any UI: the owning call signal,
			// runtime/session freshness (a captured runtime must be the live one,
			// still at its captured epoch, AND operational; assertAvailable rejects
			// a disposed runtime), and cwd, mirroring assertDialogCurrent's checks
			// and authorize's own post-await epoch recheck.
			if (signal?.aborted) return errorResult("No read grant: call aborted.");
			if (rt !== runtime || rt.epoch !== epoch || rt.teardownFailure) return errorResult("No read grant: the guard session changed; nothing was approved or saved.");
			try { rt.assertAvailable(); } catch (err) { return errorResult(`No read grant: ${err instanceof Error ? err.message : String(err)}`); }
			if (rt.policy.cwd !== cwd || ctx.cwd !== cwd) return errorResult("No read grant: guard cwd changed; awaiting session replacement.");
			// Decision contract: deny refuses with the cause, no dialog; prompt
			// with no UI refuses with an actionable diagnostic; prompt with UI and
			// allow both open the dialog (the consent surface, never an automatic
			// grant); classifier failures and indeterminate verdicts fail closed.
			if (decision.action === "deny") return errorResult(`No read grant: guard denied the request (${decision.reason}). No interpreter workers were stopped and no previously run code was replayed.`);
			if (decision.action === "prompt" && /classifier (call failed|had no verdict)/.test(decision.reason)) return errorResult("No read grant: guard could not classify this request, so it fails closed. Retry later, or have the user add a covering read root to the guard config.");
			if (decision.action === "prompt" && !ctx.hasUI) return errorResult("No read grant: no interactive UI is available to approve read access. Ask the user in an interactive session, or have the user add a covering read root to the guard config.");
			const outcome = await requestReadGrant(rt, "request_read_access", requestPath, ctx, signal, "tool");
			if (outcome.kind === "granted") {
				const savedTo = outcome.savedTo ? ` Saved to ${outcome.savedTo}.` : "";
				return { content: [{ type: "text", text: `Read-only grant added for ${outcome.root} (${outcome.scope} scope).${savedTo} Running interpreter workers were stopped; their state was discarded; previously run code was not replayed.` }], details: undefined };
			}
			if (outcome.kind === "denied") {
				// The helper appends the capability note to refused diagnostics;
				// denied outcomes carry it here because the steering side effect
				// already ran and the outcome type has no diagnostic field.
				const note = ownedStagesFor(ctx) ? "" : CAPABILITY_LIMITED_NOTE;
				return errorResult(`Read request denied.${note} No read grant was made: interpreter workers were not stopped and no previously run code was replayed.`);
			}
			return errorResult(outcome.diagnostic);
		},
	});

	// Appended by the tool and the shared helper when a non-grant outcome
	// follows a capability-limited dialog (no owned editor stages).
	const CAPABILITY_LIMITED_NOTE = " Only a session grant was offerable: this host cannot open the root editor for persistent saves.";

	type GrantOutcome =
		| { kind: "granted"; scope: "session" | "project" | "user"; root: string; savedTo?: string }
		| { kind: "denied" }
		| { kind: "refused"; diagnostic: string };

	/**
	 * Shared read-grant interaction for the python/node worker path
	 * (permission_needed) and the request_read_access tool. Mirrors the former
	 * handleReadGrant body: epoch capture, suggestion validation, the dialog
	 * gate lease, the prompt flow, then the extension transition wrapper with
	 * expectedEpoch, preempt, invalidateWorkers, and a beforeCommit that
	 * rechecks the config signature against the post-dialog snapshot before
	 * any write. Returns a typed outcome; success is never inferred from
	 * absent diagnostics or message text. The caller projects the outcome
	 * into its own response shape. The dialog keeps disclosing the actual
	 * request path, suggested root, and scope being authorized
	 * (runReadGrantPrompt); nothing is ever replayed.
	 */
	async function requestReadGrant(rt: GuardRuntime, requesterName: string, requestPath: string, ctx: ExtensionContext, signal: AbortSignal | undefined, caller: "worker" | "tool"): Promise<GrantOutcome> {
		if (signal?.aborted) return { kind: "refused", diagnostic: "No read grant: call aborted." };
		if (!ctx.hasUI) {
			// The tool gets an actionable diagnostic; the worker path keeps the
			// silent passthrough (an empty diagnostic means no field changes).
			if (caller === "tool") return { kind: "refused", diagnostic: `No read grant: no interactive UI is available to approve read access to ${requestPath}. Ask the user in an interactive session, or have the user add a covering read root to the guard config.` };
			return { kind: "refused", diagnostic: "" };
		}
		const epoch = rt.epoch;
		const cwd = rt.policy.cwd;
		// Capability-limited hosts (no owned editor stages) degrade to session
		// grant and deny; computed once BEFORE the dialog so save actions are
		// never offered and then failed.
		const capabilityNote = caller === "tool" && !ownedStagesFor(ctx) ? CAPABILITY_LIMITED_NOTE : "";
		try {
			rt.assertAvailable();
			const suggestedRoot = validateReadGrant(readGrantSuggestion(requestPath, ctx.cwd), ctx.cwd);
			// Same narrow lease as approvals: validation, the complete interaction,
			// validation. Session grants stay one-stage; persistent saves open the
			// root editor and preview through the prompt flow.
			const outcome = await dialogs.run({ signal }, async (dialogSignal) => {
				dialogSignal.throwIfAborted();
				assertDialogCurrent(rt, epoch, ctx, cwd, "Read grant expired; nothing saved or replayed.");
				const result = await admittedDialog(ctx, () => runReadGrantPrompt({
					io: promptIO(ctx),
					signal: dialogSignal,
					workerName: requesterName,
					requestPath,
					suggestedRoot,
					scopes: ["project", "user"],
					parseReadRoot: (text) => parseReadRootInput(text, ctx.cwd),
					validateRoot: (candidate) => {
						try { validateReadRootSave(candidate, requestPath, ctx.cwd); return { ok: true as const }; }
						catch (err) { return { ok: false as const, error: err instanceof Error ? err.message : String(err) }; }
					},
					destination: (scope) => configDestination(ctx, scope),
				}));
				dialogSignal.throwIfAborted();
				assertDialogCurrent(rt, epoch, ctx, cwd, "Read grant expired; nothing saved or replayed.");
				return result;
			});
			assertCallActive(signal);
			if (outcome.kind === "no-grant") return { kind: "refused", diagnostic: `No read grant: the request was not approved.${capabilityNote}` };
			if (outcome.kind === "deny") {
				deliverSteering(outcome.steering, signal, rt, epoch, cwd);
				return { kind: "denied" };
			}
			rt.assertAvailable();
			// Revalidate the ACTUAL edited root (or the suggested root for a session
			// grant, which has no editor) against the request path before committing.
			const root = outcome.kind === "save-root" ? validateReadRootSave(outcome.root, requestPath, ctx.cwd) : suggestedRoot;
			rt.assertAvailable();
			const diskConfig = loadConfig(ctx.cwd);
			const target = { ...diskConfig, readRoots: [...new Set([...diskConfig.readRoots, root])] };
			await transition({ ...state! }, target, ctx, { epoch, beforeCommit: () => {
				assertCallActive(signal);
				if (configSignature(loadConfig(ctx.cwd)) !== configSignature(diskConfig)) throw new Error("guard: config changed while waiting; nothing saved or replayed");
				if (outcome.kind === "save-root") validateReadRootSave(root, requestPath, ctx.cwd);
				else validateReadGrant(root, ctx.cwd);
				if (outcome.kind === "grant-session") sessionReadRoots = [...new Set([...sessionReadRoots, root])];
				else addToConfigScope(outcome.scope, { readRoots: [root] }, { cwd: ctx.cwd });
				return loadConfig(ctx.cwd);
			} });
			return outcome.kind === "grant-session"
				? { kind: "granted", scope: "session", root }
				: { kind: "granted", scope: outcome.scope, root, savedTo: configDestination(ctx, outcome.scope) };
		} catch (err) { return { kind: "refused", diagnostic: `Read grant refused: ${String(err)}${capabilityNote}` }; }
	}

	// Async bus listeners publish the effective policy only after teardown.
	pi.events.on("guard:research-request", async (data: unknown) => {
		const holder = (data as { holder?: string } | null)?.holder ?? "plan";
		if (!state || !config || !runtime || !lastCtx) {
			pi.events.emit("guard:research-ack", { granted: false, reason: "guard session state not initialized", profile: "default" });
			return;
		}
		const next = { ...state };
		const result = requestResearchHold(next, holder);
		if (!result.granted) { pi.events.emit("guard:research-ack", result); return; }
		try {
			await transition(next, config, lastCtx);
			runtime?.assertAvailable();
			if (state?.researchHolder !== holder || state?.profile !== "research") throw new Error("research request superseded by a policy transition");
			pi.events.emit("guard:research-ack", result);
		}
		catch (err) { pi.events.emit("guard:research-ack", { granted: false, reason: String(err), profile: state?.profile ?? "default" }); }
	});
	pi.events.on("guard:research-release", async (data: unknown) => {
		const holder = (data as { holder?: string } | null)?.holder ?? "plan";
		if (!state || !config || !lastCtx) return;
		const next = { ...state };
		const result = releaseResearchHold(next, holder);
		if (!result.released) return;
		try { await transition(next, config, lastCtx); pi.events.emit("guard:research-release-ack", result); }
		catch (err) { pi.events.emit("guard:research-release-ack", { released: false, reason: String(err), profile: state?.profile ?? "default" }); }
	});

	// Step 5: subagent dispatch handshake. The subagent's query helper
	// subscribes, emits, and unsubscribes without yielding, so this responder
	// must acknowledge synchronously: no await may appear before the emit.
	// Read-only and fail-closed: only an initialized, valid, unlocked runtime
	// answers with a profile.
	pi.events.on("guard:subagent-snapshot-request", (data: unknown) => {
		const valid = isSubagentRequest(data, ["id", "cwd"]);
		const request = valid ? (data as Record<string, unknown>) : null;
		const refuse = (reason: string) => pi.events.emit("guard:subagent-snapshot-ack", { version: 1, id: ackId(request), ok: false, reason } satisfies SubagentAckBase & { id: string | null });
		if (!valid || !request) { refuse("malformed subagent snapshot request"); return; }
		if (!state || !config) { refuse("guard session state not initialized"); return; }
		if (inheritedConstraint && "error" in inheritedConstraint) { refuse("guard inheritance is invalid; this session cannot dispatch subagents"); return; }
		if (!runtime) { refuse("guard runtime not initialized"); return; }
		try { runtime.assertAvailable(); } catch (err) { refuse(String(err instanceof Error ? err.message : err)); return; }
		if (runtime.policy.cwd !== request.cwd) { refuse(`guard is bound to ${runtime.policy.cwd}, not ${request.cwd}; reload the session before dispatching`); return; }
		if (runtime.policy.workspaceLocked) { refuse(`workspace locked (${state.workspaceLockReason ?? "no reason recorded"}); /guard ack is required before dispatching subagents`); return; }
		pi.events.emit("guard:subagent-snapshot-ack", { version: 1, id: request.id as string, ok: true, profile: state.profile });
	});

	// Step 5: child startup gate (child side). The bootstrap extension in a
	// dispatched child asks this responder to prove that this guard consumed
	// the exact inheritance contract. An older guard without this responder
	// never answers, so the gate fails closed. Synchronous for the same
	// reason as the snapshot responder.
	pi.events.on("guard:child-contract-request", (data: unknown) => {
		const request = data as { version?: unknown; nonce?: unknown; profile?: unknown } | null;
		const refuse = (reason: string) => pi.events.emit("guard:child-contract-ack", { version: 1, ok: false, reason, nonce: ackNonce(request as Record<string, unknown> | null) } satisfies SubagentAckBase & { nonce: string | null });
		if (!request || request.version !== 1 || ackNonce(request) === null || !isProfile(request.profile)) { refuse("malformed child contract request"); return; }
		if (!inheritedContract) { refuse("guard has no inherited contract; this is not a guard-dispatched subagent"); return; }
		if (inheritedContract.nonce !== request.nonce) { refuse("child contract nonce mismatch"); return; }
		if (inheritedContract.profile !== request.profile) { refuse("child contract profile mismatch"); return; }
		if (!state || !runtime) { refuse("guard session state not initialized"); return; }
		if (!state.inherited || !("profile" in state.inherited) || state.inherited.profile !== inheritedContract.profile) { refuse("the inherited restriction is not installed"); return; }
		if (state.profile !== inheritedContract.profile && state.profile !== "research") { refuse(`current profile ${state.profile} is outside the inherited restriction`); return; }
		try { runtime.assertAvailable(); } catch (err) { refuse(String(err instanceof Error ? err.message : err)); return; }
		pi.events.emit("guard:child-contract-ack", { version: 1, ok: true, nonce: request.nonce as string, inherited: inheritedContract.profile, profile: state.profile });
	});

	async function applyProfile(profile: Profile, ctx: ExtensionContext, ownership?: CommandOwnership): Promise<void> {
		if (!state || !config) { notify(ctx, "guard: no active session state yet.", "warning"); return; }
		const next = { ...state };
		const result = setProfile(next, profile);
		if (!result.ok) { notify(ctx, result.notice, "warning"); return; }
		// Picker-originated transitions carry a command-only final commit guard:
		// the captured owner signal is rechecked inside the runtime queue, after
		// any asynchronous teardown and before policy assignment or publication.
		// Direct profile commands and the cycle shortcut pass no guard and behave
		// exactly as before.
		const epoch = runtime?.epoch;
		const commandGuard = ownership && epoch !== undefined ? { epoch, check: () => assertOwnerLive(ownership) } : undefined;
		try {
			await transition(next, config, ctx, undefined, commandGuard);
			notify(ctx, `Profile: ${profile} (this session only)`);
			const danger = PROFILE_DANGER_NOTICES[profile];
			if (danger) notify(ctx, danger, "warning");
		}
		catch (err) {
			if (ownership && err === ownership.cancelled) { notify(ctx, ownership.cancelled.message, "warning"); return; }
			notify(ctx, `guard: profile transition failed: ${String(err)}`, "warning");
		}
	}
	async function pickProfile(ctx: ExtensionContext): Promise<void> {
		const current = state?.profile ?? "default";
		if (!ctx.hasUI || !state) { notify(ctx, `Profile (this session): ${current}`); return; }
		// Step 5: children may only pick their inherited profile or research.
		// The current profile stays in the list, marked "(current)"; picking it
		// re-applies it exactly like any other selection.
		const allowed = ALL_PROFILES.filter((p) => profileChangeAllowed(state!, p).ok);
		if (allowed.length === 0) { notify(ctx, `Profile (this session): ${current} (no other profile is allowed)`); return; }
		const pickerOptions = profilePickerOptions(current, allowed);
		const rt = runtime;
		const epoch = rt?.epoch;
		const cwd = rt?.policy.cwd;
		// Capture the owning operation's signal once, before any await: the
		// SDK's ctx.signal is a live getter that would return undefined or
		// another operation's signal if reread after the dialog.
		const ownership: CommandOwnership = { signal: ctx.signal, cancelled: new Error("guard: profile selection cancelled; profile unchanged.") };
		let choice: string | undefined;
		try {
			// Command dialogs share the approval gate: a queued or open picker
			// must not replace or be replaced by a permission prompt.
			choice = await dialogs.run({ signal: ownership.signal }, async (dialogSignal) => {
				dialogSignal.throwIfAborted();
				if (!rt) throw new Error("guard: profile selection expired after a session/policy change.");
				assertDialogCurrent(rt, epoch as number, ctx, cwd as string, "guard: profile selection expired after a session/policy change.");
				const answer = await admittedDialog(ctx, () => gatedSelect(ctx, "Guard profile (this session):", pickerOptions.labels, dialogSignal));
				dialogSignal.throwIfAborted();
				assertDialogCurrent(rt, epoch as number, ctx, cwd as string, "guard: profile selection expired after a session/policy change.");
				return answer;
			});
		} catch (err) {
			notify(ctx, /expired/.test(String(err)) ? "guard: profile selection expired after a session/policy change." : "guard: profile selection cancelled.", "warning");
			return;
		}
		if (rt !== runtime || epoch !== runtime?.epoch) { notify(ctx, "guard: profile selection expired after a session/policy change.", "warning"); return; }
		if (!choice || choice === "Cancel") return;
		const profile = pickerOptions.byLabel.get(choice);
		if (profile) {
			if (ownership.signal?.aborted) { notify(ctx, ownership.cancelled.message, "warning"); return; }
			await applyProfile(profile, ctx, ownership);
		}
	}
	/** Post-write step shared by the /guard model set and clear paths: reload
	 *  the merged config through the same transition as /guard reload (which
	 *  invalidates open dialogs, clears the classifier cache, and publishes),
	 *  then refresh the classifier label that only startSession computes.
	 *  Returns false when nothing was reloaded (no runtime, or the transition
	 *  threw): callers must then skip their success notices. */
	async function applyClassifierConfigChange(ctx: ExtensionContext): Promise<boolean> {
		if (!state || !runtime) { notify(ctx, "guard: no active runtime (an invalid inheritance blocks this session); the user config was written but not reloaded.", "warning"); return false; }
		try {
			await transition({ ...state, sandbox: detectSandboxMode() }, loadConfig(ctx.cwd), ctx);
		} catch (err) {
			notify(ctx, `guard: classifier config reload failed: ${String(err)}`, "warning");
			return false;
		}
		refreshClassifierLabel(ctx);
		return true;
	}
	/** /guard model: interactively pin the classifier model into the user
	 *  config (or clear the pin with "model clear"). The picker goes through
	 *  the same command-dialog gate as pickProfile so it can never collide
	 *  with a pending approval prompt. */
	async function pickClassifierPin(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			const pin = loadUserConfigRaw().classifier;
			const project = projectClassifierPin(ctx.cwd);
			let status = `guard: classifier: ${pin ? `${pin.provider}/${pin.model}` : "(auto-select)"}`;
			if (project) status += `\neffective: ${project.provider}/${project.model} (project pin in ${ctx.cwd}/.pi/guard.local.json overrides the user pin)`;
			notify(ctx, `${status}\n/guard model  Pick the classifier model (saved to user config) | /guard model clear  Remove the user pin`);
			return;
		}
		const pool = ctx.scopedModels.length ? ctx.scopedModels.map((s) => s.model) : ctx.modelRegistry.getAvailable();
		const pickable = pickableModels(pool, (m) => ctx.modelRegistry.hasConfiguredAuth(m));
		if (pickable.length === 0) { notify(ctx, "guard: no models with configured auth are available; classifier pin unchanged.", "warning"); return; }
		// The currently effective classifier first so it is pre-highlighted;
		// dedupe by label (provider/model) against the pickable pool.
		const current = classifierModel(ctx);
		const ordered = current ? [current, ...pickable.filter((m) => modelLabel(m) !== modelLabel(current))] : pickable;
		const labels = ordered.map(modelLabel);
		const byLabel = new Map(ordered.map((m) => [modelLabel(m), m] as const));
		const rt = runtime;
		const epoch = rt?.epoch;
		const cwd = rt?.policy.cwd;
		// Capture the owning operation's signal once, before any await: the
		// SDK's ctx.signal is a live getter that would return undefined or
		// another operation's signal if reread after the dialog.
		const ownership: CommandOwnership = { signal: ctx.signal, cancelled: new Error("guard: classifier model selection cancelled; pin unchanged.") };
		let choice: string | undefined;
		try {
			// Command dialogs share the approval gate: a queued or open picker
			// must not replace or be replaced by a permission prompt.
			choice = await dialogs.run({ signal: ownership.signal }, async (dialogSignal) => {
				dialogSignal.throwIfAborted();
				if (!rt) throw new Error("guard: classifier model selection expired after a session/policy change.");
				assertDialogCurrent(rt, epoch as number, ctx, cwd as string, "guard: classifier model selection expired after a session/policy change.");
				const answer = await admittedDialog(ctx, () => gatedSelect(ctx, "Guard classifier model (saved to user config):", labels, dialogSignal));
				dialogSignal.throwIfAborted();
				assertDialogCurrent(rt, epoch as number, ctx, cwd as string, "guard: classifier model selection expired after a session/policy change.");
				return answer;
			});
		} catch (err) {
			notify(ctx, /expired/.test(String(err)) ? "guard: classifier model selection expired after a session/policy change." : "guard: classifier model selection cancelled.", "warning");
			return;
		}
		if (rt !== runtime || epoch !== runtime?.epoch) { notify(ctx, "guard: classifier model selection expired after a session/policy change.", "warning"); return; }
		if (!choice) return; // cancelled: no file write, no transition
		const model = byLabel.get(choice);
		if (!model) return;
		if (ownership.signal?.aborted) { notify(ctx, ownership.cancelled.message, "warning"); return; }
		setUserClassifierPin(model.provider, model.id);
		if (!(await applyClassifierConfigChange(ctx))) return;
		// The classifier merge is project-wins: with a project pin that differs
		// from the pin just written, the effective classifier is unchanged and
		// the plain success notice would be false.
		const project = projectClassifierPin(ctx.cwd);
		if (project && !(project.provider === model.provider && project.model === model.id)) {
			notify(ctx, `guard: classifier model set to ${choice} (user config), but a project pin in ${ctx.cwd}/.pi/guard.local.json overrides it: the effective classifier stays ${project.provider}/${project.model}.`, "warning");
		} else {
			notify(ctx, `guard: classifier model set to ${choice} (user config).`);
		}
	}
	/** Danger notices emitted at warning level whenever a host-powered profile
	 *  is applied, regardless of entry path (picker, command, cycle shortcut). */
	const PROFILE_DANGER_NOTICES: Partial<Record<Profile, string>> = {
		yolo: "guard: yolo disables the sandbox; commands run on the host",
		unrestricted: "guard: unrestricted ignores all rules",
	};
	/** Picker label for one profile: the danger annotation, then "(current)". */
	function profilePickerLabel(profile: Profile, current: Profile): string {
		const base = profile === "yolo" ? "⚠️ yolo (dangerous: host access)"
			: profile === "unrestricted" ? "⚠️ unrestricted (rules ignored)"
			: profile;
		return profile === current ? `${base} (current)` : base;
	}
	/** Picker options: "Cancel" first (the selector's cursor always starts at
	 *  index 0), then the allowed profiles in natural ALL_PROFILES order, plus
	 *  a label-to-profile map for resolving the chosen label back to a name. */
	function profilePickerOptions(current: Profile, allowed: readonly Profile[]): { labels: string[]; byLabel: Map<string, Profile> } {
		const labels = ["Cancel", ...allowed.map((p) => profilePickerLabel(p, current))];
		const byLabel = new Map<string, Profile>(allowed.map((p) => [profilePickerLabel(p, current), p]));
		return { labels, byLabel };
	}
	async function migrate(ctx: ExtensionCommandContext, dry: boolean): Promise<void> {
		const report = computeMigration(homedir(), ctx.cwd);
		notify(ctx, `/guard migrate${dry ? " (dry)" : ""}:\n${report.summary}${!ctx.hasUI && !dry ? "\n(no UI: behaving like dry; re-run in a TUI to write)" : ""}`);
		if (dry || !ctx.hasUI) return;
		runtime?.assertAvailable();
		const diskConfig = loadConfig(ctx.cwd);
		const rt = runtime;
		const epoch = rt?.epoch;
		const cwd = rt?.policy.cwd;
		// Capture the owning operation's signal once, before any await: the
		// SDK's ctx.signal is a live getter that would return undefined or
		// another operation's signal if reread after the dialog.
		const ownership: CommandOwnership = { signal: ctx.signal, cancelled: new Error("guard: migrate cancelled; nothing was written.") };
		let choice: string | undefined;
		try {
			// The migration confirmation shares the approval gate; headless and
			// dry runs above never enqueue a dialog.
			choice = await dialogs.run({ signal: ownership.signal }, async (dialogSignal) => {
				dialogSignal.throwIfAborted();
				if (!rt) throw new Error("guard: migration expired; nothing was written.");
				assertDialogCurrent(rt, epoch as number, ctx, cwd as string, "guard: migration expired; nothing was written.");
				const answer = await admittedDialog(ctx, () => gatedSelect(ctx, "Write the migration into guard.json (union, never removes)?", ["Write", "Cancel"], dialogSignal));
				dialogSignal.throwIfAborted();
				assertDialogCurrent(rt, epoch as number, ctx, cwd as string, "guard: migration expired; nothing was written.");
				return answer;
			});
		} catch (err) {
			// Expected command-dialog cancellation is a notice, not a rejection.
			notify(ctx, /expired/.test(String(err)) ? "guard: migration expired; nothing was written." : "guard: migrate cancelled; nothing was written.", "warning");
			return;
		}
		if (choice !== "Write") { notify(ctx, "guard: migrate cancelled; nothing was written."); return; }
		if (rt !== runtime || epoch !== runtime?.epoch || runtime?.teardownFailure) { notify(ctx, "guard: migration expired; nothing was written.", "warning"); return; }
		runtime?.assertAvailable();
		if (!state || !config || !runtime || epoch === undefined) { notify(ctx, "guard: no active session; migration not saved.", "warning"); return; }
		if (ownership.signal?.aborted) { notify(ctx, ownership.cancelled.message, "warning"); return; }
		const scopes = (["user", "project"] as const).filter((scope) => report[scope].sourceFound && Object.keys(report[scope].patch).length);
		if (!scopes.length) { notify(ctx, "guard: migrate: nothing to write."); return; }
		if (configSignature(loadConfig(ctx.cwd)) !== configSignature(diskConfig)) { notify(ctx, "guard: migration expired after a config change; nothing was written.", "warning"); return; }
		if (scopes.every((scope) => report[scope].changes === 0)) { notify(ctx, "guard: migrate wrote 0 new entries: already merged; no files or worker state changed. Re-running adds nothing (union with dedupe)."); return; }
		let added = 0;
		const written: string[] = [];
		try {
			// The final commit guard rechecks the captured owner signal inside the
			// runtime queue, after any asynchronous teardown and immediately
			// before the privileged writes in beforeCommit. Genuine persistence
			// failures keep their existing diagnostic path.
			await transition({ ...state }, diskConfig, ctx, { epoch, beforeCommit: () => {
				if (configSignature(loadConfig(ctx.cwd)) !== configSignature(diskConfig)) throw new Error("guard: config changed while waiting; migration not saved");
				const fresh = computeMigration(homedir(), ctx.cwd);
				if (JSON.stringify([fresh.user.patch, fresh.project.patch]) !== JSON.stringify([report.user.patch, report.project.patch])) throw new Error("guard: legacy migration sources changed; preview again before saving");
				for (const scope of scopes) {
					const result = addToConfigScope(scope, report[scope].patch, { cwd: ctx.cwd });
					added += result.added;
					written.push(`${result.path} (+${result.added})`);
				}
				return loadConfig(ctx.cwd);
			} }, { epoch, check: () => assertOwnerLive(ownership) });
		}
		catch (err) {
			// Expected owner cancellation while teardown is pending is a notice,
			// not an unhandled command rejection; completed writes are never
			// rolled back.
			if (err === ownership.cancelled) { notify(ctx, ownership.cancelled.message, "warning"); return; }
			throw err;
		}
		notify(ctx, `guard: migrate wrote ${added} new entr${added === 1 ? "y" : "ies"}:\n${written.join("\n")}\nRe-running adds nothing (union with dedupe).`);
	}
	function showList(ctx: ExtensionContext): void {
		if (!state || !config) { notify(ctx, "guard: no active session state yet."); return; }
		const cfg = effectiveConfig();
		const inheritedLine = !state.inherited ? null
			: "error" in state.inherited ? `inherited (subagent): INVALID (${state.inherited.error}); guard is blocked`
			: `inherited (subagent): ${state.inherited.profile} (only "${state.inherited.profile}" and "research" are allowed)`;
		notify(ctx, [
			`profile (this session): ${state.profile}${state.researchHolder ? ` (research held by ${state.researchHolder})` : ""}`,
			...(inheritedLine ? [inheritedLine] : []),
			`sandbox: ${state.sandbox?.mode ?? "unknown"} (${state.sandbox?.diagnostics.join("; ") ?? ""})`,
			`workspace: ${state.workspaceLocked ? `LOCKED (/guard ack): ${state.workspaceLockReason}` : "unlocked"}`,
			`unresolved teardown: ${runtime?.teardownFailure ?? "none"}`,
			`protected paths (top level): ${[...PROTECTED_TOP_LEVEL, ...cfg.protectedPaths].join(", ")}`,
			`mask exceptions: ${cfg.maskExceptions.join(", ") || "(none)"}`,
			`web_fetch allowlist: ${cfg.webFetchAllow.length} glob(s)`,
			`host shell rules: ${cfg.hostBash.deny.length} deny, ${cfg.hostBash.ask.length} ask, ${cfg.hostBash.allow.length} allow`,
			`read roots: ${cfg.readRoots.join(", ") || "(none)"}`,
			`write roots: ${cfg.writeRoots.join(", ") || "(none)"}`,
			`toolClasses overrides: ${Object.keys(cfg.toolClasses).length}`,
			`classifier: ${cfg.classifier ? `${cfg.classifier.provider}/${cfg.classifier.model}` : "(auto-select)"}`,
			`shared scratch: ${runtime?.scratchDir ?? "not initialized"}`,
			`debug: ${debugEnabled ? "on" : "off"}`,
		].join("\n"));
	}
	pi.registerCommand("guard", {
		description: "Guard sandbox permissions: profiles, policy, read-only lock acknowledgment and migration (/guard help)",
		getArgumentCompletions: (prefix) => {
			const inheritedProfile = state?.inherited && "profile" in state.inherited ? state.inherited.profile : null;
			const selectable = inheritedProfile
				? ALL_PROFILES.filter((p) => p === inheritedProfile || p === "research")
				: ALL_PROFILES;
			const filtered = ["help", "list", "reload", "profile", "model", "model clear", ...selectable.map((p) => `profile ${p}`), "migrate", "migrate dry", "ack", "debug on", "debug off"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command || command === "profile") { await pickProfile(ctx); return; }
			if (command === "help") {
				notify(ctx, ["guard: usage", "/guard [profile <name>]  Pick or set the session profile", "/guard list              Inspect effective policy and shared scratch", "/guard reload            Reload guard.json", "/guard model             Pick the classifier model (saved to user config)", "/guard model clear       Remove the classifier pin (resume auto-select)", "/guard migrate [dry]     Preview before confirming migration", "/guard ack               Clear workspace lock after successful worker teardown", "/guard debug on|off      Live enforcement/observation decisions", `Profiles: ${PROFILE_LADDER.join(" -> ")}; unrestricted is command-only.`, `Cycle shortcut: ${config?.cycleShortcut ?? DEFAULT_CYCLE_SHORTCUT}`, "Guard ENFORCES bash, host_bash, python and node; other tools remain observe-only (grep results are secret-filtered).", "Headless prompts deny. Sandbox failures never run on the host. Raw descendants may escape tracking; tightening cannot undo previous host effects.", "Subagent children inherit this session's effective profile at each spawn and cannot leave it except for research (guard:subagent-snapshot-request)."].join("\n"));
				return;
			}
			if (command === "list") { showList(ctx); return; }
			if (command === "debug on" || command === "debug off") { debugEnabled = command.endsWith("on"); notify(ctx, `guard: debug ${debugEnabled ? "ON" : "OFF"}; owned tools enforce, others observe.`); return; }
			if (command === "migrate" || command === "migrate dry") { await migrate(ctx, command.endsWith("dry")); return; }
			if (/^model(\s|$)/i.test(command)) {
				const sub = command.slice(5).trim().toLowerCase();
				if (sub && sub !== "clear") {
					notify(ctx, "guard usage: /guard model  Pick the classifier model (saved to user config) | /guard model clear  Remove the pin (resume auto-select)", "warning");
					return;
				}
				if (sub === "clear") {
					if (!clearUserClassifierPin()) { notify(ctx, "guard: no classifier pin in the user config."); return; }
					if (!(await applyClassifierConfigChange(ctx))) return;
					// A project pin keeps applying after the user pin is gone:
					// auto-select only resumes when no project pin shadows it.
					const project = projectClassifierPin(ctx.cwd);
					notify(ctx, project
						? `guard: user classifier pin cleared (user config); a project pin in ${ctx.cwd}/.pi/guard.local.json still applies, so auto-select does not resume.`
						: "guard: classifier pin cleared (user config); resuming auto-select.");
					return;
				}
				await pickClassifierPin(ctx);
				return;
			}
			if (command === "reload") {
				if (!state || !runtime) { notify(ctx, "guard: no active runtime (an invalid inheritance blocks this session); nothing to reload.", "warning"); return; }
				await transition({ ...state, sandbox: detectSandboxMode() }, loadConfig(ctx.cwd), ctx);
				refreshClassifierLabel(ctx);
				notify(ctx, "guard: config reloaded."); return;
			}
			if (command === "ack") {
				if (!state || !config || !runtime) { notify(ctx, "guard: no active session state yet.", "warning"); return; }
				if (runtime.teardownFailure) { notify(ctx, `guard: ack refused: unresolved teardown: ${runtime.teardownFailure}`, "warning"); return; }
				const next = { ...state };
				const result = ackWorkspaceLock(next);
				try {
				await transition(next, config, ctx);
				if (result.cleared && state.workspaceLocked) notify(ctx, "guard: ack refused: a new audit finding kept the workspace locked.", "warning");
				else notify(ctx, `guard: ${result.notice}`, result.cleared ? "info" : "warning");
			}
				catch (err) { notify(ctx, `guard: ack refused: ${String(err)}`, "warning"); }
				return;
			}
			if (command.startsWith("profile ")) {
				const profile = command.slice(8).trim();
				if (isProfile(profile)) await applyProfile(profile, ctx);
				else notify(ctx, `Unknown profile "${profile}". Profiles: ${ALL_PROFILES.join(", ")}`, "warning");
				return;
			}
			notify(ctx, `Unknown subcommand "${command}". /guard help shows usage.`, "warning");
		},
	});
	pi.registerShortcut((loadUserConfigRaw().cycleShortcut ?? DEFAULT_CYCLE_SHORTCUT) as Parameters<ExtensionAPI["registerShortcut"]>[0], {
		description: "Cycle guard profile (research -> default -> allow-edits -> auto -> trusted -> yolo; this session only)",
		handler: async (ctx) => {
			if (!state) return;
			if (state.researchHolder) { notify(ctx, `Profile changes are blocked while ${state.researchHolder} holds research; the holder must release it first.`, "warning"); return; }
			await applyProfile(nextProfile(state.profile), ctx);
		},
	});
}
