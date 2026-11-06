import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fixtureContext, observeFixture, type Fixture } from "./guard-shell-fixture-policy.mts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-shell-fixtures-")));
for (const path of Object.values(fixtureContext(root).replacements).filter(p => p.startsWith(root))) mkdirSync(path, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));
const parts = ["hard", "widening", "incompleteness"] as const;
const fixtures = Object.fromEntries(parts.map(part => [part, JSON.parse(readFileSync(new URL(`./fixtures/guard-shell/${part}.json`, import.meta.url), "utf8")) as Fixture[]]));

test("curated coverage and bounded cause samples", () => {
	assert.equal(fixtures.hard.filter(r => r.id.startsWith("parse-reject-")).length, 11);
	assert.equal(fixtures.hard.filter(r => r.id.startsWith("ambiguous-compound-")).length, 6);
	assert.equal(fixtures.widening.length, 43);
	const counts = new Map<string, number>();
	const ids = new Set<string>();
	for (const part of parts) {
		for (const row of fixtures[part]) {
			assert.ok(!ids.has(row.id), `duplicate fixture ${row.id}`);
			ids.add(row.id);
			assert.doesNotMatch(row.command, /\/home\/|~\/|1password\.com|wxk444j57/);
			assert.equal(typeof row.expected.cause, "string");
			if (part === "incompleteness") {
				assert.ok(row.sampleCause);
				assert.equal(row.expected.cause, row.sampleCause, row.id);
				counts.set(row.sampleCause!, (counts.get(row.sampleCause!) ?? 0) + 1);
			}
		}
	}
	for (const [cause, count] of counts) assert.ok(count <= 20, `${cause}: ${count}`);
});

for (const part of parts) {
	for (const row of fixtures[part]) {
		test(`${part}: ${row.id}`, async () => {
			// Nothing is executed. Both policy roots and command placeholders use
			// this fresh temp directory; no user config or classifier is loaded.
			assert.deepEqual(await observeFixture(row, root), row.expected);
		});
	}
}
