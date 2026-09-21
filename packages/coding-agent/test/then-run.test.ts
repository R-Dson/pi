import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "../src/core/extensions/types.ts";
import { type BashToolInput, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { type BashToolDefinition, createSessionFusedCommandExecutor } from "../src/core/tools/then-run.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

function fakeCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		// The bash tool reads session metadata when ctx is present; an unpersisted
		// stub keeps fused commands working without a real session.
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => undefined,
			getSessionDir: () => cwd,
		},
	} as unknown as ExtensionContext;
}

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n") || ""
	);
}

describe("thenRun fused execution", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-then-run-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("edit runs the command after a successful edit and appends its output", async () => {
		const testFile = join(testDir, "fused-edit.txt");
		writeFileSync(testFile, "foo");
		const tool = createEditToolDefinition("/");

		const result = await tool.execute(
			"call-1",
			{ path: testFile, edits: [{ oldText: "foo", newText: "bar" }], thenRun: { command: "echo fused-ok" } },
			undefined,
			undefined,
			fakeCtx(testDir),
		);

		const output = getTextOutput(result);
		expect(output).toContain("Successfully replaced 1 block(s)");
		expect(output).toContain("[thenRun:succeeded] echo fused-ok");
		expect(output).toContain("fused-ok");
		expect(readFileSync(testFile, "utf-8")).toBe("bar");
	});

	it("edit keeps the change and reports both outputs when the command fails", async () => {
		const testFile = join(testDir, "fused-edit-fail.txt");
		writeFileSync(testFile, "foo");
		const tool = createEditToolDefinition("/");

		await expect(
			tool.execute(
				"call-2",
				{
					path: testFile,
					edits: [{ oldText: "foo", newText: "bar" }],
					thenRun: { command: "echo boom >&2; exit 3" },
				},
				undefined,
				undefined,
				fakeCtx(testDir),
			),
		).rejects.toThrow(/Successfully replaced[\s\S]*\[thenRun:failed\][\s\S]*Command exited with code 3/);

		expect(readFileSync(testFile, "utf-8")).toBe("bar");
	});

	it("edit skips the command when the edit itself fails", async () => {
		const tool = createEditToolDefinition("/");
		const marker = join(testDir, "then-ran-marker");

		await expect(
			tool.execute(
				"call-3",
				{
					path: join(testDir, "missing.txt"),
					edits: [{ oldText: "foo", newText: "bar" }],
					thenRun: { command: `touch ${marker}` },
				},
				undefined,
				undefined,
				fakeCtx(testDir),
			),
		).rejects.toThrow(/Could not edit file[\s\S]*\[thenRun:skipped\]/);

		expect(existsSync(marker)).toBe(false);
	});

	it("surfaces a mid-mutation abort unwrapped instead of as a skip", async () => {
		const testFile = join(testDir, "fused-abort.txt");
		writeFileSync(testFile, "foo");
		const tool = createEditToolDefinition("/");
		const controller = new AbortController();
		controller.abort();

		await expect(
			tool.execute(
				"call-abort",
				{ path: testFile, edits: [{ oldText: "foo", newText: "bar" }], thenRun: { command: "echo ran" } },
				controller.signal,
				undefined,
				fakeCtx(testDir),
			),
		).rejects.toThrow(/^Operation aborted$/);
	});

	it("write runs the command after a successful write and appends its output", async () => {
		const testFile = join(testDir, "fused-write.txt");
		const tool = createWriteToolDefinition("/");

		const result = await tool.execute(
			"call-4",
			{ path: testFile, content: "hello", thenRun: { command: "cat fused-write.txt" } },
			undefined,
			undefined,
			fakeCtx(testDir),
		);

		const output = getTextOutput(result);
		expect(output).toContain("Successfully wrote to");
		expect(output).toContain("[thenRun:succeeded] cat fused-write.txt");
		expect(output).toContain("hello");
		expect(readFileSync(testFile, "utf-8")).toBe("hello");
	});

	it("passes the command timeout through to bash", async () => {
		const testFile = join(testDir, "fused-timeout.txt");
		writeFileSync(testFile, "foo");
		const tool = createEditToolDefinition("/");

		await expect(
			tool.execute(
				"call-5",
				{
					path: testFile,
					edits: [{ oldText: "foo", newText: "bar" }],
					thenRun: { command: "sleep 5", timeout: 1 },
				},
				undefined,
				undefined,
				fakeCtx(testDir),
			),
		).rejects.toThrow(/\[thenRun:failed\][\s\S]*timed out after 1 seconds/);
	});
});

