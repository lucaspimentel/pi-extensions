/** Helpers for building shell rule prefills. User-edited broad rules remain valid. */

export function ruleToolForNamespace(shell: "host-bash" | "pwsh"): "HostBash" | "Pwsh" {
	return shell === "pwsh" ? "Pwsh" : "HostBash";
}

/** Escape a subject into an anchored exact pattern. */
export function escapeExactPattern(subject: string): string {
	return subject.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Bash subjects with glob metacharacters, regex-shaped text, or the shell
 * expansion marker need an exact regex to avoid unintentionally broadening
 * the suggested rule. PowerShell prefills retain their existing semantics.
 * The marker branch is defense in depth: expansion-bearing subjects never
 * reach a prefill (the evaluator refuses to allow them and the save/suggest
 * paths refuse to plan them), but any future caller stays safe.
 */
export function globAllowRule(shell: "host-bash" | "pwsh", subject: string): string {
	const tool = ruleToolForNamespace(shell);
	if (shell === "host-bash" && (/[?*]/.test(subject) || (subject.startsWith("/") && subject.endsWith("/")) || subject.toLowerCase().includes("@guard:exp:"))) {
		return `${tool}(/^${escapeExactPattern(subject)}$/)`;
	}
	return `${tool}(${subject})`;
}

export function exactDenyRule(shell: "host-bash" | "pwsh", subject: string): string {
	return `${ruleToolForNamespace(shell)}(/^${escapeExactPattern(subject)}$/)`;
}
