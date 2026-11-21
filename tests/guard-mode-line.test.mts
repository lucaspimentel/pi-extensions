// Unit and policy-consistency tests for the model-visible guard state line
// (extensions/guard/policy/mode-line.ts): the exact section body for every
// profile, the sandbox/lock/inherited variants, the blocked and fallback
// states, and drift guards that pin the rendered clauses to the decision core
// (bashRunsOnHost, effectiveWorkspaceMode, bashWorkspaceMode,
// childWriteDeniesWorkspace, decide, decideLocalWrite).
//
// Run: node --test tests/guard-mode-line.test.mts
import assert from "node:assert/strict";

import { mergeConfig } from "../extensions/guard/policy/config.ts";
import {
	bashRunsOnHost,
	bashWorkspaceMode,
	childWriteDeniesWorkspace,
	decide as decidePolicy,
	decideLocalWrite,
	effectiveWorkspaceMode,
	type Decision,
	type GuardCall,
	type PolicyState,
} from "../extensions/guard/policy/decision.ts";
import { analysisForSync } from "./shellast-sync.mts";

// Synchronous test façade over the async shell-ast analysis (see shellast-sync.mts).
function decide(policy: PolicyState, call: GuardCall): Decision {
	return decidePolicy(policy, call, analysisForSync(call));
}
import {
	GUARD_STATE_BLOCKED_INHERITANCE,
	GUARD_STATE_BLOCKED_TEARDOWN,
	GUARD_STATE_FALLBACK,
	GUARD_STATE_LOCK_TAIL,
	GUARD_STATE_SECTION,
	renderGuardStateSection,
	type GuardStateSectionInput,
} from "../extensions/guard/policy/mode-line.ts";
import { ALL_PROFILES, isProfile, type Profile } from "../extensions/guard/policy/profiles.ts";
import type { SandboxMode } from "../extensions/guard/policy/state.ts";

const CWD = "/home/user/proj";

function input(overrides: Partial<GuardStateSectionInput> = {}): GuardStateSectionInput {
	return {
		initialized: true,
		inheritanceError: null,
		teardownFailure: null,
		profile: "default",
		sandboxMode: "full",
		workspaceLocked: false,
		inheritedProfile: null,
		interactive: true,
		bashWorkspaceReadOnly: false,
		...overrides,
	};
}

function makePolicy(overrides: Partial<PolicyState> = {}): PolicyState {
	return {
		profile: "default",
		config: mergeConfig({}, {}, CWD),
		sandboxMode: "full",
		cwd: CWD,
		workspaceLocked: false,
		interactive: true,
		inherited: false,
		...overrides,
	};
}

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
	tests.push({ name, fn });
}

test("the state line is exact for every profile at full sandbox, unlocked", () => {
	assert.equal(GUARD_STATE_SECTION, "guard_state");
	const expected: Record<Profile, string> = {
		research: "guard: profile research; sandbox full; host shell denied; writes denied",
		default: "guard: profile default; sandbox full; host shell rules, then read-only tier, then prompt; writes prompted (in-root or not), and sandboxed bash writes the workspace directly",
		"allow-edits": "guard: profile allow-edits; sandbox full; host shell rules, then read-only tier, then prompt; writes in-root allowed, out-of-root prompt",
		auto: "guard: profile auto; sandbox full; host shell rules, then read-only tier, then classifier; writes in-root classified, out-of-root prompt",
		trusted: "guard: profile trusted; sandbox full; host shell rules, then read-only tier, then allow; writes allowed",
		yolo: "guard: profile yolo; sandbox none (tools run raw); host shell deny/ask rules, else allow; writes allowed",
		unrestricted: "guard: profile unrestricted; sandbox none (tools run raw); host shell allow; writes allowed",
	};
	assert.deepEqual(Object.keys(expected).sort(), [...ALL_PROFILES].sort(), "every profile is covered");
	// Raw profiles are named verbatim: this line is advisory and the per-call
	// decision reasons already name them.
	for (const profile of ALL_PROFILES) {
		assert.ok(isProfile(profile));
		assert.equal(renderGuardStateSection(input({ profile })), expected[profile], profile);
	}
});

