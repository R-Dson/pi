import { createHash } from "node:crypto";
import {
	type Context,
	type FauxResponseStep,
	fauxAssistantMessage,
	registerFauxProvider,
	type SimpleStreamOptions,
	type SystemMessage,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.ts";
import {
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
} from "../src/core/compaction/compaction.ts";
import type { SummarizationPrefix } from "../src/core/compaction/replay.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

/**
 * Characterization gate for the prefix-replaying summarizer requests (cache
 * plan phase A): compaction and branch-summary requests are pinned by digest
 * (SHA-256 over the serialized request context and stream options, under a
 * fixed clock). Any change to what the replay sends - including pure code
 * moves that alter construction order - must land here deliberately, because
 * the request bytes are what the provider prompt cache matches.
 *
 * Requests are captured through the faux provider's response-step seam (the
 * prompt-stable-prefix pattern), so they travel the full faux streaming path.
 * The fixtures carry tool-call/result pairs (pairing bytes) and a dangling
 * trailing call (the branch path's synthesized terminal result), and the
 * fresh-compaction path passes customInstructions (the instruction builder's
 * focus branch).
 */

const faux = registerFauxProvider({
	models: [{ id: "test-model", name: "Test Model", contextWindow: 200000, maxTokens: 8192 }],
});

const echoTool = {
	name: "bash",
	label: "Bash",
	description: "Echo a command back",
	parameters: Type.Object({ command: Type.String() }),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
};

const derivedPrefix: SummarizationPrefix = {
	systemPrompt: "You are the agent's real system prompt.",
	tools: [echoTool],
};

const liveSystemMessage: SystemMessage = {
	role: "system",
	content: "You are the live transcript system prompt.",
	timestamp: 1,
};

function entry(id: string, parentId: string | null, timestamp: number, message: unknown): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: message as never,
	};
}

function userEntry(id: string, parentId: string | null, text: string, timestamp: number): SessionEntry {
	return entry(id, parentId, timestamp, { role: "user", content: text, timestamp });
}

function assistantTextEntry(id: string, parentId: string | null, text: string, timestamp: number): SessionEntry {
	return entry(id, parentId, timestamp, {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp,
	});
}

function assistantToolCallEntry(
	id: string,
	parentId: string | null,
	toolCallId: string,
	timestamp: number,
): SessionEntry {
	return entry(id, parentId, timestamp, {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "make check" } }],
		timestamp,
	});
}

function toolResultEntry(
	id: string,
	parentId: string | null,
	toolCallId: string,
	text: string,
	timestamp: number,
): SessionEntry {
	return entry(id, parentId, timestamp, {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		timestamp,
	});
}

/** Fresh-session entries: no previous compaction; includes an answered tool-call pair. */
const freshEntries: SessionEntry[] = [
	userEntry("e1", null, "Original request", 1),
	assistantToolCallEntry("e2", "e1", "tc-1", 2),
	toolResultEntry("e3", "e2", "tc-1", "make output line", 3),
	assistantTextEntry("e4", "e3", "Work happened", 4),
	userEntry("e5", "e4", "Follow-up request", 5),
];

/**
 * Post-compaction entries: a checkpoint to replay, messages after it to
 * summarize (with their own tool-call pair), and a trailing partial turn (the
 * cut splits it, so the run also exercises the standalone turn-prefix request).
 */
const checkpointEntries: SessionEntry[] = [
	userEntry("u1", null, "Ancient request", 1),
	{
		type: "compaction",
		id: "c1",
		parentId: "u1",
		timestamp: new Date(2).toISOString(),
		summary: "Prior checkpoint summary text.",
		firstKeptEntryId: "u2",
		tokensBefore: 1000,
		systemMessage: liveSystemMessage,
	},
	userEntry("u2", "c1", "Kept turn request", 3),
	assistantToolCallEntry("a2", "u2", "tc-2", 4),
	toolResultEntry("tr2", "a2", "tc-2", "kept turn tool output", 5),
	assistantTextEntry("a2b", "tr2", "New work", 6),
	userEntry("u3", "a2b", "Third request", 7),
	assistantTextEntry("a3", "u3", "New work three", 8),
];

