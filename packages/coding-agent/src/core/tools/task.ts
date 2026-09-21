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
import { formatSize, truncateLine } from "./truncate.ts";

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

/** One entry of the sub-agent's conversation, for the task row's expanded view. */
export type TaskTranscriptEntry =
	| { kind: "user"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "tool_call"; tool: string; args?: string }
	| { kind: "tool_result"; tool: string; isError?: boolean; size?: string; text: string };

/**
 * Renderer payload for the task tool. Never reaches the model: `activity` rides
 * partial updates while the sub-agent runs; `transcript`/`totalCalls` ride the
 * final result. Usage stays on `AgentToolResult.usage`.
 */
export interface TaskToolDetails {
	/** Session-scoped spawn number, for the "Task N" window header. */
	task?: number;
	/** Wall time the sub-agent ran (spawn to completion), for the frozen header duration. */
	durationMs?: number;
	/** The sub-agent's current tool call, shown live in the collapsed row. */
	activity?: string;
	/** The sub-agent's conversation (last MAX_TRANSCRIPT_ENTRIES), excerpted per message. */
	transcript?: TaskTranscriptEntry[];
	/** Total tool calls across the whole run. */
	totalCalls?: number;
	/** Transcript entries dropped by the cap (oldest first). */
	dropped?: number;
}

const MAX_TRANSCRIPT_ENTRIES = 500;
const EXCERPT_HEAD_LINES = 8;
const EXCERPT_TAIL_LINES = 8;
/** Per-line excerpt cap: a single huge line (minified output) must not survive the line-count bound. */
const EXCERPT_MAX_LINE_CHARS = 2000;
const ACTIVITY_ARG_LIMIT = 60;
const CALL_ARG_LIMIT = 160;
const ELLIPSIS = "...";

/** Default sub-agent deadline (the `taskTimeoutMs` setting, 10 minutes; 0 disables). */
export const DEFAULT_TASK_TIMEOUT_MS = 600_000;

/**
 * Ceiling for `taskTimeoutMs`: `setTimeout` silently coerces larger values to a
 * 1ms deadline, so both the setting getter and the tool's deadline setup reject
 * them instead (the agent loop's `timeoutMs` range check).
 */
export const MAX_TASK_TIMEOUT_MS = 2_147_483_647;

/**
 * Salient argument keys, tried in order before falling back to the first string
 * value - the model's JSON key order is arbitrary, so `grep {path, pattern}`
 * must still preview the pattern.
 */
const PREFERRED_ARG_KEYS = ["command", "path", "pattern", "prompt", "url", "query"] as const;

/** The argument's salient string value, whitespace-collapsed. */
function argPreview(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) {
		return undefined;
	}
	const record = args as Record<string, unknown>;
	const preferred = PREFERRED_ARG_KEYS.map((key) => record[key]).find(
		(value): value is string => typeof value === "string",
	);
	const first = preferred ?? Object.values(record).find((value): value is string => typeof value === "string");
	return first?.replace(/\s+/g, " ").trim();
}

