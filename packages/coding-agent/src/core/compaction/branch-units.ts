/**
 * Branch replay units (fork-owned, cache plan phase A).
 *
 * Groups branch entries into units that must enter or leave a summarizer
 * budget window together, so a replayed branch never sends a tool_use whose
 * tool_result is missing (a strict provider such as Anthropic rejects that).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "../session-manager.ts";
import { sessionEntryToContextMessages } from "../sessions/projector.ts";
import { INTERRUPTED_TOOL_RESULT_TEXT } from "../sessions/recovery.ts";

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
 *
 * Entry-to-message conversion delegates to the projector's conversion, so the
 * replay mirrors the regular context projection exactly (null-content
 * hardening, empty-summary skipping) instead of re-implementing the switch.
 * Tool results are included: the replay sends structured messages, and a
 * strict provider rejects a tool_use whose tool_result never arrives.
 */
export function groupBranchUnits(entries: SessionEntry[]): BranchUnit[] {
	const units: BranchUnit[] = [];
	for (const entry of entries) {
		const [message] = sessionEntryToContextMessages(entry);
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