/** Branch entries: an answered pair mid-branch and a dangling trailing call. */
const branchEntries: SessionEntry[] = [
	userEntry("b1", null, "Branch request", 1),
	assistantToolCallEntry("b2", "b1", "tc-b1", 2),
	toolResultEntry("b3", "b2", "tc-b1", "branch tool output", 3),
	assistantToolCallEntry("b4", "b3", "tc-b2", 4),
];

interface Captured {
	contextDigest: string;
	optionsDigest: string;
	context: Context;
	options: SimpleStreamOptions | undefined;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Options digest input: sessionId is stripped (the standalone path mints a
 * random throwaway id); its value is asserted structurally instead.
 */
function optionsDigest(options: SimpleStreamOptions | undefined): string {
	const { sessionId: _sessionId, ...rest } = options ?? {};
	return digest(rest);
}

/** A faux response step that records the request and answers with a summary. */
function captureStep(captures: Captured[]): FauxResponseStep {
	return (context, options) => {
		captures.push({ contextDigest: digest(context), optionsDigest: optionsDigest(options), context, options });
		return fauxAssistantMessage("summary");
	};
}

/** compact() with only the arguments these tests vary; everything else is pinned. */
async function compactWith(
	preparation: CompactionPreparation,
	prefix: SummarizationPrefix,
	customInstructions?: string,
): Promise<void> {
	await compact(
		preparation,
		faux.getModel(),
		prefix,
		undefined,
		undefined,
		customInstructions,
		undefined,
		undefined,
		streamSimple,
		undefined,
		undefined,
		undefined,
		"sess-golden",
	);
}

const TIGHT_BUDGET = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };
const CUSTOM_FOCUS = "Focus on test coverage.";

