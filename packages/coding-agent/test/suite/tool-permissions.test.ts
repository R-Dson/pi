import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRule, ToolProfile } from "../../src/core/tools/permissions.ts";
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

function policySettings(rules: PermissionRule[], profile?: ToolProfile) {
	return {
		tools: { permissions: { mode: "policy" as const, rules, ...(profile ? { profile } : {}) } },
	};
}

/**
 * Runs one prompt whose first model call records the model-visible tool list
 * (the tools array sent to the provider) and then finishes the turn.
 */
async function captureVisibleTools(harness: Harness): Promise<string[]> {
	let visibleTools: string[] = [];
	harness.setResponses([
		(context) => {
			visibleTools = (context.tools ?? []).map((tool) => tool.name);
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt("list your tools");
	expect(getAssistantTexts(harness)).toContain("done");
	return visibleTools;
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

describe("AgentSession tool visibility filtering", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("policy mode removes a hide-rule tool from the model-visible tools", async () => {
		const harness = await createHarness({
			settings: policySettings([{ tool: "bash", effect: "deny", hide: true }]),
		});
		harnesses.push(harness);

		// Default active tools are read/bash/edit/write; bash is hidden.
		expect(await captureVisibleTools(harness)).toEqual(["read", "edit", "write"]);
	});

	it("policy mode keeps a deny-only (no hide) tool visible but blocked", async () => {
		const harness = await createHarness({
			settings: policySettings([{ tool: "bash", effect: "deny" }]),
		});
		harnesses.push(harness);

		expect(await captureVisibleTools(harness)).toEqual(["read", "bash", "edit", "write"]);
	});

	it("a hidden tool stays registered and returns after its hide rule is removed", async () => {
		const harness = await createHarness({
			settings: policySettings([{ tool: "bash", effect: "deny", hide: true }]),
		});
		harnesses.push(harness);

		// Hidden from the model-visible list...
		expect(await captureVisibleTools(harness)).toEqual(["read", "edit", "write"]);
		// ...but still in the internal registry.
		expect(harness.session.getToolDefinition("bash")?.name).toBe("bash");

		// An extension saves the filtered active list and restores it later:
		// the hidden tool must not be stranded by the restore.
		const saved = harness.session.getActiveToolNames();
		expect(saved).toEqual(["read", "edit", "write"]);
		harness.session.setActiveToolsByName(saved);
		expect(harness.session.getActiveToolNames()).toEqual(["read", "edit", "write"]);

		// Removing the hide rule restores the tool on the next active-tool change.
		harness.settingsManager.setPermissionRules([]);
		harness.session.setActiveToolsByName(saved);
		expect(harness.session.getActiveToolNames()).toEqual(["read", "edit", "write", "bash"]);
	});

	it("legacy mode never hides, even with a hide rule", async () => {
		const harness = await createHarness({
			settings: {
				tools: { permissions: { mode: "legacy", rules: [{ tool: "bash", effect: "deny", hide: true }] } },
			},
		});
		harnesses.push(harness);

		expect(await captureVisibleTools(harness)).toEqual(["read", "bash", "edit", "write"]);
	});

	it("a stale call to a hidden tool fails with a not-found error instead of executing", async () => {
		const harness = await createHarness({
			settings: policySettings([{ tool: "bash", effect: "deny", hide: true }]),
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf stale-probe" }, { id: "call_hidden_1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run bash anyway");

		// The tool is not in context.tools, so the agent loop rejects the call
		// before the permission policy runs: terminal "not found" error result.
		const toolResult = getToolResult(harness);
		expect(toolResult.isError).toBe(true);
		const text = getToolResultText(harness);
		expect(text).toContain("not found");
		expect(text).not.toContain("stale-probe");
		expect(getAssistantTexts(harness)).toContain("done");
	});

	it("the review profile hides write and process tools and keeps read visible and callable", async () => {
		const harness = await createHarness({ settings: policySettings([], "review") });
		harnesses.push(harness);
		const probePath = join(harness.tempDir, "review-probe.txt");
		writeFileSync(probePath, "review-probe-content\n");

		expect(await captureVisibleTools(harness)).toEqual(["read"]);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: probePath }, { id: "call_review_read" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read the probe file");

		expect(getToolResult(harness).isError ?? false).toBe(false);
		expect(getToolResultText(harness)).toContain("review-probe-content");
	});

	it("the review profile blocks bash calls: the hidden tool is not found, never executed", async () => {
		const harness = await createHarness({ settings: policySettings([], "review") });
		harnesses.push(harness);

		await runBashToolCall(harness, "call_review_bash");

		const toolResult = getToolResult(harness);
		expect(toolResult.isError).toBe(true);
		const text = getToolResultText(harness);
		expect(text).toContain("not found");
		expect(text).not.toContain("permission-probe");
	});

	it("legacy mode ignores the review profile entirely", async () => {
		const harness = await createHarness({
			settings: { tools: { permissions: { mode: "legacy", profile: "review" } } },
		});
		harnesses.push(harness);

		// Nothing hidden...
		expect(await captureVisibleTools(harness)).toEqual(["read", "bash", "edit", "write"]);

		// ...and bash executes without evaluation.
		await runBashToolCall(harness, "call_legacy_review");
		expect(getToolResultText(harness)).toContain("permission-probe");
	});

	it("a user allow rule overrides the review profile for that tool", async () => {
		const harness = await createHarness({
			settings: policySettings([{ tool: "write", effect: "allow" }], "review"),
		});
		harnesses.push(harness);
		const probePath = join(harness.tempDir, "override-probe.txt");

		// write is visible again (and only the non-overridden tools stay hidden)
		expect(await captureVisibleTools(harness)).toEqual(["read", "write"]);

		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("write", { path: probePath, content: "override-probe" }, { id: "call_override_1" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write the probe file");

		expect(getToolResult(harness).isError ?? false).toBe(false);
		expect(existsSync(probePath)).toBe(true);
	});

	it("the minimal profile hides bash/edit/write but not read", async () => {
		const harness = await createHarness({ settings: policySettings([], "minimal") });
		harnesses.push(harness);

		expect(await captureVisibleTools(harness)).toEqual(["read"]);
	});
});
