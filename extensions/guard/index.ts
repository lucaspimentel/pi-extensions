/** Guard owns four executors. All other tool decisions remain observe-only. */
import { createBashTool, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type ToolAnnotations, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { GuardRuntime, validateReadGrant } from "./runtime.ts";
import { DialogGate } from "./dialogs.ts";
import { FAILURE_STATUSES as PYTHON_FAILURES } from "./tools/python/session.ts";
import { FAILURE_STATUSES as NODE_FAILURES } from "./tools/node/session.ts";
import { createGuardShellOperations, SANDBOX_FAILURE_HINT } from "./tools/shell.ts";
import { createShellRenderCall } from "./tools/shell-render.ts";
import { filterSearchResult, type SearchResultEvent } from "./filter.ts";
import { detectSandboxMode } from "./sandbox/detect.ts";
import { PROTECTED_TOP_LEVEL } from "./sandbox/spec.ts";
import { loadConfig, loadUserConfigRaw, resolvedClassifierConfig, type ResolvedGuardConfig } from "./policy/config.ts";
import { decide, resolveDecision, type Decision, type GuardCall, type PolicyState } from "./policy/decision.ts";
import { isOwnedExecutor, type OwnedExecutor } from "./policy/classes.ts";
import { computeMigration } from "./policy/migrate.ts";
import { pickClassifierModel, classifyAction } from "./policy/classifier.ts";
import { addToConfigScope, effectiveAllowSuggestion, readGrantSuggestion } from "./policy/suggest.ts";
import { ackWorkspaceLock, createSessionState, footerLabel, lockWorkspace, mapToolCallToGuardCall, profileEventPayload, profileChangeAllowed, releaseResearchHold, requestResearchHold, setProfile, toPolicyState, type GuardSessionState } from "./policy/state.ts";
import { constraintFromParse, INHERIT_ENV, parseInheritance, type InheritanceConstraint, type InheritanceContract } from "./policy/inheritance.ts";
import { isProfile, ALL_PROFILES, PROFILE_LADDER, nextProfile, type Profile } from "./policy/profiles.ts";

const DEFAULT_CYCLE_SHORTCUT = "ctrl+alt+g";

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
	 * Open one guard dialog selector with the TUI working spinner hidden for
	 * its duration. Presentation only: visibility failures never change the
	 * selector's result or error, and restoration is attempted on every settle
	 * path. Only TUI mode toggles: RPC and print have no terminal spinner (the
	 * RPC setter is a no-op), and restoration always passes true, matching the
	 * legacy extension, because the UI API has no visibility getter.
	 */
	async function gatedSelect(ctx: ExtensionContext, title: string, options: string[], signal: AbortSignal): Promise<string | undefined> {
		if (ctx.mode !== "tui") return ctx.ui.select(title, options, { signal });
		try {
			try { ctx.ui.setWorkingVisible(false); } catch { /* cosmetic; the dialog outcome is unaffected */ }
			return await ctx.ui.select(title, options, { signal });
		} finally {
			try { ctx.ui.setWorkingVisible(true); } catch { /* cosmetic; never masks the selector's result or error */ }
		}
	}
	function classifierModel(ctx: ExtensionContext): Model<Api> | undefined {
		return pickClassifierModel(ctx.scopedModels.length ? ctx.scopedModels.map((s) => s.model) : ctx.modelRegistry.getAvailable(), ctx.model?.provider, (m) => ctx.modelRegistry.hasConfiguredAuth(m), config?.classifier, (provider, modelId) => ctx.modelRegistry.find(provider, modelId));
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
		try {
			const input = (event.input ?? {}) as Record<string, unknown>;
			const policy = policyFor(ctx);
			const mapped = mappedCall(event.toolName, input);
			// No classifier or dialog here for owned tools: execute is authoritative.
			const decision = owned ? decide({ ...policy, interactive: ctx.hasUI }, mapped.call) : await decisionFor(event.toolName, input, ctx, policy);
			pi.events.emit("guard:decision", { toolName: event.toolName, class: mapped.cls, call: mapped.call, ...decision, enforcement: owned });
			if (debugEnabled) notify(ctx, `[guard ${owned ? "enforce" : "observe"}] ${event.toolName}: ${decision.action} (${decision.reason})`);
			if (owned && (decision.action === "deny" || runtime?.teardownFailure)) return { block: true, reason: runtime?.teardownFailure ?? decision.reason };
		} catch (err) {
			if (owned) return { block: true, reason: `guard: authorization failed closed: ${String(err)}` };
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
		const patch = decision.provenance === "explicit-ask" ? null : effectiveAllowSuggestion(call, policy);
		const options = ["Allow once", ...(patch ? ["Save for project", "Save for user"] : []), "Deny"];
		// The gate holds the UI lease only across pre-display validation, the
		// selector interaction, and post-answer validation. Persistence and
		// execution happen after the lease is released, so the transition this
		// choice triggers cannot cancel its own dialog.
		const cwd = rt.policy.cwd;
		const choice = await dialogs.run({ signal }, async (dialogSignal) => {
			dialogSignal.throwIfAborted();
			assertDialogCurrent(rt, epoch, ctx, cwd, "guard: approval expired; nothing saved or executed");
			const answer = await gatedSelect(ctx, `guard: ${name}\n${decision.reason}\n${String(input.command ?? "")}\n${patch ? `Exact rule: ${patch.hostBash?.allow?.join(", ")}\nProject: ${ctx.cwd}/.pi/guard.local.json\nUser: ${homedir()}/.pi/agent/guard.json` : ""}`, options, dialogSignal);
			dialogSignal.throwIfAborted();
			assertDialogCurrent(rt, epoch, ctx, cwd, "guard: approval expired; nothing saved or executed");
			return answer;
		});
		assertCallActive(signal);
		if (choice === "Allow once") return epoch;
		if (patch && (choice === "Save for project" || choice === "Save for user")) {
			// Recheck the complete hypothetical merge immediately before persistence.
			const diskConfig = loadConfig(ctx.cwd);
			const latestPolicy = { ...policyFor(ctx), config: { ...diskConfig, readRoots: [...new Set([...diskConfig.readRoots, ...sessionReadRoots])] } };
			if (!effectiveAllowSuggestion(call, latestPolicy)) throw new Error("guard: suggested rule no longer authorizes the complete call");
			const target = { ...diskConfig, hostBash: { ...diskConfig.hostBash, allow: [...new Set([...diskConfig.hostBash.allow, ...patch.hostBash!.allow!])] } };
			await transition({ ...state! }, target, ctx, { epoch, beforeCommit: () => {
				assertCallActive(signal);
				if (configSignature(loadConfig(ctx.cwd)) !== configSignature(diskConfig)) throw new Error("guard: config changed while waiting; nothing saved or executed");
				addToConfigScope(choice === "Save for project" ? "project" : "user", patch, { cwd: ctx.cwd });
				return loadConfig(ctx.cwd);
			} });
			return rt.epoch;
		}
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
			const tool = createBashTool(ctx.cwd, { operations: createGuardShellOperations(execution, host), exposeSessionEnvironment: false });
			const run = () => tool.execute(id, input, execution.signal, onUpdate);
			try {
				const result = host ? await run() : await rt.sandboxBoundary(run, execution.warnings);
				if (!host && result.isError) return appendWarnings(result, [SANDBOX_FAILURE_HINT]);
				return result;
			} catch (err) {
				if (!host) throw new Error(`${err instanceof Error ? err.message : String(err)}\n${SANDBOX_FAILURE_HINT}`);
				throw err;
			}
		}, signal);
		return appendWarnings(outcome.result, outcome.warnings);
	}
	const bash = createBashTool(process.cwd(), { exposeSessionEnvironment: false });
	for (const name of ["bash", "host_bash"] as const) pi.registerTool({
		...bash, name, label: name,
		description: name === "bash" ? `${bash.description} Guard sandboxed except in raw profiles; isolated network and shared real-path scratch.` : `${bash.description} Runs on the host, subject to HostBash rules and guard profile.`,
		renderCall: createShellRenderCall(name),
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
				data = await handleReadGrant(rt, name, data, ctx, signal);
			}
			const failed = (name === "python" ? PYTHON_FAILURES : NODE_FAILURES).has(data.status);
			const text = [data.stdout, data.stderr, data.repr ?? data.value, data.exception ? JSON.stringify(data.exception) : "", data.diagnostic, data.stateLost ? `Interpreter state lost: ${data.stateLostReason ?? "worker stopped"}. Scratch retained.` : "", !data.status ? JSON.stringify(data) : `status: ${data.status}`, failed && rt.policy.profile !== "yolo" && rt.policy.profile !== "unrestricted" ? SANDBOX_FAILURE_HINT : ""].filter(Boolean).join("\n");
			return appendWarnings({ content: [{ type: "text", text }], details: data, structuredContent: data, isError: failed }, outcome.warnings);
		},
	});

	async function handleReadGrant(rt: GuardRuntime, name: string, data: Record<string, any>, ctx: ExtensionContext, signal?: AbortSignal): Promise<Record<string, any>> {
		if (signal?.aborted) return { ...data, diagnostic: "No read grant: call aborted." };
		if (!ctx.hasUI) return data;
		const epoch = rt.epoch;
		const cwd = rt.policy.cwd;
		try {
			rt.assertAvailable();
			const root = validateReadGrant(readGrantSuggestion(data.permissionPath, ctx.cwd), ctx.cwd);
			const title = `guard: ${name} requests read-only access to ${root}. Granting discards worker state; code is never replayed.`;
			// Same narrow lease as approvals: validation, selector, validation.
			const choice = await dialogs.run({ signal }, async (dialogSignal) => {
				dialogSignal.throwIfAborted();
				assertDialogCurrent(rt, epoch, ctx, cwd, "Read grant expired; nothing saved or replayed.");
				const answer = await gatedSelect(ctx, title, ["Grant for session", "Save for project", "Save for user", "Deny"], dialogSignal);
				dialogSignal.throwIfAborted();
				assertDialogCurrent(rt, epoch, ctx, cwd, "Read grant expired; nothing saved or replayed.");
				return answer;
			});
			assertCallActive(signal);
			if (choice !== "Grant for session" && choice !== "Save for project" && choice !== "Save for user") return data;
			rt.assertAvailable();
			validateReadGrant(root, ctx.cwd);
			const diskConfig = loadConfig(ctx.cwd);
			const target = { ...diskConfig, readRoots: [...new Set([...diskConfig.readRoots, root])] };
			await transition({ ...state! }, target, ctx, { epoch, beforeCommit: () => {
				assertCallActive(signal);
				if (configSignature(loadConfig(ctx.cwd)) !== configSignature(diskConfig)) throw new Error("guard: config changed while waiting; nothing saved or replayed");
				validateReadGrant(root, ctx.cwd);
				if (choice === "Grant for session") sessionReadRoots = [...new Set([...sessionReadRoots, root])];
				else addToConfigScope(choice === "Save for project" ? "project" : "user", { readRoots: [root] }, { cwd: ctx.cwd });
				return loadConfig(ctx.cwd);
			} });
			return { ...data, stateLost: true, stateLostReason: "read roots changed", diagnostic: `Read-only grant added: ${root}. Worker state discarded. Code was not replayed; run it again explicitly.` };
		} catch (err) { return { ...data, diagnostic: `Read grant refused: ${String(err)}` }; }
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
		const allowed = ALL_PROFILES.filter((p) => p !== current && profileChangeAllowed(state!, p).ok);
		if (allowed.length === 0) { notify(ctx, `Profile (this session): ${current} (no other profile is allowed)`); return; }
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
				const answer = await gatedSelect(ctx, "Guard profile (this session):", [current, ...allowed], dialogSignal);
				dialogSignal.throwIfAborted();
				assertDialogCurrent(rt, epoch as number, ctx, cwd as string, "guard: profile selection expired after a session/policy change.");
				return answer;
			});
		} catch (err) {
			notify(ctx, /expired/.test(String(err)) ? "guard: profile selection expired after a session/policy change." : "guard: profile selection cancelled.", "warning");
			return;
		}
		if (rt !== runtime || epoch !== runtime?.epoch) { notify(ctx, "guard: profile selection expired after a session/policy change.", "warning"); return; }
		if (choice && isProfile(choice)) {
			if (ownership.signal?.aborted) { notify(ctx, ownership.cancelled.message, "warning"); return; }
			await applyProfile(choice, ctx, ownership);
		}
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
				const answer = await gatedSelect(ctx, "Write the migration into guard.json (union, never removes)?", ["Write", "Cancel"], dialogSignal);
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
			const filtered = ["help", "list", "reload", "profile", ...selectable.map((p) => `profile ${p}`), "migrate", "migrate dry", "ack", "debug on", "debug off"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command || command === "profile") { await pickProfile(ctx); return; }
			if (command === "help") {
				notify(ctx, ["guard: usage", "/guard [profile <name>]  Pick or set the session profile", "/guard list              Inspect effective policy and shared scratch", "/guard reload            Reload guard.json", "/guard migrate [dry]     Preview before confirming migration", "/guard ack               Clear workspace lock after successful worker teardown", "/guard debug on|off      Live enforcement/observation decisions", `Profiles: ${PROFILE_LADDER.join(" -> ")}; unrestricted is command-only.`, `Cycle shortcut: ${config?.cycleShortcut ?? DEFAULT_CYCLE_SHORTCUT}`, "Guard ENFORCES bash, host_bash, python and node; other tools remain observe-only (grep results are secret-filtered).", "Headless prompts deny. Sandbox failures never run on the host. Raw descendants may escape tracking; tightening cannot undo previous host effects.", "Subagent children inherit this session's effective profile at each spawn and cannot leave it except for research (guard:subagent-snapshot-request)."].join("\n"));
				return;
			}
			if (command === "list") { showList(ctx); return; }
			if (command === "debug on" || command === "debug off") { debugEnabled = command.endsWith("on"); notify(ctx, `guard: debug ${debugEnabled ? "ON" : "OFF"}; owned tools enforce, others observe.`); return; }
			if (command === "migrate" || command === "migrate dry") { await migrate(ctx, command.endsWith("dry")); return; }
			if (command === "reload") {
				if (!state || !runtime) { notify(ctx, "guard: no active runtime (an invalid inheritance blocks this session); nothing to reload.", "warning"); return; }
				await transition({ ...state, sandbox: detectSandboxMode() }, loadConfig(ctx.cwd), ctx);
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
		description: "Cycle guard profile (research -> default -> auto -> trusted -> yolo; this session only)",
		handler: async (ctx) => {
			if (!state) return;
			if (state.researchHolder) { notify(ctx, `Profile changes are blocked while ${state.researchHolder} holds research; the holder must release it first.`, "warning"); return; }
			await applyProfile(nextProfile(state.profile), ctx);
		},
	});
}
