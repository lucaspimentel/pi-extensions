/**
 * NuGet.Config sanitizer for the guard sandbox.
 *
 * The sandbox bind-mounts a sanitized copy of ~/.nuget/NuGet/NuGet.Config over
 * the original: the <packageSourceCredentials> and <apikeys> sections are
 * removed (case-insensitive, multiline, including self-closing forms) and
 * everything else is kept byte-identical, because an empty file breaks
 * restore. Project-level nuget.config files inside the workspace are NOT
 * touched (see the README threat model).
 */

export interface NugetSanitizeResult {
	/** Sanitized XML, or null when there was nothing to remove. */
	sanitized: string | null;
	/** Names of the removed sections. */
	removed: string[];
}

const SECTION_NAMES = ["packageSourceCredentials", "apikeys"] as const;

/**
 * Remove credentials-bearing sections from a NuGet.Config document. Returns
 * the sanitized text and the list of removed section names; sanitized is null
 * when nothing matched (the original can then be reused as-is conceptually;
 * run.ts still writes a copy so the bind is uniform).
 */
export function sanitizeNugetConfig(xml: string): NugetSanitizeResult {
	let out = xml;
	const removed: string[] = [];
	for (const name of SECTION_NAMES) {
		const block = new RegExp(`[ \\t]*<${name}(\\s[^>]*)?>[\\s\\S]*?</${name}\\s*>[ \\t]*\\r?\\n?`, "gi");
		const selfClosing = new RegExp(`[ \\t]*<${name}\\b[^>]*?/>[ \\t]*\\r?\\n?`, "gi");
		const before = out;
		out = out.replace(block, "");
		out = out.replace(selfClosing, "");
		if (out !== before) removed.push(name);
	}
	return { sanitized: removed.length > 0 ? out : null, removed };
}
