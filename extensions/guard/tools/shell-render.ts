/** Call-header rendering for guard's shell tools. Presentation only; execution lives in shell.ts. */
import { createBashToolDefinition, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";

/** Shape of the shell tools' arguments relevant to call rendering. */
interface ShellArgs {
	command?: string;
	timeout?: number;
}

/**
 * Structural copy of the SDK's tool renderer context (ToolRenderContext is not exported from the
 * package index). Required so the context can be forwarded to the native renderer unchanged.
 */
interface ShellRenderContext {
	args: ShellArgs;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: Record<string, unknown>;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
}

/**
 * Per-tool-call renderer state. The SDK scopes state to one tool row, so rows stay isolated. The
 * startedAt/endedAt/interval fields belong to the native renderer, which writes them into the
 * same shared state object; they are declared here so the forwarded context typechecks.
 */
interface ShellCallState {
	container?: Container;
	title?: Text;
	command?: Component;
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
}

// Native bash's own call renderer, obtained through the public definition factory so command
// formatting ($ prompt, timeout suffix, wrapping, missing and invalid argument handling) is
// delegated rather than copied. The definition is never executed; only renderCall is used.
const nativeBashRenderCall = createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }).renderCall!;

/**
 * Build a renderCall for one guard shell tool. The header shows the tool name on its own line,
 * then the command exactly as native bash presents it. The outer container is never forwarded to
 * the native renderer as lastComponent: the native text child is retained separately so repeated
 * renders reuse it without mixing guard's title into the native render slot.
 */
export function createShellRenderCall(toolName: string) {
	return (args: ShellArgs, theme: Theme, context: ShellRenderContext): Component => {
		const state = context.state as unknown as ShellCallState;
		const container = state.container ?? new Container();
		const title = state.title ?? new Text("", 0, 0);
		title.setText(theme.fg("toolTitle", theme.bold(toolName)));
		// The native signature declares command as required; at render time the arguments can still
		// be incomplete while streaming, and the native formatter handles the missing cases itself.
		const command = nativeBashRenderCall(args as { command: string; timeout?: number }, theme, {
			...context,
			args: args as { command: string; timeout?: number },
			lastComponent: state.command,
			state,
		});
		state.container = container;
		state.title = title;
		state.command = command;
		container.clear();
		container.addChild(title);
		container.addChild(command);
		return container;
	};
}
