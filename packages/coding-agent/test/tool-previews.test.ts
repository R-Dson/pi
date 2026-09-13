/**
 * Counts-first tool summaries and the ticking running row: read shows its
 * line count when collapsed, grep leads with the match count, and any tool
 * row ticks "Elapsed Xs" while it runs with no result yet.
 */

import type { TUI } from "@earendil-works/pi-tui";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createAllToolDefinitions, type ToolName } from "../src/core/tools/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { stubTaskToolOptions } from "./utilities.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

const toolDefinitions = createAllToolDefinitions("/repo", { task: stubTaskToolOptions() });

function createComponent(toolName: ToolName, args: Record<string, unknown> = {}): ToolExecutionComponent {
	return new ToolExecutionComponent(toolName, "call_1", args, {}, toolDefinitions[toolName], createFakeTui(), "/repo");
}

function renderText(component: ToolExecutionComponent, width = 100): string {
	return stripAnsi(component.render(width).join("\n"));
}

describe("tool preview summaries", () => {
	beforeAll(() => {
		initTheme("dark");
		// Expand hints resolve keys through the global manager.
		setKeybindings(new KeybindingsManager());
	});
	afterAll(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("read collapsed result shows a line-count summary with the expand hint", () => {
		const component = createComponent("read", { file_path: "/repo/main.ts" });
		component.updateResult({
			content: [{ type: "text", text: "line one\nline two\nline three" }],
			isError: false,
		});

		const rendered = renderText(component);

		expect(rendered).toContain("3 lines");
		expect(rendered).toContain("ctrl+o");
	});

	test("an empty read counts zero lines", () => {
		const component = createComponent("read", { file_path: "/repo/empty.txt" });
		component.updateResult({ content: [{ type: "text", text: "" }], isError: false });

		expect(renderText(component)).toContain("0 lines");
	});

	test("an image-only read stays silent instead of counting zero lines", () => {
		const component = createComponent("read", { file_path: "/repo/shot.png" });
		component.updateResult({
			content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
			isError: false,
		});

		expect(renderText(component)).not.toContain("0 lines");
	});

	test("grep results carrying a matchCount in details use it over line counting", () => {
		const component = createComponent("grep");
		component.updateResult({
			content: [{ type: "text", text: "src/a.ts:1:first match" }],
			details: { matchCount: 5 },
			isError: false,
		});

		expect(renderText(component)).toContain("5 matches");
	});

	test("grep count excludes the trailing notices block", () => {
		const component = createComponent("grep");
		component.updateResult({
			content: [
				{
					type: "text",
					text: "src/a.ts:1:first match\nsrc/b.ts:9:second match\n\n[100 matches limit reached. Use limit=200 for more]",
				},
			],
			isError: false,
		});

		const rendered = renderText(component);
		expect(rendered).toContain("2 matches");
		expect(rendered).not.toContain("4 matches");
	});

	test("grep error results carry no match count", () => {
		const component = createComponent("grep");
		component.updateResult({
			content: [{ type: "text", text: "Path not found: /repo/missing" }],
			isError: true,
		});

		expect(renderText(component)).not.toContain("matches");
	});

	test("grep collapsed result leads with the match count", () => {
		const component = createComponent("grep");
		component.updateResult({
			content: [{ type: "text", text: "src/a.ts:1:first match\nsrc/b.ts:9:second match" }],
			isError: false,
		});

		const rendered = renderText(component);

		const countIndex = rendered.indexOf("2 matches");
		const matchIndex = rendered.indexOf("first match");
		expect(countIndex).toBeGreaterThanOrEqual(0);
		expect(matchIndex).toBeGreaterThan(countIndex);
	});

	test("grep no-match output is not counted as a match", () => {
		const component = createComponent("grep");
		component.updateResult({
			content: [{ type: "text", text: "No matches found" }],
			isError: false,
		});

		expect(renderText(component)).not.toContain("1 matches");
	});

	test("a running tool row ticks elapsed seconds until the result arrives", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		try {
			const component = createComponent("grep");
			component.markExecutionStarted();

			expect(renderText(component)).toContain("Elapsed 0s");

			vi.advanceTimersByTime(2500);
			expect(renderText(component)).toContain("Elapsed 2s");

			component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
			expect(renderText(component)).not.toContain("Elapsed");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("destroy clears the ticker without needing a result", () => {
		vi.useFakeTimers();
		try {
			const component = createComponent("grep");
			component.markExecutionStarted();
			expect(vi.getTimerCount()).toBe(1);

			component.destroy();

			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("the elapsed ticker hands over to partial results without duplicating", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		try {
			const component = createComponent("bash");
			component.markExecutionStarted();
			vi.advanceTimersByTime(1500);

			component.updateResult({ content: [{ type: "text", text: "partial output" }], isError: false }, true);
			// The generic ticker stops; bash's own elapsed ticker takes over.
			expect(vi.getTimerCount()).toBe(1);
			const rendered = renderText(component);
			expect(rendered).toContain("partial output");
			expect((rendered.match(/Elapsed/g) ?? []).length).toBeLessThanOrEqual(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("task shows the prompt preview and truncates long ones on one line", () => {
		const short = createComponent("task", { prompt: "summarize the spec" });
		expect(renderText(short)).toContain("task");
		expect(renderText(short)).toContain("summarize the spec");

		const long = createComponent("task", {
			prompt:
				"review the entire repository starting with the root manifests, then every package under packages/, and report inconsistencies with our conventions",
		});
		const rendered = renderText(long);
		expect(rendered).toContain("...");
		expect(rendered).not.toContain("with our conventions");
	});

	test("task results stream partials and show sub-agent token usage", () => {
		const component = createComponent("task", { prompt: "do research" });
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "partial findings" }], isError: false }, true);
		expect(renderText(component)).toContain("partial findings");

		component.updateResult({
			content: [{ type: "text", text: "final findings" }],
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			isError: false,
		});
		const rendered = renderText(component);
		expect(rendered).toContain("final findings");
		expect(rendered).toContain("15 sub-agent tokens");
	});

	test("task partials render a live Task window with the activity line", () => {
		vi.useFakeTimers();
		try {
			const component = createComponent("task", { prompt: "do research" });
			component.markExecutionStarted();

			component.updateResult(
				{ content: [], details: { task: 2, activity: "bash: ls -la /repo" }, isError: false },
				true,
			);
			const rendered = renderText(component);
			// Thinking-style header: task number, animated dots, running timer.
			expect(rendered).toContain("Task 2");
			expect(rendered).toMatch(/Task 2\.{3} 0\.0s/);
			expect(rendered).toContain("bash: ls -la /repo");
			// No "running" prefix: between tool calls the line truthfully reads as the
			// most recent action, not a claim about what is in flight.
			expect(rendered).not.toContain("running");
			expect(rendered).not.toContain("Elapsed");

			// The header owns a 1s re-render interval while live (the generic row
			// ticker stops at the first partial), cleared on the final result.
			expect(vi.getTimerCount()).toBe(1);
			component.updateResult(
				{ content: [{ type: "text", text: "done" }], details: { task: 2, durationMs: 1000 }, isError: false },
				false,
			);
			expect(vi.getTimerCount()).toBe(0);
			expect(renderText(component)).toContain("Task 2 1.0s");
			component.destroy();
		} finally {
			vi.useRealTimers();
		}
	});

	test("a history-reloaded task row keeps its header from persisted details", () => {
		// No partials ever arrive for a reloaded row: number and duration come
		// from the persisted details alone.
		const component = createComponent("task", { prompt: "do research" });
		component.updateResult({
			content: [{ type: "text", text: Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n") }],
			details: { task: 7, durationMs: 4200, totalCalls: 3, transcript: [] },
			isError: false,
		});
		const rendered = renderText(component);
		expect(rendered).toContain("Task 7 4.2s · 3 tool calls");
		expect(rendered).toContain("line 8");
		expect(rendered).not.toContain("line 0");
	});

	test("task results show the Task header and counts collapsed, the conversation expanded", () => {
		const transcript = [
			{ kind: "user", text: "review the repo" },
			{ kind: "tool_call", tool: "bash", args: "ls -la /repo" },
			{ kind: "tool_result", tool: "bash", size: "1.2 KB", text: "README.md\nsrc/", isError: false },
			{ kind: "tool_call", tool: "read", args: "/repo/README.md" },
			{ kind: "tool_result", tool: "read", isError: true, size: "400 B", text: "not found" },
		];
		const component = createComponent("task", { prompt: "do research" });
		component.updateResult({
			content: [{ type: "text", text: "final findings" }],
			details: { task: 3, transcript, totalCalls: 2 },
			isError: false,
		});

		const collapsed = renderText(component);
		expect(collapsed).toContain("Task 3 · 2 tool calls");
		expect(collapsed).toContain("ctrl+o");
		expect(collapsed).toContain("final findings");
		expect(collapsed).not.toContain("ls -la /repo");

		component.setExpanded(true);
		const expanded = renderText(component);
		// The whole conversation: the prompt it got, the calls it made, and the
		// results it saw - not just call names.
		expect(expanded).toContain("> review the repo");
		expect(expanded).toContain("bash");
		expect(expanded).toContain("ls -la /repo");
		expect(expanded).toContain("  README.md");
		// Error entries keep their size marker alongside the error marker.
		expect(expanded).toContain("(error, 400 B)");
	});

	test("a capped transcript marks dropped entries and long text keeps one hint, folded to the tail", () => {
		const transcript = [
			{ kind: "user", text: "do research" },
			{ kind: "tool_call", tool: "bash", args: "latest call" },
			{ kind: "tool_result", tool: "bash", text: "ok", isError: false },
		];
		const longText = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
		const component = createComponent("task", { prompt: "do research" });
		component.updateResult({
			content: [{ type: "text", text: longText }],
			details: { task: 1, transcript, totalCalls: 205, dropped: 42 },
			isError: false,
		});

		const collapsed = renderText(component);
		// Exactly one expand hint; the window folds to the tail like reasoning.
		expect((collapsed.match(/ctrl\+o/g) ?? []).length).toBe(1);
		expect(collapsed).toContain("line 29");
		expect(collapsed).not.toContain("line 0");

		component.setExpanded(true);
		const expanded = renderText(component);
		expect(expanded).toContain("... (42 earlier entries)");
		expect(expanded).toContain("latest call");
		expect(expanded).toContain("line 0");
	});
});
