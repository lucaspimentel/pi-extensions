/**
 * guard: sandbox-first permission redesign (step 2: policy core).
 *
 * Coexistence mode: guard is loaded by pi alongside pi-tool-permissions until
 * switchover (step 6). In this step guard owns the profile ladder, the
 * decision function, /guard, the cycle hotkey, and the footer status, but its
 * tool_call hook is OBSERVE-ONLY: it computes each decision and publishes it
 * on the "guard:decision" event and NEVER blocks, prompts, or mutates input.
 * pi-tool-permissions remains the enforcing extension until guard reaches
 * parity (step 6); permission dialogs and "always allow" saving land in
 * step 3.
 *
 * Session-only state: every session starts at the "default" profile; nothing
 * is persisted. Profile changes are broadcast on "guard:profile" (payload:
 * { profile, sandbox: { mode, workspaceMode, readRoots }, workspaceLocked })
 * for the step-3 tools. plan.ts will request research over
 * "guard:research-request" / "guard:research-release" in step 4.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolAnnotations,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { detectSandboxMode } from "./sandbox/detect.ts";
import { PROTECTED_TOP_LEVEL } from "./sandbox/spec.ts";
import {
	loadConfig,
	loadUserConfigRaw,
	type ResolvedGuardConfig,
} from "./policy/config.ts";
import { resolveDecision, type Decision, type GuardCall, type PolicyState } from "./policy/decision.ts";
import { computeMigration } from "./policy/migrate.ts";
import { pickClassifierModel } from "./policy/classifier.ts";
import { addToConfigScope } from "./policy/suggest.ts";
import {
	ackWorkspaceLock,
	cycleProfile,
	createSessionState,
	footerLabel,
	lockWorkspace,
	mapToolCallToGuardCall,
	profileEventPayload,
	releaseResearchHold,
	requestResearchHold,
	setProfile,
	toPolicyState,
} from "./policy/state.ts";
import { isProfile, ALL_PROFILES, PROFILE_LADDER, type Profile } from "./policy/profiles.ts";
import { classifyAction } from "./policy/classifier.ts";
import { resolvedClassifierConfig } from "./policy/config.ts";

const STATUS_KEY = "guard";
const PROFILE_EVENT = "guard:profile";
const DECISION_EVENT = "guard:decision";

/** Cycle hotkey; guard.json cycleShortcut (user scope, read at load) overrides. */
const DEFAULT_CYCLE_SHORTCUT = "ctrl+alt+g";

