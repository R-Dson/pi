/**
 * Cache-economics aggregation unit tests (cache plan phase C, issue #42).
 *
 * Seam: the pure fork module `core/sessions/cache-usage.ts` — the tracker the
 * AgentSession streamFn observer feeds per-request usage into, and the hit-rate
 * helper the `/session` panel renders. Scripted usage literals come from the
 * issue examples, not from the implementation.
 */

import { describe, expect, it } from "vitest";
import { CacheUsageTracker, cacheHitRate } from "../src/core/sessions/cache-usage.ts";

describe("CacheUsageTracker", () => {
	it("aggregates recorded usage per request kind with request counts", () => {
		const tracker = new CacheUsageTracker();

		tracker.record("turn", { input: 1_000, output: 500, cacheRead: 42_000, cacheWrite: 0 });
		tracker.record("turn", { input: 800, output: 300, cacheRead: 43_000, cacheWrite: 1_200 });
		tracker.record("compaction", { input: 40_900, output: 700, cacheRead: 0, cacheWrite: 41_000 });

		expect(tracker.snapshot()).toEqual({
			turn: { requests: 2, input: 1_800, output: 800, cacheRead: 85_000, cacheWrite: 1_200 },
			compaction: { requests: 1, input: 40_900, output: 700, cacheRead: 0, cacheWrite: 41_000 },
		});
	});

	it("returns a snapshot copy that later records do not mutate", () => {
		const tracker = new CacheUsageTracker();
		tracker.record("turn", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });

		const snapshot = tracker.snapshot();
		tracker.record("turn", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });

		expect(snapshot.turn?.requests).toBe(1);
		expect(tracker.snapshot().turn?.requests).toBe(2);
	});

	it("records zero-usage requests so the request count stays honest", () => {
		const tracker = new CacheUsageTracker();
		// Failed/aborted requests can carry all-zero usage; they still hit the provider.
		tracker.record("retry", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		expect(tracker.snapshot().retry).toEqual({
			requests: 1,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});
});

describe("cacheHitRate", () => {
	it("is the cached share of all prompt tokens (read over read + written + uncached)", () => {
		// Same denominator as the existing Tokens-section hit rate: 42.1k read
		// against 42.1k + 1.2k + 6.8k prompt tokens -> 84.0%.
		const rate = cacheHitRate({ input: 6_800, cacheRead: 42_100, cacheWrite: 1_200 });
		expect(rate).toBeCloseTo(42_100 / (42_100 + 1_200 + 6_800), 10);
		expect((rate! * 100).toFixed(1)).toBe("84.0");
	});

	it("is undefined when no prompt tokens were billed", () => {
		expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
	});
});