function truncatePreview(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - ELLIPSIS.length)}${ELLIPSIS}` : text;
}

/** Head+tail excerpt with an omission marker, the same shape the tool rows use. */
function excerptLines(text: string): string {
	const lines = text.replace(/\r/g, "").split("\n");
	// A trailing newline is a terminator, not a line (parity with truncate.ts counting).
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	const bounded = lines.map((line) => truncateLine(line, EXCERPT_MAX_LINE_CHARS).text);
	if (bounded.length <= EXCERPT_HEAD_LINES + EXCERPT_TAIL_LINES) {
		return bounded.join("\n");
	}
	const omitted = bounded.length - EXCERPT_HEAD_LINES - EXCERPT_TAIL_LINES;
	return `${bounded.slice(0, EXCERPT_HEAD_LINES).join("\n")}\n... (${omitted} lines omitted)\n${bounded
		.slice(-EXCERPT_TAIL_LINES)
		.join("\n")}`;
}

/** The sub-agent's conversation as bounded transcript entries, newest kept past the cap. */
function buildTranscript(messages: AgentMessage[]): {
	transcript: TaskTranscriptEntry[];
	totalCalls: number;
	dropped: number;
} {
	const entries: TaskTranscriptEntry[] = [];
	let totalCalls = 0;
	for (const message of messages) {
		if (message.role === "user") {
			const content = message.content;
			const text =
				typeof content === "string"
					? content
					: content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
			entries.push({ kind: "user", text: excerptLines(text) });
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "thinking" && block.thinking.trim()) {
					entries.push({ kind: "thinking", text: excerptLines(block.thinking) });
				} else if (block.type === "text" && block.text.trim()) {
					entries.push({ kind: "assistant", text: excerptLines(block.text) });
				} else if (block.type === "toolCall") {
					const preview = argPreview(block.arguments);
					entries.push({
						kind: "tool_call",
						tool: block.name,
						...(preview ? { args: truncatePreview(preview, CALL_ARG_LIMIT) } : {}),
					});
				}
			}
		} else if (message.role === "toolResult") {
			totalCalls++;
			const resultText = message.content
				.map((block) => (block.type === "text" ? block.text : `[image: ${block.mimeType ?? "unknown"}]`))
				.join("\n");
			entries.push({
				kind: "tool_result",
				tool: message.toolName,
				...(message.isError ? { isError: true } : {}),
				...(resultText.length > 0 ? { size: formatSize(Buffer.byteLength(resultText, "utf-8")) } : {}),
				text: excerptLines(resultText),
			});
		}
	}
	const dropped = Math.max(0, entries.length - MAX_TRANSCRIPT_ENTRIES);
	return { transcript: entries.slice(-MAX_TRANSCRIPT_ENTRIES), totalCalls, dropped };
}

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
	/**
	 * Wall-clock deadline per sub-agent run in ms (the `taskTimeoutMs` setting;
	 * 0 disables). A hung provider stream ends in a timeout error instead of
	 * holding a limiter slot forever. Read per spawn, so settings changes apply
	 * without a runtime rebuild.
	 */
	getTaskTimeoutMs?(): number;
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
	/** Session-scoped spawn counter, for stable "Task N" numbering across resume. */
	nextTaskNumber(): number;
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

export function createTaskToolDefinition(
	options: TaskToolOptions,
): ToolDefinition<typeof taskSchema, TaskToolDetails | undefined> {
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

				// Per-spawn deadline, the agent loop's timer discipline: an unref'd
				// timer cleared on settle, and a race for streams that never settle
				// on their own. Whichever settles first decides the reported error:
				// the deadline rejects with the timeout message, a user abort or a
				// failed run settles with its own error.
				const timeoutMs = options.getTaskTimeoutMs?.() ?? DEFAULT_TASK_TIMEOUT_MS;
				// The agent loop's invalid-timeout contract: a value above 2^31-1
				// would be silently coerced by setTimeout to a 1ms deadline, while
				// NaN and negatives compare false against the > 0 deadline guard
				// and silently disable it, so reject the whole range here too.
				if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TASK_TIMEOUT_MS) {
					throw new RangeError(
						"taskTimeoutMs is out of range: must be a finite non-negative number not exceeding 2^31-1",
					);
				}
				const deadlineController = timeoutMs > 0 ? new AbortController() : undefined;
				let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
				if (deadlineController) {
					deadlineTimer = setTimeout(() => deadlineController.abort(), timeoutMs);
					deadlineTimer.unref?.();
				}
				const timeoutMessage = `Sub-agent timed out after ${timeoutMs}ms`;

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

				// Live progress rides partial updates; the conversation transcript is
				// built once from the sub-agent's messages after the run. Both renderer-only.
				const taskNumber = options.nextTaskNumber();
				const runStartedAt = Date.now();
				let activity: string | undefined;
				let streamedText = "";
				const emitPartial = () => {
					if (!activity && !streamedText) {
						return;
					}
					onUpdate?.({
						content: [{ type: "text", text: streamedText }],
						details: { task: taskNumber, ...(activity ? { activity } : {}) },
					});
				};

				const unsubscribe = subAgent.subscribe((event) => {
					if (event.type === "tool_execution_start") {
						const preview = argPreview(event.args);
						activity = preview
							? `${event.toolName}: ${truncatePreview(preview, ACTIVITY_ARG_LIMIT)}`
							: event.toolName;
						emitPartial();
					} else if (event.type === "message_update" || event.type === "message_end") {
						const text = assistantText(event.message);
						if (text) {
							// Assistant text replaces the activity line; the transcript keeps the history.
							activity = undefined;
							streamedText = text;
							emitPartial();
						}
					}
				});
				// The deadline aborts the sub-agent through the same listener as a user
				// abort; the race exists for streams that never settle on their own.
				const runSignal =
					signal && deadlineController
						? AbortSignal.any([signal, deadlineController.signal])
						: (signal ?? deadlineController?.signal);
				const onAbort = () => subAgent.abort();
				runSignal?.addEventListener("abort", onAbort, { once: true });
				const deadline = deadlineController
					? new Promise<never>((_resolve, reject) => {
							deadlineController.signal.addEventListener(
								"abort",
								() => {
									reject(new Error(timeoutMessage));
								},
								{ once: true },
							);
						})
					: undefined;
				try {
					const run = subAgent.prompt(params.prompt);
					await (deadline ? Promise.race([run, deadline]) : run);
				} finally {
					if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
					runSignal?.removeEventListener("abort", onAbort);
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
				const { transcript, totalCalls, dropped } = buildTranscript(messages);
				return {
					content: [{ type: "text", text: output }],
					// The window header needs the task number even when the sub-agent
					// made no tool calls (no transcript to show in that case); the
					// duration persists so resumed rows keep their frozen header.
					details: {
						task: taskNumber,
						durationMs: Math.max(0, Date.now() - runStartedAt),
						...(totalCalls > 0 ? { transcript, totalCalls, dropped } : {}),
					},
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
