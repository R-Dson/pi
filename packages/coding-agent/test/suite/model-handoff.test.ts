import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import modelHandoff from "../../src/extensions/model-handoff.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

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

function assistantModels(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => (message as AssistantMessage).model);
}

function toolResultTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => getMessageText(message));
}

describe("model-handoff built-in (#107)", () => {
	it("activates with two resolvable tiers and lists them in the prompt", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
			],
			extensionFactories: [modelHandoff],
		});
		harnesses.push(harness);
		pointConfigAt(harness, {
			smart: { provider: "faux", modelId: "faux-1", description: "plans and reviews" },
			fast: { provider: "faux", modelId: "faux-2", description: "mechanical edits" },
		});
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		let providerSystemPrompt = "";
		let switchModelDescription = "";
		let targetSchema = "";
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				const tool = context.tools?.find((candidate) => candidate.name === "switch_model");
				switchModelDescription = tool?.description ?? "";
				targetSchema = JSON.stringify(
					(tool?.parameters as { properties?: { target?: unknown } } | undefined)?.properties?.target,
				);
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("hello");

		expect(providerSystemPrompt).toContain("switch_model");
		expect(providerSystemPrompt).toContain("task boundaries");
		expect(switchModelDescription).toContain("smart: faux/faux-1");
		expect(switchModelDescription).toContain("plans and reviews");
		expect(switchModelDescription).toContain("fast: faux/faux-2");
		expect(switchModelDescription).toContain("mechanical edits");
		// The target is an enum of exactly the configured tiers, so the model
		// cannot name an unconfigured model.
		expect(targetSchema).toContain('"smart"');
		expect(targetSchema).toContain('"fast"');
	});

	it("hands the baton to the target tier inside the same run", async () => {
		const modelSelects: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
			],
			extensionFactories: [
				modelHandoff,
				(pi) => {
					pi.on("model_select", async (event) => {
						modelSelects.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
					});
				},
			],
		});
		harnesses.push(harness);
		pointConfigAt(harness, {
			smart: { provider: "faux", modelId: "faux-1" },
			fast: { provider: "faux", modelId: "faux-2" },
		});
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

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
				targetRequestSawBaton = JSON.stringify(context.messages).includes("Handed off from");
				return fauxAssistantMessage("fast done");
			},
		]);
		await harness.session.prompt("delegate this");

		// The run continued on the target model: same run, next assistant turn.
		expect(assistantModels(harness)).toEqual(["faux-1", "faux-2"]);
		expect(getAssistantTexts(harness).at(-1)).toBe("fast done");
		// The baton: the tool result carries who, why, and the brief.
		expect(toolResultTexts(harness).join("\n")).toContain("faux/faux-1");
		expect(toolResultTexts(harness).join("\n")).toContain("fast (faux/faux-2)");
		expect(toolResultTexts(harness).join("\n")).toContain("mechanical from here");
		expect(toolResultTexts(harness).join("\n")).toContain("apply the plan");
		// Persistence and events, exactly as a manual switch.
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => `${entry.provider}/${entry.modelId}`),
		).toEqual(["faux/faux-2"]);
		expect(modelSelects).toEqual(["faux-1->faux-2:set"]);
		expect(targetRequestHadTool).toBe(true);
		expect(targetRequestSawBaton).toBe(true);
		// Cache accounting: announced as model-change, no surprise invalidation.
		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({ "model-change": 1 });
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("is absent without a config file: system prompt unchanged", async () => {
		const capturePrompt = async (
			withExtension: boolean,
		): Promise<{ prompt: string; cwd: string; switchModelTool: boolean }> => {
			const harness = await createHarness({
				models: [
					{ id: "faux-1", name: "One" },
					{ id: "faux-2", name: "Two" },
				],
				extensionFactories: withExtension ? [modelHandoff] : [],
			});
			harnesses.push(harness);
			pointConfigAt(harness, null);
			await harness.session.bindExtensions({ shutdownHandler: () => {} });
			let prompt = "";
			let switchModelTool = false;
			harness.setResponses([
				(context) => {
					prompt = context.systemPrompt ?? "";
					switchModelTool = context.tools?.some((tool) => tool.name === "switch_model") ?? false;
					return fauxAssistantMessage("ok");
				},
			]);
			await harness.session.prompt("hello");
			return { prompt, cwd: harness.tempDir, switchModelTool };
		};

		const withExtension = await capturePrompt(true);
		const withoutExtension = await capturePrompt(false);
		expect(withExtension.switchModelTool).toBe(false);
		// The prompt embeds the cwd (forward-slashed on Windows); normalize both forms.
		const normalize = ({ prompt, cwd }: { prompt: string; cwd: string }) =>
			prompt.split(cwd).join("<cwd>").split(cwd.replace(/\\/g, "/")).join("<cwd>");
		expect(normalize(withExtension)).toBe(normalize(withoutExtension));
	});

	it("stays inactive with a warning when fewer than two tiers resolve", async () => {
		const notifications: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
			],
			extensionFactories: [modelHandoff],
		});
		harnesses.push(harness);
		pointConfigAt(harness, {
			fast: { provider: "faux", modelId: "faux-2" },
			ghost: { provider: "faux", modelId: "faux-ghost" },
		});
		await harness.session.bindExtensions({
			uiContext: {
				notify: (message: string) => notifications.push(message),
			} as unknown as ExtensionUIContext,
		});

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
		expect(notifications.join("\n")).toContain("found 1");
		expect(providerSystemPrompt).not.toContain("switch_model");
		expect(switchModelTool).toBe(false);
	});
});