test("the sandbox clause follows the runtime mode and the lock", () => {
	assert.equal(
		renderGuardStateSection(input({ profile: "research", sandboxMode: "reduced" })),
		"guard: profile research; sandbox reduced (workspace overlay degrades to read-only); host shell denied; writes denied",
	);
	assert.equal(
		renderGuardStateSection(input({ profile: "research", sandboxMode: "degraded" })),
		"guard: profile research; sandbox degraded (no sandbox; bash and interpreters unavailable); host shell read-only tier only (degraded); writes denied",
	);
	// A locked raw profile is sandboxed and read-only again, so the raw clause
	// must disappear (bashRunsOnHost is false under the lock).
	assert.equal(
		renderGuardStateSection(input({ profile: "yolo", sandboxMode: "reduced", workspaceLocked: true })),
		`guard: profile yolo; sandbox reduced (workspace locked: read-only); host shell denied (workspace locked); writes stopped (workspace locked); ${GUARD_STATE_LOCK_TAIL}`,
	);
});

test("a locked workspace rewrites the affected clauses and adds the remedy", () => {
	assert.equal(
		renderGuardStateSection(input({ profile: "yolo", workspaceLocked: true })),
		`guard: profile yolo; sandbox full (workspace locked: read-only); host shell denied (workspace locked); writes stopped (workspace locked); ${GUARD_STATE_LOCK_TAIL}`,
	);
	// The lock posture is uniform; research denies writes on its own, so it
	// keeps its own clause while the lock still applies to host execution.
	const clauseOf = (line: string, prefix: string): string => line.split("; ").find((c) => c.startsWith(prefix)) ?? "";
	for (const profile of ALL_PROFILES) {
		const line = renderGuardStateSection(input({ profile, workspaceLocked: true }))!;
		assert.equal(clauseOf(line, "host shell "), "host shell denied (workspace locked)", profile);
		assert.equal(
			clauseOf(line, "writes "),
			profile === "research" ? "writes denied" : "writes stopped (workspace locked)",
			profile,
		);
		assert.ok(line.endsWith(`; ${GUARD_STATE_LOCK_TAIL}`), profile);
	}
});

test("the inherited suffix is shown while a valid constraint exists", () => {
	assert.equal(
		renderGuardStateSection(input({ profile: "default", inheritedProfile: "default" })),
		"guard: profile default (inherited, cannot be loosened); sandbox full; host shell rules, then read-only tier, then prompt; writes prompted (in-root or not), and sandboxed bash writes the workspace directly",
	);
	// Even after the child moved to research on its own: the restriction stands.
	assert.equal(
		renderGuardStateSection(input({ profile: "research", inheritedProfile: "default" })),
		"guard: profile research (inherited, cannot be loosened); sandbox full; host shell denied; writes denied",
	);
	assert.ok(!(renderGuardStateSection(input({ profile: "default" })) ?? "").includes("inherited"));
});

test("uninitialized, blocked, and unresolvable states", () => {
	assert.equal(renderGuardStateSection(input({ initialized: false })), null, "no session state, no section");
	assert.equal(
		renderGuardStateSection(input({ initialized: false, profile: "research", workspaceLocked: true })),
		null,
		"nothing is claimed before initialization",
	);
	assert.equal(renderGuardStateSection(input({ inheritanceError: "payload exceeds 1024 characters" })), GUARD_STATE_BLOCKED_INHERITANCE);
	assert.equal(renderGuardStateSection(input({ teardownFailure: "session replacement" })), GUARD_STATE_BLOCKED_TEARDOWN);
	// A blocked state wins over an unrenderable one: the reason is what matters.
	assert.equal(renderGuardStateSection(input({ profile: "made-up" as Profile, inheritanceError: "x" })), GUARD_STATE_BLOCKED_INHERITANCE);
	// A cast-invalid profile or mode (a stale caller) yields the fallback, never
	// a half-written line.
	assert.equal(renderGuardStateSection(input({ profile: "made-up" as Profile })), GUARD_STATE_FALLBACK);
	assert.equal(renderGuardStateSection(input({ sandboxMode: "made-up" as SandboxMode })), GUARD_STATE_FALLBACK);
	assert.equal(renderGuardStateSection(input({ sandboxMode: null })), GUARD_STATE_FALLBACK);
});

test("the sandbox clause agrees with bashRunsOnHost and effectiveWorkspaceMode", () => {
	for (const profile of ALL_PROFILES) {
		for (const sandboxMode of ["full", "reduced", "degraded"] as const) {
			for (const workspaceLocked of [false, true]) {
				const policy = makePolicy({ profile, sandboxMode, workspaceLocked });
				const line = renderGuardStateSection(input({ profile, sandboxMode, workspaceLocked }))!;
				const rawClause = line.includes("tools run raw");
				assert.equal(
					rawClause,
					bashRunsOnHost(policy) && sandboxMode !== "degraded",
					`${profile}/${sandboxMode}/locked=${workspaceLocked}: ${line}`,
				);
				if (workspaceLocked) assert.equal(effectiveWorkspaceMode(policy), "ro", `${profile}/${sandboxMode}`);
				if (sandboxMode === "degraded") assert.ok(line.includes("bash and interpreters unavailable"), profile);
			}
		}
	}
});

