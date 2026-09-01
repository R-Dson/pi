import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import modelHandoff, { handoffCallSummary } from "../../src/extensions/model-handoff.ts";
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

function writeProjectConfig(harness: Harness, contents: string): void {
	const dir = join(harness.tempDir, ".pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "handoff.json"), contents);
}

/** UI context capturing notify calls, for asserting warnings. */
function captureNotify(): { notifications: string[]; uiContext: ExtensionUIContext } {
	const notifications: string[] = [];
	return {
		notifications,
		uiContext: { notify: (message: string) => notifications.push(message) } as unknown as ExtensionUIContext,
	};
}

const threeModels = [
	{ id: "faux-1", name: "One" },
	{ id: "faux-2", name: "Two" },
	{ id: "faux-3", name: "Three" },
];

/** Harness with the handoff extension loaded and its config pointed at a temp file. */
async function setupHandoff(
	tiers: Record<string, unknown> | null,
	options: {
		models?: HarnessOptions["models"];
		factories?: HarnessOptions["extensionFactories"];
		uiContext?: ExtensionUIContext;
		untrusted?: boolean;
	} = {},
): Promise<Harness> {
	const harness = await createHarness({
		models: options.models ?? [
			{ id: "faux-1", name: "One" },
			{ id: "faux-2", name: "Two" },
		],
		extensionFactories: [modelHandoff, ...(options.factories ?? [])],
	});
	harnesses.push(harness);
	pointConfigAt(harness, tiers);
	if (options.untrusted) harness.settingsManager.setProjectTrusted(false);
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

function assistantModelIds(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => (message as AssistantMessage).model);
}

function toolResultTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => getMessageText(message));
}

function modelChanges(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "model_change")
		.map((entry) => `${entry.provider}/${entry.modelId}`);
}

/** A refused handoff: both assistant turns stayed on the start model, nothing switched. */
function expectStayedPut(harness: Harness, ...resultContains: string[]): void {
	expect(assistantModelIds(harness)).toEqual(["faux-1", "faux-1"]);
	const results = toolResultTexts(harness).join("\n");
	for (const fragment of resultContains) {
		expect(results).toContain(fragment);
	}
	expect(modelChanges(harness)).toEqual([]);
}

