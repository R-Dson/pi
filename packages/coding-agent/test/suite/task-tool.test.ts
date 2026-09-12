import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, ToolResultMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskTool, SubAgentLimiter } from "../../src/core/tools/task.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function toolResultTexts(context: Context): string[] {
	return context.messages.filter((message) => message.role === "toolResult").map((message) => getMessageText(message));
}

function taskToolResults(harness: Harness): ToolResultMessage[] {
	return harness.session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "task",
	);
}

describe("task tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("spawns a sub-agent with LLM-provided instructions and returns its final text", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const subContexts: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("task", { prompt: "Summarize the data below.", systemPrompt: "You are a terse analyst." })],
				{ stopReason: "toolUse" },
			),
			(context) => {
				subContexts.push(context);
				return fauxAssistantMessage("sub-agent final answer");
			},
			fauxAssistantMessage("main agent conclusion"),
		]);

		await harness.session.prompt("delegate this");

		const toolResults = taskToolResults(harness);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError ?? false).toBe(false);
		expect(getMessageText(toolResults[0])).toContain("sub-agent final answer");

		expect(subContexts).toHaveLength(1);
		expect(subContexts[0].systemPrompt).toBe("You are a terse analyst.");
		const subMessages = subContexts[0].messages;
		const lastUser = subMessages[subMessages.length - 1];
		expect(lastUser?.role).toBe("user");
		expect(getMessageText(lastUser)).toContain("Summarize the data below.");
		// One layer deep: the sub-agent cannot spawn its own sub-agents.
		expect(subContexts[0].tools?.map((tool) => tool.name) ?? []).not.toContain("task");
	});

	it("sub-agents run the tools they inherit from the main agent", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "marker.txt"), "marker");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { prompt: "List the directory and report." })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("read", { path: "marker.txt" })], { stopReason: "toolUse" }),
			(context) => fauxAssistantMessage(`sub-agent saw: ${toolResultTexts(context).join(" | ")}`),
			fauxAssistantMessage("main agent conclusion"),
		]);

		await harness.session.prompt("delegate this");

		const toolResults = taskToolResults(harness);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError ?? false).toBe(false);
		// The sub-agent's read really executed against the session cwd and its
		// output reached the sub-agent's follow-up turn.
		expect(getMessageText(toolResults[0])).toContain("sub-agent saw: marker");
	});

	it("applies the session's tool_call extension gate to sub-agent tool calls", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event) => {
						if (event.toolName === "read") {
							return { block: true, reason: "blocked by test policy" };
						}
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "marker.txt"), "marker");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { prompt: "List the directory." })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("read", { path: "marker.txt" })], { stopReason: "toolUse" }),
			(context) => fauxAssistantMessage(`sub-agent saw: ${toolResultTexts(context).join(" | ")}`),
			fauxAssistantMessage("main agent conclusion"),
		]);

		await harness.session.prompt("delegate this");

		const toolResults = taskToolResults(harness);
		expect(toolResults).toHaveLength(1);
		expect(getMessageText(toolResults[0])).toContain("blocked by test policy");
	});

	it("caps concurrently running sub-agents at maxSubAgents; excess spawns queue", async () => {
		const harness = await createHarness({ settings: { maxSubAgents: 1 } });
		harnesses.push(harness);

		let inFlight = 0;
		let maxInFlight = 0;
		const gates: Array<() => void> = [];
		const gatedSubAgentResponse = (label: string) => async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise<void>((resolve) => {
				gates.push(resolve);
			});
			inFlight--;
			return fauxAssistantMessage(`${label} answer`);
		};

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("task", { prompt: "first task" }, { id: "task-a" }),
					fauxToolCall("task", { prompt: "second task" }, { id: "task-b" }),
				],
				{ stopReason: "toolUse" },
			),
			gatedSubAgentResponse("first"),
			gatedSubAgentResponse("second"),
			fauxAssistantMessage("main agent conclusion"),
		]);

		const promptPromise = harness.session.prompt("delegate both");

		// First sub-agent starts; the second must queue behind the cap of 1.
		await vi.waitFor(() => expect(gates.length).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(gates.length).toBe(1);

		gates.shift()!();
		await vi.waitFor(() => expect(gates.length).toBe(1));
		gates.shift()!();
		await promptPromise;

		expect(maxInFlight).toBe(1);
		const toolResults = taskToolResults(harness);
		expect(toolResults).toHaveLength(2);
		const resultTexts = toolResults.map((result) => getMessageText(result)).sort();
		expect(resultTexts).toEqual(["first answer", "second answer"]);
		expect(toolResults.every((result) => !result.isError)).toBe(true);
	});

	it("SubAgentLimiter hands off slots FIFO without ever exceeding the cap", async () => {
		const limiter = new SubAgentLimiter();
		let inFlight = 0;
		let maxInFlight = 0;
		const gates: Array<() => void> = [];
		const run = async () => {
			const release = await limiter.acquire(1);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise<void>((resolve) => {
				gates.push(resolve);
			});
			inFlight--;
			release();
		};

		const first = run();
		await vi.waitFor(() => expect(gates.length).toBe(1));
		const second = run();
		const third = run();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(gates.length).toBe(1);

		// Each release hands the slot to the next waiter in order; a waiter never
		// starts before the previous holder finishes, and the cap is never exceeded.
		for (let index = 0; index < 2; index++) {
			gates.shift()!();
			await vi.waitFor(() => expect(gates.length).toBe(1));
		}
		gates.shift()!();
		await Promise.all([first, second, third]);

		expect(maxInFlight).toBe(1);
	});

	it("aborts the running sub-agent when the tool call is aborted", async () => {
		// A stream that hangs until its signal aborts, then ends with an aborted message.
		const streamFn: StreamFn = async (_model, _context, streamOptions) => {
			await new Promise<void>((resolve) => {
				streamOptions?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				errorMessage: "Request was aborted",
				timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "error", reason: "aborted", error: message });
			stream.end(message);
			return stream;
		};
		const faux = registerFauxProvider({});
		try {
			const tool = createTaskTool({
				getMaxSubAgents: () => 2,
				getStreamFn: () => streamFn,
				getModel: () => faux.getModel(),
				getThinkingLevel: () => undefined,
				getTools: () => [],
				limiter: new SubAgentLimiter(),
			});

			const controller = new AbortController();
			const execution = tool.execute("call-1", { prompt: "do it" }, controller.signal);
			await new Promise((resolve) => setTimeout(resolve, 0));
			controller.abort();

			await expect(execution).rejects.toThrow(/abort/i);
		} finally {
			faux.unregister();
		}
	});
});
