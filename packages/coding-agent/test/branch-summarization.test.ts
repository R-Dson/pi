import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const entries: SessionEntry[] = [
	{
		type: "message",
		id: "branch-user",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "Abandoned request", timestamp: 1 },
	},
];

function response(content: AssistantMessage["content"]): AssistantMessage {
	return {
		...fauxAssistantMessage(""),
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

const echoTool = {
	name: "bash",
	label: "Bash",
	description: "Echo a command back",
	parameters: Type.Object({ command: Type.String() }),
	execute: async (_toolCallId: string, params: unknown) => {
		const command =
			typeof params === "object" && params !== null && "command" in params ? String(params.command) : "";
		return {
			content: [{ type: "text" as const, text: `ran:${command}` }],
			details: { command },
		};
	},
};

const prefix = { systemPrompt: "You are the agent's real system prompt.", tools: [echoTool] };

describe("branch summarization", () => {
	it("replays the agent request prefix with one appended instruction turn", async () => {
		let requestContext: Context | undefined;
		const streamFn: StreamFn = (_model, context) => {
			requestContext = context;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
			prefix,
		});

		expect(requestContext?.systemPrompt).toBe("You are the agent's real system prompt.");
		expect(requestContext?.tools).toEqual([echoTool]);

		const messages = requestContext?.messages ?? [];
		expect(messages).toHaveLength(2);
		// The real branch message history is replayed, not serialized into a blob.
		expect(messages[0]?.role).toBe("user");
		expect(JSON.stringify(messages[0])).toContain("Abandoned request");
		expect(JSON.stringify(messages[0])).not.toContain("[User]:");

		const instruction = messages[1];
		expect(instruction?.role).toBe("user");
		const instructionContent = instruction?.content;
		const instructionText =
			typeof instructionContent === "string"
				? instructionContent
				: (instructionContent ?? [])
						.filter((block) => block.type === "text")
						.map((block) => (block.type === "text" ? block.text : ""))
						.join("\n");
		expect(instructionText).toContain("Act as a summarizer for this single turn; do not continue the conversation.");
		expect(instructionText).toContain("Create a structured summary of this conversation branch");
		expect(instructionText).not.toContain("<conversation>");
	});

	it("does not override tool choice for branch summaries", async () => {
		let requestOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
			prefix,
		});

		expect(requestOptions?.toolChoice).toBeUndefined();
	});

	it("forwards the session routing id on the replaying request", async () => {
		let requestOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
			prefix,
			sessionId: "branch-summary-routing",
		});

		expect(requestOptions?.sessionId).toBe("branch-summary-routing");
	});

	it("rejects tool calls from branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "toolUse",
					message: response([
						{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } },
					]),
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
			prefix,
		});

		expect(result.error).toBe("Branch summarization attempted to call a tool");
	});

	it("rejects length-limited branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "length",
					message: { ...response([{ type: "text", text: "partial" }]), stopReason: "length" },
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			prefix,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe(
			"Branch summarization failed: generation hit the token cap and the summary is incomplete",
		);
	});

	it("replays tool results so tool_use blocks stay paired", async () => {
		let requestContext: Context | undefined;
		const streamFn: StreamFn = (_model, context) => {
			requestContext = context;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		const toolEntries: SessionEntry[] = [
			entries[0],
			{
				type: "message",
				id: "branch-tool-call",
				parentId: "branch-user",
				timestamp: new Date(2).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
					api: model.api,
					provider: model.provider,
					model: model.id,
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
				},
			},
			{
				type: "message",
				id: "branch-tool-result",
				parentId: "branch-tool-call",
				timestamp: new Date(3).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "bash",
					content: [{ type: "text", text: "file listing" }],
					isError: false,
					timestamp: 3,
				},
			},
		];

		await generateBranchSummary(toolEntries, {
			model,
			signal: new AbortController().signal,
			streamFn,
			prefix,
		});

		const messages = requestContext?.messages ?? [];
		const roles = messages.map((message) => message.role);
		expect(roles).toContain("toolResult");
		// The result must sit directly after its call: a strict provider rejects
		// a tool_use whose tool_result is missing or reordered.
		const callIndex = roles.indexOf("assistant");
		const resultIndex = roles.indexOf("toolResult");
		expect(callIndex).toBeGreaterThanOrEqual(0);
		expect(resultIndex).toBe(callIndex + 1);
	});

	it("synthesizes a terminal result for a dangling tool call at the branch tail", async () => {
		let requestContext: Context | undefined;
		const streamFn: StreamFn = (_model, context) => {
			requestContext = context;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		// Branch abandoned mid-turn: the assistant called a tool, the session
		// died before the result landed.
		const danglingEntries: SessionEntry[] = [
			entries[0],
			{
				type: "message",
				id: "branch-dangling-call",
				parentId: "branch-user",
				timestamp: new Date(2).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_dangling", name: "bash", arguments: { command: "ls" } }],
					api: model.api,
					provider: model.provider,
					model: model.id,
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
				},
			},
		];

		await generateBranchSummary(danglingEntries, {
			model,
			signal: new AbortController().signal,
			streamFn,
			prefix,
		});

		const messages = requestContext?.messages ?? [];
		const synthesized = messages.find(
			(message) =>
				message.role === "toolResult" && "toolCallId" in message && message.toolCallId === "call_dangling",
		);
		expect(synthesized).toBeDefined();
		expect(synthesized?.role === "toolResult" && synthesized.isError).toBe(true);
	});
});
