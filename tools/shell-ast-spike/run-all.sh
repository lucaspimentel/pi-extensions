#!/usr/bin/env bash
# The complete spike run. Long (bench alone is tens of minutes over the full
# corpus), so launch it detached and poll out/run.log:
#
#   setsid nohup bash run-all.sh < /dev/null > /dev/null 2>&1 &
#
# Override with ITERS / BOOTS env vars. Needs network only for `npm install`
# (run separately); everything here is local.
set -u
cd "$(dirname "$0")"
mkdir -p out
{
	echo "== bench $(date -Is)"
	node bench.ts --iters "${ITERS:-30}" --out out/warm.json
	echo "bench exit=$?"
	echo "== cold $(date -Is)"
	node cold.ts --boots "${BOOTS:-10}" --out out/cold.json
	echo "cold exit=$?"
	echo "== battery $(date -Is)"
	node battery.ts --out out/battery.json
	echo "battery exit=$?"
	echo "== fidelity $(date -Is)"
	node fidelity.ts --out out/fidelity.json
	echo "fidelity exit=$?"
	echo "== report $(date -Is)"
	node report.ts --dir out --out results
	echo "report exit=$?"
	echo "== ALL DONE $(date -Is)"
} > out/run.log 2>&1
