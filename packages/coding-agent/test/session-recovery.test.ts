import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.ts";
import { appendInterruptedTurnResults } from "../src/core/sessions/recovery.ts";

/**
 * Interrupted-turn recovery marking seam tests.
 *
 * A crash mid-tool-execution leaves the final assistant message with toolCalls
 * and no toolResults. appendInterruptedTurnResults repairs the turn at resume
 * time by appending one terminal error toolResult per dangling call
 * (append-only, no history rewrite) — but only where appending keeps each
 * result adjacent to its tool_use, i.e. when no later message entry follows the
 * dangling turn; the pure projector keeps projecting raw entries unchanged
 * (see session-fixtures-golden.test.ts).
 */

const FIXTURES_DIR = join(__dirname, "fixtures", "sessions");

/** Tool call ids in the projected messages that have no toolResult at a later index. */
function danglingToolCallIds(messages: AgentMessage[]): string[] {
	const dangling: string[] = [];
	messages.forEach((message, index) => {
		if (message.role !== "assistant") return;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const answered = messages
				.slice(index + 1)
				.some((later) => later.role === "toolResult" && later.toolCallId === block.id);
			if (!answered) dangling.push(block.id);
		}
	});
	return dangling;
}

describe("appendInterruptedTurnResults", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-recovery-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Copy a fixture into a tmp dir and open it as a persisted session. */
	function openFixture(name: string): SessionManager {
		const file = join(tempDir, name);
		writeFileSync(file, readFileSync(join(FIXTURES_DIR, name)));
		return SessionManager.open(file);
	}

	/** In-memory session carrying exactly the fixture's plain message entries. */
	function inMemoryFromFixture(name: string): SessionManager {
		const session = SessionManager.inMemory();
		for (const entry of loadEntriesFromFile(join(FIXTURES_DIR, name))) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			// Only user/assistant/toolResult messages exist as raw message entries;
			// the custom roles (compaction summaries, ...) enter history through
			// their own entry types, which appendMessage rejects.
			if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
				session.appendMessage(message);
			}
		}
		return session;
	}

	it("appends one terminal toolResult per dangling call of the interrupted final turn", () => {
		const session = openFixture("interrupted-turn.jsonl");
		const before = session.getEntries().length;

		const appendedIds = appendInterruptedTurnResults(session);

		// The fixture's final assistant message carries exactly one dangling call.
		expect(appendedIds).toHaveLength(1);
		expect(session.getEntries().length).toBe(before + 1);

		const messages = session.buildSessionContext().messages;
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);

		const repaired = messages[2];
		if (repaired.role !== "toolResult") throw new Error(`expected toolResult, got ${repaired.role}`);
		expect(repaired.toolCallId).toBe("call_1");
		expect(repaired.toolName).toBe("bash");
		expect(repaired.isError).toBe(true);
		expect(repaired.content).toEqual([
			{
				type: "text",
				text: expect.stringMatching(/interrupted/i),
			},
		]);

		// The appended entry is an ordinary message entry parented on the old leaf.
		const entry = session.getEntry(appendedIds[0]);
		expect(entry?.type).toBe("message");
		expect(danglingToolCallIds(messages)).toEqual([]);
	});

	it("is a no-op on a second run (idempotent) and on a completed session", () => {
		const session = openFixture("interrupted-turn.jsonl");
		expect(appendInterruptedTurnResults(session)).toHaveLength(1);
		expect(appendInterruptedTurnResults(session)).toEqual([]);

		const normal = openFixture("normal.jsonl");
		expect(appendInterruptedTurnResults(normal)).toEqual([]);
		expect(normal.getEntries().length).toBe(4);

		const toolSuccess = openFixture("tool-success.jsonl");
		expect(appendInterruptedTurnResults(toolSuccess)).toEqual([]);
	});

	it("appends nothing when later message entries follow the dangling turn", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "run two things", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "calling" },
				{ type: "toolCall", id: "call_mid", name: "bash", arguments: { command: "echo mid" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		// A steering user message persisted mid-tool-run before the crash: the
		// dangling call is mid-path. A tail-appended toolResult would land after
		// this message — non-adjacent to its tool_use, so Anthropic rejects the
		// request anyway and only the local validator would be satisfied. The
		// repair is skipped and resume proceeds unrepaired.
		session.appendMessage({ role: "user", content: "actually never mind", timestamp: 3 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "understood" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 4,
		});

		expect(appendInterruptedTurnResults(session)).toEqual([]);
		expect(session.getEntries()).toHaveLength(4);
		expect(danglingToolCallIds(session.buildSessionContext().messages)).toEqual(["call_mid"]);
	});

	it("appends results when only non-message entries follow the dangling turn", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "run it", timestamp: 1 });
		const assistantId = session.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_tail", name: "bash", arguments: { command: "echo tail" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		});
		// Non-message entries (settings, labels) project nothing into the LLM
		// context, so tail-appended results stay adjacent to the tool_use.
		session.appendThinkingLevelChange("medium");
		session.appendLabelChange(assistantId, "mark");

		expect(appendInterruptedTurnResults(session)).toHaveLength(1);
		const messages = session.buildSessionContext().messages;
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(danglingToolCallIds(messages)).toEqual([]);
	});

	it("repairs a dangling call that ends the context (tail case, in memory)", () => {
		const interrupted = inMemoryFromFixture("interrupted-turn.jsonl");
		expect(appendInterruptedTurnResults(interrupted)).toHaveLength(1);
		const messages = interrupted.buildSessionContext().messages;
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(danglingToolCallIds(messages)).toEqual([]);
	});
});

