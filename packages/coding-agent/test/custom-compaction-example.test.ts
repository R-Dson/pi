/**
 * Verify the custom-compaction example issues a cache-disciplined summarizer
 * request: it replays the agent's request prefix (session model, system
 * prompt, active tool list in active order, replayMessages) plus exactly one
 * appended instruction turn, and carries the session routing id instead of a
 * throwaway one. Pins the example to the replay shape so it cannot regress to
 * the standalone serialized-blob pattern the fork's core compaction replaced
 * (issue #146).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import customCompaction from "../examples/extensions/custom-compaction.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	ToolInfo,
} from "../src/core/extensions/index.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { convertToLlm } from "../src/index.ts";

type Handler = (event: never, ctx?: never) => unknown;

interface CompleteContext {
	systemPrompt: string;
	tools: unknown[];
	messages: { role: string; content: unknown }[];
}

interface CompleteOptions {
	sessionId?: string;
	cacheRetention?: string;
	signal: AbortSignal;
	maxTokens?: number;
}

function makeTool(name: string): ToolInfo {
	return {
		name,
		description: `The ${name} tool`,
		parameters: {},
		promptGuidelines: undefined,
		sourceInfo: createSyntheticSourceInfo(`example:${name}`, { source: "example" }),
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1_000 };
}

function install() {
	const handlers = new Map<string, Handler>();
	const tools = [makeTool("read"), makeTool("bash"), makeTool("edit")];
	const activeTools = ["bash", "read"];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getAllTools: () => tools,
		getActiveTools: () => activeTools,
	} as unknown as ExtensionAPI;
	customCompaction(pi);
	return { handlers, tools, activeTools };
}

function makeEvent(replayMessages: AgentMessage[], previousSummary?: string) {
	const event: SessionBeforeCompactEvent = {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: replayMessages,
			replayMessages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1234,
			previousSummary,
			fileOps: { writes: [], reads: [] } as never,
			settings: {} as never,
		},
		branchEntries: [],
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	};
	return event;
}

function mockComplete(result: { text: string } | { error: Error }) {
	return vi.fn(async (_model: unknown, _context: CompleteContext, _options: CompleteOptions) => {
		if ("error" in result) throw result.error;
		return {
			content: [{ type: "text" as const, text: result.text }],
			usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
		};
	});
}

const MODEL = { provider: "faux", id: "faux-model" } as ExtensionContext["model"];

function makeCtx(complete: ReturnType<typeof mockComplete>): ExtensionContext {
	return {
		ui: { notify: vi.fn() },
		model: MODEL,
		modelRegistry: { complete: complete as unknown as ExtensionContext["modelRegistry"]["complete"] },
		sessionManager: { getSessionId: () => "session-1" },
		getSystemPrompt: () => "SYSTEM PROMPT",
	} as unknown as ExtensionContext;
}

async function callHandler(
	handlers: Map<string, Handler>,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<unknown> {
	const handler = handlers.get("session_before_compact")!;
	return (handler as unknown as (e: SessionBeforeCompactEvent, c: ExtensionContext) => Promise<unknown>)(event, ctx);
}

describe("custom-compaction example", () => {
	it("replays the agent's request prefix plus one appended instruction turn", async () => {
		const { handlers, tools, activeTools } = install();
		const event = makeEvent([userMessage("first"), userMessage("second")]);

		const complete = mockComplete({ text: "SUMMARY" });
		const ctx = makeCtx(complete);

		const result = (await callHandler(handlers, event, ctx)) as {
			compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage: unknown };
		};

		expect(complete).toHaveBeenCalledTimes(1);
		const [model, context, options] = complete.mock.calls[0];

		// Same model as the conversation: provider prompt caches are per model,
		// so a cheaper summarizer model would forfeit the cache the replay exists to reuse.
		expect(model).toBe(MODEL);

		// Same system prompt the agent uses.
		expect(context.systemPrompt).toBe("SYSTEM PROMPT");

		// Active tools in active-list order, serialized shape only.
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		expect(context.tools).toEqual(
			activeTools.map((name) => {
				const tool = byName.get(name)!;
				return { name: tool.name, description: tool.description, parameters: tool.parameters };
			}),
		);

		// History replays byte-stable (same conversion the regular request uses),
		// then exactly one appended instruction turn — not a standalone blob.
		const expectedHistory = convertToLlm(event.preparation.replayMessages);
		expect(context.messages).toHaveLength(expectedHistory.length + 1);
		expect(context.messages.slice(0, expectedHistory.length)).toEqual(expectedHistory);
		const instruction = context.messages[context.messages.length - 1];
		expect(instruction.role).toBe("user");
		const instructionText = JSON.stringify(instruction.content);
		expect(instructionText).toContain("Summarize");
		expect(instructionText).not.toContain("<conversation>");

		// Routing id is forwarded from the session, never minted; no cache opt-out.
		expect(options.sessionId).toBe("session-1");
		expect(options.cacheRetention).toBeUndefined();
		expect(options.signal).toBe(event.signal);

		expect(result.compaction).toEqual({
			summary: "SUMMARY",
			firstKeptEntryId: "kept-1",
			tokensBefore: 1234,
			usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
		});
	});

	it("switches to an update prompt on a previous summary without inlining it", async () => {
		const { handlers } = install();
		const event = makeEvent([userMessage("first")], "PREVIOUS SUMMARY");

		const complete = mockComplete({ text: "UPDATED" });
		const ctx = makeCtx(complete);

		await callHandler(handlers, event, ctx);

		const [, context] = complete.mock.calls[0];
		// The replayed history is unchanged; the instruction becomes an update
		// prompt — the old summary rides the replayed checkpoint message, so
		// inlining its text again would duplicate it.
		expect(context.messages.slice(0, 1)).toEqual(convertToLlm([userMessage("first")]));
		const instructionText = JSON.stringify(context.messages[1].content);
		expect(instructionText).toContain("Update");
		expect(instructionText).not.toContain("PREVIOUS SUMMARY");
	});

	it("falls back to default compaction when the summary is empty", async () => {
		const { handlers } = install();
		const ctx = makeCtx(mockComplete({ text: "  " }));

		const result = await callHandler(handlers, makeEvent([userMessage("first")]), ctx);
		expect(result).toBeUndefined();
	});

	it("falls back to default compaction when the request fails", async () => {
		const { handlers } = install();
		const complete = mockComplete({ error: new Error("boom") });
		const ctx = makeCtx(complete);

		const result = await callHandler(handlers, makeEvent([userMessage("first")]), ctx);
		expect(result).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("boom"), "error");
	});
});
