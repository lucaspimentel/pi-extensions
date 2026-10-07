// Real-process tests at the guard worker controller seam.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { test } from "node:test";
import { PythonSessionController } from "../extensions/guard/tools/python/session.ts";
import { NodeSessionController } from "../extensions/guard/tools/node/session.ts";
import { detectSandboxMode } from "../extensions/guard/sandbox/detect.ts";

const pythonAvailable = spawnSync("python3", ["--version"], { timeout: 5_000 }).status === 0;
const detection = detectSandboxMode();
const workers = [
	{ name: "python", Controller: PythonSessionController, available: pythonAvailable, assign: "x = 41", read: "x + 1" },
	{ name: "node", Controller: NodeSessionController, available: true, assign: "let x = 41", read: "x + 1" },
] as const;

function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-workers-")));
	const projectDir = path.join(root, "project");
	const runtimeDir = path.join(root, "runtime");
	const scratchDir = path.join(root, "scratch");
	for (const dir of [projectDir, runtimeDir, scratchDir]) fs.mkdirSync(dir, { mode: 0o700 });
	return { root, projectDir, runtimeDir, scratchDir };
}

function sandboxSkip(available: boolean): false | string {
	if (!available) return "Python interpreter unavailable";
	return detection.mode === "full" ? false : `Full guard sandbox unavailable (${detection.mode}): ${detection.diagnostics.join(" ")}`;
}

