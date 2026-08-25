/**
 * Cache-economics attribution tests (cache plan phase C, issue #42).
 *
 * Seam: AgentSession's public surface — `getSessionStats().cacheUsageByKind`.
 * Attribution happens at the phase-B streamFn wrapper: every provider request
 * (faux turns, the phase-A replaying compaction/branch-summary calls, and
 * retried requests) must land in exactly one request-kind bucket with the
 * request's own final-message usage. The faux provider estimates usage from
 * the request context and, when the agent carries a sessionId, simulates a
 * prompt cache — so turn requests report real read/write splits without a
 * real provider.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { cacheHitRate } from "../../src/core/sessions/cache-usage.ts";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("cache-economics attribution (issue #42)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("aggregates turn usage across requests and exposes it via getSessionStats", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// sessionId engages the faux provider's prompt-cache simulation, so the
		// second turn reports cache reads/writes like a real provider would.
		harness.session.agent.sessionId = "cache-stats-turns";
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");

		const stats = harness.session.getSessionStats();
		expect(Object.keys(stats.cacheUsageByKind)).toEqual(["turn"]);
		const turn = stats.cacheUsageByKind.turn;
		expect(turn?.requests).toBe(2);
		expect(turn?.cacheRead).toBeGreaterThan(0);
		expect(turn?.cacheWrite).toBeGreaterThan(0);
		expect(turn?.output).toBeGreaterThan(0);
		const hitRate = turn ? cacheHitRate(turn) : undefined;
		expect(hitRate).toBeGreaterThan(0);
		expect(hitRate).toBeLessThan(1);
	});

	it("attributes the compaction summarizer request to compaction, not turn", async () => {
		const harness = await createHarness({
			// keep ~10 tokens so the cut lands on the second turn's user message
			// (same shape as the phase-A replay tests): one summarizer request.
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
		// First regular request after compaction is a turn, not compaction:
		// the rebuild miss is counted as an invalidation, not as usage kind.
		await harness.session.prompt("third turn");

		const stats = harness.session.getSessionStats();
		expect(stats.cacheUsageByKind.turn?.requests).toBe(3);
		const compaction = stats.cacheUsageByKind.compaction;
		expect(compaction?.requests).toBe(1);
		expect(compaction?.input).toBeGreaterThan(0);
		expect(compaction?.output).toBeGreaterThan(0);
	});

	it("attributes a retried agent turn to retry", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		const stats = harness.session.getSessionStats();
		// The failed attempt was a turn; the re-issued request is the retry.
		expect(stats.cacheUsageByKind.turn?.requests).toBe(1);
		expect(stats.cacheUsageByKind.retry?.requests).toBe(1);
	});

	it("attributes a retried compaction summarizer request to retry", async () => {
		const harness = await createHarness({
			settings: {
				compaction: { keepRecentTokens: 10 },
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("second reply"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("## Goal\ncheckpoint summary"),
		]);

		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn ".repeat(20).trim());
		const result = await harness.session.compact();

		expect(result.summary).toContain("checkpoint summary");
		const stats = harness.session.getSessionStats();
		// The failed summarizer attempt belongs to compaction; the re-issued
		// request (after onRetryAttemptStart) is the retry.
		expect(stats.cacheUsageByKind.compaction?.requests).toBe(1);
		expect(stats.cacheUsageByKind.retry?.requests).toBe(1);
		expect(stats.cacheUsageByKind.retry?.output).toBeGreaterThan(0);
	});

	it("attributes the branch-summary request to branch-summary", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("branch summary text")]);

		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned branch work"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));

		const result = await harness.session.navigateTree(targetId, { summarize: true });

		expect(result.cancelled).toBe(false);
		const stats = harness.session.getSessionStats();
		expect(stats.cacheUsageByKind["branch-summary"]?.requests).toBe(1);
		expect(stats.cacheUsageByKind["branch-summary"]?.output).toBeGreaterThan(0);
	});
});
