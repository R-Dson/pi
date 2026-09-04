/**
 * Interrupted-turn recovery marking.
 *
 * A crash mid-tool-execution leaves the session's final assistant tool-call
 * turn with unanswered calls — no results at all, or only some siblings' results
 * when tools ran in parallel. On resume, a dangling tool_use message would go
 * straight into the next provider request, and strict providers (Anthropic)
 * reject tool_use blocks without tool_result blocks.
 *
 * appendInterruptedTurnResults repairs the turn by appending one terminal error
 * toolResult message per dangling call — only where appending keeps each result
 * adjacent to its tool_use, i.e. when no later message entry follows the
 * dangling turn. Appending only: history is never rewritten, and no new entry
 * types are introduced (plan 2.1) — the synthesized results are ordinary
 * message entries.
 */

import type { SessionManager } from "../session-manager.ts";
import type { SessionEntry } from "./projector.ts";
import { unansweredFinalToolCalls } from "./projector.ts";

export const INTERRUPTED_TOOL_RESULT_TEXT = "Tool execution was interrupted before completing; no result was recorded.";

/**
 * Whether any entry after index entries[afterIndex] projects into a context
 * message other than an already-persisted toolResult (partial-flush sibling).
 * Such an entry would sit between the dangling tool_use and a tail-appended
 * toolResult, and Anthropic rejects non-adjacent tool_use/tool_result pairs.
 */
function breaksAdjacency(entries: SessionEntry[], afterIndex: number): boolean {
	for (const entry of entries.slice(afterIndex + 1)) {
		if (entry.type === "message") {
			if (entry.message.role !== "toolResult") return true;
			continue;
		}
		if (entry.type === "custom_message" || entry.type === "compaction") return true;
		if (entry.type === "branch_summary" && entry.summary) return true;
	}
	return false;
}

/**
 * Append one terminal error toolResult message per dangling tool call of the
 * interrupted final turn — the unanswered-final-tool-calls condition
 * validateEntries detects as an incomplete final turn.
 *
 * Detection runs on the compaction-aware context entries, so calls summarized
 * away by an earlier compaction are not resurrected. Repair happens only when
 * the dangling turn is the context's last message-bearing region: nothing
 * after it may project into a context message except the sibling toolResults
 * already persisted (partial flush). When later message entries follow the
 * dangling turn (e.g. a steering user message persisted mid-tool-run), a
 * tail-appended toolResult would be non-adjacent to its tool_use and Anthropic
 * rejects the request anyway — only the local validator would be satisfied —
 * so nothing is appended and the session resumes unrepaired. Returns the ids
 * of the appended entries (empty when there was nothing to do); running it on
 * an already-repaired session is a no-op.
 */
export function appendInterruptedTurnResults(sessionManager: SessionManager): string[] {
	const contextEntries = sessionManager.buildContextEntries();
	const unanswered = unansweredFinalToolCalls(contextEntries);
	if (unanswered.length === 0) return [];

	const danglingIndex = contextEntries.findIndex((entry) => entry.id === unanswered[0].entryId);
	if (danglingIndex < 0 || breaksAdjacency(contextEntries, danglingIndex)) return [];

	const appendedIds: string[] = [];
	for (const call of unanswered) {
		appendedIds.push(
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: call.callId,
				toolName: call.toolName,
				content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
				isError: true,
				timestamp: Date.now(),
			}),
		);
	}
	return appendedIds;
}
