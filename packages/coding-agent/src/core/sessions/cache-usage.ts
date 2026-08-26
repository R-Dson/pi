/**
 * Cache-economics aggregation (cache plan phase C, issue #42).
 *
 * Per-request usage attribution by request kind, recorded at the same
 * AgentSession streamFn boundary as the phase-B prefix monitor. The tracker is
 * in-memory and run-scoped (a resumed session restarts from zero) because the
 * session log must not carry high-frequency per-request telemetry; persisted
 * usage totals already live on session entries.
 *
 * Pure module: no I/O, no global state.
 */

import type { Usage } from "@earendil-works/pi-ai/compat";

/**
 * The kind of provider request a usage record belongs to. Current flows
 * produce "turn", "compaction", "branch-summary", and "retry"; kinds are
 * added when a flow that produces them exists.
 */
export type RequestKind = "turn" | "compaction" | "branch-summary" | "retry";

/** Display order for non-turn kinds in the `/session` cache block. */
export const NON_TURN_REQUEST_KINDS: readonly RequestKind[] = ["compaction", "branch-summary", "retry"];

/** Aggregated usage for one request kind. */
export interface CacheUsageTotals {
	/** Provider requests observed for this kind, including failed ones. */
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function createTotals(): CacheUsageTotals {
	return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * Cached share of all prompt tokens: `cacheRead / (input + cacheRead +
 * cacheWrite)`. Undefined when no prompt tokens were billed, so callers can
 * omit a meaningless 0.0%.
 */
export function cacheHitRate(usage: Pick<CacheUsageTotals, "input" | "cacheRead" | "cacheWrite">): number | undefined {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? usage.cacheRead / promptTokens : undefined;
}

/**
 * In-memory aggregation of `{kind, usage}` records fed by the streamFn
 * observer. One instance per session run, mirroring the phase-B
 * `PrefixInvalidationTracker` lifetime.
 */
export class CacheUsageTracker {
	private readonly byKind = new Map<RequestKind, CacheUsageTotals>();

	/** `usage` needs only the four token counters; cost is tracked on session entries. */
	record(kind: RequestKind, usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): void {
		const totals = this.totalsFor(kind);
		totals.requests++;
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
	}

	/** Copy of the per-kind aggregates; kinds with no recorded requests are absent. */
	snapshot(): Partial<Record<RequestKind, CacheUsageTotals>> {
		return Object.fromEntries(Array.from(this.byKind, ([kind, totals]) => [kind, { ...totals }] as const));
	}

	private totalsFor(kind: RequestKind): CacheUsageTotals {
		let totals = this.byKind.get(kind);
		if (!totals) {
			totals = createTotals();
			this.byKind.set(kind, totals);
		}
		return totals;
	}
}
