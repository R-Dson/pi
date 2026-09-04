import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ToolCall } from "@earendil-works/pi-ai";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	buildSessionContext,
	loadEntriesFromFile,
	type SessionEntry,
	type SessionMessageEntry,
} from "../src/core/session-manager.ts";

/**
 * Golden projection tests over committed v3 session fixtures.
 *
 * The fixtures are real JSONL session files in test/fixtures/sessions/. These tests
 * load them through the public seam (loadEntriesFromFile + buildSessionContext) and
 * pin the projected context: message roles, content, thinking level, and model.
 * They document current behavior so later fork work (torn-tail recovery, incremental
 * projection) has a baseline to diff against.
 */

const FIXTURES_DIR = join(__dirname, "fixtures", "sessions");

function loadFixtureEntries(name: string, dir: string = FIXTURES_DIR): SessionEntry[] {
	const fileEntries = loadEntriesFromFile(join(dir, name));
	expect(fileEntries.length).toBeGreaterThan(0);
	const header = fileEntries[0];
	expect(header.type).toBe("session");
	return fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

function projectFixture(name: string) {
	return buildSessionContext(loadFixtureEntries(name));
}

/** Assert a message has the given role and return it narrowed to that role. */
function expectRole<TRole extends AgentMessage["role"]>(
	message: AgentMessage,
	role: TRole,
): Extract<AgentMessage, { role: TRole }> {
	expect(message.role).toBe(role);
	if (message.role !== role) {
		throw new Error(`expected ${role} message, got ${message.role}`);
	}
	return message as Extract<AgentMessage, { role: TRole }>;
}

/** Concatenated text blocks of a message ("" for messages without text content). */
function messageText(message: AgentMessage): string {
	const textBlocks = (content: readonly { type: string }[] | string): string =>
		typeof content === "string"
			? content
			: content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("");
	switch (message.role) {
		case "user":
			return textBlocks(message.content);
		case "assistant":
		case "toolResult":
			return textBlocks(message.content);
		default:
			return "";
	}
}

function toolCallsOf(message: AgentMessage): ToolCall[] {
	if (message.role !== "assistant") return [];
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

describe("golden session fixture projection", () => {
	describe("normal.jsonl", () => {
		it("projects the full conversation in order with exact content", () => {
			const ctx = projectFixture("normal.jsonl");
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
			expect(messageText(ctx.messages[0])).toBe("What is 2+2?");
			expect(messageText(ctx.messages[1])).toBe("2+2 equals 4.");
			expect(messageText(ctx.messages[2])).toBe("Now what is 3+3?");
			expect(messageText(ctx.messages[3])).toBe("3+3 equals 6.");
		});

		it("defaults to thinking off and the last assistant's model", () => {
			const ctx = projectFixture("normal.jsonl");
			expect(ctx.thinkingLevel).toBe("off");
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		});
	});

	describe("tool-success.jsonl", () => {
		it("projects the tool call/result round trip", () => {
			const ctx = projectFixture("tool-success.jsonl");
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
			expect(messageText(ctx.messages[0])).toBe("Run `echo hi` and show me the output.");

			const calling = expectRole(ctx.messages[1], "assistant");
			expect(calling.stopReason).toBe("toolUse");
			expect(toolCallsOf(calling)).toEqual([
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } },
			]);

			const result = expectRole(ctx.messages[2], "toolResult");
			expect(result.toolCallId).toBe("call_1");
			expect(result.toolName).toBe("bash");
			expect(result.isError).toBe(false);
			expect(messageText(result)).toBe("hi");

			expect(messageText(ctx.messages[3])).toBe("The command completed and printed: hi");
		});

		it("keeps thinking off and derives the model from the last assistant", () => {
			const ctx = projectFixture("tool-success.jsonl");
			expect(ctx.thinkingLevel).toBe("off");
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		});
	});

	describe("tool-failure.jsonl", () => {
		it("projects the failed tool result with isError", () => {
			const ctx = projectFixture("tool-failure.jsonl");
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
			expect(messageText(ctx.messages[0])).toBe("Run `nonexistent-command` and show me the output.");

			const calling = expectRole(ctx.messages[1], "assistant");
			expect(toolCallsOf(calling)).toEqual([
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "nonexistent-command" } },
			]);

			const result = expectRole(ctx.messages[2], "toolResult");
			expect(result.toolCallId).toBe("call_1");
			expect(result.isError).toBe(true);
			expect(messageText(result)).toBe("command not found");

			expect(messageText(ctx.messages[3])).toBe("That command failed with: command not found");
		});

		it("keeps thinking off and derives the model from the last assistant", () => {
			const ctx = projectFixture("tool-failure.jsonl");
			expect(ctx.thinkingLevel).toBe("off");
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		});
	});

	describe("model-switch.jsonl", () => {
		it("projects both exchanges around the model and thinking changes", () => {
			const ctx = projectFixture("model-switch.jsonl");
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
			expect(messageText(ctx.messages[0])).toBe("What is the capital of France?");
			expect(messageText(ctx.messages[1])).toBe("The capital of France is Paris.");
			expect(messageText(ctx.messages[2])).toBe("Roughly how many people live there?");
			expect(messageText(ctx.messages[3])).toBe("Paris proper has about 2.1 million residents.");
		});

		it("applies the model_change and thinking_level_change entries", () => {
			const ctx = projectFixture("model-switch.jsonl");
			expect(ctx.thinkingLevel).toBe("high");
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
			// The pre-switch assistant still carries its original model in the message itself.
			expect(expectRole(ctx.messages[1], "assistant").model).toBe("claude-haiku-4-5");
			expect(expectRole(ctx.messages[3], "assistant").model).toBe("claude-sonnet-4-5");
		});
	});

	describe("compacted.jsonl", () => {
		it("projects the compaction summary followed by the kept tail and post-compaction exchange", () => {
			const ctx = projectFixture("compacted.jsonl");
			expect(ctx.messages.map((m) => m.role)).toEqual([
				"compactionSummary",
				"assistant",
				"user",
				"assistant",
				"user",
				"assistant",
				"user",
				"assistant",
			]);

			const summary = expectRole(ctx.messages[0], "compactionSummary");
			expect(summary.summary).toBe("Summary of earlier conversation.");
			expect(summary.tokensBefore).toBe(1234);

			// The kept boundary is the 4th session entry (the 2nd exchange's assistant reply).
			expect(messageText(ctx.messages[1])).toBe(
				"Appending a single line is cheap, and a torn final line can be dropped safely.",
			);
			expect(messageText(ctx.messages[2])).toBe("What happens if a line is only half written?");
			expect(messageText(ctx.messages[3])).toBe("The incomplete JSON fails to parse and is skipped on load.");
			expect(messageText(ctx.messages[4])).toBe("Does the whole file need re-reading after every turn?");
			expect(messageText(ctx.messages[5])).toBe(
				"Readers can resume from the last known offset, but full projection re-reads it.",
			);
			expect(messageText(ctx.messages[6])).toBe("Understood. Let's change topics.");
			expect(messageText(ctx.messages[7])).toBe("Sure, what should we look at next?");
		});

		it("drops the summarized prefix from the projection", () => {
			const ctx = projectFixture("compacted.jsonl");
			const allText = ctx.messages.map(messageText).join(" ");
			expect(allText).not.toContain("Explain what a JSONL file is.");
			expect(allText).not.toContain("JSONL stores one JSON object per line");
			expect(allText).not.toContain("Why is it a good format for session logs?");
		});

		it("keeps model and thinking settings from the full path", () => {
			const ctx = projectFixture("compacted.jsonl");
			expect(ctx.thinkingLevel).toBe("off");
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		});
	});

	describe("branched.jsonl", () => {
		it("follows the second branch from the default leaf", () => {
			const ctx = projectFixture("branched.jsonl");
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
			expect(messageText(ctx.messages[0])).toBe("Write a haiku about the sea.");
			expect(messageText(ctx.messages[1])).toBe(
				"Salt wind over waves, gulls trace the falling white foam, tide keeps its old time.",
			);
			expect(messageText(ctx.messages[2])).toBe("Rewrite it about winter.");
			expect(messageText(ctx.messages[3])).toBe(
				"Frost blooms on the glass, night arrives a little early, stoves remember sun.",
			);
			// The abandoned first branch is not part of the default projection.
			expect(ctx.messages.map(messageText).join(" ")).not.toContain("mountains");
		});

		it("keeps thinking off and derives the model from the active branch's last assistant", () => {
			const ctx = projectFixture("branched.jsonl");
			expect(ctx.thinkingLevel).toBe("off");
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		});

		it("can still project the abandoned branch by leaf id", () => {
			const entries = loadFixtureEntries("branched.jsonl");
			const abandonedLeaf = entries.find(
				(entry): entry is SessionMessageEntry =>
					entry.type === "message" && messageText(entry.message).includes("Stone peaks hold the snow"),
			);
			if (!abandonedLeaf) throw new Error("abandoned branch leaf not found in fixture");

			const ctx = buildSessionContext(entries, abandonedLeaf.id);
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
			expect(messageText(ctx.messages[2])).toBe("Rewrite it about mountains.");
			expect(messageText(ctx.messages[3])).toBe(
				"Stone peaks hold the snow, thin air and long morning light, valleys sleep below.",
			);
		});
	});

	describe("interrupted-turn.jsonl", () => {
		it("keeps the dangling assistant toolCall in the projection (current behavior)", () => {
			const ctx = projectFixture("interrupted-turn.jsonl");
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
			expect(messageText(ctx.messages[0])).toBe("Check which git tag this checkout is on.");

			const calling = expectRole(ctx.messages[1], "assistant");
			expect(calling.stopReason).toBe("toolUse");
			expect(toolCallsOf(calling)).toEqual([
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "git describe --tags" } },
			]);
			// No toolResult follows: the session crashed mid-turn. Projection includes the
			// dangling toolCall message as-is.
		});

		it("keeps thinking off and derives the model from the dangling assistant", () => {
			const ctx = projectFixture("interrupted-turn.jsonl");
			expect(ctx.thinkingLevel).toBe("off");
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		});
	});

	describe("truncated-tail.jsonl", () => {
		it("silently drops the torn final line (current behavior, to improve when session validation lands)", () => {
			// loadEntriesFromFile repairs a missing trailing newline in place
			// (upstream 0b5ee5d8b), so load a disposable copy to keep the
			// committed fixture torn.
			const dir = mkdtempSync(join(tmpdir(), "pi-golden-fixtures-"));
			writeFileSync(join(dir, "truncated-tail.jsonl"), readFileSync(join(FIXTURES_DIR, "truncated-tail.jsonl")));
			try {
				const truncated = loadFixtureEntries("truncated-tail.jsonl", dir);
				const normal = loadFixtureEntries("normal.jsonl");
				expect(truncated).toEqual(normal.slice(0, -1));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("unknown-fields.jsonl", () => {
		it("projects identically to normal.jsonl despite unknown entry fields", () => {
			const ctxUnknown = buildSessionContext(loadFixtureEntries("unknown-fields.jsonl"));
			const ctxNormal = buildSessionContext(loadFixtureEntries("normal.jsonl"));
			expect(ctxUnknown).toEqual(ctxNormal);
		});
	});
});
