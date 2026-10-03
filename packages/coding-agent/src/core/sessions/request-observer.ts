/**
 * Provider-request observer (issue #60; fork-owned module, no upstream counterpart).
 *
 * Everything the session needs to know about outgoing provider requests,
 * observed at one point: the agent's stream function, wrapped once per session
 * so every request — regular turns, retries, and the replaying
 * compaction/branch-summary calls that share the stream function — is seen:
 *
 * - prefix-stability monitoring (issue #41): serialize each request prefix,
 *   diff it against the previous one, attribute announced invalidations,
 *   count and emit unannounced ones; blockImages toggles announce before the
 *   diff (issue #53).
 * - cache-economics attribution (issue #42): claim a request kind per call
 *   and record the stream's final-message usage under it.
 *
 * AgentSession keeps only the wiring: constructing the observer, the
 * announce/mark/window calls at the legitimate rewrite sites, and reading the
 * counters for `getSessionStats()`. The observer is decoupled from the
 * settings manager via the injected `getBlockImages` getter and from the
 * event bus via the injected `prefix_invalidated` emitter.
 *
 * In-memory only: a resumed session restarts these counters from zero.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEventStream, TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../agent-session.ts";
import { type CacheUsageTotals, CacheUsageTracker, type RequestKind } from "./cache-usage.ts";
import {
	attributeUnannouncedInvalidation,
	diffRequestPrefix,
	type PrefixInvalidationCause,
	type PrefixInvalidationExpectation,
	PrefixInvalidationTracker,
	serializeRequestPrefix,
} from "./prefix-stability.ts";

/**
 * The `prefix_invalidated` member of `AgentSessionEvent`. Typed as an
 * `Extract` against the union (which stays in agent-session.ts) so the
 * observer cannot drift from the event shape the session emits.
 */
type PrefixInvalidatedEvent = Extract<AgentSessionEvent, { type: "prefix_invalidated" }>;

/** See through the prefix-monitor wrapper (and any nested wrappers) to the underlying stream function. */
export function unwrapStreamFn(streamFn: StreamFn): StreamFn {
	let current = streamFn;
	let inner = (current as StreamFn & { unwrapped?: StreamFn }).unwrapped;
	while (inner) {
		current = inner;
		inner = (current as StreamFn & { unwrapped?: StreamFn }).unwrapped;
	}
	return current;
}

export class ProviderRequestObserver {
	private readonly _emit: (event: PrefixInvalidatedEvent) => void;
	private readonly _getBlockImages: () => boolean;

	// Prefix-stability monitor (issue #41), observed at the streamFn boundary.
	// In-memory only: a resumed session restarts these counters from zero.
	private readonly _prefixTracker = new PrefixInvalidationTracker();
	private _lastRequestSnapshot: { serializedPrefix: string; modelKey: string } | undefined;
	private _prefixInvalidationsByCause: Partial<Record<PrefixInvalidationCause, number>> = {};
	/**
	 * Last-seen effective `images.blockImages` value (issue #53). Initialized
	 * from the first observed request; a flip between observed requests
	 * announces a `settings-change` invalidation, because the rewrite the
	 * toggle triggers (`convertToLlmWithBlockImages` replaces images in ALL
	 * messages, including already-sent ones) is the feature, not a violation.
	 */
	private _lastBlockImages: boolean | undefined;

	// Cache-economics attribution (issue #42), observed at the same streamFn
	// boundary. In-memory only: a resumed session restarts these counters
	// from zero.
	private readonly _cacheUsage = new CacheUsageTracker();
	/** Request-kind window: set while a summarizer flow owns the stream. */
	private _summarizerRequestKind: RequestKind | undefined;
	/** One-shot marker: the next provider request re-issues a failed one. */
	private _nextRequestIsRetry = false;

	constructor(emit: (event: PrefixInvalidatedEvent) => void, getBlockImages: () => boolean) {
		this._emit = emit;
		this._getBlockImages = getBlockImages;
	}

	/**
	 * Wrap the agent's stream function once so every provider request — regular
	 * turns, retries, and the phase-A replaying compaction/branch-summary calls
	 * that share the stream function — is observed by the prefix monitor and
	 * the cache-usage attribution. The wrapper is transparent: it delegates to
	 * the wrapped function unchanged and carries it on `unwrapped` so
	 * default-stream detection still works.
	 */
	wrap(streamFn: StreamFn): StreamFn {
		const inner = streamFn;
		const monitored = (async (
			model: Parameters<StreamFn>[0],
			context: Parameters<StreamFn>[1],
			options?: Parameters<StreamFn>[2],
		) => {
			const kind = this._claimRequestKind();
			this._observeProviderRequest(model, context);
			const stream = await inner(model, context, options);
			this._observeRequestUsage(kind, stream);
			return stream;
		}) as StreamFn;
		(monitored as StreamFn & { unwrapped?: StreamFn }).unwrapped = inner;
		return monitored;
	}

