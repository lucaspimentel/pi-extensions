import { realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Component-aware containment, including the root itself. */
export function isWithin(candidate: string, root: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

/** Keep the configured spelling and any real target, so aliases cannot bypass exclusions. */
export function pathAliases(p: string): string[] {
	const normalized = path.resolve(p);
	try {
		return [...new Set([normalized, realpathSync(normalized)])];
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return [normalized];
		throw err;
	}
}

/** Explicit host exclusions only; this never scans home for mask-pattern matches. */
export function sensitiveHostPaths(homePath: string): string[] {
	const homes = new Set([...pathAliases(homePath), ...pathAliases(os.homedir())]);
	const paths = ["/run", "/mnt/c"];
	for (const home of homes) {
		for (const name of [
			".ssh", ".config/gh", ".aws", ".azure", ".npmrc", ".git-credentials", ".docker",
			".pi/agent", ".config/pup", ".local/share/pup", ".pup",
			".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".profile",
		]) paths.push(path.join(home, name));
	}
	if (process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)) {
		paths.push(path.join(process.env.XDG_CONFIG_HOME, "gh"), path.join(process.env.XDG_CONFIG_HOME, "pup"));
	}
	if (process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME)) {
		paths.push(path.join(process.env.XDG_DATA_HOME, "pup"));
	}
	if (process.env.SSH_AUTH_SOCK && path.isAbsolute(process.env.SSH_AUTH_SOCK)) paths.push(process.env.SSH_AUTH_SOCK);
	return [...new Set(paths.flatMap(pathAliases))];
}
