import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import modelHandoff from "../../src/extensions/model-handoff.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

// #107: machine-wide model handoff. The config is pointed at a temp file via
// the env seam (PI_HANDOFF_GLOBAL) so nothing reads or writes ~/.pi/agent.
const CONFIG_ENV = "PI_HANDOFF_GLOBAL";

const harnesses: Harness[] = [];

afterEach(() => {
	delete process.env[CONFIG_ENV];
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

function pointConfigAt(harness: Harness, tiers: Record<string, unknown> | null): void {
	const path = join(harness.tempDir, "handoff.json");
	if (tiers !== null) {
		writeFileSync(path, JSON.stringify({ tiers }));
	}
	process.env[CONFIG_ENV] = path;
}

/** Harness with the handoff extension loaded and its config pointed at a temp file. */
async function setupHandoff(
	tiers: Record<string, unknown> | null,
	options: { factories?: HarnessOptions["extensionFactories"]; uiContext?: ExtensionUIContext } = {},
): Promise<Harness> {
	const harness = await createHarness({
		models: [
			{ id: "faux-1", name: "One" },
			{ id: "faux-2", name: "Two" },
		],
		extensionFactories: [modelHandoff, ...(options.factories ?? [])],
	});
	harnesses.push(harness);
	pointConfigAt(harness, tiers);
	await harness.session.bindExtensions(
		options.uiContext ? { uiContext: options.uiContext } : { shutdownHandler: () => {} },
	);
	return harness;
}

/** Extra extension recording model_select transitions as "from->to:source" strings. */
function modelSelectRecorder() {
	const selects: string[] = [];
	return {
		selects,
		factory: (pi: ExtensionAPI) => {
			pi.on("model_select", async (event) => {
				selects.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
			});
		},
	};
}

describe("model-handoff built-in (#107)", () => {
	it("activates with two resolvable tiers and lists them in the prompt", async () => {
		const harness = await setupHandoff({
			smart: { provider: "faux", modelId: "faux-1", description: "plans and reviews" },
			fast: { provider: "faux", modelId: "faux-2", description: "mechanical edits" },
		});

		let providerSystemPrompt = "";
		let switchModel = "";
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				switchModel = JSON.stringify(context.tools?.find((tool) => tool.name === "switch_model"));
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("hello");

		expect(providerSystemPrompt).toContain("switch_model");
		expect(providerSystemPrompt).toContain("task boundaries");
		expect(switchModel).toContain("smart: faux/faux-1");
		expect(switchModel).toContain("plans and reviews");
		expect(switchModel).toContain("fast: faux/faux-2");
		expect(switchModel).toContain("mechanical edits");
		// The target parameter admits exactly the configured tiers.
		expect(switchModel).toContain('"smart"');
		expect(switchModel).toContain('"fast"');
	});

	it("hands the baton to the target tier inside the same run", async () => {
		const recorder = modelSelectRecorder();
		const harness = await setupHandoff(
			{
				smart: { provider: "faux", modelId: "faux-1" },
				fast: { provider: "faux", modelId: "faux-2" },
			},
			{ factories: [recorder.factory] },
		);

		let targetRequestHadTool = false;
		let targetRequestSawBaton = false;
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("switch_model", { target: "fast", reason: "mechanical from here", brief: "apply the plan" })],
				{ stopReason: "toolUse" },
			),
			(context) => {
				// The request made by the target model keeps the tool and carries
				// the baton tool result in its message history.
				targetRequestHadTool = context.tools?.some((tool) => tool.name === "switch_model") ?? false;
				targetRequestSawBaton = JSON.stringify(context.messages).includes("mechanical from here");
				return fauxAssistantMessage("fast done");
			},
		]);
		await harness.session.prompt("delegate this");

		// The run continued on the target model: same run, next assistant turn.
		const assistantModels = harness.session.messages
			.filter((message) => message.role === "assistant")
			.map((message) => (message as AssistantMessage).model);
		expect(assistantModels).toEqual(["faux-1", "faux-2"]);
		expect(getAssistantTexts(harness).at(-1)).toBe("fast done");
		// The baton: the tool result carries who, why, and the brief.
		const baton = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => getMessageText(message))
			.join("\n");
		expect(baton).toContain("faux/faux-1");
		expect(baton).toContain("fast (faux/faux-2)");
		expect(baton).toContain("mechanical from here");
		expect(baton).toContain("apply the plan");
		// Persistence and events, exactly as a manual switch.
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => `${entry.provider}/${entry.modelId}`),
		).toEqual(["faux/faux-2"]);
		expect(recorder.selects).toEqual(["faux-1->faux-2:set"]);
		expect(targetRequestHadTool).toBe(true);
		expect(targetRequestSawBaton).toBe(true);
		// Cache accounting: announced as model-change, no surprise invalidation.
		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({ "model-change": 1 });
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("is absent without a config file: no tool, no prompt bytes", async () => {
		const harness = await setupHandoff(null);

		let providerSystemPrompt = "";
		let switchModelTool = false;
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				switchModelTool = context.tools?.some((tool) => tool.name === "switch_model") ?? false;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("hello");

		expect(switchModelTool).toBe(false);
		expect(providerSystemPrompt).not.toContain("switch_model");
		expect(providerSystemPrompt).not.toContain("Hand the whole conversation");
	});

	it("stays inactive with a warning when fewer than two tiers resolve", async () => {
		const notifications: string[] = [];
		const harness = await setupHandoff(
			{
				fast: { provider: "faux", modelId: "faux-2" },
				ghost: { provider: "faux", modelId: "faux-ghost" },
			},
			{
				uiContext: {
					notify: (message: string) => notifications.push(message),
				} as unknown as ExtensionUIContext,
			},
		);

		let providerSystemPrompt = "";
		let switchModelTool = false;
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				switchModelTool = context.tools?.some((tool) => tool.name === "switch_model") ?? false;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("hello");

		expect(notifications.join("\n")).toContain("model-handoff");
		expect(notifications.join("\n")).toContain("faux-ghost");
		expect(providerSystemPrompt).not.toContain("switch_model");
		expect(switchModelTool).toBe(false);
	});
});
