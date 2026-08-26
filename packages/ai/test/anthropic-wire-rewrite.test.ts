import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

// Module-scoped adapter state: lastSerializedOAuth and anchoredDeferredToolNames
// never reset, so auth-mode tests run in a known order (key first, then OAuth)
// and deferred-tool tests use unique tool names per test.
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Tool, ToolResultMessage, UserMessage } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	createParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");

		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	class FakeAnthropic {
		messages = {
			create: (params: Record<string, unknown>) => {
				mockState.createParams = params;
				return {
					asResponse: async () => createSseResponse(),
				};
			},
		};
	}

	return { default: FakeAnthropic };
});

function makeTool(name: string): Tool {
	return {
		name,
		description: `The ${name} tool`,
		parameters: Type.Object({ value: Type.String() }),
	};
}

function makeUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function makeAssistantToolCall(name: string, id = "call_1"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function makeToolResult(toolName: string, addedToolNames: string[], id = "call_1"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text: "done" }],
		addedToolNames,
		isError: false,
		timestamp: 3,
	};
}

/**
 * Context shaped like a dynamic-tool session: `baseName` was called, the result
 * of that call marks `lateName` as added, and the late tool has not been used
 * yet (the first request after the marker anchors the deferred load).
 */
function makeDeferredContext(baseName: string, lateName: string): Context {
	return {
		messages: [
			makeUserMessage("Hello"),
			makeAssistantToolCall(baseName),
			makeToolResult(baseName, [lateName]),
			makeUserMessage("Continue"),
		],
		tools: [makeTool(baseName), makeTool(lateName)],
	};
}

afterEach(() => {
	mockState.createParams = undefined;
});

describe("Anthropic wire-rewrite observer (issue #56 seam)", () => {
	it("fires provider-deferred-tool-load when a request first anchors a deferred tool load", async () => {
		const causes: string[] = [];
		const model = getModel("anthropic", "claude-opus-4-6");
		const context = makeDeferredContext("wire_base_one", "wire_late_one");

		await streamSimple(model, context, {
			apiKey: "anthropic-key",
			onWireRewrite: (cause) => causes.push(cause),
		}).result();

		expect(causes).toEqual(["provider-deferred-tool-load"]);
		// The anchor is observable on the wire: the marker result carries a
		// tool_reference for the deferred tool.
		const messages = mockState.createParams?.messages as Array<{
			content: string | Array<{ type: string; content?: unknown }>;
		}>;
		const marker = messages
			.flatMap((message) => (typeof message.content === "string" ? [] : message.content))
			.find((block) => block.type === "tool_result");
		expect(marker?.content).toEqual([{ type: "tool_reference", tool_name: "wire_late_one" }]);
	});

	it("does not re-fire for a deferred load an earlier request already anchored", async () => {
		const causes: string[] = [];
		const options = {
			apiKey: "anthropic-key",
			onWireRewrite: (cause: string) => causes.push(cause),
		};
		const model = getModel("anthropic", "claude-opus-4-6");
		const context = makeDeferredContext("wire_base_two", "wire_late_two");

		await streamSimple(model, context, options).result();
		expect(causes).toEqual(["provider-deferred-tool-load"]);

		// Second request: same anchor, and the deferred tool has now been used
		// after its marker. The placement is unchanged, so nothing re-fires.
		const usedContext: Context = {
			tools: context.tools,
			messages: [
				...context.messages,
				makeAssistantToolCall("wire_late_two", "call_2"),
				makeToolResult("wire_late_two", [], "call_2"),
			],
		};
		await streamSimple(model, usedContext, options).result();
		expect(causes).toEqual(["provider-deferred-tool-load"]);
	});

	it("fires provider-auth-mode when the auth mode changes between requests", async () => {
		const causes: string[] = [];
		const observer = { onWireRewrite: (cause: string) => causes.push(cause) };
		const model = getModel("anthropic", "claude-opus-4-6");
		const context: Context = { messages: [makeUserMessage("Hello")] };

		// First observed request only initializes the tracked mode.
		await streamSimple(model, context, { ...observer, apiKey: "anthropic-key" }).result();
		expect(causes).toEqual([]);

		// API key -> OAuth: the Claude Code identity block and tool renames
		// rewrite the whole wire.
		await streamSimple(model, context, { ...observer, apiKey: "sk-ant-oat-test" }).result();
		expect(causes).toEqual(["provider-auth-mode"]);

		// Same mode again: no re-fire.
		causes.length = 0;
		await streamSimple(model, context, { ...observer, apiKey: "sk-ant-oat-other" }).result();
		expect(causes).toEqual([]);

		// OAuth -> API key: rewrite back, fires again.
		await streamSimple(model, context, { ...observer, apiKey: "anthropic-key" }).result();
		expect(causes).toEqual(["provider-auth-mode"]);
	});

	it("does not report auth-mode changes for bearer-header auth", async () => {
		const causes: string[] = [];
		const model = getModel("anthropic", "claude-opus-4-6");
		const context: Context = { messages: [makeUserMessage("Hello")] };

		// Header-owned auth (e.g. ANTHROPIC_AUTH_TOKEN gateways) never enables
		// OAuth shaping, so it must not fire the auth-mode rewrite.
		await streamSimple(model, context, {
			headers: { Authorization: "Bearer gateway-token" },
			onWireRewrite: (cause) => causes.push(cause),
		}).result();
		await streamSimple(model, context, {
			headers: { Authorization: "Bearer other-gateway-token" },
			onWireRewrite: (cause: string) => causes.push(cause),
		}).result();

		expect(causes).toEqual([]);
	});

	it("works unchanged without an observer", async () => {
		const model = getModel("anthropic", "claude-opus-4-6");

		const deferred = await streamSimple(model, makeDeferredContext("wire_base_three", "wire_late_three"), {
			apiKey: "anthropic-key",
		}).result();
		expect(deferred.stopReason).toBe("stop");

		const oauth = await streamSimple(
			model,
			{ messages: [makeUserMessage("Hello")] },
			{ apiKey: "sk-ant-oat-test" },
		).result();
		expect(oauth.stopReason).toBe("stop");
	});
});
