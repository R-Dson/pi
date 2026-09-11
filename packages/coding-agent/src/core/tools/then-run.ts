import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
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
 * Shared contract for recognizing fused-command blocks in tool results, so
 * downstream mechanisms (reducers, observation packing) can treat them
 * distinctly from the mutation output.
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
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`${message}\n\n${THEN_RUN_SKIPPED} command was not run because the file change failed: ${command}`);
}

/** Concatenate the text blocks of a tool result. */
function textOf(content: (TextContent | ImageContent)[]): string {
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/**
 * Run the fused follow-up command and append its output to the mutation result.
 *
 * Runs inside the caller's file-mutation-queue slot, so the command sees the
 * mutation and no other mutation interleaves. On command failure the error
 * carries the mutation output plus the command output; the file change stays.
 */
export async function appendThenRunResult(options: {
	cwd: string;
	toolCallId: string;
	thenRun: ThenRunInput;
	mutationContent: (TextContent | ImageContent)[];
	signal: AbortSignal | undefined;
	ctx: ExtensionContext | undefined;
}): Promise<(TextContent | ImageContent)[]> {
	const bash = createBashToolDefinition(options.cwd);
	let commandOutput: string;
	try {
		const result = await bash.execute(
			`${options.toolCallId}:thenRun`,
			{ command: options.thenRun.command, timeout: options.thenRun.timeout },
			options.signal,
			undefined,
			// The definition type requires a context; bash treats it as optional.
			options.ctx ?? ({ cwd: options.cwd } as ExtensionContext),
		);
		commandOutput = textOf(result.content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${textOf(options.mutationContent)}\n\n${THEN_RUN_FAILED} command exited unsuccessfully: ${options.thenRun.command}\n${message}`,
		);
	}
	return [
		...options.mutationContent,
		{ type: "text", text: `${THEN_RUN_SUCCEEDED} ${options.thenRun.command}\n${commandOutput || "(no output)"}` },
	];
}
