/**
 * Branch summarization for tree navigation.
 *
 * When navigating to a different point in the session tree, this generates
 * a summary of the branch being left so context isn't lost.
 */

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type { Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../messages.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { sessionEntryToContextMessages } from "../sessions/projector.ts";
import { INTERRUPTED_TOOL_RESULT_TEXT } from "../sessions/recovery.ts";
import {
	completeSummarization,
	estimateTokens,
	getSummarizationFailure,
	type SummarizationPrefix,
} from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZER_PERSONA,
} from "./utils.ts";

// ============================================================================
// Types
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	usage?: Usage;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** Details stored in BranchSummaryEntry.details for file tracking */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.ts";

export interface BranchPreparation {
	/** Messages extracted for summarization, in chronological order */
	messages: AgentMessage[];
	/** File operations extracted from tool calls */
	fileOps: FileOperations;
	/** Total estimated tokens in messages */
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** Entries to summarize, in chronological order */
	entries: SessionEntry[];
	/** Common ancestor between old and new position, if any */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** Model to use for summarization */
	model: Model<any>;
	/** API key for the model */
	apiKey?: string;
	/** Request headers for the model */
	headers?: Record<string, string>;
	/** Provider-scoped environment values for the model */
	env?: Record<string, string>;
	/** Abort signal for cancellation */
	signal: AbortSignal;
	/** Optional custom instructions for summarization */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	replaceInstructions?: boolean;
	/** Tokens reserved for prompt + LLM response (default 16384) */
	reserveTokens?: number;
	/** Optional session stream function. Used to preserve SDK request behavior without mutating agent state. */
	streamFn?: StreamFn;
	/** Retry policy for transient summarization errors. Reuses coding-agent's `settings.retry`. */
	retry?: RetryPolicy;
	/** Optional callbacks for retry reporting (e.g. TUI retry indicators). */
	callbacks?: RetryCallbacks;
	/**
	 * Routing session id carried on the replaying request (cache plan phase A):
	 * the same value the session's regular requests use, so providers with
	 * session-scoped cache routing (OpenAI's `prompt_cache_key` and friends)
	 * keep the replay on the regular requests' cache. Never minted here.
	 */
	sessionId?: string;
	/**
	 * Agent request prefix (system prompt + tool list) replayed as the summarizer
	 * request prefix (cache plan phase A). Must be the same content the last
	 * regular request used.
	 */
	prefix: SummarizationPrefix;
}

// ============================================================================
// Entry Collection
// ============================================================================

/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// If no old position, nothing to summarize
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// Find common ancestor (deepest node that's on both paths)
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath is root-first, so iterate backwards to find deepest common ancestor
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// Collect entries from old leaf back to common ancestor
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// Reverse to get chronological order
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// Entry to Message Conversion
// ============================================================================

/**
 * Extract the conversation message for a session entry by delegating to the
 * projector's conversion, so the replay mirrors the regular context projection
 * exactly — including its hardening (null-content messages, empty summaries)
 * and its entry-type filtering. Tool results are included: the replay sends
 * structured messages, and a strict provider (Anthropic) rejects a tool_use
 * whose tool_result never arrives.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	const [message] = sessionEntryToContextMessages(entry);
	return message;
}

/** A replay unit: messages that must enter (or leave) the budget window together. */
interface BranchUnit {
	messages: AgentMessage[];
	/** Compaction/branch-summary entries keep the fit-anyway budget exception. */
	important: boolean;
}

/**
 * Group branch messages into replay units: an assistant message carrying tool
 * calls and its trailing tool results replay together or not at all, because a
 * strict provider (Anthropic) rejects a tool_use whose tool_result is missing —
 * splitting a pair at the budget edge would rebuild exactly that. A dangling
 * call at a branch tail (session died mid-turn) gets one synthesized terminal
 * result per unanswered id, mirroring core/sessions/recovery.ts; an orphan
 * result whose call fell outside the window is dropped rather than replayed
 * unpaired.
 */
