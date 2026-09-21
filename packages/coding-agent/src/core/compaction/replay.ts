/**
 * Prefix-replaying summarizer request construction (fork-owned, cache plan
 * phase A).
 *
 * Everything the replaying summarizer calls send lives here, so the bytes the
 * provider prompt cache matches have one home: the summarizer persona and
 * checkpoint format instructions, the replay-context builders shared by
 * compaction and branch summarization, and the replay message list headed by
 * the previous checkpoint. compaction.ts and branch-summarization.ts delegate
 * here; test/compaction-replay-golden.test.ts pins the resulting requests by
 * digest, so any change to what a replay sends lands in this file visibly.
 */

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	getInitialSystemMessage,
	type Message,
	normalizeContext,
	type SystemMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "../messages.ts";
import type { CompactionEntry, SessionEntry } from "../session-manager.ts";
import { sessionEntryToContextMessages } from "../sessions/projector.ts";
import { SUMMARIZATION_SYSTEM_PROMPT, SUMMARIZER_PERSONA } from "./utils.ts";

/**
 * The request prefix a replaying summarizer call must reproduce byte for byte
 * (cache plan phase A): the system prompt (with ALL tool definitions) and
 * tool list the model saw on its last regular request, so the provider's
 * prompt cache covers the replayed conversation history. Precondition: a
 * `transformContext` extension that rewrites history breaks this equivalence,
 * and the cache win with it; the prefix-stability monitor (cache plan phase B)
 * surfaces such rewrites.
 */
export interface SummarizationPrefix {
	systemPrompt: string;
	tools: AgentTool[];
	/**
	 * The transcript's current system message, when one is active. Replayed as-is
	 * so the summarizer request's leading bytes match the regular request's
	 * exactly; `systemPrompt`/`tools` remain the derived fallback.
	 */
	systemMessage?: SystemMessage;
}

const SUMMARIZATION_PROMPT = `Summarize the conversation above. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The conversation above contains NEW messages to incorporate into the existing checkpoint summary (the first message of the conversation).

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

/**
 * Build the appended user instruction turn for prefix-replaying summarization.
 * Combines the summarizer persona, the checkpoint format instructions (format
 * body byte-identical to the standalone prompts), the previous summary, and
 * optional custom focus.
 */
export function buildSummaryInstruction(previousSummary?: string, customInstructions?: string): string {
	let text = `${SUMMARIZER_PERSONA}\n\n${previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT}`;
	if (customInstructions) {
		text += `\n\nAdditional focus: ${customInstructions}`;
	}
	return text;
}

/** Build the provider context for a standalone (non-replaying) summary request. */
export function buildStandaloneSummarizationContext(promptText: string): TranscriptContext {
	return normalizeContext({
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
		],
	});
}

/**
 * Build the provider context for a prefix-replaying summary request: the agent's
 * real system prompt and tool list, the converted conversation exactly as a
 * regular request sends it, and one appended user instruction turn. Shared by
 * compaction and branch summarization so both replay identical shapes.
 */
export function buildReplaySummarizationContext(
	currentMessages: AgentMessage[],
	instruction: string,
	prefix: SummarizationPrefix,
): TranscriptContext {
	const replayMessages: Message[] = [
		...convertToLlm(currentMessages),
		{
			role: "user",
			content: [{ type: "text", text: instruction }],
			timestamp: Date.now(),
		},
	];
	if (prefix.systemMessage) {
		// A checkpoint-headed transcript already restored its system message after
		// the cut; the prefix supplies it, so drop a leading duplicate from the
		// replayed history to keep the prefix byte-identical to a regular request.
		const history = getInitialSystemMessage(replayMessages) ? replayMessages.slice(1) : replayMessages;
		return { messages: [prefix.systemMessage, ...history] } as TranscriptContext;
	}
	// No active system message in the transcript: fold the derived prefix into a
	// leading system message, the same shape a regular request sends.
	return normalizeContext({
		systemPrompt: prefix.systemPrompt,
		tools: prefix.tools,
		messages: replayMessages,
	});
}

/**
 * The exact message list the model saw since the previous checkpoint, headed by
 * the checkpoint's own projection (system message plus compaction summary when
 * present): every regular request's context began this way, so the summarizer
 * request's prefix equals the prior request's from message 0.
 */
export function buildReplayMessages(
	pathEntries: SessionEntry[],
	prevCompactionIndex: number,
	messagesToSummarize: AgentMessage[],
): AgentMessage[] {
	const replayMessages: AgentMessage[] = [];
	if (prevCompactionIndex >= 0) {
		replayMessages.push(...sessionEntryToContextMessages(pathEntries[prevCompactionIndex] as CompactionEntry));
	}
	replayMessages.push(...messagesToSummarize);
	return replayMessages;
}
