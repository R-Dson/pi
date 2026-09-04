import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, type RgbColor, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Lines of thinking tail shown under the preview header; also the height the
 * live block reserves, so streaming never reflows what sits below it.
 */
const THINKING_PREVIEW_LINES = 6;

/**
 * Terminal background (OSC 11) for the preview fade; undefined until the
 * terminal answers the startup query (or never, on terminals that ignore it).
 */
let previewFadeBackground: RgbColor | undefined;

/** Interactive startup reports the terminal's actual background color here. */
export function setThinkingPreviewFadeBackground(rgb: RgbColor | undefined): void {
	previewFadeBackground = rgb;
}

function hexToRgb(hex: string): RgbColor | undefined {
	if (!/^#[0-9a-f]{6}$/i.test(hex)) {
		return undefined;
	}
	return {
		r: parseInt(hex.slice(1, 3), 16),
		g: parseInt(hex.slice(3, 5), 16),
		b: parseInt(hex.slice(5, 7), 16),
	};
}

/** The thinking gray as RGB, when the theme defines it as hex. */
function thinkingGrayRgb(): RgbColor | undefined {
	const value = theme.fgValue("thinkingText");
	return typeof value === "string" ? hexToRgb(value) : undefined;
}

/**
 * Color each word of the visible tail between the terminal background (oldest,
 * dissolving into it exactly) and the thinking gray (newest). Position-keyed
 * per word, so existing words darken continuously as newer text arrives —
 * a fade, not a flip.
 */
function fadeTailLines(lines: string[], gray: RgbColor, background: RgbColor): string[] {
	const total = lines.reduce((sum, line) => sum + line.length, 0) || 1;
	let offset = 0;
	return lines.map((line) =>
		line
			.split(/(\s+)/)
			.filter((token) => token.length > 0)
			.map((token) => {
				if (/^\s+$/.test(token)) {
					offset += token.length;
					return token;
				}
				// 0 at the oldest visible word, 1 at the newest.
				const position = (offset + token.length / 2) / total;
				const r = Math.round(background.r + (gray.r - background.r) * position);
				const g = Math.round(background.g + (gray.g - background.g) * position);
				const b = Math.round(background.b + (gray.b - background.b) * position);
				offset += token.length;
				return theme.italic(`\x1b[38;2;${r};${g};${b}m${token}\x1b[39m`);
			})
			.join(""),
	);
}

function hasVisibleThinking(content: AssistantMessage["content"][number]): boolean {
	return content.type === "thinking" && content.thinking.trim().length > 0;
}

/**
 * Count maximal runs of consecutive visible thinking blocks: the clock
 * measures a run, and providers may deliver several adjacent thinking blocks
 * as one visual run. Invisible (whitespace-only) blocks render as part of the
 * surrounding run, so they keep the run open.
 */
function countThinkingRuns(content: AssistantMessage["content"]): number {
	let runs = 0;
	let inRun = false;
	for (const block of content) {
		if (block.type !== "thinking") {
			inRun = false;
			continue;
		}
		if (hasVisibleThinking(block)) {
			if (!inRun) runs++;
			inRun = true;
		}
	}
	return runs;
}

/**
 * Non-thinking content that streaming produces once a thinking run has ended:
 * visible text or a tool call.
 */
function isStreamedNonThinking(content: AssistantMessage["content"][number]): boolean {
	return (content.type === "text" && content.text.trim().length > 0) || content.type === "toolCall";
}

/**
 * Whether streaming has moved past the newest visible thinking run (visible
 * text or a tool call follows it), i.e. that run has ended.
 */
