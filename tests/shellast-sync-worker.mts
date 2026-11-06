// Worker behind tests/shellast-sync.mts: owns the async shell-ast adapter and
// answers synchronous analysis requests from the test process over shared
// memory. Test-only; never imported by extension code.
import { workerData } from "node:worker_threads";
import { analyzeHostCommand } from "../extensions/guard/policy/shellast.ts";

interface Shared {
	reqSab: SharedArrayBuffer;
	resSab: SharedArrayBuffer;
}

const { reqSab, resSab } = workerData as Shared;
const reqI = new Int32Array(reqSab);
const resI = new Int32Array(resSab);
const reqBytes = new Uint8Array(reqSab, 8);
const resBytes = new Uint8Array(resSab, 8);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

let seen = 0;
for (;;) {
	Atomics.wait(reqI, 0, seen);
	const seq = Atomics.load(reqI, 0);
	const len = Atomics.load(reqI, 1);
	const command = decoder.decode(reqBytes.subarray(0, len));
	const analysis = await analyzeHostCommand(command);
	const json = encoder.encode(JSON.stringify(analysis));
	if (json.length <= resBytes.length) {
		resBytes.set(json);
		Atomics.store(resI, 1, json.length);
	} else {
		Atomics.store(resI, 1, -1);
	}
	seen = seq;
	Atomics.store(resI, 0, seq);
	Atomics.notify(resI, 0);
}
