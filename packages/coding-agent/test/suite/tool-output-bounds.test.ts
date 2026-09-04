import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const bigLines = Array.from({ length: 30 * 1024 }, (_, i) => `payload-line-${i}`);
const bigOutput = ["HEAD-START", ...bigLines, "TAIL-END"].join("\n");

const bigOutputTool: AgentTool = {
	name: "big_output",
	label: "Big output",
	description: "Returns a large output",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [{ type: "text", text: bigOutput }],
		details: { origin: "test" },
	}),
};

const smallOutput = "a compact answer";
const smallOutputTool: AgentTool = {
	name: "small_output",
	label: "Small output",
	description: "Returns a small output",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [{ type: "text", text: smallOutput }],
		details: undefined,
	}),
};

function getToolResultText(harness: Harness): string {
	const toolResult = harness.session.messages.find((message) => message.role === "toolResult") as
		| ToolResultMessage
		| undefined;
	expect(toolResult).toBeDefined();
	const first = toolResult?.content[0];
	expect(first?.type).toBe("text");
	return (first as TextContent).text;
}

describe("AgentSession tool output bounding", () => {
	const harnesses: Harness[] = [];
	const extraDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (extraDirs.length > 0) {
			const dir = extraDirs.pop();
			if (dir && existsSync(dir)) {
				rmSync(dir, { recursive: true });
			}
		}
	});

	it("bounds oversized tool results and spills the full output to an artifact file", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-tool-output-bounds-"));
		extraDirs.push(baseDir);
		const sessionManager = SessionManager.create(baseDir, join(baseDir, "sessions"));
		const harness = await createHarness({
			tools: [bigOutputTool],
			settings: { tools: { maxToolOutputBytes: 8 * 1024 } },
			sessionManager,
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("big_output", {}, { id: "call_big_1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the big tool");

		const text = getToolResultText(harness);
		// Head and tail survive; the marker reports the bound.
		expect(text.startsWith("HEAD-START")).toBe(true);
		expect(text.endsWith("TAIL-END")).toBe(true);
		expect(text).toContain("big_output output truncated");
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(8 * 1024 + 1024);

		// The full output is spilled under <sessionDir>/artifacts/<sessionId>/.
		const artifactPath = join(
			sessionManager.getSessionDir(),
			"artifacts",
			sessionManager.getSessionId(),
			"call_big_1.txt",
		);
		expect(existsSync(artifactPath)).toBe(true);
		expect(readFileSync(artifactPath, "utf-8")).toBe(bigOutput);
		// The marker points the model at the artifact.
		expect(text).toContain(artifactPath);
	});

	it("bounds without an artifact for in-memory sessions", async () => {
		const harness = await createHarness({
			tools: [bigOutputTool],
			settings: { tools: { maxToolOutputBytes: 8 * 1024 } },
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("big_output", {}, { id: "call_big_2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the big tool");

		const text = getToolResultText(harness);
		expect(text).toContain("big_output output truncated");
		expect(text).toContain("in-memory session");
		expect(text.endsWith("TAIL-END")).toBe(true);

		// No artifact was written, so the artifact count stays at zero.
		const stats = harness.session.getSessionStats();
		expect(stats.truncatedToolOutputBytes).toBeGreaterThan(0);
		expect(stats.toolOutputArtifacts).toBe(0);
	});

	it("reports tool output volume, truncation, and artifacts in session stats", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-tool-output-bounds-"));
		extraDirs.push(baseDir);
		const sessionManager = SessionManager.create(baseDir, join(baseDir, "sessions"));
		const harness = await createHarness({
			tools: [bigOutputTool],
			settings: { tools: { maxToolOutputBytes: 8 * 1024 } },
			sessionManager,
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("big_output", {}, { id: "call_big_3" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the big tool");

		const stats = harness.session.getSessionStats();
		const totalBytes = Buffer.byteLength(bigOutput, "utf-8");
		// The stored tool result is the bounded text: within the 8 KiB bound plus marker overhead.
		expect(stats.toolOutputBytes).toBeGreaterThan(0);
		expect(stats.toolOutputBytes).toBeLessThan(8 * 1024 + 1024);
		// The excerpt never exceeds the 8 KiB budget, so at least totalBytes - 8 KiB was removed.
		expect(stats.truncatedToolOutputBytes).toBeGreaterThanOrEqual(totalBytes - 8 * 1024);
		expect(stats.truncatedToolOutputBytes).toBeLessThan(totalBytes);
		// The bound result was spilled to exactly one artifact file.
		expect(stats.toolOutputArtifacts).toBe(1);
	});

	it("leaves small tool results byte-identical with the default threshold", async () => {
		const harness = await createHarness({ tools: [smallOutputTool] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("small_output", {}, { id: "call_small_1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the small tool");

		expect(getToolResultText(harness)).toBe(smallOutput);
	});
});
