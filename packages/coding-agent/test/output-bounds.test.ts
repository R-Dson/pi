import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { boundToolResultText, DEFAULT_MAX_TOOL_OUTPUT_BYTES } from "../src/core/tools/output-bounds.ts";

function makeLines(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `line-${String(i).padStart(4, "0")}`);
}

describe("boundToolResultText", () => {
	it("returns the same content reference when under the threshold", async () => {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: "small output" }];

		const result = await boundToolResultText(content, {
			maxBytes: DEFAULT_MAX_TOOL_OUTPUT_BYTES,
			toolName: "read",
			toolCallId: "call_1",
		});

		expect(result.bounded).toBe(false);
		expect(result.content).toBe(content);
		expect(result.artifactPath).toBeUndefined();
	});

	it("is disabled when maxBytes <= 0", async () => {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: "x".repeat(10000) }];

		for (const maxBytes of [0, -1]) {
			const result = await boundToolResultText(content, { maxBytes, toolName: "big", toolCallId: "call_1" });
			expect(result.bounded).toBe(false);
			expect(result.content).toBe(content);
		}
	});

	it("replaces oversized text with a head+tail excerpt and a marker", async () => {
		const lines = makeLines(200); // "line-0000".."line-0199", 9 bytes per line + separators
		const text = lines.join("\n"); // 1999 bytes total
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];

		const result = await boundToolResultText(content, {
			maxBytes: 1000,
			toolName: "big_output",
			toolCallId: "call_1",
		});

		expect(result.bounded).toBe(true);
		expect(result.content).toHaveLength(1);
		const boundedText = (result.content[0] as TextContent).text;

		// Head keeps ~60% of the 1000-byte budget, aligned to a line boundary (lines 0-59).
		expect(boundedText.startsWith(lines.slice(0, 60).join("\n"))).toBe(true);
		// Tail keeps ~40% of the budget, aligned to a line boundary (lines 160-199).
		expect(boundedText.endsWith(lines.slice(160).join("\n"))).toBe(true);
		// The middle is omitted.
		expect(boundedText).not.toContain("line-0100");

		// Marker reports the tool name, total bytes, and omitted bytes (1999 - 599 - 399).
		expect(boundedText).toContain("big_output");
		expect(boundedText).toContain("1999 bytes");
		expect(boundedText).toContain("1001 bytes omitted");

		// Model-visible text stays near the threshold, not at the original size.
		expect(Buffer.byteLength(boundedText, "utf-8")).toBeLessThan(1500);
	});

	it("passes image content blocks through untouched", async () => {
		const lines = makeLines(200);
		const image: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: lines.join("\n") }, image];

		const result = await boundToolResultText(content, {
			maxBytes: 1000,
			toolName: "big_output",
			toolCallId: "call_1",
		});

		expect(result.bounded).toBe(true);
		expect(result.content).toHaveLength(2);
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[1]).toBe(image);
	});

	describe("artifact spill", () => {
		const tempDirs: string[] = [];

		afterEach(() => {
			while (tempDirs.length > 0) {
				const dir = tempDirs.pop();
				if (dir && existsSync(dir)) {
					rmSync(dir, { recursive: true });
				}
			}
		});

		it("writes the full text to the artifact file and includes its path in the marker", async () => {
			const baseDir = mkdtempSync(join(tmpdir(), "pi-output-bounds-"));
			tempDirs.push(baseDir);
			const artifactsDir = join(baseDir, "artifacts", "session-1");
			const lines = makeLines(200);
			const fullText = lines.join("\n");
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: fullText }];

			const result = await boundToolResultText(content, {
				maxBytes: 1000,
				toolName: "big_output",
				toolCallId: "call with/special:id",
				artifactsDir,
			});

			expect(result.bounded).toBe(true);
			const artifactPath = join(artifactsDir, "call_with_special_id.txt");
			expect(result.artifactPath).toBe(artifactPath);
			expect(existsSync(artifactPath)).toBe(true);
			// The artifact holds the complete original output, not the excerpt.
			expect(readFileSync(artifactPath, "utf-8")).toBe(fullText);

			const boundedText = (result.content[0] as TextContent).text;
			expect(boundedText).toContain(`Full output: ${artifactPath}`);
			expect(boundedText).not.toContain("in-memory session");
		});

		it("bounds without an artifact path when no artifactsDir is given", async () => {
			const lines = makeLines(200);
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: lines.join("\n") }];

			const result = await boundToolResultText(content, {
				maxBytes: 1000,
				toolName: "big_output",
				toolCallId: "call_1",
			});

			expect(result.bounded).toBe(true);
			expect(result.artifactPath).toBeUndefined();
			const boundedText = (result.content[0] as TextContent).text;
			expect(boundedText).toContain("1001 bytes omitted");
			expect(boundedText).toContain("Full output not saved (in-memory session)");
			expect(boundedText).not.toContain("Full output:");
		});
	});
});
