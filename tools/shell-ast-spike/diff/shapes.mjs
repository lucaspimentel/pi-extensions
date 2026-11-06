/**
 * Synthetic fixture-candidate inputs, shared by both side runners so the diff
 * measures them identically. These are the known-hard shapes from the spike's
 * correctness battery (tools/shell-ast-spike/battery.ts): the five
 * constructions that were once false-allowed on the host tier, and the
 * malformed set. They are appended to the harvested corpus and marked `ext`
 * so the comparator keeps them out of corpus totals.
 */

/** The five 2026-10-21 false-allow constructions. */
export const FALSE_ALLOWS = [
	"echo `touch probe`",
	"echo <(touch probe)",
	"printf x & touch probe",
	"command touch probe",
	"for x in $(touch probe); do echo ok; done",
];

/** The malformed-input set from the battery. */
export const MALFORMED = [
	"echo 'unterminated",
	"echo $(unclosed",
	"( echo",
	"cat <<EOF",
	"echo a &&",
	"echo `x",
];

/**
 * Shape label per synthetic input. The comparator reports one representative
 * per label; `command touch probe` doubles as a manual-wrapper shape.
 */
export const SHAPE_LABELS = new Map([
	["echo `touch probe`", "false-allow.backtick-substitution"],
	["echo <(touch probe)", "false-allow.process-substitution"],
	["printf x & touch probe", "false-allow.background"],
	["command touch probe", "false-allow.manual-wrapper"],
	["for x in $(touch probe); do echo ok; done", "false-allow.structural-head"],
	["echo 'unterminated", "malformed.unterminated-quote"],
	["echo $(unclosed", "malformed.unclosed-substitution"],
	["( echo", "malformed.unclosed-subshell"],
	["cat <<EOF", "malformed.heredoc-without-body"],
	["echo a &&", "malformed.trailing-operator"],
	["echo `x", "malformed.unclosed-backtick"],
]);

/** Every synthetic input, in stable order. */
export const SYNTHETIC = [...FALSE_ALLOWS, ...MALFORMED];