/** A scripted assistant turn whose only content is a switch_model tool call. */
function handoffTurn(
	target: string,
	args: { reason?: string; brief?: string; returnAfterRun?: boolean } = {},
	id?: string,
) {
	return fauxAssistantMessage(
		[fauxToolCall("switch_model", { target, reason: args.reason ?? "hand off", ...args }, id ? { id } : undefined)],
		{ stopReason: "toolUse" },
	);
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
		expect(assistantModelIds(harness)).toEqual(["faux-1", "faux-2"]);
		expect(getAssistantTexts(harness).at(-1)).toBe("fast done");
		// The baton: the tool result carries who, why, and the brief.
		const baton = toolResultTexts(harness).join("\n");
		expect(baton).toContain("faux/faux-1");
		expect(baton).toContain("fast (faux/faux-2)");
		expect(baton).toContain("mechanical from here");
		expect(baton).toContain("apply the plan");
		// Persistence and events, exactly as a manual switch.
		expect(modelChanges(harness)).toEqual(["faux/faux-2"]);
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

describe("model-handoff guards (#108)", () => {
	it("returns a no-op for a tier that is already the active model", async () => {
		const recorder = modelSelectRecorder();
		const harness = await setupHandoff(
			{
				smart: { provider: "faux", modelId: "faux-1" },
				fast: { provider: "faux", modelId: "faux-2" },
			},
			{ factories: [recorder.factory] },
		);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("switch_model", { target: "smart", reason: "already here" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("still me"),
		]);
		await harness.session.prompt("try a no-op");

		expectStayedPut(harness, "already the active model");
		expect(recorder.selects).toEqual([]);
		expect(harness.session.getSessionStats().prefixInvalidationsByCause ?? {}).toEqual({});
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("refuses an in-run bounce and allows the reverse handoff in a fresh run", async () => {
		const recorder = modelSelectRecorder();
		const harness = await setupHandoff(
			{
				smart: { provider: "faux", modelId: "faux-1" },
				fast: { provider: "faux", modelId: "faux-2" },
			},
			{ factories: [recorder.factory] },
		);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("switch_model", { target: "fast", reason: "mechanical now" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("switch_model", { target: "smart", reason: "bouncing back" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done on fast"),
		]);
		await harness.session.prompt("bounce around");

		// The bounce was refused with nothing announced: the third turn is still
		// fast, and only the first handoff switched anything.
		expect(assistantModelIds(harness)).toEqual(["faux-1", "faux-2", "faux-2"]);
		expect(toolResultTexts(harness).join("\n")).toContain("held the baton");
		expect(modelChanges(harness)).toEqual(["faux/faux-2"]);
		expect(recorder.selects).toEqual(["faux-1->faux-2:set"]);
		expect(harness.session.getSessionStats().prefixInvalidationsByCause ?? {}).toEqual({ "model-change": 1 });
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("switch_model", { target: "smart", reason: "new run, allowed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("back on smart"),
		]);
		await harness.session.prompt("hand back later");

		expect(modelChanges(harness)).toEqual(["faux/faux-2", "faux/faux-1"]);
		expect(recorder.selects).toEqual(["faux-1->faux-2:set", "faux-2->faux-1:set"]);
		expect(assistantModelIds(harness).at(-1)).toBe("faux-1");
	});

	it("refuses a multi-hop bounce back to any earlier holder in the run", async () => {
		const harness = await setupHandoff(
			{
				smart: { provider: "faux", modelId: "faux-1" },
				fast: { provider: "faux", modelId: "faux-2" },
				tiny: { provider: "faux", modelId: "faux-3" },
			},
			{
				models: [
					{ id: "faux-1", name: "One" },
					{ id: "faux-2", name: "Two" },
					{ id: "faux-3", name: "Three" },
				],
			},
		);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("switch_model", { target: "fast", reason: "step one" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("switch_model", { target: "tiny", reason: "step two" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("switch_model", { target: "smart", reason: "hop back to start" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done on tiny"),
		]);
		await harness.session.prompt("hop around");

		expect(assistantModelIds(harness)).toEqual(["faux-1", "faux-2", "faux-3", "faux-3"]);
		expect(toolResultTexts(harness).join("\n")).toContain("held the baton");
		expect(modelChanges(harness)).toEqual(["faux/faux-2", "faux/faux-3"]);
	});

	it("stays put and reports when the target provider has no credentials", async () => {
		// A second faux provider registered without an apiKey: resolvable in the
		// registry (so activation passes) but never authenticated, so the switch
		// is refused at the auth check. Deleting stored credentials mid-run does
		// not drive this: the harness's faux provider carries an embedded key.
		const keyless = registerFauxProvider({
			provider: "faux-keyless",
			models: [{ id: "faux-keyless-1", name: "Keyless" }],
		});
		try {
			const harness = await setupHandoff(
				{
					smart: { provider: "faux", modelId: "faux-1" },
					ghost: { provider: "faux-keyless", modelId: "faux-keyless-1" },
				},
				{
					factories: [
						(pi) => {
							pi.registerProvider("faux-keyless", {
								baseUrl: keyless.models[0].baseUrl,
								api: keyless.api,
								models: keyless.models.map((model) => ({
									id: model.id,
									name: model.name,
									reasoning: model.reasoning,
									input: model.input,
									cost: model.cost,
									contextWindow: model.contextWindow,
									maxTokens: model.maxTokens,
								})),
							});
						},
					],
				},
			);

			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("switch_model", { target: "ghost", reason: "go keyless" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("stayed put"),
			]);
			await harness.session.prompt("escalate");

			expectStayedPut(harness, "no credentials for faux-keyless/faux-keyless-1", "staying on the current model");
		} finally {
			keyless.unregister();
		}
	});

	it("stays put and names the tier when it is gone from the registry at call time", async () => {
		const harness = await setupHandoff(
			{
				smart: { provider: "faux", modelId: "faux-1" },
				fast: { provider: "faux", modelId: "faux-2" },
			},
			{
				factories: [
					(pi) => {
						pi.on("agent_start", (_event, ctx) => {
							ctx.modelRegistry.unregisterProvider("faux");
						});
					},
				],
			},
		);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("switch_model", { target: "fast", reason: "go faster" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("stayed put"),
		]);
		await harness.session.prompt("escalate");

		expectStayedPut(harness, 'tier "fast" is not available');
	});
});

describe("model-handoff returnAfterRun (#109)", () => {
	const threeTiers = {
		smart: { provider: "faux", modelId: "faux-1" },
		fast: { provider: "faux", modelId: "faux-2" },
		tiny: { provider: "faux", modelId: "faux-3" },
	};

	it("returns control to the requester when the run settles, once, without a new prompt", async () => {
		const recorder = modelSelectRecorder();
		const harness = await setupHandoff(
			{
				smart: { provider: "faux", modelId: "faux-1" },
				fast: { provider: "faux", modelId: "faux-2" },
			},
			{ factories: [recorder.factory] },
		);

		harness.setResponses([
			handoffTurn("fast", { reason: "mechanical work", returnAfterRun: true }, "handoff-1"),
			fauxAssistantMessage("done on fast"),
		]);
		await harness.session.prompt("delegate");

		// The return fired at settle: the session is back on the requester, with
		// the full setModel side effects, and no extra assistant turn happened.
		expect(harness.session.model?.id).toBe("faux-1");
		expect(modelChanges(harness)).toEqual(["faux/faux-2", "faux/faux-1"]);
		expect(recorder.selects).toEqual(["faux-1->faux-2:set", "faux-2->faux-1:set"]);
		expect(assistantModelIds(harness)).toEqual(["faux-1", "faux-2"]);

		// The slot cleared: a plain later run settles without switching back again,
		// is answered by the requester, and materializes the return's invalidation.
		harness.setResponses([fauxAssistantMessage("plain turn")]);
		await harness.session.prompt("plain");
		expect(harness.session.model?.id).toBe("faux-1");
		expect(assistantModelIds(harness).at(-1)).toBe("faux-1");
		expect(modelChanges(harness)).toEqual(["faux/faux-2", "faux/faux-1"]);
		expect(harness.session.getSessionStats().prefixInvalidationsByCause ?? {}).toEqual({ "model-change": 2 });
	});

	it("a later handoff without the flag cancels the pending return", async () => {
		const harness = await setupHandoff(threeTiers, { models: threeModels });

		harness.setResponses([
			handoffTurn("fast", { reason: "step one", returnAfterRun: true }),
			handoffTurn("tiny", { reason: "step two" }),
			fauxAssistantMessage("done on tiny"),
		]);
		await harness.session.prompt("chain");

		expect(harness.session.model?.id).toBe("faux-3");
		expect(modelChanges(harness)).toEqual(["faux/faux-2", "faux/faux-3"]);
	});

	it("a later handoff with the flag replaces the pending return with the newer requester", async () => {
		const harness = await setupHandoff(threeTiers, { models: threeModels });

		harness.setResponses([
			handoffTurn("fast", { reason: "step one", returnAfterRun: true }),
			handoffTurn("tiny", { reason: "step two", returnAfterRun: true }),
			fauxAssistantMessage("done on tiny"),
		]);
		await harness.session.prompt("chain");

		expect(harness.session.model?.id).toBe("faux-2");
		expect(modelChanges(harness)).toEqual(["faux/faux-2", "faux/faux-3", "faux/faux-2"]);
	});

	it("a no-op switch records no pending return", async () => {
		const harness = await setupHandoff(threeTiers, { models: threeModels });

		harness.setResponses([
			handoffTurn("smart", { reason: "already here", returnAfterRun: true }),
			fauxAssistantMessage("still me"),
		]);
		await harness.session.prompt("no-op");

		expectStayedPut(harness, "already the active model");
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("a manual switch cancels the pending return", async () => {
		const manual: { switch: () => Promise<void> } = { switch: async () => {} };
		const harness = await setupHandoff(threeTiers, {
			models: threeModels,
			factories: [
				(pi) => {
					pi.on("tool_result", async (event) => {
						if (event.toolCallId === "handoff-1") await manual.switch();
					});
				},
			],
		});
		const target = harness.getModel("faux-3");
		if (!target) throw new Error("faux-3 missing");
		manual.switch = async () => {
			await harness.session.setModel(target);
		};

		harness.setResponses([
			handoffTurn("fast", { reason: "delegate", returnAfterRun: true }, "handoff-1"),
			fauxAssistantMessage("done on fast"),
		]);
		await harness.session.prompt("delegate then user switches");

		// The user's mid-run choice survives the settle: no return to faux-1.
		expect(harness.session.model?.id).toBe("faux-3");
		expect(modelChanges(harness)).toEqual(["faux/faux-2", "faux/faux-3"]);
	});

	it("stays put with a warning when the requester is gone at settle time", async () => {
		const notifications: string[] = [];
		// The handoff itself succeeds, then the tool_result hook unregisters the
		// provider, so the requester (faux-1) is unresolvable when settle fires.
		const harness = await setupHandoff(threeTiers, {
			models: threeModels,
			uiContext: {
				notify: (message: string) => notifications.push(message),
			} as unknown as ExtensionUIContext,
			factories: [
				(pi) => {
					pi.on("tool_result", (_event, ctx) => {
						ctx.modelRegistry.unregisterProvider("faux");
					});
				},
			],
		});

		harness.setResponses([
			handoffTurn("fast", { reason: "delegate", returnAfterRun: true }, "handoff-1"),
			fauxAssistantMessage("done on fast"),
		]);
		await harness.session.prompt("delegate");

		expect(harness.session.model?.id).toBe("faux-2");
		expect(notifications.join("\n")).toContain("model-handoff");
	});
});

describe("model-handoff project config (#110)", () => {
	const threeModels = [
		{ id: "faux-1", name: "One" },
		{ id: "faux-2", name: "Two" },
		{ id: "faux-3", name: "Three" },
	];

	it("merges project tiers with machine tiers, project winning on collision", async () => {
		const harness = await setupHandoff({ smart: { provider: "faux", modelId: "faux-1" } }, { models: threeModels });
		writeProjectConfig(
			harness,
			JSON.stringify({
				tiers: { smart: { provider: "faux", modelId: "faux-2" }, fast: { provider: "faux", modelId: "faux-3" } },
			}),
		);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		harness.setResponses([
			handoffTurn("smart", { reason: "collision should follow the project file" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("delegate");

		expect(assistantModelIds(harness)).toEqual(["faux-1", "faux-2"]);
		expect(modelChanges(harness)).toEqual(["faux/faux-2"]);
	});

	it("ignores the project file entirely in an untrusted project", async () => {
		const harness = await setupHandoff(
			{
				smart: { provider: "faux", modelId: "faux-1" },
				fast: { provider: "faux", modelId: "faux-2" },
			},
			{ models: threeModels, untrusted: true },
		);
		writeProjectConfig(harness, JSON.stringify({ tiers: { tiny: { provider: "faux", modelId: "faux-3" } } }));
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		let switchModel = "";
		harness.setResponses([
			(context) => {
				switchModel = JSON.stringify(context.tools?.find((tool) => tool.name === "switch_model"));
				return handoffTurn("fast", { reason: "machine tiers still work" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("delegate");

		expect(switchModel).toContain('"fast"');
		expect(switchModel).not.toContain("tiny");
		expect(assistantModelIds(harness)).toEqual(["faux-1", "faux-2"]);
	});

	it("re-registers with a regenerated enum when a reload adds a tier", async () => {
		const harness = await setupHandoff(
			{
				smart: { provider: "faux", modelId: "faux-1" },
				fast: { provider: "faux", modelId: "faux-2" },
			},
			{ models: threeModels },
		);
		writeProjectConfig(harness, JSON.stringify({ tiers: { tiny: { provider: "faux", modelId: "faux-3" } } }));
		// session.reload() would invalidate the harness's frozen extension
		// runtime; a second bindExtensions fires session_start on the live
		// runner, which is the re-read-and-re-register path this tests.
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		harness.setResponses([
			handoffTurn("tiny", { reason: "new tier from the reloaded config" }),
			fauxAssistantMessage("done on tiny"),
		]);
		await harness.session.prompt("delegate");

		expect(assistantModelIds(harness)).toEqual(["faux-1", "faux-3"]);
		expect(modelChanges(harness)).toEqual(["faux/faux-3"]);
	});

	it("deactivates on reload when the merged set drops below two tiers, and reactivates when it grows back", async () => {
		const { notifications, uiContext } = captureNotify();
		const harness = await setupHandoff(
			{
				smart: { provider: "faux", modelId: "faux-1" },
				fast: { provider: "faux", modelId: "faux-2" },
			},
			{ uiContext },
		);
		pointConfigAt(harness, { smart: { provider: "faux", modelId: "faux-1" } });
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

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
		expect(notifications.join("\n")).toContain("found 1");

		// Growing back re-registers and reactivates: the subtraction is undone.
		pointConfigAt(harness, {
			smart: { provider: "faux", modelId: "faux-1" },
			fast: { provider: "faux", modelId: "faux-2" },
		});
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		harness.setResponses([handoffTurn("fast", { reason: "back in business" }), fauxAssistantMessage("done")]);
		await harness.session.prompt("delegate again");

		expect(assistantModelIds(harness)).toEqual(["faux-1", "faux-1", "faux-2"]);
		expect(modelChanges(harness)).toEqual(["faux/faux-2"]);
	});

	it("treats an unreadable project file as absent with a warning", async () => {
		const { notifications, uiContext } = captureNotify();
		const harness = await setupHandoff(
			{
				smart: { provider: "faux", modelId: "faux-1" },
				fast: { provider: "faux", modelId: "faux-2" },
			},
			{ uiContext },
		);
		writeProjectConfig(harness, "{ not json");
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		harness.setResponses([handoffTurn("fast", { reason: "machine tiers still work" }), fauxAssistantMessage("done")]);
		await harness.session.prompt("delegate");

		expect(notifications.join("\n")).toContain("unreadable");
		expect(assistantModelIds(harness)).toEqual(["faux-1", "faux-2"]);
	});

	it("treats an unreadable machine file as absent with a warning", async () => {
		const { notifications, uiContext } = captureNotify();
		const harness = await setupHandoff(
			{
				smart: { provider: "faux", modelId: "faux-1" },
				fast: { provider: "faux", modelId: "faux-2" },
			},
			{ uiContext },
		);
		const machinePath = process.env[CONFIG_ENV];
		if (!machinePath) throw new Error("machine config path missing");
		writeFileSync(machinePath, "[not an object");
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		let switchModelTool = false;
		harness.setResponses([
			(context) => {
				switchModelTool = context.tools?.some((tool) => tool.name === "switch_model") ?? false;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("hello");

		expect(notifications.join("\n")).toContain("unreadable");
		expect(switchModelTool).toBe(false);
	});
});

describe("model-handoff call row (#111)", () => {
	it("shows tier and reason on one collapsed line, brief only when expanded", () => {
		const args = { target: "fast", reason: "mechanical now", brief: "apply the plan" };
		expect(handoffCallSummary(args, false)).toBe("Handoff -> fast: mechanical now");
		expect(handoffCallSummary(args, true)).toBe("Handoff -> fast: mechanical now\nBrief: apply the plan");
		expect(handoffCallSummary(args, true, "faux/faux-2")).toBe(
			"Handoff -> fast (faux/faux-2): mechanical now\nBrief: apply the plan",
		);
		expect(handoffCallSummary({ target: "fast" }, true)).toBe("Handoff -> fast");
		expect(handoffCallSummary({}, false)).toBe("Handoff -> ?");
	});
});

describe("model-handoff settle window (#122)", () => {
	it("a prompt arriving during the settle emission is answered by the returned model, not the delegatee", async () => {
		// The settling extension loads BEFORE model-handoff so its handler runs
		// first; the prompt is queued as a microtask so it lands while the
		// settle emission is still in flight (idle already reported, by
		// contract) but from outside any handler. Fire once: the late run's own
		// settle re-triggers handlers otherwise.
		let fired = false;
		let lateRun: Promise<unknown> | undefined;
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
			],
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (fired) return;
						fired = true;
						queueMicrotask(() => {
							lateRun = harness.session.prompt("late question");
						});
					});
				},
				modelHandoff,
			],
		});
		harnesses.push(harness);
		pointConfigAt(harness, {
			smart: { provider: "faux", modelId: "faux-1" },
			fast: { provider: "faux", modelId: "faux-2" },
		});
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		harness.setResponses([
			handoffTurn("fast", { reason: "delegate", returnAfterRun: true }),
			fauxAssistantMessage("done on fast"),
			fauxAssistantMessage("late answer"),
		]);
		await harness.session.prompt("delegate");
		if (lateRun) await lateRun;
		else await harness.session.waitForIdle();

		// The handoff turn, the delegate's turn, and the late prompt answered by
		// the returned model.
		expect(assistantModelIds(harness)).toEqual(["faux-1", "faux-2", "faux-1"]);
		expect(getAssistantTexts(harness).at(-1)).toBe("late answer");
		expect(modelChanges(harness)).toEqual(["faux/faux-2", "faux/faux-1"]);
	});
});