export default function guard(pi: ExtensionAPI) {
	let state: ReturnType<typeof createSessionState> | null = null;
	let config: ResolvedGuardConfig | null = null;
	let debugEnabled = false;

	/** Per-session annotation cache (pi.getAllTools results); cleared on session_start and /guard reload. */
	let annotationCache = new Map<string, ToolAnnotations | undefined>();
	let annotationSnapshot: ToolInfoLite[] | null = null;
	interface ToolInfoLite {
		name: string;
		annotations?: ToolAnnotations;
	}

	function getAnnotations(name: string): ToolAnnotations | undefined {
		if (annotationCache.has(name)) return annotationCache.get(name);
		if (annotationSnapshot === null) {
			try {
				annotationSnapshot = pi.getAllTools().map((t) => ({ name: t.name, annotations: t.annotations }));
			} catch {
				annotationSnapshot = [];
			}
		}
		const found = annotationSnapshot.find((t) => t.name === name)?.annotations;
		annotationCache.set(name, found);
		return found;
	}

	function clearAnnotationCache(): void {
		annotationCache = new Map();
		annotationSnapshot = null;
	}

	function currentCtx(): { state: NonNullable<typeof state>; config: ResolvedGuardConfig } | null {
		return state !== null && config !== null ? { state, config } : null;
	}

	function policyFor(ctx: ExtensionContext): PolicyState | null {
		const cur = currentCtx();
		if (cur === null) return null;
		return toPolicyState(cur.state, cur.config, ctx.cwd, ctx.hasUI);
	}

	function statusValue(ctx: ExtensionContext): string | undefined {
		const cur = currentCtx();
		if (cur === null) return undefined;
		const label = footerLabel(cur.state);
		if (!label) return undefined;
		const role = cur.state.profile === "unrestricted" ? "error" : "warning";
		return ctx.ui.theme.fg(role, `guard: ${label}`);
	}

	function updateFooter(ctx: ExtensionContext): void {
		try {
			ctx.ui.setStatus(STATUS_KEY, statusValue(ctx));
		} catch {
			// setStatus unavailable (some contexts): the footer is best-effort.
		}
	}

	function emitProfile(ctx: ExtensionContext): void {
		const cur = currentCtx();
		if (cur === null) return;
		pi.events.emit(PROFILE_EVENT, profileEventPayload(cur.state, cur.config, ctx.cwd));
	}

	function resolveClassifierModelFromCtx(ctx: ExtensionContext): Model<Api> | undefined {
		const cur = currentCtx();
		return pickClassifierModel(
			ctx.scopedModels.length > 0 ? ctx.scopedModels.map((s) => s.model) : ctx.modelRegistry.getAvailable(),
			ctx.model?.provider,
			(m) => ctx.modelRegistry.hasConfiguredAuth(m),
			cur?.config.classifier,
			(provider, modelId) => ctx.modelRegistry.find(provider, modelId),
		);
	}

	/** Map a GuardCall back to pi-style (toolName, input) for the classifier port. */
	function piToolNameForClassifier(call: GuardCall): string {
		switch (call.kind) {
			case "host-shell": return call.shell === "pwsh" ? "pwsh" : "HostBash";
			case "sandboxed-exec": return call.tool;
			case "local-write": return call.tool;
			case "local-read": return call.tool;
			case "web-fetch": return "webfetch";
			case "remote-read":
			case "remote-write":
				return call.tool;
			case "meta": return call.tool;
		}
	}

	function piInputForClassifier(call: GuardCall): Record<string, unknown> {
		switch (call.kind) {
			case "host-shell":
			case "sandboxed-exec":
				return { command: call.command ?? "" };
			case "local-write":
				return { path: call.path ?? "" };
			case "local-read":
				return { path: call.path ?? "" };
			case "web-fetch":
				return { url: call.url };
			case "remote-read":
				return {};
			case "remote-write":
				return call.input ?? {};
			case "meta":
				return {};
		}
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	// The most recent extension context, so the plan.ts handshake listeners
	// (which receive no ctx) can refresh the footer and broadcast the profile.
	let lastCtx: ExtensionContext | null = null;

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		config = loadConfig(ctx.cwd);
		state = createSessionState({
			config,
			sandbox: detectSandboxMode(),
			cwd: ctx.cwd,
			interactive: ctx.hasUI,
		});
		clearAnnotationCache();
		try {
			const model = resolveClassifierModelFromCtx(ctx);
			state.classifierLabel = model ? String(model.id) : null;
		} catch {
			state.classifierLabel = null;
		}
		updateFooter(ctx);
		emitProfile(ctx);
	});

	// ── Observe-only decision recording ─────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		try {
			const policy = policyFor(ctx);
			const cur = currentCtx();
			if (policy === null || cur === null) return;
			const input = (event.input ?? {}) as Record<string, unknown>;
			const mapped = mapToolCallToGuardCall(event.toolName, input, cur.config, getAnnotations);
			const decision: Decision = await resolveDecision(policy, mapped.call, async (call) => {
				const model = resolveClassifierModelFromCtx(ctx);
				if (model === undefined) return { verdict: "no_match", reason: "no classifier model available" };
				const result = await classifyAction(
					(m, cc) => ctx.modelRegistry.streamSimple(m, cc).result(),
					model,
					piToolNameForClassifier(call),
					piInputForClassifier(call),
					resolvedClassifierConfig(cur.config),
					classifierCache,
				);
				return { ...result, modelId: String(model.id) };
			});
			pi.events.emit(DECISION_EVENT, {
				toolName: event.toolName,
				class: mapped.cls,
				call: mapped.call,
				action: decision.action,
				reason: decision.reason,
			});
			if (debugEnabled) {
				ctx.ui.notify(`[guard observe] ${event.toolName}: ${decision.action} (${decision.reason})`, "info");
			}
		} catch {
			// Observation must never break a tool call.
		}
	});

	const classifierCache = new Map<string, { verdict: "allow" | "soft_deny" | "hard_deny" | "no_match"; reason: string }>();

	// ── plan.ts handshake (guard side; plan wiring lands in step 4) ─────────

	pi.events.on("guard:research-request", (data: unknown) => {
		const holder = (data as { holder?: string } | null)?.holder ?? "plan";
		if (state === null) {
			pi.events.emit("guard:research-ack", { granted: false, reason: "guard session state not initialized", profile: "default" });
			return;
		}
		const result = requestResearchHold(state, holder);
		pi.events.emit("guard:research-ack", result);
	});

	pi.events.on("guard:research-release", (data: unknown) => {
		const holder = (data as { holder?: string } | null)?.holder ?? "plan";
		if (state === null) return;
		const result = releaseResearchHold(state, holder);
		// The restored profile is broadcast so the step-3 tools stay in sync.
		if (result.released && lastCtx !== null) {
			updateFooter(lastCtx);
			emitProfile(lastCtx);
		}
	});

	// ── /guard command ───────────────────────────────────────────────────────

	pi.registerCommand("guard", {
		description: "Guard sandbox permissions: cycle profiles, inspect policy, migrate old rules (/guard help)",
		getArgumentCompletions: (prefix: string) => {
			const subs = [
				"help",
				"list",
				"reload",
				"profile",
				...ALL_PROFILES.map((p) => `profile ${p}`),
				"migrate",
				"migrate dry",
				"ack",
				"debug on",
				"debug off",
			];
			const items = subs.map((s) => ({ value: s, label: s }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				await pickProfile(ctx);
				return;
			}
			if (trimmed === "help") { showHelp(ctx); return; }
			if (trimmed === "list") { showList(ctx); return; }
			if (trimmed === "reload") { reloadConfig(ctx); return; }
			if (trimmed === "ack") { handleAck(ctx); return; }
			if (trimmed === "migrate" || trimmed === "migrate dry") { await handleMigrate(ctx, trimmed.endsWith("dry")); return; }
			if (trimmed === "debug on") { debugEnabled = true; ctx.ui.notify("guard: debug observations ON (decisions appear as notifications; nothing is blocked).", "info"); return; }
			if (trimmed === "debug off") { debugEnabled = false; ctx.ui.notify("guard: debug observations OFF.", "info"); return; }
			if (trimmed.startsWith("profile")) {
				const name = trimmed.slice("profile".length).trim();
				if (!name) {
					await pickProfile(ctx);
					return;
				}
				if (!isProfile(name)) {
					ctx.ui.notify(`Unknown profile "${name}". Profiles: ${ALL_PROFILES.join(", ")} (the cycle covers ${PROFILE_LADDER.join(" -> ")})`, "warning");
					return;
				}
				applyProfile(name as Profile, ctx);
				return;
			}
			ctx.ui.notify(`Unknown subcommand "${trimmed}". /guard help shows usage.`, "warning");
		},
	});

	function applyProfile(profile: Profile, ctx: ExtensionContext): void {
		const cur = currentCtx();
		if (cur === null) {
			ctx.ui.notify("guard: no active session state yet.", "warning");
			return;
		}
		const result = setProfile(cur.state, profile);
		if (!result.ok) {
			ctx.ui.notify(result.notice, "warning");
			return;
		}
		updateFooter(ctx);
		emitProfile(ctx);
		ctx.ui.notify(`Profile: ${profile} (this session only)`, "info");
	}

	async function pickProfile(ctx: ExtensionContext): Promise<void> {
		const cur = currentCtx();
		const current = cur?.state.profile ?? "default";
		if (!ctx.hasUI || cur === null) {
			ctx.ui.notify(`Profile (this session): ${current}`, "info");
			return;
		}
		const ordered = [current, ...ALL_PROFILES.filter((p) => p !== current)];
		const choice = await ctx.ui.select("Guard profile (this session):", ordered);
		if (!choice) return;
		if (isProfile(choice)) applyProfile(choice as Profile, ctx);
	}

	function showHelp(ctx: ExtensionContext): void {
		const lines = [
			"guard: usage",
			"",
			"Subcommands:",
			"  /guard                  Pick the session profile (menu)",
			"  /guard help             Show this help",
			"  /guard list             Show profile, sandbox mode, and effective policy",
			"  /guard reload           Reload guard.json from disk",
			"  /guard profile [name]   Show or set the session profile",
			"  /guard migrate [dry]    Convert pi-tool-permissions rules into guard.json",
			"  /guard ack              Clear the workspace lock (step 3 sets it on audit findings)",
			"  /guard debug on|off     Show live observe-only decisions as notifications",
			"",
			`Profiles (starts at default every session, never persisted): ${PROFILE_LADDER.join(" -> ")};`,
			`unrestricted is command-only (/guard profile unrestricted). The cycle hotkey is`,
			`${config?.cycleShortcut ?? DEFAULT_CYCLE_SHORTCUT} unless cycleShortcut overrides it in guard.json.`,
			"While both guard and pi-tool-permissions are loaded, guard only OBSERVES:",
			"decisions are recorded on the guard:decision event and nothing is blocked or prompted.",
		];
		ctx.ui.notify(lines.join("\n"), "info");
	}

	function showList(ctx: ExtensionContext): void {
		const cur = currentCtx();
		if (cur === null || config === null) {
			ctx.ui.notify("guard: no active session state yet.", "info");
			return;
		}
		const st = cur.state;
		const cfg = config;
		const lines = [
			`profile (this session): ${st.profile}${st.researchHolder !== null ? ` (research held by ${st.researchHolder})` : ""}`,
			`sandbox: ${st.sandbox?.mode ?? "unknown"}${st.sandbox && st.sandbox.diagnostics.length > 0 ? ` (${st.sandbox.diagnostics.join("; ")})` : ""}`,
			`workspace: ${st.workspaceLocked ? `LOCKED (/guard ack): ${st.workspaceLockReason ?? ""}` : "unlocked"}`,
			`protected paths (top level): ${[...PROTECTED_TOP_LEVEL, ...cfg.protectedPaths].join(", ")}`,
			`mask exceptions: ${cfg.maskExceptions.length > 0 ? cfg.maskExceptions.join(", ") : "(none)"}`,
			`web_fetch allowlist: ${cfg.webFetchAllow.length} glob(s)`,
			`host shell rules: ${cfg.hostBash.deny.length} deny, ${cfg.hostBash.ask.length} ask, ${cfg.hostBash.allow.length} allow`,
			`read roots: ${cfg.readRoots.length > 0 ? cfg.readRoots.join(", ") : "(none)"}`,
			`write roots: ${cfg.writeRoots.length > 0 ? cfg.writeRoots.join(", ") : "(none)"}`,
			`toolClasses overrides: ${Object.keys(cfg.toolClasses).length}`,
			`classifier: ${cfg.classifier ? `${cfg.classifier.provider}/${cfg.classifier.model}` : "(auto-select)"}`,
			`debug: ${debugEnabled ? "on" : "off"}`,
		];
		ctx.ui.notify(lines.join("\n"), "info");
	}

	function reloadConfig(ctx: ExtensionContext): void {
		config = loadConfig(ctx.cwd);
		if (state !== null) state.sandbox = detectSandboxMode();
		clearAnnotationCache();
		updateFooter(ctx);
		emitProfile(ctx);
		ctx.ui.notify("guard: config reloaded.", "info");
	}

	function handleAck(ctx: ExtensionContext): void {
		const cur = currentCtx();
		if (cur === null) {
			ctx.ui.notify("guard: no active session state yet.", "warning");
			return;
		}
		const result = ackWorkspaceLock(cur.state);
		updateFooter(ctx);
		emitProfile(ctx);
		ctx.ui.notify(`guard: ${result.notice}`, result.cleared ? "info" : "warning");
	}

	async function handleMigrate(ctx: ExtensionCommandContext, dry: boolean): Promise<void> {
		const home = homedir();
		const report = computeMigration(home, ctx.cwd);
		if (dry || !ctx.hasUI) {
			const lines = [report.summary];
			if (!dry && !ctx.hasUI) lines.push("", "(no UI: behaving like dry; re-run /guard migrate in a TUI to write)");
			ctx.ui.notify(`/guard migrate${dry ? " (dry)" : ""}:\n${lines.join("\n")}`, "info");
			return;
		}
		const choice = await ctx.ui.select("Write the migration into guard.json (union, never removes)?", ["Write", "Cancel"]);
		if (choice !== "Write") {
			ctx.ui.notify("guard: migrate cancelled; nothing was written.", "info");
			return;
		}
		const written: string[] = [];
		let added = 0;
		for (const scope of ["user", "project"] as const) {
			const scopeReport = report[scope];
			if (!scopeReport.sourceFound || Object.keys(scopeReport.patch).length === 0) continue;
			const result = addToConfigScope(scope, scopeReport.patch, { home, cwd: ctx.cwd });
			written.push(`${result.path} (+${result.added})`);
			added += result.added;
		}
		if (written.length === 0) {
			ctx.ui.notify("guard: migrate: nothing to write (no legacy config found or empty patch).", "info");
			return;
		}
		config = loadConfig(ctx.cwd, home);
		updateFooter(ctx);
		emitProfile(ctx);
		ctx.ui.notify(`guard: migrate wrote ${added} new entr${added === 1 ? "y" : "ies"}:\n${written.join("\n")}\n\nRe-running /guard migrate adds nothing (union with dedupe).`, "info");
	}

	// ── Cycle hotkey ─────────────────────────────────────────────────────────

	// ctrl+alt+g (mnemonic: guard); overridable via cycleShortcut in guard.json.
	// pi-tool-permissions owns ctrl+alt+p, so there is no conflict and no
	// coexistence warning is needed.
	pi.registerShortcut((loadUserConfigRaw().cycleShortcut ?? DEFAULT_CYCLE_SHORTCUT) as Parameters<ExtensionAPI["registerShortcut"]>[0], {
		description: "Cycle guard profile (research -> default -> auto -> trusted -> yolo; this session only)",
		handler: async (ctx) => {
			const cur = currentCtx();
			if (cur === null) return;
			const result = cycleProfile(cur.state);
			if (!result.ok) {
				ctx.ui.notify(result.notice, "warning");
				return;
			}
			updateFooter(ctx);
			emitProfile(ctx);
			ctx.ui.notify(`Profile: ${result.profile} (this session only)`, "info");
		},
	});

	void lockWorkspace; // step 3 calls this on audit lockWrites; kept exported via state.ts
}
