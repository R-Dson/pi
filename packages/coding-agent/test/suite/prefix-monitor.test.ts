/**
 * Runtime prefix-stability monitor tests (cache plan phase B, issue #41;
 * settings-change announcements from issue #53; provider wire-rewrite
 * attribution from issue #56).
 *
 * Seam: AgentSession's public surface — getSessionStats() counters and the
 * `prefix_invalidated` diagnostic event. The monitor sits on the session's
 * streamFn wrapper, so every provider request (regular turns and the
 * phase-A replaying summarizer calls) flows through it. Normal turns must
 * record nothing; legitimate rewrites (compaction, model switch) must be
 * attributed to the announcing subsystem without a diagnostic event; an
 * extension rewriting earlier history must surface as unexpected with an
 * event.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function echoTool(): AgentTool {
	return {
		name: "bash",
		label: "Bash",
		description: "Echo a command back",
		parameters: Type.Object({ command: Type.String() }),
		execute: async (_toolCallId, params) => {
			const command =
				typeof params === "object" && params !== null && "command" in params ? String(params.command) : "";
			return {
				content: [{ type: "text", text: `ran:${command}` }],
				details: { command },
			};
		},
	};
}

describe("runtime prefix-stability monitor (issue #41)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records nothing and emits no event across normal turns", async () => {
		const harness = await createHarness({ tools: [echoTool()] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");

		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({});
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("attributes compaction invalidations to compaction without a diagnostic event", async () => {
		const harness = await createHarness({
			tools: [echoTool()],
			// keep ~10 tokens so the cut lands on the second turn's user message
			// (same shape as the phase-A replay test).
			settings: { compaction: { keepRecentTokens: 10 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("second reply"),
			fauxAssistantMessage("## Goal\ncheckpoint summary"),
			fauxAssistantMessage("third reply"),
		]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn ".repeat(20).trim());
		await harness.session.compact();
		// First regular request after compaction: rebuilt history, still announced.
		await harness.session.prompt("third turn");

		const stats = harness.session.getSessionStats();
		// One invalidation for the replaying summarizer call (it swaps the trailing
		// user turn for the instruction) and one for the post-compaction rebuilt
		// context — both announced by the compaction flow.
		expect(stats.prefixInvalidationsByCause).toEqual({ compaction: 2 });
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("surfaces a history-rewriting extension as unexpected with a diagnostic event", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => {
						// Rewrite the opening user message from the second request on,
						// deterministically, so exactly one consecutive-request diff diverges.
						if (event.messages.length < 2) return undefined;
						const messages = event.messages.map((message, index) =>
							index === 0 && message.role === "user"
								? {
										...message,
										content: [{ type: "text" as const, text: "rewritten opener" }],
									}
								: message,
						);
						return { messages };
					});
				},
			],
		});
		harnesses.push(harness);
		const captures: Context[] = [];
		const capture = (reply: string) => (context: Context) => {
			captures.push(context);
			return fauxAssistantMessage(reply);
		};
		harness.setResponses([capture("first reply"), capture("second reply"), capture("third reply")]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");
		await harness.session.prompt("third turn");

		expect(captures).toHaveLength(3);
		const events = harness.eventsOfType("prefix_invalidated");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ cause: "unexpected-history-change", firstDivergenceIndex: 0 });
		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({
			"unexpected-history-change": 1,
		});
	});

	it("attributes a model switch to model-change without a diagnostic event", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 100_000 },
				{ id: "faux-2", contextWindow: 100_000 },
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first turn");
		const secondModel = harness.getModel("faux-2");
		if (!secondModel) throw new Error("faux-2 model missing");
		await harness.session.setModel(secondModel);
		await harness.session.prompt("second turn");

		// The request bytes are unchanged by a model switch; the invalidation comes
		// from the model identity comparison and the setModel announcement.
		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({ "model-change": 1 });
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("attributes a mid-session blockImages toggle to settings-change without a diagnostic event", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		// The first request carries a real image; the toggle rewrites it (and the
		// rest of history) into placeholders on the next request.
		await harness.session.prompt("describe this", {
			images: [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }],
		});
		harness.settingsManager.setBlockImages(true);
		await harness.session.prompt("second turn");

		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({ "settings-change": 1 });
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("records nothing for a blockImages toggle that leaves the request unchanged", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		// No images in history: the value flip still announces, but the request
		// bytes are unchanged (append-only), so nothing is counted and the
		// announcement does not leak past the stable request.
		await harness.session.prompt("first turn");
		harness.settingsManager.setBlockImages(true);
		await harness.session.prompt("second turn");

		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({});
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("attributes a schema-only tool re-registration to tool-set-change without a diagnostic event (#120)", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const register = (value: string) => {
						pi.registerTool({
							name: "shape",
							label: "Shape",
							description: "Shaped tool",
							parameters: Type.Object({ v: Type.Literal(value) }),
							execute: async () => ({ content: [], details: undefined }),
						});
					};
					register("one");
					// Re-register between runs, like a config reload. A
					// message_end-timed re-registration lands at the user-message
					// boundary — before any request of the run — arming ahead of
					// the trivially stable first request, which clears the latch
					// per design (#127); attribution is pinned for the
					// between-runs timing real re-registrations use.
					pi.on("agent_settled", () => {
						register("two");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");

		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({ "tool-set-change": 1 });
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("counts nothing when a tool is re-registered with an unchanged schema (#120)", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const register = (description: string) => {
						pi.registerTool({
							name: "shape",
							label: "Shape",
							description,
							parameters: Type.Object({ v: Type.Literal("one") }),
							execute: async () => ({ content: [], details: undefined }),
						});
					};
					register("Shaped tool");
					// Also covers a description-only change: the monitor never
					// compares descriptions, so nothing may arm for it.
					pi.on("agent_settled", () => {
						register("Shaped tool, reworded");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");

		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({});
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});
});

describe("provider wire-rewrite attribution (issue #56)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/**
	 * Build a harness whose streamFn records the monitor-injected onWireRewrite
	 * observers and simulates an adapter wire rewrite by invoking the callback
	 * during the request whose 1-based index is in `fireOn` with `cause`.
	 */
	async function createFiringHarness(fireOn: number[], cause: string): Promise<Harness> {
		let observedRequests = 0;
		const harness = await createHarness({
			tools: [echoTool()],
			streamFn: async (model, context, options) => {
				observedRequests++;
				if (options?.onWireRewrite && fireOn.includes(observedRequests)) {
					// Simulate the adapter firing during request serialization,
					// as the Anthropic adapter does inside the stream call.
					options.onWireRewrite(cause);
				}
				return streamSimple(model, context, options);
			},
		});
		harnesses.push(harness);
		return harness;
	}

	it("counts a deferred-tool load reported during a dynamic-tool session's anchor request", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "load_more_tools",
					label: "Load More Tools",
					description: "Add another tool mid-run",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setActiveTools([...pi.getActiveTools(), "after_load"]);
						return {
							content: [{ type: "text", text: "loaded" }],
							details: {},
						};
					},
				});
				pi.registerTool({
					name: "after_load",
					label: "After Load",
					description: "Tool available after loading",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "after" }],
						details: {},
					}),
				});
			},
		];
		let observedRequests = 0;
		const harness = await createHarness({
			extensionFactories,
			streamFn: async (model, context, options) => {
				observedRequests++;
				if (observedRequests === 2) {
					// Request 2 is the first one carrying the added-tool marker
					// (the anthropic adapter anchors the deferred load here);
					// simulate that wire-rewrite report.
					options?.onWireRewrite?.("provider-deferred-tool-load");
				}
				return streamSimple(model, context, options);
			},
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["load_more_tools"]);
		harness.setResponses([
			() => fauxAssistantMessage(fauxToolCall("load_more_tools", {}), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("done"),
			() => fauxAssistantMessage("second turn reply"),
		]);

		await harness.session.prompt("start");
		await harness.session.prompt("second turn");

		// Request 2 counts twice, correctly: the announced context-level
		// tool-set change (the tool list grew) and the wire-level deferred-load
		// anchor the adapter reported. The append-only request 3 adds nothing.
		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({
			"tool-set-change": 1,
			"provider-deferred-tool-load": 1,
		});
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("counts an adapter-reported auth-mode switch under its cause without a diagnostic event", async () => {
		const harness = await createFiringHarness([2], "provider-auth-mode");
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");

		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({
			"provider-auth-mode": 1,
		});
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("does not count a rewrite reported by the first observed request", async () => {
		const harness = await createFiringHarness([1], "provider-auth-mode");
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");

		// The first observed request only initializes the monitor; there is no
		// earlier wire the rewrite could have diverged from.
		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({});
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("ignores cause tags the monitor does not know", async () => {
		const harness = await createFiringHarness([2], "provider-future-rewrite");
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");

		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({});
		expect(harness.eventsOfType("prefix_invalidated")).toHaveLength(0);
	});

	it("does not attribute a later unannounced divergence to the provider cause", async () => {
		let observedRequests = 0;
		const harness = await createHarness({
			tools: [echoTool()],
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => {
						// Rewrite the opening user message from the third request
						// on, so the divergence lands strictly after the fire.
						if (event.messages.length < 5) return undefined;
						const messages = event.messages.map((message, index) =>
							index === 0 && message.role === "user"
								? {
										...message,
										content: [{ type: "text" as const, text: "rewritten opener" }],
									}
								: message,
						);
						return { messages };
					});
				},
			],
			streamFn: async (model, context, options) => {
				observedRequests++;
				if (observedRequests === 2) {
					options?.onWireRewrite?.("provider-deferred-tool-load");
				}
				return streamSimple(model, context, options);
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("second reply"),
			fauxAssistantMessage("third reply"),
		]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");
		await harness.session.prompt("third turn");

		// The provider rewrite counts under its own cause; the later history
		// rewrite stays an unexpected change with its own diagnostic event —
		// the wire-rewrite count must not arm the expectation latch.
		expect(harness.session.getSessionStats().prefixInvalidationsByCause).toEqual({
			"provider-deferred-tool-load": 1,
			"unexpected-history-change": 1,
		});
		const events = harness.eventsOfType("prefix_invalidated");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ cause: "unexpected-history-change", firstDivergenceIndex: 0 });
	});
});
