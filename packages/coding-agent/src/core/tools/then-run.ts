import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ExtensionRunner } from "../extensions/runner.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import { createBashToolDefinition } from "./bash.ts";

export const thenRunSchema = Type.Object({
	command: Type.String({
		description:
			"Bash command run after the file change succeeds, typically a test or build of the changed file. Skipped when the change fails; the change is kept when the command fails.",
	}),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type ThenRunInput = Static<typeof thenRunSchema>;

/**
 * Markers for recognizing fused-command blocks in tool results: the skip and
 * failure paths are part of the model-visible result contract, and tests pin
 * them by these constants.
 */
export const THEN_RUN_SUCCEEDED = "[thenRun:succeeded]";
export const THEN_RUN_FAILED = "[thenRun:failed]";
export const THEN_RUN_SKIPPED = "[thenRun:skipped]";

/** Wrap a failed mutation so the model sees the follow-up command never ran. */
export function thenRunSkippedError(error: unknown, command: string): Error {
	// An abort is not a mutation failure; surface it untouched.
	if (error instanceof Error && error.message === "Operation aborted") {
		return error;
	}
	return new Error(
		`${errorMessage(error)}\n\n${THEN_RUN_SKIPPED} command was not run because the file change failed: ${command}`,
	);
}

/** Concatenate the text blocks of a tool result. */
function textOf(content: (TextContent | ImageContent)[]): string {
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What happened to a fused command; `command` is what actually ran (after gate argument mutation). */
export type FusedCommandOutcome =
	| { status: "ran"; command: string; output: string }
	| { status: "failed"; command: string; output: string }
	| { status: "blocked"; reason: string };

/**
 * Runs a fused thenRun command with the session's semantics. Supplied by the
 * session (see {@link createSessionFusedCommandExecutor}); plain tool factories
 * without a session fall back to a fresh local bash definition with no gate.
 */
export type FusedCommandExecutor = (
	toolCallId: string,
	input: { command: string; timeout?: number },
	signal: AbortSignal | undefined,
	ctx: ExtensionContext | undefined,
) => Promise<FusedCommandOutcome>;

/**
 * The bash definition shape the fused command executes through — the return
 * type of the executor's `getBashDefinition` dep. Exported because the tool
 * registry erases the concrete type, so the session wiring and embedders using
 * the exported executor need the name.
 */
export type BashToolDefinition = ReturnType<typeof createBashToolDefinition>;

/**
 * Build the session's fused-command executor.
 *
 * The fused command fires a real `tool_call` event for its bash facet
 * (`toolName: "bash"`, `toolCallId: "<parent>:thenRun"`), so every gating
 * extension judges it like any bash call, including `ask` dialogs and argument
 * mutation. Execution goes through the session's own bash definition when one
 * is registered (inheriting its options: commandPrefix, shellPath, operations),
 * falling back to a fresh local definition. The `tool_result` observation event
 * fires afterwards; core output bounding is deliberately NOT applied here
 * because the outer edit/write call's existing bound covers the combined
 * content, and a second bound would double-spill artifacts.
 *
 * A throwing gate handler must not reject out of this executor: the file
 * mutation has already succeeded at that point, and a raw rejection would drop
 * its output from the result. Gate errors map to a `failed` outcome with an
 * extension-error message; the tool_result observation never throws (the
 * runner catches per handler and reports through its error channel).
 */
export function createSessionFusedCommandExecutor(deps: {
	getCwd(): string;
	/** Extension runner the gate fires through; omitted (or undefined) runs ungated. */
	getRunner?(): Pick<ExtensionRunner, "hasHandlers" | "emitToolCall" | "emitToolResult"> | undefined;
	/** Session bash definition to execute through; omitted runs a fresh local one. */
	getBashDefinition?(): BashToolDefinition | undefined;
}): FusedCommandExecutor {
	return async (toolCallId, input, signal, ctx) => {
		const runner = deps.getRunner?.();
		const callId = `${toolCallId}:thenRun`;
		// A copy, so handler mutations of event.input land on our object and the
		// executed command reflects them.
		const effective = { ...input };
		const cwd = deps.getCwd();
		const bash = deps.getBashDefinition?.() ?? createBashToolDefinition(cwd);

		if (runner?.hasHandlers("tool_call")) {
			let decision: Awaited<ReturnType<typeof runner.emitToolCall>>;
			try {
				decision = await runner.emitToolCall({
					type: "tool_call",
					toolName: "bash",
					toolCallId: callId,
					input: effective,
				});
			} catch (error) {
				return {
					status: "failed",
					command: effective.command,
					output: `fused-command gate extension error: ${errorMessage(error)}`,
				};
			}
			if (decision?.block) {
				return { status: "blocked", reason: decision.reason ?? "blocked by an extension" };
			}
		}

		// Emit the tool_result observation for the fused call (no wrap needed:
		// emitToolResult catches per handler and reports through its error channel).
		const observe = (content: (TextContent | ImageContent)[], isError: boolean) =>
			runner?.hasHandlers("tool_result")
				? runner.emitToolResult({
						type: "tool_result",
						toolName: "bash",
						toolCallId: callId,
						input: { command: effective.command },
						content,
						details: undefined,
						isError,
						usage: undefined,
					})
				: undefined;

		let content: (TextContent | ImageContent)[];
		try {
			const result = await bash.execute(callId, effective, signal, undefined, ctx ?? ({ cwd } as ExtensionContext));
			content = result.content;
		} catch (error) {
			const output = errorMessage(error);
			await observe([{ type: "text", text: output }], true);
			return { status: "failed", command: effective.command, output };
		}

		const observed = await observe(content, false);
		return { status: "ran", command: effective.command, output: textOf(observed?.content ?? content) };
	};
}

/**
 * Run the fused follow-up command and append its output to the mutation result.
 *
 * Runs inside the caller's file-mutation-queue slot, so the command sees the
 * mutation and no other mutation interleaves. On command failure the error
 * carries the mutation output plus the command output; the file change stays.
 * A blocked command (permission denial) appends a skip marker with the reason;
 * the mutation result stays non-error.
 */
export async function appendThenRunResult(options: {
	cwd: string;
	toolCallId: string;
	thenRun: ThenRunInput;
	mutationContent: (TextContent | ImageContent)[];
	signal: AbortSignal | undefined;
	ctx: ExtensionContext | undefined;
	/** Session executor; omitted by plain factories (fresh local bash, no gate). */
	fusedCommand?: FusedCommandExecutor;
}): Promise<(TextContent | ImageContent)[]> {
	// Without a session executor, the same executor with no runner and no bash
	// definition is exactly the ungated fresh-bash fallback.
	const executor: FusedCommandExecutor =
		options.fusedCommand ?? createSessionFusedCommandExecutor({ getCwd: () => options.cwd });
	const outcome = await executor(options.toolCallId, options.thenRun, options.signal, options.ctx);

	if (outcome.status === "blocked") {
		return [
			...options.mutationContent,
			{ type: "text", text: `${THEN_RUN_SKIPPED} command was not run: ${outcome.reason}` },
		];
	}
	if (outcome.status === "failed") {
		throw new Error(
			`${textOf(options.mutationContent)}\n\n${THEN_RUN_FAILED} command exited unsuccessfully: ${outcome.command}\n${outcome.output}`,
		);
	}
	return [
		...options.mutationContent,
		{ type: "text", text: `${THEN_RUN_SUCCEEDED} ${outcome.command}\n${outcome.output || "(no output)"}` },
	];
}
