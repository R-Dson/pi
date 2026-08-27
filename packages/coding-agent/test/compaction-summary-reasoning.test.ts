import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	type CompactionSettings,
	compact,
	completeSummarization,
	generateSummary,
	generateSummaryWithUsage,
	prepareCompaction,
} from "../src/core/compaction/index.ts";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(
	reasoning: boolean,
	maxTokens = 8192,
	compat?: Model<"anthropic-messages">["compat"],
): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
		...(compat ? { compat } : {}),
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const mockToolCallResponse: AssistantMessage = {
	...mockSummaryResponse,
	content: [{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } }],
	stopReason: "toolUse",
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

const prefix = {
	systemPrompt: "You are the agent's real system prompt.",
	tools: [
		{
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
		},
	],
};

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		const result = await generateSummaryWithUsage(
			messages,
			createModel(true),
			prefix,
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(result.text).toBe("## Goal\nTest summary");
		expect(result.usage).toEqual(mockSummaryResponse.usage);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("preserves the string result from generateSummary", async () => {
		await expect(generateSummary(messages, createModel(false), prefix, 2000, "test-key")).resolves.toBe(
			"## Goal\nTest summary",
		);
	});

	it("inherits provider caching like a regular request (cache plan phase A)", async () => {
		await generateSummary(messages, createModel(false), prefix, 2000, "test-key");
		await generateSummary(messages, createModel(false), prefix, 2000, "test-key");

		const requestOptions = completeSimpleMock.mock.calls.map((call) => call[2]);
		expect(requestOptions).toHaveLength(2);
		// Replaying summary calls must NOT opt out of caching or mint fresh
		// routing ids: both would break prefix affinity with the prior request.
		expect(requestOptions.every((options) => options?.cacheRetention === undefined)).toBe(true);
		expect(requestOptions.every((options) => options?.sessionId === undefined)).toBe(true);
	});

	it("standalone requests opt out of caching; replaying requests inherit it", async () => {
		await completeSummarization(
			createModel(false),
			{ systemPrompt: "Summarize", messages: [] },
			{
				sessionId: "current-routing-session",
				cacheRetention: "long",
				toolChoice: "auto",
			},
		);
		await completeSummarization(
			createModel(false),
			{ systemPrompt: "Summarize", messages: [] },
			{
				sessionId: "current-routing-session",
				toolChoice: "auto",
			},
			undefined,
			undefined,
			undefined,
			false,
		);

		const standalone = completeSimpleMock.mock.calls[0][2];
		expect(standalone).toMatchObject({
			sessionId: "current-routing-session",
			cacheRetention: "none",
			toolChoice: "auto",
		});
		const replay = completeSimpleMock.mock.calls[1][2];
		expect(replay).toMatchObject({ sessionId: "current-routing-session" });
		expect(replay).not.toHaveProperty("cacheRetention");
	});

	it("preserves the standalone split-turn summary prompt", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			replayMessages: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await compact(preparation, createModel(false), prefix, "test-key");

		const requestContext = completeSimpleMock.mock.calls[0][1] as Context;
		const prompt = JSON.stringify(requestContext.messages);
		expect(prompt).toContain("This is the PREFIX of a turn that was too large to keep");
		expect(prompt).toContain("<conversation>");
	});

	it("rejects tool calls from conversation summaries", async () => {
		completeSimpleMock.mockResolvedValueOnce(mockToolCallResponse);

		await expect(generateSummaryWithUsage(messages, createModel(false), prefix, 2000, "test-key")).rejects.toThrow(
			"Summarization attempted to call a tool",
		);
	});

	it("rejects tool calls from split-turn summaries", async () => {
		completeSimpleMock.mockResolvedValueOnce(mockToolCallResponse);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			replayMessages: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await expect(compact(preparation, createModel(false), prefix, "test-key")).rejects.toThrow(
			"Turn prefix summarization attempted to call a tool",
		);
	});

	it("rejects a length-limited history summary", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});

		await expect(generateSummaryWithUsage(messages, createModel(false), prefix, 2000, "test-key")).rejects.toThrow(
			"generation hit the token cap",
		);
	});

	it("rejects a length-limited split-turn summary", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...mockSummaryResponse,
			stopReason: "length",
			content: [{ type: "text", text: "partial" }],
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			replayMessages: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		await expect(compact(preparation, createModel(false), prefix, "test-key")).rejects.toThrow(
			"generation hit the token cap",
		);
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			prefix,
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			prefix,
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("leaves Anthropic refusal fallback handling to pi-ai model metadata", async () => {
		await generateSummary(
			messages,
			createModel(true, 8192, {
				allowedFallbackModels: [
					{
						provider: "anthropic",
						model: "claude-opus-4-8",
						cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
					},
				],
			}),
			prefix,
			2000,
			"test-key",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("refusalFallbacks");
	});

	it("does not set Anthropic refusal fallback for models without allowed fallback targets", async () => {
		await generateSummary(messages, createModel(true), prefix, 2000, "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("refusalFallbacks");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			replayMessages: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		const result = await compact(preparation, createModel(false, 128000), prefix, "test-key");

		expect(result.usage).toEqual({
			...mockSummaryResponse.usage,
			input: 20,
			output: 20,
			totalTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});
});

describe("split-turn compaction with a previous checkpoint", () => {
	const timestamp = "2025-01-01T00:00:00.000Z";
	const usage: Usage = {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	function assistantEntry(id: string, parentId: string, text: string): SessionMessageEntry {
		return {
			type: "message",
			id,
			parentId,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage,
				stopReason: "stop",
				timestamp: 1,
			},
		};
	}

	function userEntry(id: string, parentId: string | null, text: string): SessionMessageEntry {
		return {
			type: "message",
			id,
			parentId,
			timestamp,
			message: { role: "user", content: text, timestamp: 1 },
		};
	}

	it("keeps the prior checkpoint when the split cut leaves no new messages to summarize", async () => {
		// Session: a checkpoint keeping from u1, one giant turn (u1, a1), and a
		// short follow-up turn. A keep window that cuts inside the giant turn
		// splits the first kept turn, leaving messagesToSummarize empty.
		const u1 = userEntry("u1", null, "giant request");
		const a1 = assistantEntry("a1", "u1", "x".repeat(20000));
		const checkpoint: CompactionEntry = {
			type: "compaction",
			id: "k1",
			parentId: "a1",
			timestamp,
			summary: "## Goal\nPRIOR-CHECKPOINT-MARKER",
			firstKeptEntryId: "u1",
			tokensBefore: 50000,
		};
		const u2 = userEntry("u2", "k1", "short follow-up");
		const a2 = assistantEntry("a2", "u2", "short reply");
		const entries: SessionEntry[] = [u1, a1, checkpoint, u2, a2];

		const settings: CompactionSettings = { enabled: true, reserveTokens: 2000, keepRecentTokens: 200 };
		const preparation = prepareCompaction(entries, settings);

		expect(preparation).toBeDefined();
		expect(preparation!.isSplitTurn).toBe(true);
		expect(preparation!.messagesToSummarize).toEqual([]);
		expect(preparation!.previousSummary).toBe(checkpoint.summary);

		const result = await compact(preparation!, createModel(false), prefix, "test-key");
		expect(result.summary).toContain("PRIOR-CHECKPOINT-MARKER");
	});
});
