// Integration tests for the guard sandbox library: real bubblewrap sandbox,
// real launcher (overlays, seccomp, rlimits), real isolation and escape
// attempts, protected paths and masks, the post-call audit, and offline
// cargo/dotnet happy paths. Skips with an explicit reason when the runtime
// cannot reach full mode. On a supported Linux environment these must pass for
// the implementation to count as verified; mocked argument tests are
// insufficient.
//
// Run: node --test tests/guard-sandbox-integration.test.mts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { spawnSandboxed, createSessionDir, defaultRuntimeRoot, disposeSession, SandboxUnavailableError } from "../extensions/guard/sandbox/run.ts";
import { detectSandboxMode, resetSandboxDetection, type SandboxDetection } from "../extensions/guard/sandbox/detect.ts";
import { auditProtected, snapshotProtected } from "../extensions/guard/sandbox/audit.ts";
import { DEFAULT_MASK_PATTERNS, DEFAULT_MASK_EXCEPTIONS, RESERVED_ENV_KEYS, NEVER_ENV_KEYS, RLIMITS_PYTHON, RLIMITS_SHELL, type LaunchSpec } from "../extensions/guard/sandbox/spec.ts";

// ── Prerequisites: skip with an explicit reason when unsupported ─────────────

const onLinux = process.platform === "linux";
resetSandboxDetection();
const detection = onLinux ? detectSandboxMode() : null;
const supported = detection !== null && detection.mode === "full";
const skipReason = supported
	? null
	: !onLinux
		? `platform ${process.platform} is not Linux; guard sandbox tests require Linux with bubblewrap`
		: `guard runtime is not in full mode (${detection?.mode}): ${(detection?.diagnostics ?? []).join(" ")}`;

const tempDirs: string[] = [];
const sessionDirs: string[] = [];
function trackCleanup(dir: string) {
	tempDirs.push(dir);
	return dir;
}