function hasStreamedContentAfterNewestThinking(content: AssistantMessage["content"]): boolean {
	let newestThinking = -1;
	for (let i = 0; i < content.length; i++) {
		if (hasVisibleThinking(content[i])) {
			newestThinking = i;
		}
	}
	return newestThinking !== -1 && content.slice(newestThinking + 1).some(isStreamedNonThinking);
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	/** When the newest thinking run was first seen while streaming; run-count growth resets it. */
	private thinkingStartedAt: number | undefined;
	/** Frozen thinking duration; undefined while the newest run is still streaming or when it was never streamed live. */
	private thinkingDurationMs: number | undefined;
	/** Visible thinking runs at the last update; growth restarts the clock (a new run began). */
	private thinkingRunCount = 0;
	/** Set when this message continues after a tool call: its opening thinking run renders headerless. */
	private readonly continuesAfterToolCall: boolean;
	/**
	 * Provider/model key of the previous assistant message, when the caller
	 * tracks one: a differing model renders a muted model-id line above the
	 * content, so mixed-model (handoff) sessions show who said what. Undefined
	 * renders no marker — the single-model common case stays byte-identical.
	 */
	private readonly previousModel: string | undefined;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		/** This message continues an assistant turn whose previous message ended at a tool call. */
		continuesAfterToolCall = false,
		/** Provider/model of the previous assistant message; omit to never mark. */
		previousModel?: string,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.continuesAfterToolCall = continuesAfterToolCall;
		this.previousModel = previousModel;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	/**
	 * Append the width-lazy tail block for a thinking run's text: the last
	 * THINKING_PREVIEW_LINES visual lines; folded-away content above is
	 * implied by the fade, no marker line. While the run is live the block
	 * reserves the full height — content top-aligned, blank rows below — so
	 * the block never grows mid-stream and nothing below it moves; once the
	 * run has ended it renders at its natural height, so short finished runs
	 * carry no blank rows. Fade path: when the terminal
	 * answered the OSC 11 background
	 * query and the theme's gray is a hex value, the visible tail gets per-word
	 * colors interpolated between the background and the gray — the oldest
	 * visible word dissolves into the background exactly. Position-keyed per
	 * word, so words darken continuously as newer text arrives. Without an
	 * endpoint the block stays uniformly gray, styled before wrapping.
	 */
	private addThinkingTailBlock(rawText: string, fixedHeight: boolean): void {
		const previewText = rawText.replace(/\r\n|\r/g, "\n").replace(/\n+$/, "");
		const fadeGray = thinkingGrayRgb();
		const useFade = previewFadeBackground !== undefined && fadeGray !== undefined;
		const styledText = useFade
			? previewText
			: previewText
					.split("\n")
					.map((line) => theme.italic(theme.fg("thinkingText", line)))
					.join("\n");
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		this.contentContainer.addChild({
			render: (width: number) => {
				if (cachedLines === undefined || cachedWidth !== width) {
					const result = truncateToVisualLines(styledText, THINKING_PREVIEW_LINES, width, this.outputPad);
					let bodyLines = result.visualLines;
					if (useFade && fadeGray && previewFadeBackground) {
						bodyLines = fadeTailLines(bodyLines, fadeGray, previewFadeBackground);
					}
					if (fixedHeight && bodyLines.length < THINKING_PREVIEW_LINES) {
						bodyLines = bodyLines.concat(
							Array.from({ length: THINKING_PREVIEW_LINES - bodyLines.length }, () => ""),
						);
					}
					cachedLines = bodyLines;
					cachedWidth = width;
				}
				return cachedLines ?? [];
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		});
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		const wasStreaming = this.isStreaming;
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Track hidden-thinking timing for the finished "Thought for Ns" marker.
		// Duration is only known for messages streamed through this component;
		// history reloads fall back to the static label.
		const hasThinking = message.content.some((c) => c.type === "thinking" && c.thinking.trim());
		if (hasThinking) {
			// The newest run has ended once non-thinking content streams after it.
			const newestRunEnded = hasStreamedContentAfterNewestThinking(message.content);
			if (isStreaming) {
				const runs = countThinkingRuns(message.content);
				if (this.thinkingRunCount > 0 && runs > this.thinkingRunCount) {
					// New thinking runs arrived since the last update, possibly
					// batched with the text that ends them: the clock measures
					// the newest run, so restart it.
					this.thinkingStartedAt = Date.now();
					this.thinkingDurationMs = undefined;
				}
				this.thinkingStartedAt ??= Date.now();
				if (newestRunEnded) {
					// Freeze at the first non-thinking block after the newest run:
					// post-thinking streaming is not thinking time.
					this.thinkingDurationMs ??= Math.max(0, Date.now() - this.thinkingStartedAt);
				}
				this.thinkingRunCount = runs;
			} else if (this.thinkingStartedAt !== undefined) {
				// Runs that arrive without streaming carry no clock of their own;
				// a duration frozen here measures from the last streamed run's
				// start, so treat it as a lower bound.
				if (newestRunEnded) {
					this.thinkingDurationMs ??= Math.max(0, Date.now() - this.thinkingStartedAt);
				} else if (wasStreaming || this.thinkingDurationMs === undefined) {
					// Finished while the newest run was still the trailing content
					// (including a final run that arrived un-streamed): that run
					// spanned to the end, so measure to it.
					this.thinkingDurationMs = Math.max(0, Date.now() - this.thinkingStartedAt);
				}
			}
		}

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || hasVisibleThinking(c),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));

			// Model attribution for mixed-model sessions (#135): a muted id line
			// when this message's model differs from the previous assistant's.
			// Gated on visible content so an empty stub never renders a lone marker.
			const modelKey = `${message.provider}/${message.model}`;
			if (this.previousModel !== undefined && this.previousModel !== modelKey) {
				this.contentContainer.addChild(new Text(theme.fg("muted", message.model), this.outputPad, 0));
			}
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Older runs never render when hidden; only the newest run becomes the preview.
					const hasThinkingAfter = message.content.slice(i + 1).some(hasVisibleThinking);
					if (hasThinkingAfter) {
						continue;
					}

					// While the newest run is still the trailing streaming content,
					// a header with a live timer leads; once non-thinking blocks
					// follow it (or the message finished), the header becomes the
					// frozen marker. Both states keep the tail block below the
					// header: completed lines never change as tokens arrive, so the
					// block reads as steady text with only the newest line moving —
					// the same trick the bash preview uses.
					const runEnder = message.content.slice(i + 1).find(isStreamedNonThinking);
					const runEnded = runEnder !== undefined;
					// A run ended by a tool call renders only its tail: the next
					// assistant message (the continuation after the tool result)
					// carries the next header, so suppressing this one avoids a
					// header per tool-call interruption.
					const runOpensMessage = message.content.slice(0, i).every((c) => c.type === "thinking");
					const suppressHeader = runEnder?.type === "toolCall" || (this.continuesAfterToolCall && runOpensMessage);
					if (!suppressHeader) {
						const expandHint = `${theme.fg("muted", "(")}${keyHint("app.thinking.toggle", "to expand thinking")}${theme.fg("muted", ")")}`;
						let header: string;
						if (this.isStreaming && !runEnded) {
							const elapsedS =
								this.thinkingStartedAt !== undefined
									? Math.max(0, (Date.now() - this.thinkingStartedAt) / 1000)
									: 0;
							header = `${this.hiddenThinkingLabel} ${elapsedS.toFixed(1)}s`;
						} else {
							header =
								this.thinkingDurationMs !== undefined
									? `Thought for ${Math.max(1, Math.round(this.thinkingDurationMs / 1000))}s`
									: this.hiddenThinkingLabel;
						}
						this.contentContainer.addChild(
							new Text(`${theme.italic(theme.fg("thinkingText", header))} ${expandHint}`, this.outputPad, 0),
						);
					}
					this.addThinkingTailBlock(thinkingBlocks.join("\n\n"), this.isStreaming && !runEnded);
				} else {
					// Render each run of thinking blocks as one Markdown section.
					this.contentContainer.addChild(
						new Markdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad,
							0,
							this.markdownTheme,
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						),
					);
				}
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