function groupBranchUnits(entries: SessionEntry[]): BranchUnit[] {
	const units: BranchUnit[] = [];
	for (const entry of entries) {
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		if (message.role === "toolResult") {
			const last = units[units.length - 1];
			const head = last?.messages[0];
			if (
				head?.role === "assistant" &&
				head.content.some((block) => block.type === "toolCall" && block.id === message.toolCallId)
			) {
				last.messages.push(message);
				continue;
			}
			// The calling message is not the last unit's head (call outside the
			// window, or no such call). Replaying the result alone would be
			// just as invalid as replaying the call alone.
			continue;
		}

		units.push({
			messages: [message],
			important: entry.type === "compaction" || entry.type === "branch_summary",
		});
	}

	for (const unit of units) {
		const head = unit.messages[0];
		if (head?.role !== "assistant") continue;
		const answered = new Set(
			unit.messages
				.filter(
					(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
				)
				.map((message) => message.toolCallId),
		);
		for (const block of head.content) {
			if (block.type !== "toolCall" || answered.has(block.id)) continue;
			unit.messages.push({
				role: "toolResult",
				toolCallId: block.id,
				toolName: block.name,
				content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
				isError: true,
				timestamp: head.timestamp,
			});
		}
	}
	return units;
}

/**
 * Prepare entries for summarization with token budget.
 *
 * Walks units from NEWEST to OLDEST, adding messages until we hit the token budget.
 * This ensures we keep the most recent context when the branch is too long.
 *
 * Also collects file operations from:
 * - Tool calls in assistant messages
 * - Existing branch_summary entries' details (for cumulative tracking)
 *
 * @param entries - Entries in chronological order
 * @param tokenBudget - Maximum tokens to include (0 = no limit)
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// First pass: collect file ops from ALL entries (even if they don't fit in token budget)
	// This ensures we capture cumulative file tracking from nested branch summaries
	// Only extract from pi-generated summaries (fromHook !== true), not extension-generated ones
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// Modified files go into both edited and written for proper deduplication
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// Second pass: walk units from newest to oldest, adding whole units until
	// the token budget — never a partial call/result pair.
	const units = groupBranchUnits(entries);
	for (let i = units.length - 1; i >= 0; i--) {
		const unit = units[i];
		const tokens = unit.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		// Check budget before adding
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// If this is a summary entry, try to fit it anyway as it's important context
			if (unit.important && totalTokens < tokenBudget * 0.9) {
				for (const message of unit.messages) extractFileOpsFromMessage(message, fileOps);
				messages.unshift(...unit.messages);
				totalTokens += tokens;
			}
			// Stop - we've hit the budget
			break;
		}

		for (const message of unit.messages) extractFileOpsFromMessage(message, fileOps);
		messages.unshift(...unit.messages);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// ============================================================================
// Summary Generation
// ============================================================================

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Generate a summary of abandoned branch entries.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const {
		model,
		apiKey,
		headers,
		env,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = 16384,
		streamFn,
		retry,
		callbacks,
		sessionId,
		prefix,
	} = options;

	// Token budget = context window minus reserved space for prompt + response
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// Build the appended instruction: the summarizer persona plus the branch
	// summary instructions (or the replacing custom instructions).
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `${SUMMARIZER_PERSONA}\n\n${instructions}`;

	// Prefix-replaying request (cache plan phase A): the agent's real system
	// prompt and tools, the converted branch messages, and one appended user
	// instruction turn. Call LLM through completeSummarization; prefer the
	// session stream function so SDK request behavior (timeouts, retries,
	// attribution headers) stays consistent without running through agent
	// state/events. Retried via completeSummarization so transient stream drops
	// reuse the configured retry policy.
	const context: Context = {
		systemPrompt: prefix.systemPrompt,
		tools: prefix.tools,
		messages: [
			...convertToLlm(messages),
			{
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
		],
	};
	const requestOptions: SimpleStreamOptions = { apiKey, headers, env, signal, maxTokens: 2048, sessionId };
	const response = await completeSummarization(model, context, requestOptions, streamFn, retry, callbacks, false);

	// Check if aborted or errored
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	const failure = getSummarizationFailure(response, "Branch summarization");
	if (failure) {
		return { error: failure };
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		return { error: "Branch summarization attempted to call a tool" };
	}

	let summary = contentText(response.content);

	// Prepend preamble to provide context about the branch summary
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		usage: response.usage,
		readFiles,
		modifiedFiles,
	};
}