function makeWorkspace(opts: { git?: boolean } = {}): string {
	const dir = trackCleanup(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-int-ws-"))));
	fs.writeFileSync(path.join(dir, "README.md"), "fixture\n", "utf8");
	fs.writeFileSync(path.join(dir, ".env"), "SECRET_TOKEN=1\n", "utf8");
	fs.writeFileSync(path.join(dir, ".env.example"), "PUBLIC_VAR=1\n", "utf8");
	if (opts.git) {
		const r = spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
		assert.equal(r.status, 0, `git init failed: ${r.stderr}`);
		// Minimal identity so commits work without global config assumptions.
		spawnSync("git", ["-C", dir, "config", "user.email", "guard@test"], { encoding: "utf8" });
		spawnSync("git", ["-C", dir, "config", "user.name", "guard-test"], { encoding: "utf8" });
	}
	return dir;
}

interface SandboxRun {
	code: number | null;
	signal: string | null;
	out: string;
	err: string;
	effective: ReturnType<typeof spawnSandboxed>["effective"];
	stdio: fs.ReadStream[];
}

async function runInSandbox(
	spec: Omit<LaunchSpec, "workspaceMode"> & { workspaceMode?: LaunchSpec["workspaceMode"] },
	options: { detection?: SandboxDetection } = {},
): Promise<SandboxRun> {
	const session = createSessionDir();
	sessionDirs.push(session);
	const r = spawnSandboxed(
		{
			...spec,
			workspaceMode: spec.workspaceMode ?? "rw",
			runtimeDir: session,
		},
		options,
	);
	let out = "";
	let err = "";
	r.child.stdout?.on("data", (c) => (out += c));
	r.child.stderr?.on("data", (c) => (err += c));
	const done = await r.done;
	return { ...done, out, err, effective: r.effective, stdio: r.child.stdio as unknown as fs.ReadStream[] };
}

/** Run a bash script inside a fresh sandbox and return the run. */
function bash(ws: string, script: string, extra: Partial<Parameters<typeof runInSandbox>[0]> = {}, options: { detection?: SandboxDetection } = {}) {
	return runInSandbox({ workspace: ws, target: ["bash", "-c", script], ...extra }, options);
}

const tests: { name: string; fn: () => Promise<void> }[] = [];
function test(name: string, fn: () => Promise<void>) {
	tests.push({ name, fn });
}

// ── Isolation and escapes ─────────────────────────────────────────────────────

if (supported) {
	test("home secrets are not mounted (ssh, gh, pi agent dir)", async () => {
		const ws = makeWorkspace();
		const r = await bash(
			ws,
			["ls ~/.ssh", "cat ~/.config/gh/hosts.yml", "ls ~/.pi/agent"]
				.map((cmd, i) => `${cmd} >/dev/null 2>&1; echo rc${i}=$?`)
				.join("; "),
		);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /rc0=[1-9]/, `~/.ssh must be absent; got: ${r.out}`);
		assert.match(r.out, /rc1=[1-9]/, `~/.config/gh must be absent; got: ${r.out}`);
		assert.match(r.out, /rc2=[1-9]/, `~/.pi/agent must be absent; got: ${r.out}`);
	});

	test("/mnt/c and /run/WSL are never mounted", async () => {
		const ws = makeWorkspace();
		const r = await bash(ws, "ls /mnt/c >/dev/null 2>&1; echo a=$?; ls /run/WSL >/dev/null 2>&1; echo b=$?");
		assert.match(r.out, /a=[1-9]/, "/mnt/c must be absent");
		assert.match(r.out, /b=[1-9]/, "/run/WSL must be absent");
	});

	test("the sandbox environment leaks no host variables", async () => {
		const ws = makeWorkspace();
		const r = await bash(ws, "env");
		assert.equal(r.code, 0, r.err);
		const sandboxKeys = new Set(
			r.out
				.split("\n")
				.filter((line) => line.includes("="))
				.map((line) => line.slice(0, line.indexOf("="))),
		);
		const allow = new Set<string>([...RESERVED_ENV_KEYS, ...NEVER_ENV_KEYS]);
		// Variables the shell itself provides regardless of inheritance.
		const shellProvided = new Set(["PWD", "OLDPWD", "SHLVL", "_", "PS1"]);
		const leaked: string[] = [];
		for (const key of Object.keys(process.env)) {
			if (key.length < 2) continue;
			if (allow.has(key) || shellProvided.has(key)) continue;
			if (sandboxKeys.has(key)) leaked.push(key);
		}
		assert.deepEqual(leaked, [], "host-only environment variables leaked into the sandbox");
	});

	test("external network is unreachable but loopback works", async () => {
		const ws = makeWorkspace();
		const ext = await bash(ws, "exec 3<>/dev/tcp/1.1.1.1/80 && echo open || echo closed");
		assert.match(ext.out, /closed/, "external TCP must fail under --unshare-net");
		const loopbackScript = [
			"import socket, threading",
			"s = socket.socket()",
			"s.bind(('127.0.0.1', 0))",
			"s.listen(1)",
			"port = s.getsockname()[1]",
			"def accept():",
			"    c, _ = s.accept()",
			"    c.recv(1)",
			"    c.close()",
			"t = threading.Thread(target=accept)",
			"t.start()",
			"c = socket.create_connection(('127.0.0.1', port), timeout=5)",
			"c.send(b'x')",
			"c.close()",
			"t.join(5)",
			"print('loopback-ok')",
		].join("\n");
		const loop = await bash(ws, `python3 -c '${loopbackScript.replace(/'/g, `'\\''`)}'`);
		assert.equal(loop.code, 0, `loopback failed: ${loop.err}`);
		assert.match(loop.out, /loopback-ok/, "loopback TCP must work (socket is allowed by seccomp)");
	});

	test("new user namespaces are blocked (unshare -U fails)", async () => {
		const ws = makeWorkspace();
		const r = await bash(ws, "unshare -U true; echo rc=$?");
		assert.match(r.out, /rc=[1-9]/, "--disable-userns must block nested user namespaces");
	});

	test("ptrace is blocked with EPERM by seccomp", async () => {
		const ws = makeWorkspace();
		const scriptPath = path.join(ws, "ptrace-probe.py");
		fs.writeFileSync(scriptPath, [
			"import ctypes, errno",
			"libc = ctypes.CDLL('libc.so.6', use_errno=True)",
			"r = libc.ptrace(0, 0, 0, 0)", // PTRACE_TRACEME
			"print('EPERM' if r == -1 and ctypes.get_errno() == errno.EPERM else 'NOT-BLOCKED')",
		].join("\n"));
		const r = await bash(ws, "python3 ptrace-probe.py");
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /EPERM/, "PTRACE_TRACEME must return EPERM under the seccomp policy");
	});

	test("/dev/tty cannot be opened (no controlling terminal, no TIOCSTI)", async () => {
		const ws = makeWorkspace();
		const r = await bash(ws, "exec 3<>/dev/tty; echo rc=$?");
		assert.match(r.out, /rc=[1-9]/, "/dev/tty must be unopenable under --new-session");
	});

	if (fs.existsSync("/mnt/c/Windows/System32/whoami.exe")) {
		test("WSL interop escape fails: a copied .exe does not run", async () => {
			const ws = makeWorkspace();
			fs.copyFileSync("/mnt/c/Windows/System32/whoami.exe", path.join(ws, "whoami.exe"));
			const r = await bash(ws, "./whoami.exe; echo rc=$?");
			// The binfmt handler /init needs WSL_INTEROP and /run/WSL, neither of
			// which exists in the sandbox: the exe must not produce a Windows
			// username or exit cleanly.
			assert.ok(r.code !== 0 || !/\\/.test(r.out), `whoami.exe output looks real: out=${r.out} err=${r.err}`);
			assert.doesNotMatch(r.out, /^[A-Za-z]+\\?[A-Za-z]+\\?[a-z0-9-]+$/m, "no Windows username in output");
		});
	}

	test("extra fds beyond stdio are wired through (fd 3)", async () => {
		const ws = makeWorkspace();
		const session = createSessionDir();
		sessionDirs.push(session);
		const r = spawnSandboxed({
			workspace: ws,
			workspaceMode: "rw",
			target: ["bash", "-c", "echo fd3-payload >&3; echo std-out"],
			extraFds: 1,
			runtimeDir: session,
		});
		assert.ok(r.child.stdio[3], "fd 3 must be a pipe");
		const chunks: Buffer[] = [];
		r.child.stdio[3]!.on("data", (c) => chunks.push(c as Buffer));
		let out = "";
		r.child.stdout?.on("data", (c) => (out += c));
		const res = await r.done;
		assert.equal(res.code, 0);
		assert.match(out, /std-out/);
		assert.match(Buffer.concat(chunks).toString("utf8"), /fd3-payload/);
	});

	test("launch discovery honors custom masks and exceptions", async () => {
		const ws = makeWorkspace();
		fs.writeFileSync(path.join(ws, "private.secret"), "custom-private-token");
		fs.writeFileSync(path.join(ws, "public.secret"), "public-fixture");
		const r = await bash(ws, "cat private.secret public.secret .env.example", {
			maskPatterns: [...DEFAULT_MASK_PATTERNS, "*.secret"],
			maskExceptions: [...DEFAULT_MASK_EXCEPTIONS, "public.secret"],
		});
		assert.equal(r.code, 0, r.err);
		assert.doesNotMatch(r.out, /custom-private-token/);
		assert.match(r.out, /public-fixture/);
		assert.match(r.out, /PUBLIC_VAR=1/);
		assert.equal(r.effective.maskedFiles, 2);
	});

	test("custom top-level protected entries are mounted read-only", async () => {
		const ws = makeWorkspace();
		fs.writeFileSync(path.join(ws, "custom-config"), "original");
		const r = await bash(ws, "echo evil > custom-config 2>/dev/null; echo rc=$?; cat custom-config", {
			protectedPaths: ["custom-config"],
		});
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /rc=[1-9]/);
		assert.match(r.out, /original/);
		assert.equal(fs.readFileSync(path.join(ws, "custom-config"), "utf8"), "original");
	});

	test("shared scratch is writable at its real path in overlay and reduced launches", async () => {
		const ws = makeWorkspace();
		const scratch = trackCleanup(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-int-scratch-"))));
		for (const reduced of [false, true]) {
			const file = path.join(scratch, reduced ? "reduced.txt" : "full.txt");
			const r = await bash(ws, `printf scratch-value > '${file}'; cat '${file}'`, {
				workspaceMode: "overlay",
				extraRwBinds: [[scratch, scratch]],
			}, reduced ? { detection: { ...detection!, mode: "reduced", launcherPath: null } } : {});
			assert.equal(r.code, 0, r.err);
			assert.equal(r.out, "scratch-value");
			assert.equal(fs.readFileSync(file, "utf8"), "scratch-value");
		}
	});

	// ── Protected paths and masks ─────────────────────────────────────────────

	test("writes to protected paths fail with EROFS and .git cannot be renamed", async () => {
		const ws = makeWorkspace({ git: true });
		fs.mkdirSync(path.join(ws, ".pi"));
		fs.writeFileSync(path.join(ws, "AGENTS.md"), "instructions\n");
		fs.mkdirSync(path.join(ws, "sub"));
		fs.writeFileSync(path.join(ws, "sub", "AGENTS.md"), "nested instructions\n");
		const script = [
			"touch .git/hooks/x 2>/dev/null; echo a=$?",
			"echo x > .pi/x.json 2>/dev/null; echo b=$?",
			"echo x > AGENTS.md 2>/dev/null; echo c=$?",
			"echo x > sub/AGENTS.md 2>/dev/null; echo d=$?",
			"mv .git .git2 2>/dev/null; echo e=$?",
			"echo x > .env 2>/dev/null; echo f=$?",
		].join("; ");
		const r = await bash(ws, script);
		assert.equal(r.code, 0, r.err);
		for (const k of ["a", "b", "c", "d", "e"]) {
			assert.match(r.out, new RegExp(`${k}=[1-9]`), `protected write ${k} must fail; got: ${r.out}`);
		}
		// The masked .env accepts writes (they go to /dev/null and vanish).
		assert.match(r.out, /f=0/, "masked .env behaves like /dev/null for writes");
	});

	test("masked .env reads empty while .env.example stays readable", async () => {
		const ws = makeWorkspace({ git: true });
		const r = await bash(ws, "cat .env; echo env-rc=$?; cat .env.example");
		assert.equal(r.code, 0, r.err);
		assert.equal(r.out.indexOf("env-rc=0"), 0, `cat .env must print nothing and exit 0; got: ${JSON.stringify(r.out)}`);
		assert.match(r.out, /PUBLIC_VAR=1/, ".env.example content must be readable");
		assert.doesNotMatch(r.out, /SECRET_TOKEN/, ".env content must never appear");
	});

	test("a protected path created inside the sandbox is quarantined by the audit", async () => {
		const ws = makeWorkspace();
		const before = snapshotProtected(ws);
		const r = await bash(ws, "mkdir -p .pi && echo '{}' > .pi/x.json");
		assert.equal(r.code, 0, r.err);
		const session = path.join(defaultRuntimeRoot(), "guard-int-audit1");
		const result = auditProtected(before, ws, { quarantineDir: path.join(session, "quarantine") });
		assert.deepEqual(result.created, [".pi"], JSON.stringify(result));
		assert.equal(fs.existsSync(path.join(ws, ".pi")), false, "the created .pi is quarantined out of the workspace");
		assert.ok(result.quarantined.length > 0);
		// Quarantined data is never deleted: the file content is in quarantine.
		const quarantinedTree = (() => {
			const qroot = path.join(session, "quarantine");
			const stamp = fs.readdirSync(qroot)[0];
			return fs.existsSync(path.join(qroot, stamp, ".pi", "x.json"));
		})();
		assert.ok(quarantinedTree, "the quarantined file is preserved");
		fs.rmSync(session, { recursive: true, force: true });
	});

	test("the nested parent-rename attack is detected, replaced, and quarantined", async () => {
		const ws = makeWorkspace();
		fs.mkdirSync(path.join(ws, "sub"));
		fs.writeFileSync(path.join(ws, "sub", "AGENTS.md"), "original\n");
		const before = snapshotProtected(ws);
		const r = await bash(ws, "mv sub sub2 && mkdir sub && echo evil > sub/AGENTS.md");
		assert.equal(r.code, 0, "the rename attack succeeds inside the sandbox (this is the known gap)");
		const session = path.join(defaultRuntimeRoot(), "guard-int-audit2");
		const result = auditProtected(before, ws, { quarantineDir: path.join(session, "quarantine") });
		assert.ok(result.replaced.includes(path.join("sub", "AGENTS.md")), JSON.stringify(result));
		assert.equal(result.lockWrites, true, "a replaced protected entry must set lockWrites");
		assert.equal(fs.existsSync(path.join(ws, "sub", "AGENTS.md")), false, "the evil file is quarantined");
		assert.ok(result.created.includes(path.join("sub2", "AGENTS.md")));
		fs.rmSync(session, { recursive: true, force: true });
	});

	if (spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0) {
		test("a git worktree has a read-only .git file and read-only common dir", async () => {
			const repo = makeWorkspace({ git: true });
			fs.writeFileSync(path.join(repo, "file.txt"), "tracked\n");
			spawnSync("git", ["-C", repo, "add", "."], { encoding: "utf8" });
			const commit = spawnSync("git", ["-C", repo, "commit", "-q", "-m", "init"], { encoding: "utf8" });
			assert.equal(commit.status, 0, commit.stderr);
			const wt = trackCleanup(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-int-wt-"))));
			const add = spawnSync("git", ["-C", repo, "worktree", "add", "--detach", wt], { encoding: "utf8" });
			assert.equal(add.status, 0, add.stderr);
			const script = [
				"echo x >> .git 2>/dev/null; echo a=$?",
				`echo x >> ${repo}/.git/config 2>/dev/null; echo b=$?`,
				"git status --porcelain >/dev/null 2>&1; echo c=$?",
			].join("; ");
			const r = await bash(wt, script);
			assert.match(r.out, /a=[1-9]/, "the worktree .git file must be read-only");
			assert.match(r.out, /b=[1-9]/, "the main clone's .git (common dir) must be read-only");
			assert.match(r.out, /c=0/, "git must still work inside a worktree sandbox");
		});
	}

	// ── Overlays ──────────────────────────────────────────────────────────────

	test("an overlay workspace discards writes and leaves no overlay dirs", async () => {
		const ws = makeWorkspace();
		const r = await bash(
			ws,
			"echo written-in-overlay > newfile.txt && mkdir -p obj && echo x > obj/a.o && cat newfile.txt",
			{ workspaceMode: "overlay" },
		);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /written-in-overlay/);
		assert.equal(fs.existsSync(path.join(ws, "newfile.txt")), false, "host workspace unchanged");
		assert.equal(fs.existsSync(path.join(ws, "obj")), false, "host workspace unchanged");
		assert.equal(
			fs.existsSync(path.join(r.effective.sessionDir, "overlays", r.effective.launchId)),
			false,
			"overlay dirs removed after exit",
		);
	});

	if (fs.existsSync(path.join(os.homedir(), ".cargo/registry"))) {
		test("a cache overlay lets lock files and extraction happen without persisting", async () => {
			const ws = makeWorkspace();
			const probe = path.join(os.homedir(), ".cargo/registry/guard-int-probe");
			try {
				fs.rmSync(probe, { force: true });
			} catch {
				/* ignore */
			}
			const r = await bash(ws, "touch ~/.cargo/registry/guard-int-probe && cat ~/.cargo/registry/CACHEDIR.TAG >/dev/null && echo ok");
			assert.equal(r.code, 0, r.err);
			assert.equal(fs.existsSync(probe), false, "the cache overlay write must not persist");
		});
	}

	// ── Toolchain credentials ────────────────────────────────────────────────

	test("cargo credentials read empty and NuGet.Config is sanitized (fake home)", async () => {
		const ws = makeWorkspace();
		const fakeHome = trackCleanup(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-int-home-"))));
		fs.mkdirSync(path.join(fakeHome, ".cargo"), { recursive: true });
		fs.mkdirSync(path.join(fakeHome, ".nuget", "NuGet"), { recursive: true });
		fs.writeFileSync(path.join(fakeHome, ".cargo", "credentials.toml"), 'token = "super-secret"\n');
		fs.writeFileSync(
			path.join(fakeHome, ".nuget", "NuGet", "NuGet.Config"),
			[
				"<?xml version=\"1.0\" encoding=\"utf-8\"?>",
				"<configuration>",
				"  <packageSources>",
				"    <add key=\"nuget.org\" value=\"https://api.nuget.org/v3/index.json\" />",
				"  </packageSources>",
				"  <packageSourceCredentials>",
				"    <Feed>",
				"      <add key=\"ClearTextPassword\" value=\"hunter2\" />",
				"    </Feed>",
				"  </packageSourceCredentials>",
				"  <apikeys>",
				"    <add key=\"https://api.nuget.org/v3/index.json\" value=\"key\" />",
				"  </apikeys>",
				"</configuration>",
			].join("\n"),
		);
		const r = await bash(
			ws,
			[
				"cat ~/.cargo/credentials.toml; echo cargo-rc=$?",
				"cat ~/.nuget/NuGet/NuGet.Config",
			].join("; "),
			{ homePath: fakeHome },
		);
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /cargo-rc=0/, "the credentials mask must be readable");
		assert.equal(r.out.indexOf("cargo-rc=0"), 0, `credentials.toml must read empty; got: ${JSON.stringify(r.out)}`);
		assert.match(r.out, /packageSources/, "the sanitized NuGet.Config keeps packageSources");
		assert.match(r.out, /nuget\.org/, "the sanitized NuGet.Config keeps sources");
		assert.doesNotMatch(r.out, /packageSourceCredentials/, "credentials section removed");
		assert.doesNotMatch(r.out, /hunter2/, "credential values removed");
		assert.doesNotMatch(r.out, /apikeys/, "apikeys section removed");
	});

	test("ancestor read roots cannot expose host credentials or undo toolchain sanitization", async () => {
		const parent = trackCleanup(fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), "guard-int-ancestor-"))));
		const fakeHome = path.join(parent, "home");
		fs.mkdirSync(fakeHome);
		const sensitive = [
			".ssh/key", ".config/gh/hosts.yml", ".aws/credentials", ".azure/token", ".docker/config.json",
			".pi/agent/auth.json", ".config/pup/tokens.json", ".local/share/pup/tokens.json",
			".npmrc", ".git-credentials", ".bashrc", ".zshrc", ".profile",
			".cargo/credentials", ".cargo/credentials.toml",
		];
		for (const rel of sensitive) {
			fs.mkdirSync(path.dirname(path.join(fakeHome, rel)), { recursive: true });
			fs.writeFileSync(path.join(fakeHome, rel), "HOST-CREDENTIAL-MARKER");
		}
		fs.mkdirSync(path.join(fakeHome, ".nuget/NuGet"), { recursive: true });
		fs.writeFileSync(path.join(fakeHome, ".nuget/NuGet/NuGet.Config"),
			'<configuration><packageSources><add key="public" value="https://example.test" /></packageSources><packageSourceCredentials><feed><add key="password" value="HOST-CREDENTIAL-MARKER" /></feed></packageSourceCredentials></configuration>');
		fs.writeFileSync(path.join(parent, "public.txt"), "public-root-fixture");
		const ws = makeWorkspace();
		const r = await bash(ws, [
			...sensitive.map((rel) => `cat '${path.join(fakeHome, rel)}' 2>/dev/null || true`),
			`cat '${path.join(fakeHome, ".nuget/NuGet/NuGet.Config")}'`,
			`cat '${path.join(parent, "public.txt")}'`,
		].join("; "), { homePath: fakeHome, readRoots: [parent] });
		assert.equal(r.code, 0, r.err);
		assert.doesNotMatch(r.out, /HOST-CREDENTIAL-MARKER/);
		assert.match(r.out, /packageSources/);
		assert.doesNotMatch(r.out, /packageSourceCredentials/);
		assert.match(r.out, /public-root-fixture/);
	});

	test("sensitive read-root aliases are rejected and ancestor mounts mask relocated credentials", async () => {
		const parent = trackCleanup(fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), "guard-int-aliases-"))));
		const home = path.join(parent, "home");
		const relocated = path.join(parent, "relocated-ssh");
		fs.mkdirSync(home);
		fs.mkdirSync(relocated);
		fs.writeFileSync(path.join(relocated, "key"), "RELOCATED-SECRET-MARKER");
		fs.symlinkSync(relocated, path.join(home, ".ssh"));
		const alias = path.join(parent, "ssh-alias");
		fs.symlinkSync(relocated, alias);
		const ws = makeWorkspace();
		for (const readRoots of [[alias], [parent, alias]]) {
			const r = await bash(ws, `cat '${alias}/key' '${relocated}/key' '${home}/.ssh/key' 2>/dev/null || true`, {
				homePath: home, readRoots,
			});
			assert.equal(r.code, 0, r.err);
			assert.doesNotMatch(r.out, /RELOCATED-SECRET-MARKER/);
			assert.ok(r.effective.skippedReadRoots.some((skip) => /sensitive|never mounted/.test(skip.reason)));
		}
	});

	test("workspace aliases resolve to real paths and excluded workspace aliases refuse launch", async () => {
		const parent = trackCleanup(fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), "guard-int-workspace-alias-"))));
		const ws = path.join(parent, "workspace");
		const alias = path.join(parent, "workspace-alias");
		fs.mkdirSync(ws);
		fs.writeFileSync(path.join(ws, "AGENTS.md"), "original instructions");
		fs.symlinkSync(ws, alias);
		const r = await bash(alias, "pwd; echo evil > AGENTS.md 2>/dev/null; echo rc=$?");
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, new RegExp(`^${ws}\\n`));
		assert.match(r.out, /rc=[1-9]/);
		const home = path.join(parent, "home");
		fs.mkdirSync(home);
		fs.symlinkSync(ws, path.join(home, ".ssh"));
		assert.throws(() => spawnSandboxed({ workspace: alias, workspaceMode: "rw", target: ["true"], homePath: home }), /sensitive host location/);
	});

	test("initial discovery failures refuse launch without executing a target", async () => {
		const ws = makeWorkspace();
		const marker = path.join(ws, "must-not-run");
		assert.throws(() => spawnSandboxed({
			workspace: ws, workspaceMode: "rw", target: ["bash", "-c", `touch '${marker}'`],
		}, { detection: { ...detection!, fdPath: "/missing-guard-scanner" } }), /discovery scan failed/);
		assert.equal(fs.existsSync(marker), false);
	});

	test("scratch binds and custom protections reject aliases, traversal, and mount manipulation", async () => {
		const ws = makeWorkspace();
		const scratch = trackCleanup(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-int-bind-validation-"))));
		const alias = path.join(ws, "scratch-alias");
		fs.symlinkSync(scratch, alias);
		for (const name of ["../escape", "/usr", "nested/config", "nested\\config"]) {
			assert.throws(() => spawnSandboxed({ workspace: ws, workspaceMode: "ro", target: ["true"], protectedPaths: [name] }), /top-level names/);
		}
		for (const bind of [[scratch, "/usr"], [alias, alias], ["/tmp", "/tmp"], [ws, ws]] as Array<[string, string]>) {
			assert.throws(() => spawnSandboxed({ workspace: ws, workspaceMode: "ro", target: ["true"], extraRwBinds: [bind] }), /extraRwBinds/);
		}
	});

	test("trusted scratch cannot bind sensitive host paths or their ancestors writable", async () => {
		const ws = makeWorkspace();
		const parent = trackCleanup(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-int-sensitive-scratch-"))));
		const home = path.join(parent, "home");
		const ssh = path.join(home, ".ssh");
		fs.mkdirSync(ssh, { recursive: true });
		for (const scratch of [ssh, parent]) {
			assert.throws(() => spawnSandboxed({
				workspace: ws, workspaceMode: "ro", target: ["true"], homePath: home,
				extraRwBinds: [[scratch, scratch]],
			}), /extraRwBinds.*sensitive/);
		}
	});

	test("credential aliases stay sanitized under ancestor mounts", async () => {
		const parent = trackCleanup(fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), "guard-int-credential-alias-"))));
		const home = path.join(parent, "home");
		fs.mkdirSync(path.join(home, ".cargo"), { recursive: true });
		fs.mkdirSync(path.join(home, ".nuget/NuGet"), { recursive: true });
		const cargo = path.join(parent, "cargo-secret");
		const nuget = path.join(parent, "nuget-secret");
		fs.writeFileSync(cargo, "ALIASED-CREDENTIAL-MARKER");
		fs.writeFileSync(nuget, '<configuration><packageSources /><apikeys><add key="source" value="ALIASED-CREDENTIAL-MARKER" /></apikeys></configuration>');
		fs.symlinkSync(cargo, path.join(home, ".cargo/credentials.toml"));
		fs.symlinkSync(nuget, path.join(home, ".nuget/NuGet/NuGet.Config"));
		const ws = makeWorkspace();
		const r = await bash(ws, `cat '${cargo}' '${nuget}' ~/.cargo/credentials.toml ~/.nuget/NuGet/NuGet.Config`, {
			homePath: home, readRoots: [parent],
		});
		assert.equal(r.code, 0, r.err);
		assert.doesNotMatch(r.out, /ALIASED-CREDENTIAL-MARKER|apikeys/);
		assert.match(r.out, /packageSources/);
	});

	test("staged worker binds survive hard pi-agent exclusions", async () => {
		const parent = trackCleanup(fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), "guard-int-staged-worker-"))));
		const home = path.join(parent, "home");
		fs.mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
		const worker = path.join(home, ".pi/agent/worker.py");
		fs.writeFileSync(worker, "import os\nprint('worker-ok')\nprint(os.path.exists(os.path.expanduser('~/.pi/agent/auth.json')))\n");
		fs.writeFileSync(path.join(home, ".pi/agent/auth.json"), "WORKER-HOST-SECRET");
		const r = await runInSandbox({
			workspace: makeWorkspace(), target: ["python3", "/.guard/worker.py"], homePath: home,
			readRoots: [parent], extraRoBinds: [[worker, "/.guard/worker.py"]],
		});
		assert.equal(r.code, 0, r.err);
		assert.equal(r.out, "worker-ok\nFalse\n");
	});

	test("ancestor grants and aliases cannot expose run or Windows host mounts", async () => {
		const ws = makeWorkspace();
		const alias = path.join(ws, "run-alias");
		fs.symlinkSync("/run", alias);
		const r = await bash(ws, "test -e /run/WSL; echo run=$?; test -e /mnt/c/Windows; echo windows=$?", {
			readRoots: ["/mnt", "/var", alias],
		});
		assert.equal(r.code, 0, r.err);
		assert.match(r.out, /run=1/);
		assert.match(r.out, /windows=1/);
		assert.ok(r.effective.skippedReadRoots.some((skip) => /never mounted/.test(skip.reason)));
	});

	test("custom masks also apply to nested protected files", async () => {
		const ws = makeWorkspace();
		fs.mkdirSync(path.join(ws, "sub"));
		fs.writeFileSync(path.join(ws, "sub/AGENTS.md"), "NESTED-MASKED-MARKER");
		const r = await bash(ws, "cat sub/AGENTS.md", {
			maskPatterns: [...DEFAULT_MASK_PATTERNS, "AGENTS.md"],
		});
		assert.equal(r.code, 0, r.err);
		assert.equal(r.out, "");
		assert.equal(r.effective.nestedProtectedEntries, 1);
	});

	test("incomplete discovery classification refuses launch and marks audit baselines incomplete", async () => {
		const ws = makeWorkspace();
		const tools = trackCleanup(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-int-scanner-"))));
		const scanner = path.join(tools, "scanner.mjs");
		fs.writeFileSync(scanner, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(path.join(ws, "vanished.key") + "\0")});\n`, { mode: 0o700 });
		assert.throws(() => spawnSandboxed({ workspace: ws, workspaceMode: "ro", target: ["true"] }, {
			detection: { ...detection!, fdPath: scanner },
		}), /discovery.*vanished.key/i);
		const before = snapshotProtected(ws, { fdPath: scanner });
		assert.equal(before.complete, false);
		assert.match(before.diagnostics!.join(" "), /vanished.key/);
	});

	// ── Happy paths (offline) ────────────────────────────────────────────────

	const cargoBin = path.join(os.homedir(), ".cargo/bin/cargo");
	const itoaDir = fs
		.readdirSync(path.join(os.homedir(), ".cargo/registry/src"), { withFileTypes: true })
		.flatMap((e) => (e.isDirectory() ? [path.join(os.homedir(), ".cargo/registry/src", e.name, "itoa-1.0.11")] : []))
		.find((p) => fs.existsSync(p));
	if (fs.existsSync(cargoBin) && itoaDir) {
		test("cargo test runs offline in the sandbox with cache overlays", async () => {
			const ws = makeWorkspace();
			fs.writeFileSync(
				path.join(ws, "Cargo.toml"),
				[
					"[package]",
					"name = \"guard-probe\"",
					"version = \"0.1.0\"",
					"edition = \"2021\"",
					"",
					"[dependencies]",
					"itoa = \"=1.0.11\"",
				].join("\n"),
			);
			fs.mkdirSync(path.join(ws, "src"));
			fs.writeFileSync(
				path.join(ws, "src", "lib.rs"),
				["pub fn answer() -> String {", "    itoa::Buffer::new().format(42).to_string()", "}", "", "#[cfg(test)]", "mod tests {", "    #[test]", "    fn formats() {", "        assert_eq!(super::answer(), \"42\");", "    }", "}"].join("\n"),
			);
			const lock = spawnSync(cargoBin, ["generate-lockfile", "--offline"], { cwd: ws, encoding: "utf8" });
			if (lock.status !== 0) {
				console.log(`  SKIP cargo happy path: host generate-lockfile failed: ${String(lock.stderr).trim().slice(0, 200)}`);
				return;
			}
			const r = await bash(ws, "cargo test --offline 2>&1; echo rc=$?");
			assert.match(r.out, /rc=0/, `cargo test --offline failed inside the sandbox: ${r.out}\n${r.err}`);
			assert.match(r.out, /test result: ok/, `tests must pass: ${r.out}`);
		});
	}

	const dotnet = path.join(os.homedir(), ".dotnet/dotnet");
	const newtonsoft = path.join(os.homedir(), ".nuget/packages/newtonsoft.json/13.0.3");
	if (fs.existsSync(dotnet) && fs.existsSync(newtonsoft)) {
		test("dotnet build and run work offline with no NU1900 audit warnings", async () => {
			const ws = makeWorkspace();
			const proj = path.join(ws, "GuardProbe");
			const create = spawnSync(dotnet, ["new", "console", "--no-restore", "-o", proj], { cwd: ws, encoding: "utf8" });
			if (create.status !== 0) {
				console.log(`  SKIP dotnet happy path: dotnet new failed: ${String(create.stderr).trim().slice(0, 200)}`);
				return;
			}
			const csproj = path.join(proj, "GuardProbe.csproj");
			let xml = fs.readFileSync(csproj, "utf8");
			xml = xml.replace(
				"</Project>",
				"  <ItemGroup>\n    <PackageReference Include=\"Newtonsoft.Json\" Version=\"13.0.3\" />\n  </ItemGroup>\n</Project>",
			);
			fs.writeFileSync(csproj, xml);
			fs.writeFileSync(path.join(proj, "Program.cs"), "System.Console.WriteLine(\"guard-probe-ok\");\n");
			const build = await bash(ws, "cd GuardProbe && dotnet build 2>&1; echo rc=$?");
			assert.match(build.out, /rc=0/, `dotnet build failed inside the sandbox: ${build.out}\n${build.err}`);
			assert.doesNotMatch(build.out, /NU1900/, "NuGetAudit=false must remove audit warnings");
			const run = await bash(ws, "cd GuardProbe && dotnet run --no-build 2>&1; echo rc=$?");
			assert.match(run.out, /guard-probe-ok/, `dotnet run output missing: ${run.out}\n${run.err}`);
			assert.match(run.out, /rc=0/);
		});
	}

	// ── Reduced mode ─────────────────────────────────────────────────────────

	test("forced reduced mode degrades overlay to read-only and reports it", async () => {
		const forced: SandboxDetection = {
			...detectSandboxMode(),
			mode: "reduced",
			launcherPath: null,
			diagnostics: ["forced: no compiler (integration test)"],
		};
		const ws = makeWorkspace();
		const r = await bash(ws, "echo x > reduced.txt; echo rc=$?", { workspaceMode: "overlay" }, { detection: forced });
		assert.equal(r.effective.mode, "reduced");
		assert.equal(r.effective.workspaceMode, "ro", "overlay must degrade to read-only");
		assert.ok(r.effective.degradations.length > 0, "the degradation must be reported");
		assert.match(r.out, /rc=[1-9]/, "writes must fail on the degraded read-only workspace");
		// Seccomp absence is informational: ptrace may or may not fail here for
		// other reasons; neither outcome fails this test.
	});

	// ── Rlimits ──────────────────────────────────────────────────────────────

	test("RLIMITS_PYTHON blocks a >512 MiB allocation", async () => {
		const ws = makeWorkspace();
		const r = await runInSandbox({
			workspace: ws,
			target: ["/usr/bin/python3", "-c", "b = bytearray(600 * 1024 * 1024); print('allocated')"],
			rlimits: RLIMITS_PYTHON,
		});
		assert.notEqual(r.code, 0, "the oversized allocation must fail");
		assert.doesNotMatch(r.out, /allocated/);
	});

	test("RLIMITS_SHELL leaves ulimit -v unlimited and RLIMITS_PYTHON caps it", async () => {
		const ws = makeWorkspace();
		const shell = await bash(ws, "ulimit -v", { rlimits: RLIMITS_SHELL });
		assert.equal(shell.code, 0, shell.err);
		assert.match(shell.out, /unlimited/, "RLIMITS_SHELL must not cap the address space (.NET and V8 need large ranges)");
		const py = await bash(ws, "ulimit -v", { rlimits: RLIMITS_PYTHON });
		assert.match(py.out, /524288/, "RLIMITS_PYTHON caps the address space at 512 MiB");
	});

	test("degraded mode refuses to spawn", async () => {
		const degraded: SandboxDetection = {
			mode: "degraded",
			diagnostics: ["forced degraded (integration test)"],
			bwrapPath: null,
			launcherPath: null,
			prlimitPath: null,
			fdPath: null,
			scanner: null,
		};
		const ws = makeWorkspace();
		assert.throws(
			() => spawnSandboxed({ workspace: ws, workspaceMode: "ro", target: ["true"] }, { detection: degraded }),
			(err: unknown) => err instanceof SandboxUnavailableError,
		);
	});
}

// ── Runner ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
if (!supported) {
	skipped = tests.length;
	console.log(`SKIP: guard sandbox integration tests: ${skipReason}`);
} else {
	for (const t of tests) {
		try {
			await t.fn();
			passed++;
			console.log(`  ok ${t.name}`);
		} catch (err) {
			failed++;
			console.error(`  FAIL ${t.name}:`, err);
		}
	}
	console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
	if (failed > 0) process.exit(1);
}

// Best-effort cleanup: sessions (quarantine included; tests own these dirs)
// and workspace fixtures.
for (const dir of sessionDirs) {
	try {
		disposeSession(dir);
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}
for (const dir of tempDirs) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

// Exit explicitly: killed-sandbox child handles can keep the event loop alive
// when stdout is piped (node --test runs this file as a child), so the process
// would otherwise hang after a fully passing run.
process.exit(0);
