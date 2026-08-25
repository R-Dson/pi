/**
 * Stable-prefix regression tests — fork equivalence baseline (issue #12, plan phase 7).
 *
 * Seam: the provider-bound stream function. The faux provider hands each
 * scripted response step the exact Context (systemPrompt, converted messages,
 * tools) that `streamAssistantResponse` in packages/agent/src/agent-loop.ts
 * built for the model request (transformContext + convertToLlm + context
 * tools). These tests pin today's request-prefix behavior: a later turn must
 * not mutate what an earlier turn already sent — systemPrompt byte-for-byte,
 * tool list (names + serialized parameter schemas) in the same order, and the
 * message history extend-only — so providers can reuse their prompt cache.
 * Changes to request construction must update these tests deliberately.
 *
 * N/A scenarios from the issue's golden list: model changes, compaction, and
 * branch resume never rebuild the base system prompt (buildSystemPrompt takes
 * no model input; compaction rewrites messages only), so they have no
 * system-prompt golden to pin — their request-shape effects flow through the
 * message arrays asserted here.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Context, Message } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { serializeTools } from "../../src/core/sessions/prefix-stability.ts";
import { createHarness, type Harness } from "./harness.ts";

interface CapturedRequest {
	systemPrompt: string | undefined;
	tools: Array<{ name: string; parameters: string }>;
	messages: Message[];
}

function captureRequest(context: Context): CapturedRequest {
	return {
		systemPrompt: context.systemPrompt,
		tools: serializeTools(context.tools),
		messages: structuredClone(context.messages),
	};
}

function captureStep(captures: CapturedRequest[], reply: string): FauxResponseStep {
	return (context) => {
		captures.push(captureRequest(context));
		return fauxAssistantMessage(reply);
	};
}

function captureToolCallStep(
	captures: CapturedRequest[],
	toolName: string,
	args: Record<string, string>,
): FauxResponseStep {
	return (context) => {
		captures.push(captureRequest(context));
		return fauxAssistantMessage(fauxToolCall(toolName, args), { stopReason: "toolUse" });
	};
}

/** Every captured request shares the first request's systemPrompt and tool list, in the same order. */
function expectSamePromptAndTools(captures: CapturedRequest[]): void {
	const first = captures[0];
	if (!first) {
		throw new Error("no captured requests");
	}
	expect(first.systemPrompt).toBeTruthy();
	expect(first.tools.length).toBeGreaterThan(0);
	for (const capture of captures.slice(1)) {
		expect(capture.systemPrompt).toBe(first.systemPrompt);
		expect(capture.tools).toEqual(first.tools);
	}
}

/**
 * Serialize a captured request for cross-session byte comparison, normalizing
 * the two per-instance values that are not construction nondeterminism: the
 * harness temp cwd (embedded in the prompt's working-directory line) and
 * message timestamps.
 */
function serializeRequest(capture: CapturedRequest, harness: Harness): string {
	return JSON.stringify({
		systemPrompt: capture.systemPrompt,
		tools: capture.tools,
		messages: capture.messages,
	})
		.split(harness.tempDir)
		.join("<CWD>")
		.replace(/"timestamp":\d+/g, '"timestamp":<TS>');
}

/** `next` strictly extends `previous`: every prior message is unchanged (deep-equal) at the same index. */
function expectStablePrefix(previous: Message[], next: Message[]): void {
	expect(next.length).toBeGreaterThan(previous.length);
	expect(next.slice(0, previous.length)).toEqual(previous);
}

describe("stable model-request prefix (issue #12 baseline)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps systemPrompt, tools, and message prefix stable across two plain turns", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const captures: CapturedRequest[] = [];
		harness.setResponses([captureStep(captures, "first reply"), captureStep(captures, "second reply")]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");

		expect(captures.length).toBe(2);
		expectSamePromptAndTools(captures);
		expectStablePrefix(captures[0]!.messages, captures[1]!.messages);
		expect(captures[0]!.messages.map((message) => message.role)).toEqual(["user"]);
		expect(captures[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
	});

	it("keeps the request prefix stable when the first turn executes a tool call", async () => {
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Echo a command back",
			parameters: Type.Object({ command: Type.String() }),
			execute: async (_toolCallId, params) => {
				const command =
					typeof params === "object" && params !== null && "command" in params ? String(params.command) : "";
				return {
					content: [{ type: "text", text: `ran:${command}` }],
					details: { command },
				};
			},
		};
		const harness = await createHarness({ tools: [bashTool] });
		harnesses.push(harness);
		const captures: CapturedRequest[] = [];
		harness.setResponses([
			captureToolCallStep(captures, "bash", { command: "echo hi" }),
			captureStep(captures, "done"),
			captureStep(captures, "second reply"),
		]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");

		expect(captures.length).toBe(3);
		expectSamePromptAndTools(captures);
		// Follow-up request within turn 1: only the assistant tool call and its result were appended.
		expectStablePrefix(captures[0]!.messages, captures[1]!.messages);
		expect(captures[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		// Turn 2 request: only turn 1's closing assistant reply and the new user message were appended.
		expectStablePrefix(captures[1]!.messages, captures[2]!.messages);
		expect(captures[2]!.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"user",
		]);
		const toolResult = captures[1]!.messages[2];
		if (toolResult?.role === "toolResult") {
			expect(toolResult.toolName).toBe("bash");
		} else {
			throw new Error("expected a toolResult message at index 2");
		}
	});

	it("identical state in two sessions produces identical model requests", async () => {
		const drive = async (): Promise<{ capture: CapturedRequest; harness: Harness }> => {
			const harness = await createHarness();
			harnesses.push(harness);
			const captures: CapturedRequest[] = [];
			harness.setResponses([captureStep(captures, "ok")]);
			await harness.session.prompt("say ok");
			expect(captures).toHaveLength(1);
			return { capture: captures[0], harness };
		};

		const first = await drive();
		const second = await drive();
		expect(serializeRequest(second.capture, second.harness)).toBe(serializeRequest(first.capture, first.harness));
	});
});
