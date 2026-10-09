/**
 * git-read argument validation (scaffold stub).
 *
 * Step 2 fills this in per docs/git-read-design.md: per-subcommand flag
 * allowlists, `--` splitting into revs/paths, rev and path validators
 * (safe-union rule). The schema union already restricts the subcommand.
 */

export const SUBCOMMANDS = ["diff", "log", "show", "status"] as const;

export type GitSubcommand = (typeof SUBCOMMANDS)[number];

export interface ValidInvocation {
	ok: true;
	/** Full argv for the child: global options, subcommand, validated args. */
	argv: string[];
}

export interface InvalidInvocation {
	ok: false;
	reason: string;
}

export function validateInvocation(
	_subcommand: GitSubcommand,
	_args: readonly string[],
): ValidInvocation | InvalidInvocation {
	return { ok: false, reason: "argument validation is not implemented yet (scaffold)" };
}
