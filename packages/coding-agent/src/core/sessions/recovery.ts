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
 * toolResult message per dangling call. Appending only: history is never
 * rewritten, and no new entry types are introduced (plan 2.1) — the synthesized
 * results are ordinary message entries.
 */

import type { SessionManager } from "../session-manager.ts";
import { unansweredFinalToolCalls } from "./projector.ts";

const INTERRUPTED_TOOL_RESULT_TEXT = "Tool execution was interrupted before completing; no result was recorded.";

/**
 * Append one terminal error toolResult message per dangling tool call of the
 * interrupted final turn — the unanswered-final-tool-calls condition
 * validateEntries detects as an incomplete final turn.
 *
 * Detection runs on the compaction-aware context entries, so calls summarized
 * away by an earlier compaction are not resurrected, and any unanswered call on
 * the context is repaired — a strict provider rejects it wherever it sits, not
 * only at the end. Returns the ids of the appended entries (empty when there
 * was nothing to do); running it on an already-repaired session is a no-op.
 */
export function appendInterruptedTurnResults(sessionManager: SessionManager): string[] {
	const unanswered = unansweredFinalToolCalls(sessionManager.buildContextEntries());

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
