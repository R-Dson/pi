import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import permissionPolicies from "../../src/extensions/permission-policies/index.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * The fused thenRun command fires the same tool_call event a plain bash call
 * fires (toolName "bash", toolCallId "<parent>:thenRun"), so every gating
 * extension judges it without knowing the edit/write schema. These tests pin
 * that seam end to end through a real session, first with plain extensions,
 * then driving the permission-policies builtin through real policy files.
 */
function editToolResult(harness: Harness): ToolResultMessage | undefined {
	return harness.session.messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "edit",
	);
}

/** Concatenate the text blocks of a content-parts array (result or event content). */
function textParts(content: Array<{ type: string; text?: string }> | undefined): string {
	return (content ?? [])
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function resultText(result: ToolResultMessage | undefined): string {
	return textParts(result?.content);
}

describe("thenRun bash-facet gate", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("a denied fused command is skipped with the reason; the edit is kept", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event) => {
						if (event.toolName === "bash") {
							return { block: true, reason: "bash denied by test policy" };
						}
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);

		const target = join(harness.tempDir, "target.txt");
		writeFileSync(target, "foo");
		const marker = join(harness.tempDir, "then-ran-marker");

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: target,
						edits: [{ oldText: "foo", newText: "bar" }],
						thenRun: { command: `touch ${marker}` },
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("edit the file");

		const result = editToolResult(harness);
		expect(result).toBeDefined();
		// The edit succeeded; the denial is reported as a skip marker, not an error.
		expect(result?.isError ?? false).toBe(false);
		const text = resultText(result);
		expect(text).toContain("Successfully replaced 1 block(s)");
		expect(text).toContain("[thenRun:skipped]");
		expect(text).toContain("bash denied by test policy");
		// The denied command never ran, and the mutation is kept.
		expect(existsSync(marker)).toBe(false);
		expect(readFileSync(target, "utf-8")).toBe("bar");
	});

	it("an extension mutating the fused command's arguments rewrites what runs", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event) => {
						if (event.toolName === "bash" && typeof event.input.command === "string") {
							event.input.command = `${event.input.command} && echo rewritten-by-extension`;
						}
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);

		const target = join(harness.tempDir, "target.txt");
		writeFileSync(target, "foo");

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: target,
						edits: [{ oldText: "foo", newText: "bar" }],
						thenRun: { command: "echo original" },
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("edit the file");

		const result = editToolResult(harness);
		const text = resultText(result);
		expect(text).toContain("[thenRun:succeeded] echo original && echo rewritten-by-extension");
		expect(text).toContain("rewritten-by-extension");
	});

	it("fires the tool_result event for the fused command", async () => {
		const observed: Array<{ toolName: string; toolCallId: string; isError: boolean; text: string }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async (event) => {
						if (event.toolName === "bash") {
							observed.push({
								toolName: event.toolName,
								toolCallId: event.toolCallId,
								isError: event.isError ?? false,
								text: textParts(event.content),
							});
						}
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);

		const target = join(harness.tempDir, "target.txt");
		writeFileSync(target, "foo");

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: target,
						edits: [{ oldText: "foo", newText: "bar" }],
						thenRun: { command: "echo fused-observed" },
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("edit the file");

		const fused = observed.find((event) => event.toolCallId.endsWith(":thenRun"));
		expect(fused).toBeDefined();
		expect(fused?.isError).toBe(false);
		expect(fused?.text).toContain("fused-observed");
	});

	it("runs the fused command through the session's bash settings", async () => {
		const harness = await createHarness({
			settings: { shellCommandPrefix: "echo prefix-applied;" },
		});
		harnesses.push(harness);

		const target = join(harness.tempDir, "target.txt");
		writeFileSync(target, "foo");

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: target,
						edits: [{ oldText: "foo", newText: "bar" }],
						thenRun: { command: "echo body" },
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("edit the file");

		const result = editToolResult(harness);
		const text = resultText(result);
		expect(text).toContain("[thenRun:succeeded]");
		// commandPrefix applies to the fused command exactly as it does to plain bash calls.
		expect(text).toContain("prefix-applied");
		expect(text).toContain("body");
	});

	it("runs the fused command through the session's shellPath", async () => {
		// A wrapper shell proving inheritance: a custom shellPath is invoked as
		// `<shell> -c <command>` (getBashShellConfig), so the wrapper sees the
		// command in $2.
		const shellDir = mkdtempSync(join(tmpdir(), "then-run-shellpath-"));
		try {
			const shellPath = join(shellDir, "wrapper-sh");
			writeFileSync(shellPath, '#!/bin/sh\necho shellpath-applied\neval "$2"\n', { mode: 0o755 });
			const harness = await createHarness({ settings: { shellPath } });
			harnesses.push(harness);

			const target = join(harness.tempDir, "target.txt");
			writeFileSync(target, "foo");

			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("edit", {
							path: target,
							edits: [{ oldText: "foo", newText: "bar" }],
							thenRun: { command: "echo body" },
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("edit the file");

			const result = editToolResult(harness);
			const text = resultText(result);
			expect(text).toContain("[thenRun:succeeded]");
			// shellPath applies to the fused command exactly as it does to plain bash calls.
			expect(text).toContain("shellpath-applied");
			expect(text).toContain("body");
		} finally {
			rmSync(shellDir, { recursive: true, force: true });
		}
	});
});

describe("thenRun bash-facet gate through permission-policies policy files", () => {
	const harnesses: Harness[] = [];
	const previousGlobalEnv = process.env.PI_PERMISSION_POLICIES_GLOBAL;

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		if (previousGlobalEnv === undefined) {
			delete process.env.PI_PERMISSION_POLICIES_GLOBAL;
		} else {
			process.env.PI_PERMISSION_POLICIES_GLOBAL = previousGlobalEnv;
		}
	});

	async function runFusedEdit(globalPolicy: string): Promise<Harness> {
		const harness = await createHarness({ extensionFactories: [permissionPolicies] });
		harnesses.push(harness);
		process.env.PI_PERMISSION_POLICIES_GLOBAL = join(harness.tempDir, "global-permissions.json");
		writeFileSync(process.env.PI_PERMISSION_POLICIES_GLOBAL, globalPolicy);

		const target = join(harness.tempDir, "target.txt");
		writeFileSync(target, "foo");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: target,
						edits: [{ oldText: "foo", newText: "bar" }],
						thenRun: { command: "echo gated" },
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("edit the file");
		return harness;
	}

	it("a bash deny rule in a policy file blocks the fused command; the edit is kept", async () => {
		const harness = await runFusedEdit(`{ "rules": [{ "tool": "bash", "effect": "deny" }] }`);

		const result = editToolResult(harness);
		expect(result?.isError ?? false).toBe(false);
		const text = resultText(result);
		expect(text).toContain("Successfully replaced 1 block(s)");
		expect(text).toContain("[thenRun:skipped]");
		expect(text).toContain("permission-policies: deny");
	});

	it("an ask rule blocks the fused command with its reason when no dialog is available", async () => {
		const harness = await runFusedEdit(`{ "rules": [{ "capability": "process.execute", "effect": "ask" }] }`);

		const result = editToolResult(harness);
		expect(result?.isError ?? false).toBe(false);
		const text = resultText(result);
		expect(text).toContain("[thenRun:skipped]");
		expect(text).toContain("permission-policies: ask");
	});
});
