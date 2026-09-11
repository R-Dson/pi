import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
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
