/**
 * Presentation for the task tool: each sub-agent renders as a preview window
 * (see preview-window.ts) with a "Task N" header — the same fixed-height live
 * tail, fade, and frozen-duration treatment the hidden-thinking preview uses,
 * so sub-agent activity and reasoning read identically in the transcript.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `task.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { animatedPreviewDots, createPreviewWindow } from "../../../modes/interactive/components/preview-window.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../extensions/types.ts";
import { getTextOutput, str } from "../render-utils.ts";
import type { TaskToolDetails, TaskTranscriptEntry } from "../task.ts";

/** Stop the live-header interval (final result, error, or component teardown path). */
function clearRendererInterval(state: { interval?: ReturnType<typeof setInterval> }): void {
	if (state.interval) {
		clearInterval(state.interval);
		state.interval = undefined;
	}
}

function formatTaskCall(args: { prompt?: string } | undefined, theme: Theme): string {
	const prompt = (str(args?.prompt) ?? "").replace(/\s+/g, " ").trim();
	const preview = prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt;
	return `${theme.fg("toolTitle", theme.bold("task"))} ${theme.fg("toolOutput", preview)}`;
}

function formatTranscriptEntry(entry: TaskTranscriptEntry, theme: Theme): string {
	if (entry.kind === "user") {
		return theme.fg("muted", `> ${entry.text}`);
	}
	if (entry.kind === "thinking") {
		return theme.fg("muted", `· ${entry.text}`);
	}
	if (entry.kind === "assistant") {
		return theme.fg("toolOutput", entry.text);
	}
	if (entry.kind === "tool_call") {
		const call = [theme.fg("toolTitle", entry.tool), entry.args ? theme.fg("toolOutput", entry.args) : ""]
			.filter((part) => part !== "")
			.join(" ");
		return call;
	}
	const markers: string[] = [];
	if (entry.isError) markers.push(theme.fg("error", "error"));
	if (entry.size) markers.push(theme.fg("muted", entry.size));
	const status = markers.length > 0 ? theme.fg("muted", ` (${markers.join(", ")})`) : "";
	const header = `${theme.fg("toolTitle", entry.tool)}${status}`;
	const body = entry.text
		? `\n${entry.text
				.split("\n")
				.map((line) => theme.fg("muted", `  ${line}`))
				.join("\n")}`
		: "";
	return `${header}${body}`;
}

function formatTaskResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		usage?: Usage;
		details?: TaskToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext<{ interval?: ReturnType<typeof setInterval> }>,
): Component {
	const details = result.details;
	const output = getTextOutput(result, context.showImages).trim();
	const state = context.state ?? {};

	// Error results carry no details (execute throws): plain text preview.
	if (!details?.task) {
		const text = new Text("", 0, 0);
		const usageLine = result.usage ? `\n${theme.fg("muted", `(${result.usage.totalTokens} sub-agent tokens)`)}` : "";
		text.setText(output ? `${theme.fg("toolOutput", output)}${usageLine}` : usageLine.trim());
		clearRendererInterval(state);
		return text;
	}

	const container = new Container();
	const label = `Task ${details.task}`;

	if (options.isPartial) {
		// Live: thinking-style header with animated dots and a running timer over
		// the fixed-height window; the window never grows mid-run. The sub-agent's
		// own tool calls can run silent for a long time, so the header owns a 1s
		// re-render interval (the generic row ticker stops at the first partial);
		// tool-execution.ts's destroy() clears state.interval with the row.
		state.interval ??= setInterval(() => context.invalidate(), 1000);
		const elapsedMs =
			context.executionStartedAt !== undefined ? Math.max(0, Date.now() - context.executionStartedAt) : 0;
		const header = `${label}${animatedPreviewDots(elapsedMs)} ${(elapsedMs / 1000).toFixed(1)}s`;
		container.addChild(new Text(theme.italic(theme.fg("thinkingText", header)), 0, 0));
		const liveText = [details.activity, output].filter((part) => part !== "").join("\n");
		container.addChild(createPreviewWindow(liveText, { fixedHeight: true, outputPad: 0, fade: true }));
		return container;
	}

	clearRendererInterval(state);
	// Final: duration persisted with the result (so resumed rows keep it), the
	// tool-call count, and one expand hint when there is more to see (transcript
	// or folded tail - the check is logical-line conservative because the render
	// function cannot know the wrap width).
	const calls = details.totalCalls ?? 0;
	const folded = calls > 0 || output.includes("\n");
	const hint =
		!options.expanded && folded ? ` ${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}` : "";
	const duration =
		details.durationMs !== undefined ? ` ${theme.fg("muted", `${(details.durationMs / 1000).toFixed(1)}s`)}` : "";
	const countPart = calls > 0 ? theme.fg("muted", ` · ${calls} tool call${calls === 1 ? "" : "s"}`) : "";
	container.addChild(new Text(`${theme.italic(theme.fg("thinkingText", label))}${duration}${countPart}${hint}`, 0, 0));

	if (options.expanded) {
		if (details.dropped && details.dropped > 0) {
			container.addChild(
				new Text(
					theme.fg("muted", `... (${details.dropped} earlier entr${details.dropped === 1 ? "y" : "ies"})`),
					0,
					0,
				),
			);
		}
		if (details.transcript && details.transcript.length > 0) {
			container.addChild(
				new Text(details.transcript.map((entry) => formatTranscriptEntry(entry, theme)).join("\n"), 0, 0),
			);
		}
		if (output) {
			container.addChild(
				new Text(
					output
						.split("\n")
						.map((line) => theme.fg("toolOutput", line))
						.join("\n"),
					0,
					0,
				),
			);
		}
	} else if (output) {
		container.addChild(createPreviewWindow(output, { fixedHeight: false, outputPad: 0, fade: true }));
	}

	if (result.usage) {
		container.addChild(new Text(theme.fg("muted", `(${result.usage.totalTokens} sub-agent tokens)`), 0, 0));
	}
	return container;
}

export const taskRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatTaskCall(args as { prompt?: string } | undefined, theme));
		return text;
	},
	renderResult(result, options, theme, context) {
		return formatTaskResult(result as any, options, theme, context as any);
	},
};
