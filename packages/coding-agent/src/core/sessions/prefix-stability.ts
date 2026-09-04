/**
 * Prefix-stability comparison shared by the runtime monitor and the tests
 * (cache plan phase B, issue #41).
 *
 * A provider request's "prefix" is everything a provider prompt cache can
 * reuse: the system prompt, the tool list (names and serialized parameter
 * schemas, in order), and the message history. The stable-prefix suite pins
 * the default assembly path; this module extracts the same comparison so the
 * runtime monitor observes identical semantics.
 *
 * Pure module: no I/O, no global state.
 */

import type { Context, Message } from "@earendil-works/pi-ai";

/** Why a request diverged from the previous one, as computed by the pure diff. */
export type PrefixDiffCause = "append-only" | "system-prompt" | "tools" | "history" | "reset";

/** Result of comparing two serialized request prefixes. */
export interface PrefixDiffResult {
	/** False when the previous request's bytes are no longer reusable as a prefix. */
	stable: boolean;
	cause: PrefixDiffCause;
	/** First message index whose serialized bytes differ (history cause only). */
	firstDivergenceIndex?: number;
}

/**
 * Attribution recorded (and reported) for an invalidation. The first six are
 * announced by the subsystem that legitimately rewrote the request; the two
 * `provider-*` causes are reported by the packages/ai wire-rewrite seam when
 * the adapter rewrites the wire in ways the request context cannot reveal
 * (issue #56); the `unexpected-*` causes mean nobody announced the change.
 */
export type PrefixInvalidationCause =
	| "compaction"
	| "model-change"
	| "tool-set-change"
	| "extension-override"
	| "session-reset"
	| "settings-change"
	| "provider-deferred-tool-load"
	| "provider-auth-mode"
	| "unexpected-system-prompt-change"
	| "unexpected-tools-change"
	| "unexpected-model-change"
	| "unexpected-history-change";

/** Reasons a subsystem may announce before legitimately rewriting the request. */
export type PrefixInvalidationExpectation = Exclude<
	PrefixInvalidationCause,
	| "provider-deferred-tool-load"
	| "provider-auth-mode"
	| "unexpected-system-prompt-change"
	| "unexpected-tools-change"
	| "unexpected-model-change"
	| "unexpected-history-change"
>;

/** Wire-rewrite cause tags reported through the packages/ai `onWireRewrite` seam (issue #56). */
const PROVIDER_WIRE_REWRITE_CAUSES = ["provider-deferred-tool-load", "provider-auth-mode"] as const;

export type ProviderWireRewriteCause = (typeof PROVIDER_WIRE_REWRITE_CAUSES)[number];

/** Narrow an `onWireRewrite` cause tag to the causes this monitor attributes; unknown tags stay uncounted. */
export function isProviderWireRewriteCause(cause: string): cause is ProviderWireRewriteCause {
	return PROVIDER_WIRE_REWRITE_CAUSES.includes(cause as ProviderWireRewriteCause);
}

/** Normalized request prefix; `parameters` is the serialized schema. */
interface SerializedPrefix {
	systemPrompt: string | undefined;
	tools: Array<{ name: string; parameters: string }>;
	messages: Message[];
}

/** Normalize tools as `[{name, JSON(parameters)}]` in order — the shared
 * tool-identity convention for prefix comparisons. */
export function serializeTools(tools: Context["tools"]): Array<{ name: string; parameters: string }> {
	return (tools ?? []).map((tool) => ({
		name: tool.name,
		parameters: JSON.stringify(tool.parameters),
	}));
}

/**
 * Serialize a provider request prefix for comparison: systemPrompt, tools in
 * order, and the message array as-is (referenced, not cloned — the result is
 * only ever compared, never mutated).
 */
export function serializeRequestPrefix(context: Pick<Context, "systemPrompt" | "tools" | "messages">): string {
	const prefix: SerializedPrefix = {
		systemPrompt: context.systemPrompt,
		tools: serializeTools(context.tools),
		messages: context.messages,
	};
	return JSON.stringify(prefix);
}

/**
 * Compare two serialized prefixes (see {@link serializeRequestPrefix}).
 *
 * - `reset`: `previous` is undefined (first request of a monitor instance) —
 *   stable, nothing was invalidated.
 * - `system-prompt` / `tools`: those sections differ (checked first).
 * - `history`: a message the previous request already sent changed or
 *   disappeared; `firstDivergenceIndex` names the earliest such message.
 * - `append-only`: every prior message is byte-identical, so the new request
 *   extends (or exactly repeats) the previous one.
 */
export function diffRequestPrefix(previous: string | undefined, next: string): PrefixDiffResult {
	if (previous === undefined) {
		return { stable: true, cause: "reset" };
	}

	// Fast path: `messages` is the last serialized field, so an append-only
	// request repeats every byte of the previous serialization except the
	// closing `]}`. A byte-prefix match therefore proves stability without
	// parsing; only a mismatch needs the structural diff below to attribute
	// the divergence.
	if (next.startsWith(previous.slice(0, -2))) {
		return { stable: true, cause: "append-only" };
	}

	const previousPrefix = JSON.parse(previous) as SerializedPrefix;
	const nextPrefix = JSON.parse(next) as SerializedPrefix;

	if (previousPrefix.systemPrompt !== nextPrefix.systemPrompt) {
		return { stable: false, cause: "system-prompt" };
	}
	if (JSON.stringify(previousPrefix.tools) !== JSON.stringify(nextPrefix.tools)) {
		return { stable: false, cause: "tools" };
	}
	for (let index = 0; index < previousPrefix.messages.length; index++) {
		if (JSON.stringify(previousPrefix.messages[index]) !== JSON.stringify(nextPrefix.messages[index])) {
			return { stable: false, cause: "history", firstDivergenceIndex: index };
		}
	}
	return { stable: true, cause: "append-only" };
}

/**
 * Attribution for an invalidation nobody announced. `modelChanged` covers a
 * byte-stable request sent to a different model: provider caches are per
 * model, so the switch invalidates even when the prefix bytes match.
 */
export function attributeUnannouncedInvalidation(
	diff: PrefixDiffResult,
	modelChanged: boolean,
): PrefixInvalidationCause {
	switch (diff.cause) {
		case "system-prompt":
			return "unexpected-system-prompt-change";
		case "tools":
			return "unexpected-tools-change";
		case "history":
			return "unexpected-history-change";
		default:
			return modelChanged ? "unexpected-model-change" : "unexpected-history-change";
	}
}

/**
 * Expectation announcements for the prefix monitor. Subsystems that
 * legitimately rewrite the request (compaction, model switch, tool-set,
 * settings change, prompt override, tree navigation) call
 * {@link expectInvalidation} before their requests go out.
 *
 * The expectation stays armed until the next stable request, not just the
 * next request: a flow like split-turn compaction issues several diverging
 * summarizer requests back to back (replay context, then standalone
 * turn-prefix context, then the rebuilt post-compaction context), and all of
 * them belong to the one announced cause. A stable request clears the
 * expectation, so an announced-but-abandoned flow cannot leak past the next
 * normal turn.
 */
export class PrefixInvalidationTracker {
	private expectation: PrefixInvalidationExpectation | undefined;

	/** Announce that the next request(s) legitimately invalidate the prefix. */
	expectInvalidation(reason: PrefixInvalidationExpectation): void {
		this.expectation = reason;
	}

	/** The announced reason, if any. Does not consume it. */
	peekExpectation(): PrefixInvalidationExpectation | undefined {
		return this.expectation;
	}

	/** Clear the expectation (called once a stable request is observed). */
	clearExpectation(): void {
		this.expectation = undefined;
	}
}
