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

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

const toolDefinitions = createAllToolDefinitions("/repo");

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
});
