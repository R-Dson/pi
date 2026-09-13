/**
 * The fixed-height tail window shared by the hidden-thinking preview and the
 * task tool's sub-agent windows: the last PREVIEW_WINDOW_LINES visual lines of
 * a run's text, reserved at full height while the run is live (content
 * bottom-aligned, nothing below reflows) and rendered at natural height once
 * it ends. When the terminal answered the OSC 11 background query, the visible
 * tail fades per word from the thinking gray into the background; without an
 * endpoint the text stays uniformly gray and italic.
 *
 * Extracted from assistant-message.ts when the task tool adopted the same
 * window; both callers must keep the same look.
 */

import type { Component, RgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

/**
 * Lines of tail shown under a preview header; also the height a live block
 * reserves, so streaming never reflows what sits below it.
 */
export const PREVIEW_WINDOW_LINES = 6;

/**
 * Terminal background (OSC 11) for the preview fade; undefined until the
 * terminal answers the startup query (or never, on terminals that ignore it).
 */
let previewFadeBackground: RgbColor | undefined;

/** Interactive startup reports the terminal's actual background color here. */
export function setPreviewFadeBackground(rgb: RgbColor | undefined): void {
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

/** The preview gray as RGB, when the theme defines it as hex. */
function previewGrayRgb(): RgbColor | undefined {
	const value = theme.fgValue("thinkingText");
	return typeof value === "string" ? hexToRgb(value) : undefined;
}

/**
 * Color each word of the visible tail between the preview gray (newest) and
 * the terminal background (oldest). How far the oldest visible word may sink
 * toward the background deepens along two axes: the fill of the reserved
 * window (a lone bottom line is full gray; the fade ramps in as the tail
 * climbs toward the top of the window) and the fold above it (dissolving
 * further toward the background as lines scroll away). Position-keyed per
 * word, so existing words darken continuously as newer text arrives — a fade,
 * not a flip.
 */
export function fadeTailLines(
	lines: string[],
	gray: RgbColor,
	background: RgbColor,
	skippedLines: number,
	windowLines: number,
): string[] {
	const total = lines.reduce((sum, line) => sum + line.length, 0) || 1;
	// Gradient position of the oldest visible word (1 = full gray, 0 = the
	// background), as the product of the two deepening axes above.
	const fillFloor = 1 - (lines.length - 1) / windowLines;
	const foldFloor = lines.length / (lines.length + skippedLines);
	const oldestPosition = fillFloor * foldFloor;
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
				// oldestPosition at the oldest visible word, 1 at the newest.
				const position = oldestPosition + (1 - oldestPosition) * ((offset + token.length / 2) / total);
				const r = Math.round(background.r + (gray.r - background.r) * position);
				const g = Math.round(background.g + (gray.g - background.g) * position);
				const b = Math.round(background.b + (gray.b - background.b) * position);
				offset += token.length;
				return theme.italic(`\x1b[38;2;${r};${g};${b}m${token}\x1b[39m`);
			})
			.join(""),
	);
}

/**
 * Live preview header dots: a breathing ellipsis instead of a static "...".
 * Starts full (the familiar first paint), drains, refills, and holds at full —
 * one frame per 350ms. The frame is a pure function of elapsed wall time, so
 * it advances on every streaming rebuild (per chunk) and never needs its own
 * ticker; a long gap between chunks freezes it like the timer.
 */
const PREVIEW_DOT_FRAME_MS = 350;
const PREVIEW_DOT_FRAMES = [3, 2, 1, 0, 1, 2, 3, 3];

export function animatedPreviewDots(elapsedMs: number): string {
	const phase = Math.floor(Math.max(0, elapsedMs) / PREVIEW_DOT_FRAME_MS) % PREVIEW_DOT_FRAMES.length;
	return ".".repeat(PREVIEW_DOT_FRAMES[phase]).padEnd(3);
}

/**
 * The width-lazy tail-window component. `fade` only takes effect when the
 * terminal reported a background and the theme's gray is a hex value; the
 * non-fade path renders uniformly gray and italic.
 */
export function createPreviewWindow(
	rawText: string,
	options: { fixedHeight: boolean; outputPad: number; fade?: boolean },
): Component {
	const previewText = rawText.replace(/\r\n|\r/g, "\n").replace(/\n+$/, "");
	const gray = previewGrayRgb();
	const useFade = options.fade === true && previewFadeBackground !== undefined && gray !== undefined;
	const styledText = useFade
		? previewText
		: previewText
				.split("\n")
				.map((line) => theme.italic(theme.fg("thinkingText", line)))
				.join("\n");
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render: (width: number) => {
			if (cachedLines === undefined || cachedWidth !== width) {
				const result = truncateToVisualLines(styledText, PREVIEW_WINDOW_LINES, width, options.outputPad);
				let bodyLines = result.visualLines;
				if (useFade && gray && previewFadeBackground) {
					bodyLines = fadeTailLines(
						bodyLines,
						gray,
						previewFadeBackground,
						result.skippedCount,
						PREVIEW_WINDOW_LINES,
					);
				}
				if (options.fixedHeight && bodyLines.length < PREVIEW_WINDOW_LINES) {
					bodyLines = Array.from({ length: PREVIEW_WINDOW_LINES - bodyLines.length }, () => "").concat(bodyLines);
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
	};
}