	/**
	 * Announce that the next request(s) legitimately invalidate the prefix.
	 * The expectation latch stays armed until the next stable request (see
	 * {@link PrefixInvalidationTracker}).
	 */
	expectInvalidation(cause: PrefixInvalidationExpectation): void {
		this._prefixTracker.expectInvalidation(cause);
	}

	/**
	 * One-shot marker: the next provider request re-issues a failed one, so it
	 * attributes to the `retry` request kind.
	 */
	markNextRequestAsRetry(): void {
		this._nextRequestIsRetry = true;
	}

	/**
	 * Run `flow` with every provider request it issues attributed to `kind`.
	 * Used around the compaction and branch-summary summarizer calls, which
	 * share the agent's stream function.
	 */
	async withRequestKind<T>(kind: RequestKind, flow: () => Promise<T>): Promise<T> {
		const previous = this._summarizerRequestKind;
		this._summarizerRequestKind = kind;
		try {
			return await flow();
		} finally {
			this._summarizerRequestKind = previous;
		}
	}

	/** Copy of the invalidation counters by cause, for `getSessionStats()`. */
	get prefixInvalidationsByCause(): Partial<Record<PrefixInvalidationCause, number>> {
		return { ...this._prefixInvalidationsByCause };
	}

	/** Per-kind cache-usage snapshot, for `getSessionStats()`. */
	get cacheUsageByKind(): Partial<Record<RequestKind, CacheUsageTotals>> {
		return this._cacheUsage.snapshot();
	}

	/**
	 * Request kind for the provider call being observed: the one-shot retry
	 * marker wins (this request re-issues a failed one), then an active
	 * summarizer-flow window (compaction, branch-summary), else a regular
	 * turn. The agent is idle while summarizer flows run, so a window cannot
	 * capture unrelated turns.
	 */
	private _claimRequestKind(): RequestKind {
		if (this._nextRequestIsRetry) {
			this._nextRequestIsRetry = false;
			return "retry";
		}
		return this._summarizerRequestKind ?? "turn";
	}

	/**
	 * Record the request's final-message usage under its kind. The stream's
	 * `result()` promise resolves when the provider request finishes, for
	 * agent turns and summarizer calls alike; failed and aborted requests
	 * record too (usually with zero usage) so request counts stay honest.
	 * Diagnostic only: never blocks or fails the request path.
	 */
	private _observeRequestUsage(kind: RequestKind, stream: AssistantMessageEventStream): void {
		// result() resolves for done and error completions alike and never
		// rejects, so a then-only attachment cannot leak an unhandled rejection.
		void stream.result().then((message) => {
			try {
				this._cacheUsage.record(kind, message.usage);
			} catch {
				// Diagnostic only; never surface as an unhandled rejection.
			}
		});
	}

	/**
	 * Compare the outgoing request against the previous one and record any
	 * invalidation with attribution. Announced invalidations (compaction, model
	 * switch, tool-set change, prompt override, settings change, tree navigation) count silently;
	 * unannounced ones also emit a `prefix_invalidated` diagnostic event. The
	 * model identity is compared alongside the prefix bytes because provider
	 * prompt caches are per model. Surfaces, never crashes: monitor failures
	 * must not take down the request path.
	 */
	private _observeProviderRequest(model: Parameters<StreamFn>[0], context: TranscriptContext): void {
		try {
			// A blockImages flip rewrites every message's images on this request
			// (sdk.ts reads the setting per request). Announce BEFORE diffing so
			// the history rewrite attributes to the setting; the first observed
			// request only initializes the tracked value.
			const blockImages = this._getBlockImages();
			if (this._lastBlockImages !== undefined && this._lastBlockImages !== blockImages) {
				this._prefixTracker.expectInvalidation("settings-change");
			}
			this._lastBlockImages = blockImages;

			const serializedPrefix = serializeRequestPrefix(context);
			const modelKey = `${model.provider}\0${model.id}`;
			const previous = this._lastRequestSnapshot;
			const diff = diffRequestPrefix(previous?.serializedPrefix, serializedPrefix);
			const modelChanged = previous !== undefined && previous.modelKey !== modelKey;

			if (!diff.stable || modelChanged) {
				const expected = this._prefixTracker.peekExpectation();
				const cause = expected ?? attributeUnannouncedInvalidation(diff, modelChanged);
				this._prefixInvalidationsByCause[cause] = (this._prefixInvalidationsByCause[cause] ?? 0) + 1;
				if (!expected) {
					this._emit({
						type: "prefix_invalidated",
						cause,
						...(diff.firstDivergenceIndex !== undefined
							? { firstDivergenceIndex: diff.firstDivergenceIndex }
							: {}),
					});
				}
			}
			if (diff.stable) {
				// A stable request ends any announced flow: the latch must not leak
				// into the next unannounced change.
				this._prefixTracker.clearExpectation();
			}
			this._lastRequestSnapshot = { serializedPrefix, modelKey };
		} catch {
			// Diagnostic only; never block the provider request.
		}
	}
}
