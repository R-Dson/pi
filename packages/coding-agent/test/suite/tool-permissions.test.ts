import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "../../src/core/settings-manager.ts";
import type { PermissionRule, ToolProfile } from "../../src/core/tools/permissions.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

/**
 * Settings as a v0.84.3-fork.3 settings file would carry them: the
 * `tools.permissions` keys are untyped JSON at runtime and unknown to the
 * current Settings type, which is the point of these tests.
 */
function stalePolicySettings(rules: PermissionRule[], profile?: ToolProfile): Partial<Settings> {
	return {
		tools: { permissions: { mode: "policy", rules, ...(profile ? { profile } : {}) } },
	} as unknown as Partial<Settings>;
}

/**
 * Core performs no permission enforcement (fork issue #70): rule evaluation
 * and tool hiding ship as the permission-policies extension, and settings
 * carrying `tools.permissions` keys are ignored like any unknown setting.
 */
describe("core ignores tools.permissions settings", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("executes a tool that a policy-mode deny rule would block", async () => {
		const harness = await createHarness({
			settings: stalePolicySettings([{ capability: "process.execute", effect: "deny" }]),
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "printf permission-probe" }, { id: "call_deny_ignored" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run the bash tool");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult") as
			| ToolResultMessage
			| undefined;
		expect(toolResult).toBeDefined();
		expect(toolResult?.isError ?? false).toBe(false);
		const text = (toolResult?.content ?? [])
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(text).toContain("permission-probe");
		expect(getAssistantTexts(harness)).toContain("done");
	});

	it("keeps every tool model-visible under policy-mode hide rules and profiles", async () => {
		const harness = await createHarness({
			settings: stalePolicySettings([{ tool: "bash", effect: "deny", hide: true }], "minimal"),
		});
		harnesses.push(harness);

		let visibleTools: string[] = [];
		harness.setResponses([
			(context) => {
				visibleTools = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("list your tools");

		expect(getAssistantTexts(harness)).toContain("done");
		expect(visibleTools).toEqual(["read", "bash", "edit", "write"]);
	});
});