for (const worker of workers) {
	test(`${worker.name}: raw globals persist and status/reset never start a worker`, { skip: !worker.available && "Python interpreter unavailable" }, async () => {
		const f = fixture();
		const c = new worker.Controller({ ...f, workspaceMode: "none" });
		try {
			assert.equal((await c.status()).workerRunning, false);
			await c.reset();
			assert.equal((await c.status()).generation, 0);
			assert.equal((await c.execute(worker.assign, undefined, undefined)).status, "ok");
			const result = await c.execute(worker.read, undefined, undefined);
			assert.equal(result.status, "ok", result.diagnostic ?? "");
			assert.equal(result.repr, "42");
			assert.equal(result.generation, 1);
			const status = await c.status();
			assert.equal(status.workspaceMode, "raw");
			assert.equal(status.paths.sandboxProject, f.projectDir);
			assert.equal(status.paths.sandboxScratch, f.scratchDir);
		} finally {
			await c.dispose("test");
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	test(`${worker.name}: cancellation is lazy before startup and kills active execution without replay`, { skip: !worker.available && "Python interpreter unavailable" }, async () => {
		const f = fixture();
		const c = new worker.Controller({ ...f, workspaceMode: "none" });
		const aborted = new AbortController();
		aborted.abort();
		try {
			assert.equal((await c.execute("41+1", undefined, aborted.signal)).status, "cancelled");
			assert.equal((await c.status()).generation, 0);
			const activeSignal = new AbortController();
			const marker = path.join(f.scratchDir, "started");
			const active = c.execute(worker.name === "python" ? `open(${JSON.stringify(marker)}, 'w').write('started')\nwhile True: pass` : `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started'); while(true) {}`, 30, activeSignal.signal);
			const deadline = Date.now() + 5000;
			while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.ok(fs.existsSync(marker));
			activeSignal.abort();
			const result = await active;
			assert.equal(result.status, "cancelled", result.diagnostic ?? "");
			assert.equal(result.stateLost, true);
			assert.equal((await c.status()).workerRunning, false);
			assert.ok(fs.existsSync(marker));
		} finally {
			await c.dispose("test");
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	test(`${worker.name}: ordinary errors preserve mutations and repr state`, { skip: !worker.available && "Python interpreter unavailable" }, async () => {
		const f = fixture();
		const c = new worker.Controller({ ...f, workspaceMode: "none" });
		try {
			assert.equal((await c.execute(worker.assign, undefined, undefined)).status, "ok");
			const failed = await c.execute(worker.name === "python" ? "x += 1\nraise ValueError('expected')" : "x++; throw new Error('expected')", undefined, undefined);
			assert.equal(failed.status, "runtime_error");
			assert.equal(failed.stateLost, false);
			assert.equal((await c.execute("x", undefined, undefined)).repr, "42");
		} finally {
			await c.dispose("test");
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	test(`${worker.name}: large unicode repr/errors stay bounded without losing the interpreter`, { skip: !worker.available && "Python interpreter unavailable" }, async () => {
		const f = fixture();
		const c = new worker.Controller({ ...f, workspaceMode: "none" });
		try {
			const repr = await c.execute(worker.name === "python" ? "'é' * 10000" : "Object.fromEntries(Array.from({length: 100}, (_, i) => ['key'+i, 'é'.repeat(100)]))", undefined, undefined);
			assert.equal(repr.status, "ok", repr.diagnostic ?? "");
			assert.equal(repr.reprTruncated, true);
			assert.ok(Buffer.byteLength(repr.repr!, "utf8") <= 8192);
			const error = await c.execute(worker.name === "python" ? "raise ValueError('é' * 8192)" : "throw new Error('é'.repeat(8192))", undefined, undefined);
			assert.equal(error.status, "runtime_error", error.diagnostic ?? "");
			assert.equal(error.stateLost, false);
			assert.ok(Buffer.byteLength(error.exception!.message, "utf8") <= 8192);
			assert.equal((await c.execute("41+1", undefined, undefined)).repr, "42");
		} finally {
			await c.dispose("test");
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	test(`${worker.name}: bounded output overflow and malformed FD3 frames kill the generation without replay`, { skip: !worker.available && "Python interpreter unavailable" }, async () => {
		const f = fixture();
		const c = new worker.Controller({ ...f, workspaceMode: "none" });
		try {
			const overflow = await c.execute(worker.name === "python" ? "import os\nos.write(1, b'x' * (2 * 1024 * 1024))" : "require('fs').writeSync(1, Buffer.alloc(2 * 1024 * 1024, 120))", undefined, undefined);
			assert.equal(overflow.status, "output_limit", overflow.diagnostic ?? "");
			assert.equal(overflow.stateLost, true);
			assert.equal(overflow.logComplete, false);
			assert.ok(Buffer.byteLength(overflow.stdout) < 50_000);
			const corrupt = await c.execute(worker.name === "python" ? "import os\nos.write(3, b'not-json\\n')" : "require('fs').writeSync(3, 'not-json\\n')", undefined, undefined);
			assert.equal(corrupt.status, "worker_error");
			assert.equal(corrupt.stateLost, true);
			const fresh = await c.execute("41+1", undefined, undefined);
			assert.equal(fresh.status, "ok", fresh.diagnostic ?? "");
			assert.equal(fresh.repr, "42");
			assert.ok(fresh.generation > corrupt.generation);
		} finally {
			await c.dispose("test");
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	test(`${worker.name}: a valid result followed by a malformed frame is still a protocol failure`, { skip: !worker.available && "Python interpreter unavailable" }, async () => {
		const f = fixture();
		const c = new worker.Controller({ ...f, workspaceMode: "none" });
		const forged = JSON.stringify({ type: "result", protocol: 1, id: 1, status: "ok", repr: null, reprTruncated: false, exception: null, sandboxProcesses: 0 }) + "\nnot-json\n";
		try {
			const result = await c.execute(worker.name === "python" ? `import os\nos.write(3, ${JSON.stringify(forged)}.encode())\nwhile True: pass` : `require('fs').writeSync(3, ${JSON.stringify(forged)}); while(true) {}`, undefined, undefined);
			assert.equal(result.status, "worker_error", result.diagnostic ?? "");
			assert.equal(result.stateLost, true);
		} finally {
			await c.dispose("test");
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	test(`${worker.name}: raw mode reads and writes outside the project without grants`, { skip: !worker.available && "Python interpreter unavailable" }, async () => {
		const f = fixture();
		const external = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), "guard-worker-raw-")));
		const filename = JSON.stringify(path.join(external, "host.txt"));
		const c = new worker.Controller({ ...f, workspaceMode: "none" });
		try {
			const result = await c.execute(worker.name === "python" ? `open(${filename}, 'w').write('host-visible')\nopen(${filename}).read()` : `require('fs').writeFileSync(${filename}, 'host-visible'); require('fs').readFileSync(${filename}, 'utf8')`, undefined, undefined);
			assert.equal(result.status, "ok", result.diagnostic ?? "");
			assert.equal(result.permissionPath, undefined);
			assert.match(result.repr!, /host-visible/);
			assert.equal(fs.readFileSync(path.join(external, "host.txt"), "utf8"), "host-visible");
		} finally {
			await c.dispose("test");
			fs.rmSync(external, { recursive: true, force: true });
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	test(`${worker.name}: reduced mode degrades overlays to read-only, not to host execution`, { skip: detection.mode === "degraded" ? detection.diagnostics.join(" ") : !worker.available && "Python interpreter unavailable" }, async () => {
		const f = fixture();
		fs.writeFileSync(path.join(f.projectDir, "data.txt"), "host-original");
		const reduced = { ...detection, mode: "reduced" as const, launcherPath: null };
		const c = new worker.Controller({ ...f, workspaceMode: "overlay", detection: reduced });
		try {
			const failed = await c.execute(worker.name === "python" ? "open('data.txt', 'w').write('changed')" : "require('fs').writeFileSync('data.txt', 'changed')", undefined, undefined);
			assert.equal(failed.status, "runtime_error", failed.diagnostic ?? "");
			assert.equal((await c.status()).workspaceMode, "read-only");
			assert.equal(fs.readFileSync(path.join(f.projectDir, "data.txt"), "utf8"), "host-original");
		} finally {
			await c.dispose("test");
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	test(`${worker.name}: a failed sandbox spawn never falls back to the host`, { skip: !worker.available && "Python interpreter unavailable" }, async () => {
		const f = fixture();
		const brokenDetection = { ...detection, mode: "reduced" as const, launcherPath: null, bwrapPath: path.join(f.root, "missing-bwrap") };
		const c = new worker.Controller({ ...f, workspaceMode: "overlay", detection: brokenDetection });
		try {
			const failed = await c.execute(worker.name === "python" ? "open('host-fallback', 'w').write('bad')" : "require('fs').writeFileSync('host-fallback', 'bad')", undefined, undefined);
			assert.equal(failed.status, "worker_error", failed.diagnostic ?? "");
			assert.equal(fs.existsSync(path.join(f.projectDir, "host-fallback")), false);
			assert.equal((await c.status()).workerRunning, false);
		} finally {
			await c.dispose("test");
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	for (const workspaceMode of ["none", "overlay"] as const) {
		test(`${worker.name}: ${workspaceMode} dispose preempts execution outside the lock and rejects queued code`, { skip: workspaceMode === "none" ? !worker.available && "Python interpreter unavailable" : sandboxSkip(worker.available) }, async () => {
			const f = fixture();
			const marker = path.join(f.scratchDir, "started");
			const c = new worker.Controller({ ...f, workspaceMode, detection });
			try {
				const active = c.execute(worker.name === "python" ? `open(${JSON.stringify(marker)}, 'w').write('started')\nwhile True: pass` : `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started'); while(true) {}`, 30, undefined);
				const queued = c.execute(worker.assign, undefined, undefined);
				const deadline = Date.now() + 5000;
				while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
				assert.ok(fs.existsSync(marker), "worker entered execution");
				const before = Date.now();
				await c.dispose("tightening");
				assert.ok(Date.now() - before < 2000, "dispose must not wait for the execution deadline or controller lock");
				assert.equal((await active).stateLost, true);
				assert.equal((await queued).status, "unavailable");
				assert.equal((await c.status()).workerRunning, false);
				assert.ok(fs.existsSync(marker));
			} finally {
				await c.dispose("test");
				fs.rmSync(f.root, { recursive: true, force: true });
			}
		});

		test(`${worker.name}: ${workspaceMode} timeout kills known descendants even after setsid`, { skip: process.platform !== "linux" ? "Descendant check requires Linux /proc" : workspaceMode === "none" ? !worker.available && "Python interpreter unavailable" : sandboxSkip(worker.available) }, async () => {
			const f = fixture();
			const marker = `guard-worker-descendant-${path.basename(f.root)}`;
			const c = new worker.Controller({ ...f, workspaceMode, detection });
			function descendants(): number[] {
				const pids: number[] = [];
				for (const entry of fs.readdirSync("/proc")) {
					if (!/^\d+$/.test(entry)) continue;
					try {
						const argv = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
						if (argv.includes(marker)) pids.push(Number(entry));
					} catch { /* process exited */ }
				}
				return pids;
			}
			try {
				const childCode = `exec -a ${marker} /bin/sleep 60`;
				const result = await c.execute(worker.name === "python" ? `import subprocess\nsubprocess.Popen(['/bin/bash', '-c', ${JSON.stringify(childCode)}], start_new_session=True)\nwhile True: pass` : `require('child_process').spawn('/bin/bash', ['-c', ${JSON.stringify(childCode)}], {detached: true}); while(true) {}`, 1, undefined);
				assert.equal(result.status, "timeout", result.diagnostic ?? "");
				assert.equal(result.stateLost, true);
				assert.deepEqual(descendants(), [], "known descendants no longer execute after teardown");
			} finally {
				await c.dispose("test");
				for (const pid of descendants()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
				fs.rmSync(f.root, { recursive: true, force: true });
			}
		});

		test(`${worker.name}: ${workspaceMode} timeout/reset lose globals but preserve shared scratch and logs`, { skip: workspaceMode === "none" ? !worker.available && "Python interpreter unavailable" : sandboxSkip(worker.available) }, async () => {
			const f = fixture();
			const c = new worker.Controller({ ...f, workspaceMode, detection });
			fs.writeFileSync(path.join(f.scratchDir, "keep.txt"), "durable");
			try {
				assert.equal((await c.execute(worker.assign, undefined, undefined)).status, "ok");
				const failed = await c.execute(worker.name === "python" ? "print('partial', flush=True)\nwhile True: pass" : "console.log('partial'); while(true) {}", 1, undefined);
				assert.equal(failed.status, "timeout", failed.diagnostic ?? "");
				assert.equal(failed.stateLost, true);
				assert.match(failed.stdout, /partial/);
				assert.equal(fs.readFileSync(path.join(f.scratchDir, "keep.txt"), "utf8"), "durable");
				assert.equal((await c.status()).workerRunning, false);
				const missing = await c.execute("x", undefined, undefined);
				assert.equal(missing.status, "runtime_error");
				assert.ok(missing.generation > failed.generation);
				await c.reset();
				assert.equal((await c.status()).workerRunning, false);
				await c.dispose("test");
				assert.equal(fs.readFileSync(path.join(f.scratchDir, "keep.txt"), "utf8"), "durable");
				assert.ok(fs.existsSync(failed.logPaths!.stdout), "runtime owns log cleanup");
			} finally {
				await c.dispose("test");
				fs.rmSync(f.root, { recursive: true, force: true });
			}
		});
	}

	test(`${worker.name}: workspace overlay writes stay visible to the worker but never reach the host`, { skip: sandboxSkip(worker.available) }, async () => {
		const f = fixture();
		fs.writeFileSync(path.join(f.projectDir, "data.txt"), "host-original");
		const c = new worker.Controller({ ...f, workspaceMode: "overlay", detection });
		const write = worker.name === "python" ? "open('data.txt', 'w').write('worker-overlay')" : "require('fs').writeFileSync('data.txt', 'worker-overlay')";
		const read = worker.name === "python" ? "open('data.txt').read()" : "require('fs').readFileSync('data.txt', 'utf8')";
		try {
			const changed = await c.execute(write, undefined, undefined);
			assert.equal(changed.status, "ok", changed.diagnostic ?? changed.exception?.message ?? "");
			assert.match((await c.execute(read, undefined, undefined)).repr!, /worker-overlay/);
			assert.equal(fs.readFileSync(path.join(f.projectDir, "data.txt"), "utf8"), "host-original");
			assert.equal((await c.status()).workspaceMode, "overlay");
			await c.reset();
			assert.match((await c.execute(read, undefined, undefined)).repr!, /host-original/);
		} finally {
			await c.dispose("test");
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	for (const workspaceMode of ["none", "overlay", "ro"] as const) {
		test(`${worker.name}: ${workspaceMode} filesystem, secrets, environment, and network match the mode`, { skip: workspaceMode === "none" ? !worker.available && "Python interpreter unavailable" : sandboxSkip(worker.available) }, async () => {
			const f = fixture();
			fs.writeFileSync(path.join(f.projectDir, ".env"), "hidden-token");
			fs.writeFileSync(path.join(f.projectDir, "custom.secret"), "custom-token");
			fs.writeFileSync(path.join(f.projectDir, ".env.example"), "public-example");
			fs.mkdirSync(path.join(f.projectDir, ".pi"));
			fs.writeFileSync(path.join(f.projectDir, ".pi", "config"), "protected");
			fs.writeFileSync(path.join(f.projectDir, "custom-protected.txt"), "protected");
			const markerKey = "GUARD_WORKER_TEST_TOKEN";
			const previous = process.env[markerKey];
			process.env[markerKey] = "host-environment-secret";
			const c = new worker.Controller({ ...f, workspaceMode, detection, maskPatterns: [".env*", "*.secret"], maskExceptions: [".env.example"], protectedPaths: ["custom-protected.txt"] });
			const server = net.createServer((socket) => socket.end());
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as net.AddressInfo).port;
			const read = (filename: string) => worker.name === "python" ? `open(${JSON.stringify(filename)}).read()` : `require('fs').readFileSync(${JSON.stringify(filename)}, 'utf8')`;
			const write = (filename: string) => worker.name === "python" ? `open(${JSON.stringify(filename)}, 'w').write('changed')` : `require('fs').writeFileSync(${JSON.stringify(filename)}, 'changed')`;
			try {
				const env = await c.execute(worker.name === "python" ? `import os\nos.environ.get('${markerKey}', 'scrubbed')` : `process.env.${markerKey} || 'scrubbed'`, undefined, undefined);
				assert.equal(env.status, "ok", env.diagnostic ?? "");
				assert.match(env.repr!, workspaceMode === "none" ? /host-environment-secret/ : /scrubbed/);
				for (const filename of [".env", "custom.secret"]) {
					const secret = await c.execute(read(filename), undefined, undefined);
					assert.equal(secret.status, "ok", secret.exception?.message ?? secret.diagnostic ?? "");
					assert.match(secret.repr!, workspaceMode === "none" ? /token/ : /^['"]{2}$/);
				}
				assert.match((await c.execute(read(".env.example"), undefined, undefined)).repr!, /public-example/);
				for (const filename of [".pi/config", "custom-protected.txt"]) {
					const protectedWrite = await c.execute(write(filename), undefined, undefined);
					assert.equal(protectedWrite.status, workspaceMode === "none" ? "ok" : "runtime_error", protectedWrite.diagnostic ?? "");
					assert.equal(fs.readFileSync(path.join(f.projectDir, filename), "utf8"), workspaceMode === "none" ? "changed" : "protected");
				}
				const network = worker.name === "python"
					? `import socket\ns = socket.socket()\ns.settimeout(1)\ntry:\n    s.connect(('127.0.0.1', ${port}))\n    print('connected')\nexcept OSError:\n    print('blocked')\nfinally:\n    s.close()`
					: `require('child_process').spawnSync(require('process').execPath, ['--max-old-space-size=64', '-e', ${JSON.stringify(`const s = require('net').connect(${port}, '127.0.0.1'); s.on('connect', () => {console.log('connected'); s.destroy()}); s.on('error', () => console.log('blocked')); s.setTimeout(1000, () => {console.log('blocked'); s.destroy()})`)}], {timeout: 3000}).stdout.toString()`;
				const connected = await c.execute(network, undefined, undefined);
				assert.equal(connected.status, "ok", connected.exception?.message ?? connected.diagnostic ?? "");
				assert.match(worker.name === "python" ? connected.stdout : connected.repr!, workspaceMode === "none" ? /connected/ : /blocked/);
				if (workspaceMode === "none") {
					const resource = await c.execute(worker.name === "python" ? "import resource\nresource.getrlimit(resource.RLIMIT_AS)[0] != 512 * 1024 * 1024" : "require('process').execArgv.some(x => x.startsWith('--max-old-space-size'))", undefined, undefined);
					assert.equal(resource.repr, worker.name === "python" ? "True" : "false");
				}
			} finally {
				await c.dispose("test");
				await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
				if (previous === undefined) delete process.env[markerKey]; else process.env[markerKey] = previous;
				fs.rmSync(f.root, { recursive: true, force: true });
			}
		});
	}

	test(`${worker.name}: outside reads return a grant request without replay, missing workspace files do not`, { skip: sandboxSkip(worker.available) }, async () => {
		const f = fixture();
		const external = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), "guard-worker-read-")));
		const outside = JSON.stringify(path.join(external, "data.txt"));
		const marker = JSON.stringify(path.join(f.scratchDir, "executions.txt"));
		fs.writeFileSync(path.join(external, "data.txt"), "granted-content");
		const c = new worker.Controller({ ...f, workspaceMode: "overlay", detection });
		try {
			const code = worker.name === "python"
				? `attempts = 1\nopen(${marker}, 'a').write('once\\n')\nopen(${outside}).read()`
				: `let attempts = 1; require('fs').appendFileSync(${marker}, 'once\\n'); require('fs').readFileSync(${outside}, 'utf8')`;
			const denied = await c.execute(code, undefined, undefined);
			assert.equal(denied.status, "permission_needed", denied.exception?.message ?? denied.diagnostic ?? "");
			assert.equal(denied.permissionPath, path.join(external, "data.txt"));
			assert.equal(denied.stateLost, false);
			assert.equal((await c.execute("attempts", undefined, undefined)).repr, "1");
			assert.equal(fs.readFileSync(path.join(f.scratchDir, "executions.txt"), "utf8"), "once\n");
			const missing = await c.execute(worker.name === "python" ? "open('does-not-exist.txt').read()" : "require('fs').readFileSync(require('path').join(process.cwd(), 'does-not-exist.txt'))", undefined, undefined);
			assert.equal(missing.status, "runtime_error");
			assert.equal(missing.permissionPath, undefined);
			await c.dispose("read_grant");
			const granted = new worker.Controller({ ...f, workspaceMode: "overlay", readRoots: [external], detection });
			try {
				assert.equal((await granted.status()).workerRunning, false);
				assert.equal(fs.readFileSync(path.join(f.scratchDir, "executions.txt"), "utf8"), "once\n");
				const read = await granted.execute(worker.name === "python" ? `open(${outside}).read()` : `require('fs').readFileSync(${outside}, 'utf8')`, undefined, undefined);
				assert.equal(read.status, "ok", read.exception?.message ?? read.diagnostic ?? "");
				assert.match(read.repr!, /granted-content/);
			} finally { await granted.dispose("test"); }
		} finally {
			await c.dispose("test");
			fs.rmSync(external, { recursive: true, force: true });
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});

	for (const workspaceMode of ["none", "overlay"] as const) {
		test(`${worker.name}: ${workspaceMode} project modules resolve at the real cwd`, { skip: workspaceMode === "none" ? !worker.available && "Python interpreter unavailable" : sandboxSkip(worker.available) }, async () => {
			const f = fixture();
			fs.writeFileSync(path.join(f.projectDir, "project_module.py"), "value = 42\n");
			fs.writeFileSync(path.join(f.projectDir, "project-module.cjs"), "module.exports = {value: 42}\n");
			const c = new worker.Controller({ ...f, workspaceMode, detection });
			try {
				const result = await c.execute(worker.name === "python" ? "import project_module\nproject_module.value" : "require('./project-module.cjs').value", undefined, undefined);
				assert.equal(result.status, "ok", result.exception?.message ?? result.diagnostic ?? "");
				assert.equal(result.repr, "42");
			} finally {
				await c.dispose("test");
				fs.rmSync(f.root, { recursive: true, force: true });
			}
		});
	}
}

test("node: unresolved raw descendant pipes make teardown fail, retain the handle, and allow a cleanup retry", { skip: process.platform !== "linux" || !fs.existsSync("/usr/bin/setsid") ? "Raw escaped-descendant fixture requires Linux /proc and setsid" : false }, async () => {
	const f = fixture();
	const marker = `guard-escaped-${path.basename(f.root)}`;
	const c = new NodeSessionController({ ...f, workspaceMode: "none" });
	function escapedPids(): number[] {
		return fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).flatMap((entry) => {
			try {
				return fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker) ? [Number(entry)] : [];
			} catch { return []; }
		});
	}
	try {
		// The shell exits and its detached grandchild is reparented before guard
		// can collect descendants. It retains the worker's output pipes. Raw
		// escaped descendants are an accepted limitation, not a sandbox escape.
		const script = `setsid /bin/bash -c 'exec -a ${marker} /bin/sleep 60' &`;
		const launched = await c.execute(`require('child_process').spawn('/bin/bash', ['-c', ${JSON.stringify(script)}], {stdio: ['ignore', 1, 2], detached: true}).unref()`, undefined, undefined);
		assert.equal(launched.status, "ok", launched.diagnostic ?? "");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(escapedPids().length, 1, "fixture descendant is alive outside the worker process group");
		await assert.rejects(c.dispose("tightening"), /teardown timed out/);
		assert.equal((await c.status()).workerRunning, true, "unclosed worker handle must not be forgotten");
		for (const pid of escapedPids()) process.kill(pid, "SIGKILL");
		await c.dispose("retry_cleanup");
		assert.equal((await c.status()).workerRunning, false);
	} finally {
		for (const pid of escapedPids()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
		await c.dispose("test");
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test("node: process.exit and top-level await are ordinary errors, not worker shutdowns", async () => {
	const f = fixture();
	const c = new NodeSessionController({ ...f, workspaceMode: "none" });
	try {
		assert.equal((await c.execute("let persistent = 42", undefined, undefined)).status, "ok");
		for (const code of ["process.exit(0)", "await Promise.resolve(42)"]) {
			const result = await c.execute(code, undefined, undefined);
			assert.equal(result.status, "runtime_error");
			assert.equal(result.stateLost, false);
			assert.equal((await c.execute("persistent", undefined, undefined)).repr, "42");
		}
	} finally {
		await c.dispose("test");
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

for (const workspaceMode of ["none", "overlay"] as const) {
	test(`python/node: ${workspaceMode} scratch is shared across workers and controller replacement`, { skip: workspaceMode === "none" ? !pythonAvailable && "Python interpreter unavailable" : sandboxSkip(pythonAvailable) }, async () => {
		const f = fixture();
		const py = new PythonSessionController({ ...f, workspaceMode, detection });
		const js = new NodeSessionController({ ...f, workspaceMode, detection });
		const filename = JSON.stringify(path.join(f.scratchDir, "cross.txt"));
		try {
			const write = await py.execute(`open(${filename}, 'w').write('python')`, undefined, undefined);
			assert.equal(write.status, "ok", write.exception?.message ?? write.diagnostic ?? "");
			assert.match((await js.execute(`require('fs').readFileSync(${filename}, 'utf8')`, undefined, undefined)).repr!, /python/);
			assert.equal((await js.execute(`require('fs').writeFileSync(${filename}, 'node')`, undefined, undefined)).status, "ok");
			await js.dispose("policy_remount");
			await py.reset();
			assert.match((await py.execute(`open(${filename}).read()`, undefined, undefined)).repr!, /node/);
			await py.dispose("policy_remount");
			const replacement = new NodeSessionController({ ...f, workspaceMode, detection });
			try {
				assert.match((await replacement.execute(`require('fs').readFileSync(${filename}, 'utf8')`, undefined, undefined)).repr!, /node/);
			} finally { await replacement.dispose("test"); }
		} finally {
			await py.dispose("test");
			await js.dispose("test");
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	});
}
