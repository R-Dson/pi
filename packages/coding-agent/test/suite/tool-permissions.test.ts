import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRule } from "../../src/core/tools/permissions.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

function getToolResult(harness: Harness): ToolResultMessage {
	const toolResult = harness.session.messages.find((message) => message.role === "toolResult") as
		| ToolResultMessage
		| undefined;
	expect(toolResult).toBeDefined();
	return toolResult as ToolResultMessage;
}

function getToolResultText(harness: Harness): string {
	const toolResult = getToolResult(harness);
	return toolResult.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function policySettings(rules: PermissionRule[]) {
	return { tools: { permissions: { mode: "policy" as const, rules } } };
}

async function runBashToolCall(harness: Harness, toolCallId: string): Promise<void> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "printf permission-probe" }, { id: toolCallId })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("run the bash tool");
}

describe("AgentSession tool permission policy", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("legacy mode (default) executes bash with no rules configured", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await runBashToolCall(harness, "call_legacy_1");

		const text = getToolResultText(harness);
		expect(text).toContain("permission-probe");
	});

	it("policy mode blocks a denied capability with the matched rule in the error result", async () => {
		const harness = await createHarness({
			settings: policySettings([{ capability: "process.execute", effect: "deny" }]),
		});
		harnesses.push(harness);

		await runBashToolCall(harness, "call_deny_1");

		const toolResult = getToolResult(harness);
		expect(toolResult.isError).toBe(true);
		const text = getToolResultText(harness);
		expect(text).not.toContain("permission-probe");
		expect(text).toContain("deny");
		expect(text).toContain("process.execute");

		// The model received the error result and continued.
		expect(getAssistantTexts(harness)).toContain("done");
	});

	it("policy mode executes an allowed capability", async () => {
		const harness = await createHarness({
			settings: policySettings([{ capability: "process.execute", effect: "allow" }]),
		});
		harnesses.push(harness);

		await runBashToolCall(harness, "call_allow_1");

		expect(getToolResultText(harness)).toContain("permission-probe");
		expect(getToolResult(harness).isError ?? false).toBe(false);
	});

	it("policy mode blocks an ask rule with an approval-required reason", async () => {
		const harness = await createHarness({
			settings: policySettings([{ capability: "process.execute", effect: "ask" }]),
		});
		harnesses.push(harness);

		await runBashToolCall(harness, "call_ask_1");

		const toolResult = getToolResult(harness);
		expect(toolResult.isError).toBe(true);
		const text = getToolResultText(harness);
		expect(text).not.toContain("permission-probe");
		expect(text).toContain("approval");
		expect(text).toContain("tools.permissions.rules");

		expect(getAssistantTexts(harness)).toContain("done");
	});

	it("policy mode denies a path rule for filesystem writes", async () => {
		const harness = await createHarness({
			settings: policySettings([{ capability: "filesystem.write", path: "/etc", effect: "deny" }]),
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("write", { path: "/etc/pi-probe.txt", content: "x" }, { id: "call_path_1" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write the file");

		const toolResult = getToolResult(harness);
		expect(toolResult.isError).toBe(true);
		const text = getToolResultText(harness);
		expect(text).toContain("permission rule");
		expect(text).toContain("path=/etc");
	});

	it("legacy mode performs no evaluation even with a deny-everything rule", async () => {
		const harness = await createHarness({
			settings: { tools: { permissions: { mode: "legacy", rules: [{ effect: "deny" }] } } },
		});
		harnesses.push(harness);

		await runBashToolCall(harness, "call_legacy_2");

		expect(getToolResultText(harness)).toContain("permission-probe");
	});
});
