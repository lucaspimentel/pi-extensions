/**
 * Cold probe, loaded as a pi extension into a fresh headless `pi -p` process.
 *
 * Arms (SHELLAST_ARM):
 *   0  load nothing (control: pi's own startup to this point)
 *   1  import shell-ast, never parse
 *   2  import shell-ast, then the first parse
 *
 * Everything is measured as an offset from THIS process's time origin
 * (performance.timeOrigin), so pi's own startup cancels in the arm deltas.
 * The module body runs at extension-load time, prints one tagged line, and
 * exits before any model call or credential use.
 *
 * Written as plain JS syntax in a .ts file so it loads under either pi's
 * transpile path or Node's type stripping. SHELLAST_PKG (absolute path to the
 * package entry) overrides the bare specifier if pi relocates the file.
 */
const ARM = process.env.SHELLAST_ARM ?? "0";
const pkgOverride = process.env.SHELLAST_PKG;

const t0 = performance.now();
let importedAt = null;
let parsedAt = null;
let parseOk = null;
let parseError = null;
let parseErrorKind = null;

async function load() {
	if (pkgOverride !== undefined && pkgOverride !== "") return await import(pkgOverride);
	return await import("@questi0nm4rk/shell-ast");
}

if (ARM !== "0") {
	await load();
	importedAt = performance.now();
}
if (ARM === "2") {
	const mod = await load();
	try {
		await mod.parse("ls -la");
		parseOk = true;
	} catch (err) {
		parseOk = false;
		parseErrorKind = err && err.kind ? err.kind : null;
		parseError = err && err.message ? String(err.message).slice(0, 200) : String(err);
	}
	parsedAt = performance.now();
}

const mem = process.memoryUsage();
const ru = process.resourceUsage();
const out = {
	arm: ARM,
	node: process.version,
	t_import_ms: importedAt === null ? null : Number((importedAt - t0).toFixed(3)),
	t_parse_ms: parsedAt === null ? null : Number((parsedAt - t0).toFixed(3)),
	t_total_ms: Number((performance.now() - t0).toFixed(3)),
	rss_steady: mem.rss,
	rss_heap_used: mem.heapUsed,
	rss_peak_kb: ru.maxRSS,
	parse_ok: parseOk,
	parse_error_kind: parseErrorKind,
	parse_error: parseError,
};
console.log("SHELLAST_PROBE " + JSON.stringify(out));

export default function probe() {}
process.exit(0);
