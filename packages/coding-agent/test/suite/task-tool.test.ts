import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, ToolResultMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
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
		// The sub-agent prompt is folded into a leading system message.
		const subMessages = subContexts[0].messages;
		expect(getCurrentSystemPrompt(subMessages)).toBe("You are a terse analyst.");
		const lastUser = subMessages[subMessages.length - 1];
		expect(lastUser?.role).toBe("user");
		expect(getMessageText(lastUser)).toContain("Summarize the data below.");
		// One layer deep: the sub-agent cannot spawn its own sub-agents.
		expect(getCurrentTools(subMessages).map((tool) => tool.name)).not.toContain("task");
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

	it("streams the sub-agent's live activity and returns its conversation as the transcript", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const longFile = Array.from({ length: 20 }, (_, index) => `marker line ${index}`).join("\n");
		writeFileSync(join(harness.tempDir, "marker.txt"), longFile);

		const partials: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_update" && event.toolName === "task") {
				partials.push(event.partialResult as (typeof partials)[number]);
			}
		});

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { prompt: "Read the marker and report." })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("read", { path: "marker.txt" })], { stopReason: "toolUse" }),
			(context) =>
				fauxAssistantMessage([
					fauxThinking("let me check the file contents"),
					fauxText(`sub-agent saw: ${toolResultTexts(context).join(" | ")}`),
				]),
			fauxAssistantMessage("main agent conclusion"),
		]);

		try {
			await harness.session.prompt("delegate this");
		} finally {
			unsubscribe();
		}

		// Live: while the sub-agent's read runs, the task row shows it as the current activity.
		const activities = partials.map((partial) => (partial.details as { activity?: string })?.activity);
		expect(activities.some((activity) => activity?.includes("read") && activity.includes("marker.txt"))).toBe(true);

		// Retro: the final result carries the sub-agent's whole conversation for the
		// expanded view - thinking included, long results head+tail excerpted.
		const details = taskToolResults(harness)[0].details as {
			transcript?: Array<Record<string, unknown>>;
			totalCalls?: number;
			task?: number;
			durationMs?: number;
		};
		expect(details.totalCalls).toBe(1);
		// Session-scoped numbering: each spawn gets a stable "Task N" label.
		expect(details.task).toBe(1);
		// Wall-time duration is persisted so resumed rows keep their header.
		expect(details.durationMs).toBeGreaterThanOrEqual(0);
		expect(details.transcript?.map((entry) => entry.kind)).toEqual([
			"user",
			"tool_call",
			"tool_result",
			"thinking",
			"assistant",
		]);
		expect(String(details.transcript?.[0]?.text)).toContain("Read the marker and report.");
		const callEntry = details.transcript?.[1];
		expect(callEntry?.tool).toBe("read");
		expect(String(callEntry?.args)).toContain("marker.txt");
		const resultEntry = details.transcript?.[2];
		expect(resultEntry?.tool).toBe("read");
		// Real content, head+tail excerpted past the 16-line threshold.
		expect(String(resultEntry?.text)).toContain("marker line 0");
		expect(String(resultEntry?.text)).toContain("marker line 19");
		expect(String(resultEntry?.text)).toContain("(4 lines omitted)");
		expect(String(details.transcript?.[3]?.text)).toContain("let me check the file contents");
		expect(String(details.transcript?.[4]?.text)).toContain("sub-agent saw:");
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
		// Parallel spawns get distinct sequential numbers.
		const taskNumbers = toolResults.map((result) => (result.details as { task?: number } | undefined)?.task).sort();
		expect(taskNumbers).toEqual([1, 2]);
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

	it("ends a hung sub-agent run at the task deadline and reports the timeout", async () => {
		// A stream that never settles on its own: only the deadline aborts it.
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
				nextTaskNumber: () => 1,
				getMaxSubAgents: () => 2,
				getTaskTimeoutMs: () => 20,
				getStreamFn: () => streamFn,
				getModel: () => faux.getModel(),
				getThinkingLevel: () => undefined,
				getTools: () => [],
				limiter: new SubAgentLimiter(),
			});

			await expect(tool.execute("call-1", { prompt: "do it" })).rejects.toThrow(/timed out after 20ms/);
		} finally {
			faux.unregister();
		}
	});

	it("rejects a taskTimeoutMs above the setTimeout ceiling instead of coercing it to a 1ms deadline", async () => {
		const faux = registerFauxProvider({});
		try {
			const tool = createTaskTool({
				nextTaskNumber: () => 1,
				getMaxSubAgents: () => 2,
				getTaskTimeoutMs: () => 2 ** 31,
				// Never called: the range check rejects before the sub-agent spawns.
				getStreamFn: () => streamSimple,
				getModel: () => faux.getModel(),
				getThinkingLevel: () => undefined,
				getTools: () => [],
				limiter: new SubAgentLimiter(),
			});

			await expect(tool.execute("call-1", { prompt: "do it" })).rejects.toThrow(/out of range/);
		} finally {
			faux.unregister();
		}
	});

	it("rejects a non-finite or negative taskTimeoutMs instead of silently disabling the deadline", async () => {
		const faux = registerFauxProvider({});
		try {
			let timeoutMs = Number.NaN;
			const tool = createTaskTool({
				nextTaskNumber: () => 1,
				getMaxSubAgents: () => 2,
				getTaskTimeoutMs: () => timeoutMs,
				getStreamFn: () => streamSimple,
				getModel: () => faux.getModel(),
				getThinkingLevel: () => undefined,
				getTools: () => [],
				limiter: new SubAgentLimiter(),
			});

			// Without the check, NaN and negatives compare false against both the
			// ceiling and the deadline's > 0 guard, silently disabling the deadline.
			await expect(tool.execute("call-1", { prompt: "do it" })).rejects.toThrow(/out of range/);
			timeoutMs = -1;
			await expect(tool.execute("call-2", { prompt: "do it" })).rejects.toThrow(/out of range/);
		} finally {
			faux.unregister();
		}
	});

	it("bounds each transcript excerpt line in addition to the line count", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// Three lines total (under the 16-line head+tail threshold), one of them huge:
		// the line-count cap alone would keep all 5000 chars.
		const longLine = "x".repeat(5000);
		writeFileSync(join(harness.tempDir, "marker.txt"), `short one\n${longLine}\nshort two`);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("task", { prompt: "Read the marker and report." })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("read", { path: "marker.txt" })], { stopReason: "toolUse" }),
			(context) => fauxAssistantMessage(`sub-agent saw: ${toolResultTexts(context).join(" | ")}`),
			fauxAssistantMessage("main agent conclusion"),
		]);

		await harness.session.prompt("delegate this");

		const details = taskToolResults(harness)[0].details as {
			transcript?: Array<Record<string, unknown>>;
		};
		const resultEntry = details.transcript?.find((entry) => entry.kind === "tool_result");
		const text = String(resultEntry?.text);
		expect(text).toContain("short one");
		expect(text).toContain("short two");
		expect(text).toContain("... [truncated]");
		expect(text.length).toBeLessThan(5000);
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
				nextTaskNumber: () => 1,
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
