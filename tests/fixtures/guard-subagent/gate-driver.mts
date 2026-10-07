/**
 * Subprocess driver for the guard child startup gate (step 5). Loads the real
 * bootstrap extension against a minimal fake pi API and a scripted responder,
 * then fires before_agent_start. Exit 0 with "GATE_OK" means the gate passed;
 * the bootstrap's fatal path exits 1 with a stderr diagnostic.
 *
 * Usage: node tests/fixtures/guard-subagent/gate-driver.mts <scenario>
 * Scenarios: ok | absent-listener | wrong-nonce | wrong-profile |
 *            wrong-version | refuse | malformed-ack | no-env | bad-env
 */

import bootstrap from "../../../extensions/subagent/guard-bootstrap.ts";
import { CHILD_CONTRACT_ACK, CHILD_CONTRACT_REQUEST } from "../../../extensions/subagent/guard-snapshot.ts";
import { INHERIT_ENV, serializeInheritance } from "../../../extensions/guard/policy/inheritance.ts";

const scenario = process.argv[2] ?? "ok";
const PROFILE = "auto";
const NONCE = "driver-nonce-0123456789abcdef";

if (scenario === "no-env") {
	// Ordinary session: the gate must not register or fire.
} else if (scenario === "bad-env") {
	process.env[INHERIT_ENV] = "{ not json";
} else {
	process.env[INHERIT_ENV] = serializeInheritance(PROFILE, NONCE);
}

const listeners = new Map<string, Array<(data: unknown) => void>>();
const bus = {
	on(channel: string, handler: (data: unknown) => void) {
		const list = listeners.get(channel) ?? [];
		list.push(handler);
		listeners.set(channel, list);
		return () => {
			const current = listeners.get(channel) ?? [];
			listeners.set(channel, current.filter((f) => f !== handler));
		};
	},
	emit(channel: string, data: unknown) {
		for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
	},
};

// Scripted child-guard responder for the ack matrix.
bus.on(CHILD_CONTRACT_REQUEST, (raw) => {
	const request = raw as { nonce?: string };
	const ack = (payload: Record<string, unknown>) => bus.emit(CHILD_CONTRACT_ACK, payload);
	switch (scenario) {
		case "absent-listener":
			return; // never acks: the bootstrap must refuse
		case "wrong-nonce":
			return ack({ version: 1, ok: true, nonce: "different-nonce", inherited: PROFILE, profile: PROFILE });
		case "wrong-profile":
			return ack({ version: 1, ok: true, nonce: request.nonce, inherited: "default", profile: "default" });
		case "wrong-version":
			return ack({ version: 2, ok: true, nonce: request.nonce, inherited: PROFILE, profile: PROFILE });
		case "refuse":
			return ack({ version: 1, ok: false, nonce: request.nonce, reason: "guard runtime not initialized" });
		case "malformed-ack":
			return ack({ version: 1, nonce: request.nonce });
		default:
			return ack({ version: 1, ok: true, nonce: request.nonce, inherited: PROFILE, profile: PROFILE });
	}
});

const handlers = new Map<string, Array<() => unknown>>();
bootstrap({
	events: bus,
	on(event: string, handler: () => unknown) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
		return () => {};
	},
} as never);

if (scenario === "no-env") {
	// No contract: the bootstrap must have registered nothing.
	if (handlers.size !== 0) {
		console.error(`unexpected registrations without a contract: ${[...handlers.keys()].join(", ")}`);
		process.exit(1);
	}
	console.log("GATE_IDLE");
	process.exit(0);
}

for (const handler of handlers.get("before_agent_start") ?? []) handler();
console.log("GATE_OK");
process.exit(0);
