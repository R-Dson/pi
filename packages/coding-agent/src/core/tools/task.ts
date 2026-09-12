import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	Agent,
	type AgentMessage,
	type AgentTool,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Model, TextContent, Usage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { taskRenderers } from "./renderers/task.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const taskSchema = Type.Object({
	prompt: Type.String({
		description:
			"The task for the sub-agent. Must be self-contained: the sub-agent starts with an empty conversation, does not see this session's history, and only knows what you write here.",
	}),
	systemPrompt: Type.Optional(
		Type.String({
			description:
				"Operating instructions for the sub-agent (role, constraints, output format). Its entire briefing comes from you.",
		}),
	),
});

export const taskToolSystemPromptContribution = {
	snippet: "Spawn a sub-agent to run a task",
	guidelines: [
		"Give sub-agent tasks complete, self-contained instructions - sub-agents start with an empty conversation and cannot see this session's history",
	],
} as const;

export type TaskToolInput = Static<typeof taskSchema>;

/**
 * FIFO limiter for concurrently running sub-agents. Acquires beyond `max` queue
 * until a slot frees. Owned by the session so the limit survives tool-registry rebuilds.
 */
export class SubAgentLimiter {
	private _active = 0;
	private _queue: Array<() => void> = [];

	async acquire(max: number): Promise<() => void> {
		if (this._active >= max) {
			// release() hands the slot to the next waiter without decrementing, so the
			// count never dips and a concurrent acquire cannot double-book the slot in
			// the microtask gap before the waiter resumes.
			await new Promise<void>((resolve) => {
				this._queue.push(resolve);
			});
		} else {
			this._active++;
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this._queue.shift();
			if (next) {
				next();
			} else {
				this._active--;
			}
		};
	}
}

export interface TaskToolOptions {
	/** Max simultaneously running sub-agents (the `maxSubAgents` setting). */
	getMaxSubAgents(): number;
	/** Stream function for sub-agent completions. Pass the session's, unwrapped. */
	getStreamFn(): StreamFn;
	/** Current model, inherited by sub-agents. */
	getModel(): Model<any> | undefined;
	/** Current thinking level, inherited by sub-agents. */
	getThinkingLevel(): ThinkingLevel | undefined;
	/** Main agent's active tools; `task` is filtered out so sub-agents stay one layer deep. */
	getTools(): AgentTool[];
	/** Session's tool hooks, so sub-agent tool calls get the same permission gate and output bounding. */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	/** Session-owned limiter instance. */
	limiter: SubAgentLimiter;
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function sumUsage(messages: AgentMessage[]): Usage | undefined {
	let usage: Usage | undefined;
	for (const message of messages) {
		if (message.role !== "assistant" || !message.usage) continue;
		const add = message.usage;
		usage = {
			input: (usage?.input ?? 0) + add.input,
			output: (usage?.output ?? 0) + add.output,
			cacheRead: (usage?.cacheRead ?? 0) + add.cacheRead,
			cacheWrite: (usage?.cacheWrite ?? 0) + add.cacheWrite,
			...(usage?.cacheWrite1h !== undefined || add.cacheWrite1h !== undefined
				? { cacheWrite1h: (usage?.cacheWrite1h ?? 0) + (add.cacheWrite1h ?? 0) }
				: {}),
			...(usage?.reasoning !== undefined || add.reasoning !== undefined
				? { reasoning: (usage?.reasoning ?? 0) + (add.reasoning ?? 0) }
				: {}),
			totalTokens: (usage?.totalTokens ?? 0) + add.totalTokens,
			cost: {
				input: (usage?.cost.input ?? 0) + add.cost.input,
				output: (usage?.cost.output ?? 0) + add.cost.output,
				cacheRead: (usage?.cost.cacheRead ?? 0) + add.cost.cacheRead,
				cacheWrite: (usage?.cost.cacheWrite ?? 0) + add.cost.cacheWrite,
				total: (usage?.cost.total ?? 0) + add.cost.total,
			},
		};
	}
	return usage;
}

export function createTaskToolDefinition(options: TaskToolOptions): ToolDefinition<typeof taskSchema> {
	return {
		name: "task",
		label: "task",
		description:
			"Spawn a sub-agent to run a task in a fresh conversation. The sub-agent runs with your currently active tools (except spawning its own sub-agents), the same model, and only the briefing you provide. Its final response is returned as the tool result. Because it cannot see this session, include every detail it needs in the prompt.",
		promptSnippet: taskToolSystemPromptContribution.snippet,
		promptGuidelines: [...taskToolSystemPromptContribution.guidelines],
		parameters: taskSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			const model = options.getModel();
			if (!model) {
				throw new Error("No model available for sub-agent");
			}

			// An aborted spawn that is still queued wakes when a slot frees (the abort
			// also signals sibling task tools, so slots drain promptly) and throws at
			// the aborted check below.
			const release = await options.limiter.acquire(options.getMaxSubAgents());
			try {
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				const subAgent = new Agent({
					initialState: {
						systemPrompt: params.systemPrompt ?? "",
						model,
						thinkingLevel: options.getThinkingLevel(),
						tools: options.getTools().filter((tool) => tool.name !== "task"),
					},
					streamFn: options.getStreamFn(),
					beforeToolCall: options.beforeToolCall,
					afterToolCall: options.afterToolCall,
				});

				const unsubscribe = subAgent.subscribe((event) => {
					if (event.type === "message_update" || event.type === "message_end") {
						const text = assistantText(event.message);
						if (text) {
							onUpdate?.({ content: [{ type: "text", text }], details: undefined });
						}
					}
				});
				const onAbort = () => subAgent.abort();
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					await subAgent.prompt(params.prompt);
				} finally {
					signal?.removeEventListener("abort", onAbort);
					unsubscribe();
				}

				const messages = subAgent.state.messages;
				const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
				if (lastAssistant?.errorMessage) {
					throw new Error(`Sub-agent failed: ${lastAssistant.errorMessage}`);
				}
				const output = lastAssistant ? assistantText(lastAssistant) : "";
				if (!output) {
					throw new Error("Sub-agent finished without producing text");
				}
				const usage = sumUsage(messages);
				return {
					content: [{ type: "text", text: output }],
					details: undefined,
					...(usage ? { usage } : {}),
				};
			} finally {
				release();
			}
		},
		...taskRenderers,
	};
}

export function createTaskTool(options: TaskToolOptions): AgentTool<typeof taskSchema> {
	return wrapToolDefinition(createTaskToolDefinition(options));
}
