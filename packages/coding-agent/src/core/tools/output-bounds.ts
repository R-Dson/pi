/**
 * Loop-level bounding for tool result text sent to the model.
 *
 * Safety net for tools without their own truncation (extension/MCP tools).
 * Per-tool truncation (read/grep/bash, see truncate.ts) stays primary; this
 * bound only applies above a generous byte threshold. When it triggers, the
 * model sees a head+tail excerpt plus a marker reporting the omitted bytes
 * and the artifact path, and the full text is spilled to an artifact file
 * (persisted sessions only).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";

/** Default threshold: 200KB of UTF-8 text content. */
export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 200 * 1024;

/** Share of the byte budget kept as the head excerpt (the tail keeps the rest). */
const HEAD_BUDGET_SHARE = 0.6;

export interface BoundToolResultOptions {
	/** Max total UTF-8 bytes of text content. Values <= 0 disable bounding. */
	maxBytes: number;
	/** Tool name, reported in the truncation marker. */
	toolName: string;
	/** Tool call id, used as the artifact file name. */
	toolCallId: string;
	/**
	 * Directory to spill the full text into as `<artifactsDir>/<sanitized toolCallId>.txt`.
	 * Omit for in-memory sessions: bounding still applies, no artifact is written.
	 */
	artifactsDir?: string;
}

export interface BoundToolResult {
	content: (TextContent | ImageContent)[];
	/** Whether the content was over the threshold and got replaced. */
	bounded: boolean;
	/** Path of the written artifact file, when a spill succeeded. */
	artifactPath?: string;
}

/** When aligning an excerpt to a line boundary, search at most this many characters. */
const LINE_ALIGN_WINDOW = 200;

/** Take the first maxBytes bytes at most, cut back to a UTF-8 character boundary. */
function sliceUtf8FromStart(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf-8");
	if (buf.length <= maxBytes) {
		return text;
	}
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) {
		end--;
	}
	return buf.slice(0, end).toString("utf-8");
}

/** Take the last maxBytes bytes at most, advanced forward to a UTF-8 character boundary. */
function sliceUtf8FromEnd(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf-8");
	if (buf.length <= maxBytes) {
		return text;
	}
	let start = buf.length - maxBytes;
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}
	return buf.slice(start).toString("utf-8");
}

/** Trim a partial trailing line from a head excerpt when one is nearby. */
function alignHeadToLineBoundary(excerpt: string): string {
	const lastNewline = excerpt.lastIndexOf("\n");
	if (lastNewline === -1 || excerpt.length - lastNewline > LINE_ALIGN_WINDOW) {
		return excerpt;
	}
	return excerpt.slice(0, lastNewline);
}

/** Trim a partial leading line from a tail excerpt when one is nearby. */
function alignTailToLineBoundary(excerpt: string): string {
	const firstNewline = excerpt.indexOf("\n");
	if (firstNewline === -1 || firstNewline > LINE_ALIGN_WINDOW) {
		return excerpt;
	}
	return excerpt.slice(firstNewline + 1);
}

function formatMarker(
	toolName: string,
	totalBytes: number,
	shownBytes: number,
	artifactPath: string | undefined,
): string {
	const omittedBytes = totalBytes - shownBytes;
	const location = artifactPath ? `Full output: ${artifactPath}` : "Full output not saved (in-memory session)";
	return (
		`[${toolName} output truncated: showing ${shownBytes} of ${totalBytes} bytes ` +
		`(${omittedBytes} bytes omitted). ${location}]`
	);
}

/**
 * Bound the text content of a tool result.
 *
 * Sums the UTF-8 bytes of all text blocks. At or under the threshold the input
 * content array is returned unchanged (same reference, no clone). Above it, the
 * text blocks are replaced by a single head+tail excerpt with a truncation
 * marker; non-text blocks (images etc.) pass through untouched in place.
 */
export async function boundToolResultText(
	content: (TextContent | ImageContent)[],
	options: BoundToolResultOptions,
): Promise<BoundToolResult> {
	if (options.maxBytes <= 0) {
		return { content, bounded: false };
	}

	let totalBytes = 0;
	for (const block of content) {
		if (block.type === "text") {
			totalBytes += Buffer.byteLength(block.text, "utf-8");
		}
	}
	if (totalBytes <= options.maxBytes) {
		return { content, bounded: false };
	}

	const fullText = content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");

	const headBudget = Math.floor(options.maxBytes * HEAD_BUDGET_SHARE);
	const tailBudget = options.maxBytes - headBudget;
	const head = alignHeadToLineBoundary(sliceUtf8FromStart(fullText, headBudget));
	const tail = alignTailToLineBoundary(sliceUtf8FromEnd(fullText, tailBudget));
	const shownBytes = Buffer.byteLength(head, "utf-8") + Buffer.byteLength(tail, "utf-8");

	let artifactPath: string | undefined;
	if (options.artifactsDir) {
		const safeId = options.toolCallId.replace(/[^A-Za-z0-9._-]/g, "_");
		const candidate = join(options.artifactsDir, `${safeId}.txt`);
		try {
			await mkdir(options.artifactsDir, { recursive: true });
			await writeFile(candidate, fullText, "utf-8");
			artifactPath = candidate;
		} catch {
			// Bounding still applies; the marker just omits the artifact path.
		}
	}

	const boundedText = `${head}\n\n${formatMarker(options.toolName, totalBytes, shownBytes, artifactPath)}\n\n${tail}`;

	const newContent: (TextContent | ImageContent)[] = [];
	let replacedText = false;
	for (const block of content) {
		if (block.type === "text" && !replacedText) {
			newContent.push({ type: "text", text: boundedText });
			replacedText = true;
		} else if (block.type !== "text") {
			newContent.push(block);
		}
		// Text blocks after the first are folded into the excerpt above.
	}

	return { content: newContent, bounded: true, ...(artifactPath ? { artifactPath } : {}) };
}
