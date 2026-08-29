import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

const THINKING_PREVIEW_MAX_CHARS = 120;

function hasVisibleThinking(content: AssistantMessage["content"][number]): boolean {
	return content.type === "thinking" && content.thinking.trim().length > 0;
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
 * Collapse a thinking run into a single-line TAIL preview (whitespace
 * flattened, ellipsis at the start when truncated): the end of the trace is
 * what the model is thinking right now, the opening words rarely are.
 */
function thinkingPreviewText(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	const head = truncateToWidth(collapsed, THINKING_PREVIEW_MAX_CHARS, "");
	return collapsed.length > head.length ? `…${collapsed.slice(-(head.length - 1))}` : collapsed;
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
	/** When hidden thinking was first seen while streaming; used for the finished duration marker. */
	private thinkingStartedAt: number | undefined;
	/** Frozen thinking duration; undefined while the newest run is still streaming or when it was never streamed live. */
	private thinkingDurationMs: number | undefined;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
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
				this.thinkingStartedAt ??= Date.now();
				if (newestRunEnded) {
					// Freeze at the first non-thinking block after the newest run:
					// post-thinking streaming is not thinking time.
					this.thinkingDurationMs ??= Math.max(0, Date.now() - this.thinkingStartedAt);
				} else if (this.thinkingDurationMs !== undefined) {
					// A newer run reopened the clock: the timer and the eventual
					// marker measure THIS run, not the span since the first.
					this.thinkingStartedAt = Date.now();
					this.thinkingDurationMs = undefined;
				}
			} else if (this.thinkingStartedAt !== undefined) {
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

					// Live preview only while the newest run is still the trailing
					// streaming content; once non-thinking blocks follow it (or the
					// message finished), collapse to the one-line marker. The timer
					// recomputes on every message_update (token) render, which flows
					// continuously while thinking; no separate tick needed.
					const runEnded = message.content.slice(i + 1).some(isStreamedNonThinking);
					let line: string;
					if (this.isStreaming && !runEnded) {
						const elapsedS =
							this.thinkingStartedAt !== undefined
								? Math.max(0, (Date.now() - this.thinkingStartedAt) / 1000)
								: 0;
						line = `${this.hiddenThinkingLabel} ${elapsedS.toFixed(1)}s ${thinkingPreviewText(thinkingBlocks.join("\n\n"))}`;
					} else {
						line =
							this.thinkingDurationMs !== undefined
								? `Thought for ${Math.max(1, Math.round(this.thinkingDurationMs / 1000))}s`
								: this.hiddenThinkingLabel;
					}
					const expandHint = `${theme.fg("muted", "(")}${keyHint("app.thinking.toggle", "to expand thinking")}${theme.fg("muted", ")")}`;
					this.contentContainer.addChild(
						new Text(`${theme.italic(theme.fg("thinkingText", line))} ${expandHint}`, this.outputPad, 0),
					);
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