test("the host-shell clause agrees with decide", () => {
	// A command that never reaches the tightened read-only tier, so the action
	// is exactly the profile cell.
	const writeish: GuardCall = { kind: "host-shell", shell: "host-bash", command: "command touch probe" };
	const keyword: Record<string, RegExp> = { deny: /denied/, prompt: /prompt/, classify: /classifier/, allow: /allow/ };
	for (const profile of ALL_PROFILES) {
		const action = decide(makePolicy({ profile }), writeish).action;
		const line = renderGuardStateSection(input({ profile }))!;
		const clause = line.split("; ").find((c) => c.startsWith("host shell "))!;
		assert.match(clause, keyword[action], `${profile}: decide ${action} vs ${clause}`);
	}
	// Degraded research replaces the cell with the whole-command read-only tier.
	const readOnly: GuardCall = { kind: "host-shell", shell: "host-bash", command: "echo hi" };
	assert.equal(decide(makePolicy({ profile: "research", sandboxMode: "degraded" }), readOnly).action, "allow");
	assert.equal(decide(makePolicy({ profile: "research", sandboxMode: "degraded" }), writeish).action, "deny");
	assert.equal(
		renderGuardStateSection(input({ profile: "research", sandboxMode: "degraded" })),
		"guard: profile research; sandbox degraded (no sandbox; bash and interpreters unavailable); host shell read-only tier only (degraded); writes denied",
	);
	// The lock denies host execution for every profile (before the cell).
	for (const profile of ALL_PROFILES) {
		assert.equal(decide(makePolicy({ profile, workspaceLocked: true }), writeish).action, "deny", profile);
	}
});

test("the writes clause agrees with decideLocalWrite", () => {
	const inRoot = `${CWD}/a.ts`;
	const outRoot = "/tmp/guard-elsewhere/a.ts";
	const actionsFromClause = (clause: string): { inRoot: string; outRoot: string } => {
		switch (clause) {
			case "writes denied":
			case "writes stopped (workspace locked)": return { inRoot: "deny", outRoot: "deny" };
			case "writes prompted (in-root or not), and sandboxed bash writes the workspace directly": return { inRoot: "prompt", outRoot: "prompt" };
			case "writes in-root allowed, out-of-root prompt": return { inRoot: "allow", outRoot: "prompt" };
			case "writes in-root classified, out-of-root prompt": return { inRoot: "classify", outRoot: "prompt" };
			case "writes allowed": return { inRoot: "allow", outRoot: "allow" };
			default: throw new Error(`unmapped writes clause: ${clause}`);
		}
	};
	for (const profile of ALL_PROFILES) {
		for (const workspaceLocked of [false, true]) {
			const policy = makePolicy({ profile, workspaceLocked });
			const clause = renderGuardStateSection(input({ profile, workspaceLocked }))!.split("; ").find((c) => c.startsWith("writes "))!;
			const actual = {
				inRoot: decideLocalWrite({ kind: "local-write", tool: "edit", path: inRoot }, policy).action,
				outRoot: decideLocalWrite({ kind: "local-write", tool: "edit", path: outRoot }, policy).action,
			};
			assert.deepEqual(actual, actionsFromClause(clause), `${profile} locked=${workspaceLocked} (${clause})`);
		}
	}
});

test("a denied child renders the read-only workspace and the real write barrier", () => {
	// A subagent child is non-interactive and, on the default profile, its
	// write/edit gate collapses to deny: its bash workspace is read-only, and the
	// line says so instead of claiming prompts it can never answer.
	assert.equal(
		renderGuardStateSection(input({ inheritedProfile: "default", interactive: false, bashWorkspaceReadOnly: true })),
		"guard: profile default (inherited, cannot be loosened); sandbox full (workspace read-only: writes denied without a UI); host shell rules, then read-only tier, then prompt; writes denied (no UI, so prompts collapse, and sandboxed bash cannot write the read-only workspace)",
	);
	// Print/JSON mode is also non-interactive but keeps a writable workspace: the
	// clause must not claim a read-only mount, and must still name the bash path.
	assert.equal(
		renderGuardStateSection(input({ interactive: false })),
		"guard: profile default; sandbox full; host shell rules, then read-only tier, then prompt; writes denied (no UI, so prompts collapse, but sandboxed bash still writes the workspace directly)",
	);
});