describe("session fused-command executor", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-then-run-exec-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	interface StubRunner {
		hasHandlers(event: string): boolean;
		emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined>;
		emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined>;
	}

	function stubRunner(overrides: Partial<StubRunner> = {}): StubRunner {
		return {
			hasHandlers: () => true,
			emitToolCall: async () => undefined,
			emitToolResult: async () => undefined,
			...overrides,
		};
	}

	/** Bash definition stub: records the executed call and returns fixed output. */
	function stubBash(output = "stub output") {
		const executed: Array<{ toolCallId: string; input: BashToolInput }> = [];
		const definition: BashToolDefinition = {
			...createBashToolDefinition("/"),
			execute: async (toolCallId, input: BashToolInput) => {
				executed.push({ toolCallId, input });
				return { content: [{ type: "text", text: output }], details: undefined };
			},
		};
		return { executed, definition };
	}

	it("blocks the command when the gate returns block, without executing bash", async () => {
		const bash = stubBash();
		const runner = stubRunner({
			emitToolCall: async () => ({ block: true, reason: "denied by stub" }),
		});
		const executor = createSessionFusedCommandExecutor({
			getCwd: () => testDir,
			getRunner: () => runner,
			getBashDefinition: () => bash.definition,
		});

		const outcome = await executor("call-1", { command: "echo hi" }, undefined, undefined);

		expect(outcome).toEqual({ status: "blocked", reason: "denied by stub" });
		expect(bash.executed).toEqual([]);
	});

	it("runs the gate-mutated command and reports the observed result content", async () => {
		const bash = stubBash("raw output");
		const runner = stubRunner({
			emitToolCall: async (event) => {
				const input = event.input as { command: string };
				input.command = `${input.command} --mutated`;
				return undefined;
			},
			emitToolResult: async () => ({ content: [{ type: "text", text: "observed output" }] }),
		});
		const executor = createSessionFusedCommandExecutor({
			getCwd: () => testDir,
			getRunner: () => runner,
			getBashDefinition: () => bash.definition,
		});

		const outcome = await executor("call-2", { command: "echo hi" }, undefined, undefined);

		// The mutation applied before execution, and the tool_result override won.
		expect(bash.executed).toEqual([{ toolCallId: "call-2:thenRun", input: { command: "echo hi --mutated" } }]);
		expect(outcome).toEqual({ status: "ran", command: "echo hi --mutated", output: "observed output" });
	});

	it("maps a throwing gate handler to a failed outcome instead of rejecting", async () => {
		const bash = stubBash();
		const runner = stubRunner({
			emitToolCall: async () => {
				throw new Error("handler exploded");
			},
		});
		const executor = createSessionFusedCommandExecutor({
			getCwd: () => testDir,
			getRunner: () => runner,
			getBashDefinition: () => bash.definition,
		});

		const outcome = await executor("call-3", { command: "echo hi" }, undefined, undefined);

		// The mutation has already succeeded at gate time; the executor must not
		// reject (that would drop the mutation output from the edit result).
		expect(outcome).toEqual({
			status: "failed",
			command: "echo hi",
			output: "fused-command gate extension error: handler exploded",
		});
		expect(bash.executed).toEqual([]);
	});

	it("without a runner or registered bash, runs ungated through a fresh local bash", async () => {
		// The exact shape appendThenRunResult builds for plain factories: an
		// executor with only a cwd is the ungated fresh-bash fallback.
		const executor = createSessionFusedCommandExecutor({ getCwd: () => testDir });

		const outcome = await executor("call-4", { command: `printf local-fallback` }, undefined, fakeCtx(testDir));

		expect(outcome.status).toBe("ran");
		if (outcome.status === "ran") {
			expect(outcome.output).toContain("local-fallback");
		}
	});
});

describe("bash full-output spill location", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-spill-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	function sessionCtx(sessionId: string): ExtensionContext {
		return {
			cwd: testDir,
			sessionManager: {
				getSessionFile: () => join(testDir, `${sessionId}.jsonl`),
				getSessionDir: () => testDir,
				getSessionId: () => sessionId,
			},
		} as unknown as ExtensionContext;
	}

	it("spills truncated output into the session artifacts directory", async () => {
		const tool = createBashToolDefinition("/");
		const result = await tool.execute(
			"call-6",
			{ command: "seq 1 20000" },
			undefined,
			undefined,
			sessionCtx("sess-a"),
		);

		const spillPath = result.details?.fullOutputPath;
		expect(spillPath).toBeDefined();
		expect(spillPath?.startsWith(join(testDir, "artifacts", "sess-a"))).toBe(true);
		expect(spillPath?.includes("pi-bash-")).toBe(true);
		expect(existsSync(spillPath!)).toBe(true);
		const spilled = readFileSync(spillPath!, "utf-8");
		expect(spilled.startsWith("1\n")).toBe(true);
		expect(spilled.trimEnd().endsWith("20000")).toBe(true);
		// The truncated result points at the spill file for recall.
		expect(getTextOutput(result)).toContain(spillPath!);
	});

	it("keeps the temp dir fallback without a session", async () => {
		const tool = createBashToolDefinition("/");
		const result = await tool.execute("call-7", { command: "seq 1 20000" }, undefined, undefined, fakeCtx(testDir));

		const spillPath = result.details?.fullOutputPath;
		expect(spillPath).toBeDefined();
		expect(spillPath?.startsWith(join(testDir))).toBe(false);
		expect(existsSync(spillPath!)).toBe(true);
	});
});