describe("compaction replay golden (byte-stable summarizer requests)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	afterAll(() => {
		faux.unregister();
	});

	it("compaction (fresh session) replays the derived prefix and appends the instruction", async () => {
		const preparation = prepareCompaction(freshEntries, TIGHT_BUDGET);
		expect(preparation).toBeDefined();
		expect(preparation?.replayMessages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);

		const captures: Captured[] = [];
		faux.setResponses([captureStep(captures)]);
		await compactWith(preparation!, derivedPrefix, CUSTOM_FOCUS);

		expect(captures).toHaveLength(1);
		const messages = captures[0].context.messages ?? [];
		// normalizeContext folds the derived prefix into a leading system message.
		expect(messages).toHaveLength(6);
		expect(messages[0]?.role).toBe("system");
		expect(JSON.stringify(messages[1])).toContain("Original request");
		// The tool pair replays as structured blocks...
		expect(JSON.stringify(messages[2])).toContain("make check");
		expect(JSON.stringify(messages[3])).toContain("make output line");
		// ...and the custom focus rides the appended instruction turn.
		expect(JSON.stringify(messages[5])).toContain("Summarize the conversation above");
		expect(JSON.stringify(messages[5])).toContain(`Additional focus: ${CUSTOM_FOCUS}`);
		// Replay requests inherit provider caching (no opt-out) and carry the routing id.
		expect(captures[0].options?.cacheRetention).toBeUndefined();
		expect(captures[0].options?.sessionId).toBe("sess-golden");
	});

	it("compaction (update) heads the replay with the checkpoint and uses the update prompt", async () => {
		const preparation = prepareCompaction(checkpointEntries, TIGHT_BUDGET);
		expect(preparation?.previousSummary).toBe("Prior checkpoint summary text.");
		// The replay list is headed by the checkpoint projection (system message
		// plus compaction summary), so the prefix matches from message 0.
		expect(preparation?.replayMessages.map((m) => m.role)).toEqual([
			"system",
			"compactionSummary",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);

		const captures: Captured[] = [];
		// The split turn issues two summarizer requests: queue a capture step for each.
		faux.setResponses([captureStep(captures), captureStep(captures)]);
		await compactWith(preparation!, { ...derivedPrefix, systemMessage: liveSystemMessage });

		// The split turn produces two requests: the replaying update first, then
		// the standalone turn-prefix summary for the partial trailing turn.
		expect(captures).toHaveLength(2);
		const replay = captures[0].context.messages ?? [];
		expect(replay[0]).toEqual(liveSystemMessage);
		expect(JSON.stringify(replay[1])).toContain("Prior checkpoint summary text.");
		expect(JSON.stringify(replay[replay.length - 1])).toContain("Update the existing structured summary");
		// The replay carries the routing id; the standalone request opts out of
		// caching and mints a throwaway id (never the session's bucket).
		expect(captures[0].options?.sessionId).toBe("sess-golden");
		expect(captures[0].options?.cacheRetention).toBeUndefined();
		expect(captures[1].options?.cacheRetention).toBe("none");
		expect(captures[1].options?.sessionId).not.toBe("sess-golden");
	});

	it("branch summary replays the branch history, repairing the dangling call", async () => {
		const captures: Captured[] = [];
		faux.setResponses([captureStep(captures)]);
		await generateBranchSummary(branchEntries, {
			model: faux.getModel(),
			signal: new AbortController().signal,
			streamFn: streamSimple,
			prefix: derivedPrefix,
			sessionId: "sess-golden",
		});

		expect(captures).toHaveLength(1);
		const messages = captures[0].context.messages ?? [];
		expect(messages[0]?.role).toBe("system");
		expect(JSON.stringify(messages[messages.length - 1])).toContain(
			"Create a structured summary of this conversation branch",
		);
		// The answered pair replays as toolCall + toolResult blocks; the dangling
		// trailing call gets one synthesized terminal result (recovery.ts text).
		expect(JSON.stringify(messages)).toContain("make check");
		expect(JSON.stringify(messages)).toContain("branch tool output");
		expect(JSON.stringify(messages)).toContain("Tool execution was interrupted before completing");
		expect(captures[0].options?.sessionId).toBe("sess-golden");
	});

	// The digests are the gate: they pin the full serialized requests (message
	// and block order, option keys) under a fixed clock. Update them only with
	// a deliberate request-bytes change and a changelog entry.
	it("request digests are stable", async () => {
		const fresh: Captured[] = [];
		faux.setResponses([captureStep(fresh)]);
		await compactWith(prepareCompaction(freshEntries, TIGHT_BUDGET)!, derivedPrefix, CUSTOM_FOCUS);

		const update: Captured[] = [];
		faux.setResponses([captureStep(update), captureStep(update)]);
		await compactWith(prepareCompaction(checkpointEntries, TIGHT_BUDGET)!, {
			...derivedPrefix,
			systemMessage: liveSystemMessage,
		});

		const branch: Captured[] = [];
		faux.setResponses([captureStep(branch)]);
		await generateBranchSummary(branchEntries, {
			model: faux.getModel(),
			signal: new AbortController().signal,
			streamFn: streamSimple,
			prefix: derivedPrefix,
			sessionId: "sess-golden",
		});

		expect({
			"fresh/context": fresh[0]?.contextDigest,
			"fresh/options": fresh[0]?.optionsDigest,
			"update-replay/context": update[0]?.contextDigest,
			"update-replay/options": update[0]?.optionsDigest,
			"update-turn-prefix/context": update[1]?.contextDigest,
			"update-turn-prefix/options": update[1]?.optionsDigest,
			"branch/context": branch[0]?.contextDigest,
			"branch/options": branch[0]?.optionsDigest,
		}).toEqual({
			"fresh/context": "d1e61f86a1caaa7fb5ce4204ed7812b8e5cf310f1139c0c00a7d1ab91f247b76",
			"fresh/options": "5aa5e979a9f279ab0e47e14359dd4006e63a25a36c18e1c94d4c8386b8e5f61f",
			"update-replay/context": "3202b04c97600703357565d88fbde48d1e05dfbf0dc1e1be6aab5dc5d243d7b2",
			"update-replay/options": "5aa5e979a9f279ab0e47e14359dd4006e63a25a36c18e1c94d4c8386b8e5f61f",
			"update-turn-prefix/context": "21a39bb4cacad9701526e51192b3b501c7c1095cb39209eaa5313470495cc190",
			"update-turn-prefix/options": "88a4d423a4d221bfc8ed297401059018db3f19f67475da9ba9e6259047f8de50",
			"branch/context": "e84f6897db65e357fd54abfd10cd5f9b6700e110567d3804c672c5ca5c433d2e",
			"branch/options": "fe582f49f2dcb163cb4074ce64ff08272ae70451056ad2b42ff2ea585ce7c19f",
		});
	});
});