test("bashWorkspaceMode and childWriteDeniesWorkspace pin the child rule", () => {
	// A default child with no UI: denied gate, read-only bash workspace.
	assert.equal(childWriteDeniesWorkspace(makePolicy({ inherited: true, interactive: false })), true);
	assert.equal(bashWorkspaceMode(makePolicy({ inherited: true, interactive: false })), "ro");
	// Everything else keeps the profile-derived mode: interactive parents (their
	// prompt is answerable), allow-edits and auto children (their gate can still
	// allow headless), and the raw profiles.
	assert.equal(bashWorkspaceMode(makePolicy({ inherited: false, interactive: true })), "rw");
	assert.equal(bashWorkspaceMode(makePolicy({ inherited: true, interactive: true })), "rw");
	assert.equal(bashWorkspaceMode(makePolicy({ profile: "allow-edits", inherited: true, interactive: false })), "rw");
	assert.equal(bashWorkspaceMode(makePolicy({ profile: "auto", inherited: true, interactive: false })), "rw");
	assert.equal(bashWorkspaceMode(makePolicy({ profile: "research", inherited: true, interactive: false })), "overlay");
	assert.equal(bashWorkspaceMode(makePolicy({ profile: "yolo", inherited: false, interactive: false })), "none");
	// Reduced mode degrades a research overlay but never invents rw for a child.
	assert.equal(bashWorkspaceMode(makePolicy({ profile: "research", inherited: true, interactive: false, sandboxMode: "reduced" })), "ro");
	assert.equal(bashWorkspaceMode(makePolicy({ inherited: true, interactive: false, sandboxMode: "reduced" })), "ro");
	// The workspace lock still wins, and renders on the sandbox clause.
	assert.equal(bashWorkspaceMode(makePolicy({ inherited: true, interactive: false, workspaceLocked: true })), "ro");
	// decideLocalWrite keeps returning the raw prompt; resolveDecision collapses it.
	const childPolicy = makePolicy({ inherited: true, interactive: false });
	assert.equal(decideLocalWrite({ kind: "local-write", tool: "edit", path: `${CWD}/a.ts` }, childPolicy).action, "prompt");
	assert.match(decideLocalWrite({ kind: "local-write", tool: "edit", path: `${CWD}/a.ts` }, childPolicy).reason, /do not route the write through bash/);
	// The interactive parent's reason carries no child guidance.
	assert.doesNotMatch(decideLocalWrite({ kind: "local-write", tool: "edit", path: `${CWD}/a.ts` }, makePolicy()).reason, /do not route the write through bash/);
	// The split, stated once: bash's mount mode is ro, while the profile-derived
	// mode that runtime.workerMode turns into a worker workspace stays rw (->
	// overlay in full mode), so python/node writes are discarded rather than
	// persisted (and not failed as EROFS).
	const childSplit = makePolicy({ inherited: true, interactive: false });
	assert.equal(effectiveWorkspaceMode(childSplit), "rw");
	assert.equal(bashWorkspaceMode(childSplit), "ro");
	// The text can never claim a read-only workspace that is writable: the child
	// predicate implies the ro mount across the whole matrix (the reverse is not
	// required: a lock or a degraded overlay is ro for its own reason and renders
	// its own clause).
	for (const profile of ALL_PROFILES) {
		for (const inherited of [false, true]) {
			for (const interactive of [false, true]) {
				for (const workspaceLocked of [false, true]) {
					for (const sandboxMode of ["full", "reduced", "degraded"] as const) {
						const p = makePolicy({ profile, inherited, interactive, workspaceLocked, sandboxMode });
						if (!childWriteDeniesWorkspace(p)) continue;
						assert.equal(inherited, true, "only an inherited session can trigger the child rule");
						assert.equal(bashWorkspaceMode(p), "ro", `${profile}/inherited=${inherited}/interactive=${interactive}/locked=${workspaceLocked}/${sandboxMode}`);
					}
				}
			}
		}
	}
	// A degraded child never reaches a mount: bash is denied by name there, so the
	// ro mode is inert rather than a claim about an unconfined spawn.
	assert.equal(decide(makePolicy({ inherited: true, interactive: false, sandboxMode: "degraded" }), { kind: "sandboxed-exec", tool: "bash", command: "touch x" }).action, "deny");
	// A locked child is not the child rule's case: the lock renders instead.
	assert.equal(childWriteDeniesWorkspace(makePolicy({ inherited: true, interactive: false, workspaceLocked: true })), false);
});

// ── Runner ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
	try {
		const r = t.fn();
		if (r instanceof Promise) await r;
		passed++;
		console.log(`  ok ${t.name}`);
	} catch (err) {
		failed++;
		console.error(`  FAIL ${t.name}:`, err);
	}
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
