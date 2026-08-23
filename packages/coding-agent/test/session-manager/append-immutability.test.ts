import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FileEntry, SessionManager } from "../../src/core/session-manager.ts";

/**
 * Append-immutability property (plan 2.8): a persisted session file only ever
 * grows by complete appended lines; previous bytes are never altered, and each
 * append after the deferred initial flush adds exactly one line containing
 * exactly the appended entry.
 */

const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("SessionManager append immutability", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-append-immutability-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("never alters previous bytes and only appends complete lines per entry", () => {
		const cwd = join(tempDir, "project");
		const session = SessionManager.create(cwd, join(tempDir, "sessions"));
		const filePath = session.getSessionFile();
		if (!filePath) throw new Error("expected a persisted session file path");
		const file: string = filePath;

		const userMessage = { role: "user" as const, content: "check the append path", timestamp: 1 };
		const userEntryId = session.appendMessage(userMessage);

		// Deferred creation: no assistant message yet, so the file does not exist
		// (upstream behavior: abandoned prompts leave no session file).
		expect(existsSync(file)).toBe(false);
		let previous = "";

		/** Assert content only grew over previous by complete JSON lines and return it. */
		function grewOnlyByCompleteLines(next: string): string[] {
			expect(next.startsWith(previous)).toBe(true);
			const added = next.slice(previous.length);
			if (added.length === 0) return [];
			expect(added.endsWith("\n")).toBe(true);
			const lines = added.split("\n");
			expect(lines[lines.length - 1]).toBe("");
			const completeLines = lines.slice(0, -1);
			for (const line of completeLines) {
				expect(() => JSON.parse(line) as FileEntry).not.toThrow();
			}
			return completeLines;
		}

		function readContent(): string {
			return existsSync(file) ? readFileSync(file, "utf8") : "";
		}

		const assistantMessage = {
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, id: "call_imm_1", name: "bash", arguments: { command: "echo hi" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: USAGE,
			stopReason: "toolUse" as const,
			timestamp: 2,
		};
		const assistantEntryId = session.appendMessage(assistantMessage);

		// The first assistant message flushes every pending entry (header, user,
		// assistant) as complete lines; previous bytes (none) are untouched. The
		// flush batch size is upstream's deferred-creation behavior, not this
		// property, so only completeness and ordering are asserted.
		let content = readContent();
		let added = grewOnlyByCompleteLines(content);
		expect(added.length).toBeGreaterThanOrEqual(3);
		expect((JSON.parse(added[0]) as FileEntry).type).toBe("session");
		const flushedUser = JSON.parse(added[1]) as FileEntry;
		const flushedAssistant = JSON.parse(added[2]) as FileEntry;
		previous = content;

		const toolResultMessage = {
			role: "toolResult" as const,
			toolCallId: "call_imm_1",
			toolName: "bash",
			content: [{ type: "text" as const, text: "hi" }],
			isError: false,
			timestamp: 3,
		};
		const toolResultEntryId = session.appendMessage(toolResultMessage);

		// From here on, every append adds exactly one line: the appended entry.
		content = readContent();
		added = grewOnlyByCompleteLines(content);
		expect(added).toHaveLength(1);
		const resultLine = JSON.parse(added[0]) as FileEntry;
		previous = content;

		const modelChangeEntryId = session.appendModelChange("anthropic", "claude-sonnet-4-5");
		content = readContent();
		added = grewOnlyByCompleteLines(content);
		expect(added).toHaveLength(1);
		const modelLine = JSON.parse(added[0]) as FileEntry;
		previous = content;

		const customEntryId = session.appendCustomEntry("test_data", { foo: "bar" });
		content = readContent();
		added = grewOnlyByCompleteLines(content);
		expect(added).toHaveLength(1);
		const customLine = JSON.parse(added[0]) as FileEntry;
		previous = content;

		// The appended lines carry exactly the appended payloads, chained onto the
		// previous leaf.
		expect(flushedUser).toMatchObject({ type: "message", id: userEntryId, message: userMessage });
		expect(flushedAssistant).toMatchObject({
			type: "message",
			id: assistantEntryId,
			parentId: userEntryId,
			message: assistantMessage,
		});
		expect(resultLine).toMatchObject({
			type: "message",
			id: toolResultEntryId,
			parentId: assistantEntryId,
			message: toolResultMessage,
		});
		expect(modelLine).toMatchObject({
			type: "model_change",
			id: modelChangeEntryId,
			parentId: toolResultEntryId,
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		});
		expect(customLine).toMatchObject({
			type: "custom",
			id: customEntryId,
			parentId: modelChangeEntryId,
			customType: "test_data",
			data: { foo: "bar" },
		});

		// Every persisted byte boundary is a line boundary: whole file check.
		expect(content.endsWith("\n")).toBe(true);
		// One complete line per entry plus the header; count derived from the
		// session itself rather than pinned, so batching changes do not break
		// the property.
		expect(content.split("\n").filter(Boolean)).toHaveLength(session.getEntries().length + 1);

		// Reloading the file yields identical entries.
		const reloaded = SessionManager.open(file);
		expect(reloaded.getEntries()).toEqual(session.getEntries());
	});
});