describe("createAgentSession interrupted-turn recovery wiring", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-recovery-resume-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("adopts repaired messages when resuming an interrupted session", async () => {
		mkdirSync(join(tempDir, "agent"), { recursive: true });
		const file = join(tempDir, "interrupted.jsonl");
		writeFileSync(file, readFileSync(join(FIXTURES_DIR, "interrupted-turn.jsonl")));

		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			model: model!,
			sessionManager: SessionManager.open(file),
		});

		try {
			const messages = session.messages;
			expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
			const repaired = messages[2];
			if (repaired.role !== "toolResult") throw new Error(`expected toolResult, got ${repaired.role}`);
			expect(repaired.toolCallId).toBe("call_1");
			expect(repaired.isError).toBe(true);
			expect(danglingToolCallIds(messages)).toEqual([]);

			// The repair is persisted: reloading the file projects the repaired turn.
			const reloaded = SessionManager.open(file);
			const reloadedMessages = reloaded.buildSessionContext().messages;
			expect(reloadedMessages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		} finally {
			session.dispose();
		}
	});

	it("leaves a completed session file untouched on resume", async () => {
		mkdirSync(join(tempDir, "agent"), { recursive: true });
		const file = join(tempDir, "normal.jsonl");
		const originalBytes = readFileSync(join(FIXTURES_DIR, "normal.jsonl"));
		writeFileSync(file, originalBytes);

		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			model: model!,
			sessionManager: SessionManager.open(file),
		});

		try {
			expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
			// A resumed complete session grows only by the restore bookkeeping
			// (thinking level), never by synthesized tool results.
			const roles = SessionManager.open(file)
				.buildSessionContext()
				.messages.map((message) => message.role);
			expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
		} finally {
			session.dispose();
		}
	});
});

describe("appendInterruptedTurnResults partial flush", () => {
	it("repairs only the unanswered sibling of a parallel tool batch", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "run two things", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call_a", name: "bash", arguments: { command: "echo a" } },
				{ type: "toolCall", id: "call_b", name: "bash", arguments: { command: "echo b" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		});
		// Crash after call_a's result was persisted, before call_b's.
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call_a",
			toolName: "bash",
			content: [{ type: "text", text: "a" }],
			isError: false,
			timestamp: 3,
		});

		const appendedIds = appendInterruptedTurnResults(session);
		expect(appendedIds).toHaveLength(1);
		const messages = session.buildSessionContext().messages;
		expect(danglingToolCallIds(messages)).toEqual([]);
		const results = messages.filter((message) => message.role === "toolResult");
		expect(results.map((message) => (message.role === "toolResult" ? message.toolCallId : ""))).toEqual([
			"call_a",
			"call_b",
		]);
	});
});
