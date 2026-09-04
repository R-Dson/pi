/**
 * Custom Compaction Extension (cache-disciplined)
 *
 * Replaces the default compaction summary while keeping the provider prompt
 * cache intact: the summarizer request replays the same prefix the model just
 * saw (session model, system prompt, active tools, replayed history) and
 * appends the instruction as one final user turn, instead of paying a full
 * cache miss on a standalone serialized blob at the exact moment the context
 * is largest. The inline comments mark each replay piece.
 *
 * Byte-exactness caveats: `ctx.getSystemPrompt()` excludes per-turn chained
 * rewrites and `before_provider_request` payload rewrites, and `ToolInfo` does
 * not carry constrained-sampling config, so an extension replay can drift from
 * the wire request. The default compaction replays the prefix exactly; copy
 * this shape only when you need custom summary semantics.
 *
 * Usage:
 *   pi --extension examples/extensions/custom-compaction.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const { replayMessages, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("No active model, using default compaction", "warning");
			return;
		}

		ctx.ui.notify(
			`Custom compaction: summarizing ${replayMessages.length + turnPrefixMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${model.id}...`,
			"info",
		);

		// Replayed history in conversation order: the checkpoint-headed prefix
		// the model saw, then the split-turn prefix messages when the cut
		// falls mid-turn. Same conversion the regular request uses.
		const history = convertToLlm([...replayMessages, ...turnPrefixMessages]);

		// Active tools in the active list's order — tool order sits at the
		// front of the request prefix, so a reordered list busts the cache.
		const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		const tools = pi
			.getActiveTools()
			.map((name) => toolsByName.get(name))
			.filter((tool) => tool !== undefined)
			.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));

		// When updating, the replayed prefix already leads with the previous
		// checkpoint message (the old summary), so the instruction switches to
		// an update prompt instead of inlining the old summary again.
		const task = previousSummary
			? "Update the session summary above in light of the conversation that follows it."
			: "Summarize the conversation above so work can continue with the older turns discarded.";

		const instruction = `You are a conversation summarizer for this one turn. ${task} Capture:

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the summarized turns, so include all information needed to continue the work effectively. Format it as structured markdown with clear sections.`;

		const messages = [...history, { role: "user" as const, content: instruction, timestamp: Date.now() }];

		try {
			// Pass signal to honor abort requests (e.g., user cancels compaction).
			// No cacheRetention opt-out and no minted sessionId: the routing id
			// keeps the replay in the session's cache bucket where one exists.
			const response = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: ctx.getSystemPrompt(), tools, messages },
				{
					maxTokens: 8192,
					signal,
					sessionId: ctx.sessionManager.getSessionId(),
				},
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted) ctx.ui.notify("Compaction summary was empty, using default compaction", "warning");
				return;
			}

			// Return compaction content - SessionManager adds id/parentId
			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					usage: response.usage,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Compaction failed: ${message}`, "error");
			// Fall back to default compaction on error
			return;
		}
	});
}
