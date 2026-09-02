import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	AssistantMessageComponent,
	setThinkingPreviewFadeBackground,
} from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

/**
 * Lines of the rendered tail block: everything after the header line, minus
 * any named trailing block. The header is styled truecolor in truecolor
 * environments, so fade assertions must not match it.
 */
function tailBlockLines(raw: string, excludedTexts: string[] = []): string[] {
	const lines = raw.split("\n");
	const headerIndex = lines.findIndex((line) => line.includes("Thinking..."));
	return lines
		.slice(headerIndex === -1 ? 0 : headerIndex + 1)
		.filter((line) => !excludedTexts.some((text) => line.includes(text)));
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops with neutral truncation wording", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("Thinking...");
		expect(rendered).toContain("Response was truncated before completion.");
	});

	test("coalesces adjacent thinking blocks into one hidden thinking label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/Thinking\.\.\./g)).toHaveLength(1);
		expect(rendered).toContain("answer");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("chains Markdown transformers in registration order", () => {
		initTheme("dark");
		const calls: string[] = [];
		const message = createAssistantMessage([{ type: "text", text: "The result is $x^2$." }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "assistant", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The result is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("identifies partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				streamingStates.push(context.isStreaming);
				return context.isStreaming ? markdown : `${markdown} transformed`;
			},
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("reapplies Markdown transformers when available width changes", () => {
		initTheme("dark");
		const availableWidths: number[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "answer" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					availableWidths.push(context.availableWidth);
					return `${markdown} (${context.availableWidth})`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("answer (78)");
		component.render(80);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("answer (58)");
		expect(availableWidths).toEqual([78, 58]);
	});

	test("continues the Markdown transformer chain when a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("transforms text and thinking Markdown without mutating the original message", () => {
		initTheme("dark");
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, { messageType }) => {
				return `${messageType}:${markdown}`;
			},
		]);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("hello"))).toBe(true);
	});

	describe("hidden thinking preview", () => {
		beforeAll(() => {
			// The marker's expand hint resolves keys through the global manager.
			setKeybindings(new KeybindingsManager());
		});
		afterAll(() => {
			// Restore a fresh manager so later suites do not inherit this one.
			setKeybindings(new KeybindingsManager());
			// No terminal background endpoint leaks into later suites.
			setThinkingPreviewFadeBackground(undefined);
		});

		test("words fade from thinking gray to the terminal background across the tail", () => {
			initTheme("dark");

			// Dark theme's thinking gray is #808080; a black terminal background
			// makes the gradient run from near-black (oldest) to near-gray (newest).
			setThinkingPreviewFadeBackground({ r: 0, g: 0, b: 0 });
			const lines = Array.from({ length: 8 }, (_, i) => `reasoning step ${i + 1} of the plan`);
			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(createAssistantMessage([{ type: "thinking", thinking: lines.join("\n") }]), true);
			const raw = component.render(100).join("\n");

			const wordColors = [
				...tailBlockLines(raw)
					.join("\n")
					.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g),
			].map((m) => ({
				r: Number(m[1]),
				g: Number(m[2]),
				b: Number(m[3]),
			}));
			expect(wordColors.length).toBeGreaterThan(4);
			// Oldest visible word sits near the background, newest near the gray.
			const oldest = wordColors[0];
			const newest = wordColors[wordColors.length - 1];
			expect(oldest.r).toBeLessThanOrEqual(32);
			expect(newest.r).toBeGreaterThanOrEqual(96);
			// Never darkens toward the newest word (adjacent words may round equal).
			for (let i = 1; i < wordColors.length; i++) {
				expect(wordColors[i].r).toBeGreaterThanOrEqual(wordColors[i - 1].r);
			}
			// Content survives the per-word coloring intact.
			expect(stripAnsi(raw)).toContain("reasoning step 8 of the plan");
		});

		test("without a terminal background the preview stays uniform", () => {
			initTheme("dark");

			setThinkingPreviewFadeBackground(undefined);
			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(
				createAssistantMessage([{ type: "thinking", thinking: "reasoning without an endpoint" }]),
				true,
			);
			const raw = component.render(100).join("\n");

			// The uniform path wraps each tail line in a single sequence; the fade
			// path wraps each word, so more sequences than lines means per-word
			// coloring leaked in without a terminal background.
			const tail = tailBlockLines(raw);
			const sequences = tail.join("\n").match(/\x1b\[38;2;/g)?.length ?? 0;
			expect(sequences).toBeLessThanOrEqual(tail.filter((line) => stripAnsi(line).trim() !== "").length);
			expect(stripAnsi(raw)).toContain("reasoning without an endpoint");
		});

		test("shows a live preview of the newest thinking run while streaming", () => {
			initTheme("dark");

			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(
				createAssistantMessage([{ type: "thinking", thinking: "\n\nConsidering the first approach" }]),
				true,
			);
			const rendered = stripAnsi(component.render(100).join("\n"));

			expect(rendered).toContain("Thinking...");
			expect(rendered).toContain("Considering the first approach");
		});

		test("follows the tail of a long thinking run with a live timer", () => {
			initTheme("dark");

			const head = "parsing the input token by token and considering ".repeat(20);
			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(
				createAssistantMessage([{ type: "thinking", thinking: `${head}now validating the final branch` }]),
				true,
			);
			const rendered = stripAnsi(component.render(100).join("\n"));

			// The head is far beyond the preview window, so only tail-following
			// can surface the final branch sentence.
			expect(rendered).toMatch(/Thinking\.\.\. \d+\.\ds/);
			expect(rendered).toContain("now validating the final branch");
		});

		test("the live preview is a multi-line block showing the tail with newlines preserved", () => {
			initTheme("dark");

			const lines = Array.from({ length: 12 }, (_, i) => `reasoning step number ${i + 1} of the plan`);
			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(createAssistantMessage([{ type: "thinking", thinking: lines.join("\n") }]), true);
			const rendered = stripAnsi(component.render(100).join("\n"));

			expect(rendered).toContain("Thinking...");
			// The block keeps the last lines whole; earlier ones fold away with
			// no marker line — the fade itself signals older content above.
			expect(rendered).toContain("reasoning step number 12 of the plan");
			expect(rendered).toContain("reasoning step number 11 of the plan");
			expect(rendered).not.toContain("reasoning step number 1 of the plan");
		});

		test("replaces the preview when a newer thinking run arrives", () => {
			initTheme("dark");

			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(
				createAssistantMessage([
					{ type: "thinking", thinking: "first thought about parsing" },
					{ type: "text", text: "partial answer" },
				]),
				true,
			);
			// Text already follows the run, so it renders collapsed, not previewed.
			expect(stripAnsi(component.render(100).join("\n"))).toContain("Thought for");

			component.updateContent(
				createAssistantMessage([
					{ type: "thinking", thinking: "first thought about parsing" },
					{ type: "text", text: "partial answer" },
					{ type: "thinking", thinking: "now verifying the result" },
				]),
				true,
			);
			const rendered = stripAnsi(component.render(100).join("\n"));

			expect(rendered).toContain("now verifying the result");
			expect(rendered).not.toContain("first thought about parsing");
			expect(rendered).toContain("partial answer");
		});

		test("renders nothing for hidden thinking when the message has none", () => {
			initTheme("dark");

			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(createAssistantMessage([{ type: "text", text: "hello" }]), true);
			const rendered = stripAnsi(component.render(100).join("\n"));

			expect(rendered).toContain("hello");
			expect(rendered).not.toContain("Thinking...");
			expect(rendered).not.toContain("Thought for");
		});

		test("the live timer measures the newest run, not the span since the first", () => {
			initTheme("dark");
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			try {
				const component = new AssistantMessageComponent(undefined, true);
				// Run one streams for 5s, then text arrives and freezes its marker.
				component.updateContent(
					createAssistantMessage([{ type: "thinking", thinking: "first thought about parsing" }]),
					true,
				);
				vi.advanceTimersByTime(5000);
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "first thought about parsing" },
						{ type: "text", text: "partial answer" },
					]),
					true,
				);
				// Five seconds later a second run starts: its preview timer must
				// count from this run's start, not from the session's first.
				vi.advanceTimersByTime(5000);
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "first thought about parsing" },
						{ type: "text", text: "partial answer" },
						{ type: "thinking", thinking: "now verifying the result" },
					]),
					true,
				);
				const rendered = stripAnsi(component.render(100).join("\n"));

				expect(rendered).toContain("Thinking... 0.0s");
				expect(rendered).not.toContain("Thinking... 10.0s");
			} finally {
				vi.useRealTimers();
			}
		});

		test("a burst update carrying an entire second run and its end still restarts the clock", () => {
			initTheme("dark");
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			try {
				const component = new AssistantMessageComponent(undefined, true);
				component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "run one streamed" }]), true);
				vi.advanceTimersByTime(3000);
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "run one streamed" },
						{ type: "text", text: "partial answer" },
					]),
					true,
				);
				// The next single update delivers the entire second run plus the
				// text that ends it (batched provider chunk): the marker must
				// measure the second run, not keep the first run's 3s.
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "run one streamed" },
						{ type: "text", text: "partial answer" },
						{ type: "thinking", thinking: "run two arrived whole" },
						{ type: "text", text: "final answer" },
					]),
					true,
				);
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "run one streamed" },
						{ type: "text", text: "partial answer" },
						{ type: "thinking", thinking: "run two arrived whole" },
						{ type: "text", text: "final answer" },
					]),
					false,
				);
				const rendered = stripAnsi(component.render(100).join("\n"));

				expect(rendered).toContain("Thought for 1s");
				expect(rendered).not.toContain("Thought for 3s");
			} finally {
				vi.useRealTimers();
			}
		});

		test("wide characters wrap within the render width and surrogates stay whole", () => {
			initTheme("dark");

			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(
				// Narrow head, wide tail, astral emoji: the block must wrap by
				// display columns (no line wider than the render width) and the
				// surrogate pair must never be split at a boundary.
				createAssistantMessage([{ type: "thinking", thinking: `${"x".repeat(150)}${"中".repeat(59)}\u{1F600}` }]),
				true,
			);
			const lines = component.render(200).map(stripAnsi);

			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(200);
			}
			expect(lines.some((line) => line.includes("😀"))).toBe(true);
		});

		test("a whitespace-only thinking block between visible blocks does not restart the timer", () => {
			initTheme("dark");
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			try {
				const component = new AssistantMessageComponent(undefined, true);
				component.updateContent(
					createAssistantMessage([{ type: "thinking", thinking: "real reasoning starts here" }]),
					true,
				);
				vi.advanceTimersByTime(4000);
				// An invisible block between visible ones: the render merges all
				// three into one preview, so the run count must not grow either.
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "real reasoning starts here" },
						{ type: "thinking", thinking: "   " },
						{ type: "thinking", thinking: "and continues" },
					]),
					true,
				);
				const rendered = stripAnsi(component.render(100).join("\n"));

				expect(rendered).toContain("Thinking... 4.0s");
				expect(rendered).not.toContain("Thinking... 0.0s");
			} finally {
				vi.useRealTimers();
			}
		});

		test("folds to a one-line duration marker when the message finishes", () => {
			initTheme("dark");
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			try {
				const component = new AssistantMessageComponent(undefined, true);
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "first thought about parsing" },
						{ type: "text", text: "partial answer" },
					]),
					true,
				);
				vi.advanceTimersByTime(3200);
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "first thought about parsing" },
						{ type: "text", text: "partial answer" },
						{ type: "thinking", thinking: "now verifying the result" },
					]),
					false,
				);
				const rendered = stripAnsi(component.render(100).join("\n"));

				expect(rendered).toContain("Thought for 3s");
				expect(rendered).toContain("ctrl+t to expand");
				// Older runs are gone; the newest run's tail stays under the marker.
				expect(rendered).not.toContain("first thought about parsing");
				expect(rendered).toContain("now verifying the result");
				expect(rendered.match(/Thought for/g)).toHaveLength(1);
			} finally {
				vi.useRealTimers();
			}
		});

		test("the finished block keeps the fade into the terminal background", () => {
			initTheme("dark");

			setThinkingPreviewFadeBackground({ r: 0, g: 0, b: 0 });
			const lines = Array.from({ length: 8 }, (_, i) => `reasoning step ${i + 1} of the plan`);
			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(
				createAssistantMessage([
					{ type: "thinking", thinking: lines.join("\n") },
					{ type: "text", text: "the answer" },
				]),
				false,
			);
			const raw = component.render(100).join("\n");

			expect(stripAnsi(raw)).toContain("Thinking...");
			// Tail block only: the header above and the answer block below are
			// styled independently of the fade.
			const wordColors = [
				...tailBlockLines(raw, ["the answer"])
					.join("\n")
					.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g),
			].map((m) => Number(m[1]));
			expect(wordColors.length).toBeGreaterThan(4);
			expect(wordColors[0]).toBeLessThanOrEqual(32);
			expect(wordColors[wordColors.length - 1]).toBeGreaterThanOrEqual(96);
		});

		test("a rebuilt message shows the label with the tail block, not just the label", () => {
			initTheme("dark");

			const lines = Array.from({ length: 8 }, (_, i) => `reasoning step ${i + 1} of the plan`);
			const component = new AssistantMessageComponent(
				createAssistantMessage([
					{ type: "thinking", thinking: lines.join("\n") },
					{ type: "text", text: "done" },
				]),
				true,
			);
			const rendered = stripAnsi(component.render(100).join("\n"));

			expect(rendered).toContain("Thinking...");
			expect(rendered).toContain("reasoning step 8 of the plan");
			expect(rendered).not.toContain("reasoning step 1 of the plan");
			expect(rendered).toContain("done");
		});

		test("freezes the duration and collapses the preview once text streams after the newest run", () => {
			initTheme("dark");
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			try {
				const component = new AssistantMessageComponent(undefined, true);
				component.updateContent(
					createAssistantMessage([{ type: "thinking", thinking: "pondering the approach" }]),
					true,
				);
				let rendered = stripAnsi(component.render(100).join("\n"));
				expect(rendered).toContain("Thinking...");
				expect(rendered).toContain("pondering the approach");

				// Text starts streaming after the thinking run: collapse immediately.
				vi.advanceTimersByTime(1500);
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "pondering the approach" },
						{ type: "text", text: "par" },
					]),
					true,
				);
				rendered = stripAnsi(component.render(100).join("\n"));
				expect(rendered).toContain("Thought for 2s");
				expect(rendered).not.toContain("Thinking...");
				// The tail block stays under the marker once the run ended.
				expect(rendered).toContain("pondering the approach");
				expect(rendered).toContain("par");

				// The text-streaming window is not thinking time.
				vi.advanceTimersByTime(8000);
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "pondering the approach" },
						{ type: "text", text: "partial answer" },
					]),
					true,
				);
				rendered = stripAnsi(component.render(100).join("\n"));
				expect(rendered).toContain("Thought for 2s");
				expect(rendered).toContain("partial answer");

				// Finishing the message keeps the frozen duration.
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "pondering the approach" },
						{ type: "text", text: "partial answer" },
					]),
					false,
				);
				rendered = stripAnsi(component.render(100).join("\n"));
				expect(rendered).toContain("Thought for 2s");
				expect(rendered.match(/Thought for/g)).toHaveLength(1);
			} finally {
				vi.useRealTimers();
			}
		});

		test("collapses the preview once a tool call streams after the newest run", () => {
			initTheme("dark");
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			try {
				const component = new AssistantMessageComponent(undefined, true);
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "planning the edit" },
						{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
					]),
					true,
				);
				const rendered = stripAnsi(component.render(100).join("\n"));

				// A run ended by a tool call keeps only its tail: the next
				// assistant message's run carries the next header.
				expect(rendered).not.toContain("Thought for");
				expect(rendered).not.toContain("Thinking...");
				expect(rendered).not.toContain("ctrl+t");
				expect(rendered).toContain("planning the edit");
			} finally {
				vi.useRealTimers();
			}
		});

		test("a continuation message after a tool call opens its thinking headerless", () => {
			initTheme("dark");

			const component = new AssistantMessageComponent(undefined, true, undefined, "Thinking...", 1, [], true);
			component.updateContent(
				createAssistantMessage([
					{ type: "thinking", thinking: "confirmed the intermediate result" },
					{ type: "text", text: "the answer" },
				]),
				false,
			);
			const rendered = stripAnsi(component.render(100).join("\n"));

			// No header, no expand hint: only the tail, then the answer text.
			expect(rendered).not.toContain("Thought for");
			expect(rendered).not.toContain("Thinking...");
			expect(rendered).not.toContain("ctrl+t");
			expect(rendered).toContain("confirmed the intermediate result");
			expect(rendered).toContain("the answer");
		});

		test("a run ended by text keeps its header even with a tool call later", () => {
			initTheme("dark");

			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(
				createAssistantMessage([
					{ type: "thinking", thinking: "planning the edit" },
					{ type: "text", text: "partial answer" },
					{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
				]),
				false,
			);
			const rendered = stripAnsi(component.render(100).join("\n"));

			// Never streamed live, so the header is the static label — the pin is
			// that a header exists at all (not suppressed by the trailing tool call).
			expect(rendered).toContain("Thinking...");
			expect(rendered).toContain("ctrl+t");
			expect(rendered).toContain("planning the edit");
			expect(rendered).toContain("partial answer");
		});

		test("falls back to the static label for finished messages that were never streamed", () => {
			initTheme("dark");

			const component = new AssistantMessageComponent(
				createAssistantMessage([
					{ type: "thinking", thinking: "reloaded reasoning" },
					{ type: "text", text: "answer" },
				]),
				true,
			);
			const rendered = stripAnsi(component.render(100).join("\n"));

			expect(rendered).toContain("Thinking...");
			expect(rendered).toContain("reloaded reasoning");
		});

		test("updates the preview in place as the newest run grows", () => {
			initTheme("dark");

			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "start" }]), true);
			expect(stripAnsi(component.render(100).join("\n"))).toContain("start");

			component.updateContent(
				createAssistantMessage([{ type: "thinking", thinking: "start and then continued reasoning" }]),
				true,
			);
			const rendered = stripAnsi(component.render(100).join("\n"));

			expect(rendered).toContain("start and then continued reasoning");
			expect(rendered.match(/Thinking\.\.\./g)).toHaveLength(1);
		});

		test("the live preview reserves its full height from the first line", () => {
			initTheme("dark");

			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "first line" }]), true);
			let lines = component.render(100).map(stripAnsi);
			let headerIndex = lines.findIndex((line) => line.includes("Thinking..."));
			// The block is a fixed THINKING_PREVIEW_LINES rows: content top-aligned,
			// blank rows below — the block never grows as tokens arrive.
			expect(lines.slice(headerIndex + 1)).toHaveLength(6);
			expect(lines[headerIndex + 1]).toContain("first line");
			expect(lines.slice(headerIndex + 2).every((line) => line.trim() === "")).toBe(true);
			const height = lines.length;

			component.updateContent(
				createAssistantMessage([{ type: "thinking", thinking: "first line\nsecond line\nthird line" }]),
				true,
			);
			lines = component.render(100).map(stripAnsi);
			headerIndex = lines.findIndex((line) => line.includes("Thinking..."));
			// New lines fill the reserved rows; the total height never changed, so
			// nothing below the block reflowed while the run streamed.
			expect(lines).toHaveLength(height);
			expect(lines.slice(headerIndex + 1)).toHaveLength(6);
			expect(lines[headerIndex + 1]).toContain("first line");
			expect(lines[headerIndex + 2]).toContain("second line");
			expect(lines[headerIndex + 3]).toContain("third line");
			expect(lines.slice(headerIndex + 4).every((line) => line.trim() === "")).toBe(true);
		});

		test("the block shrinks to its natural height once the run ends", () => {
			initTheme("dark");
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			try {
				const component = new AssistantMessageComponent(undefined, true);
				component.updateContent(
					createAssistantMessage([{ type: "thinking", thinking: "short run line one\nshort run line two" }]),
					true,
				);
				const first = component.render(100).map(stripAnsi);
				const headerIndex = first.findIndex((line) => line.includes("Thinking..."));
				// Live: the reserved block pads two content rows up to six.
				expect(first.slice(headerIndex + 1)).toHaveLength(6);

				vi.advanceTimersByTime(2100);
				component.updateContent(
					createAssistantMessage([
						{ type: "thinking", thinking: "short run line one\nshort run line two" },
						{ type: "text", text: "the answer" },
					]),
					true,
				);
				const lines = component.render(100).map(stripAnsi);
				const markerIndex = lines.findIndex((line) => line.includes("Thought for 2s"));
				// Ended: natural height — the two content rows, the section spacer,
				// then the answer; no blank padding survives into the transcript.
				expect(markerIndex).toBeGreaterThan(-1);
				expect(lines[markerIndex + 1]).toContain("short run line one");
				expect(lines[markerIndex + 2]).toContain("short run line two");
				expect(lines[markerIndex + 3]).toBe("");
				expect(lines[markerIndex + 4]).toContain("the answer");
				expect(lines).toHaveLength(markerIndex + 5);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("model marker (#135)", () => {
		test("shows the model id when the model differs from the previous assistant message", () => {
			initTheme("dark");

			const component = new AssistantMessageComponent(
				undefined,
				false,
				getMarkdownTheme(),
				"Thinking...",
				1,
				[],
				false,
				"google/gemini-2.5-pro",
			);
			component.updateContent(createAssistantMessage([{ type: "text", text: "hello" }]));

			const lines = component.render(100).map(stripAnsi);
			expect(lines.some((line) => line.trim() === "gpt-4o-mini")).toBe(true);
		});

		test("renders no marker when the model is unchanged", () => {
			initTheme("dark");

			const component = new AssistantMessageComponent(
				undefined,
				false,
				getMarkdownTheme(),
				"Thinking...",
				1,
				[],
				false,
				"openai/gpt-4o-mini",
			);
			component.updateContent(createAssistantMessage([{ type: "text", text: "hello" }]));

			const lines = component.render(100).map(stripAnsi);
			expect(lines.some((line) => line.trim() === "gpt-4o-mini")).toBe(false);
		});

		test("renders no marker without a previous model (first message, existing call sites)", () => {
			initTheme("dark");

			const component = new AssistantMessageComponent(undefined, false);
			component.updateContent(createAssistantMessage([{ type: "text", text: "hello" }]));

			const lines = component.render(100).map(stripAnsi);
			expect(lines.some((line) => line.trim() === "gpt-4o-mini")).toBe(false);
		});
	});
});
