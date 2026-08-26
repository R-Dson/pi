/**
 * Runtime prefix-stability monitor tests (cache plan phase B, issue #41;
 * settings-change announcements from issue #53).
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
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
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
});
