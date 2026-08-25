/**
 * Unit tests for the shared prefix-comparison helper (cache plan phase B, issue #41).
 *
 * Seam: the pure functions in core/sessions/prefix-stability.ts — the same
 * normalization the prompt-stable-prefix suite asserts by hand (systemPrompt,
 * tools as [{name, JSON(parameters)}] in order, cloned messages). The runtime
 * monitor and the tests share this module so the pinned semantics cannot drift.
 */

import type { Context, Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	attributeUnannouncedInvalidation,
	diffRequestPrefix,
	type PrefixDiffResult,
	serializeRequestPrefix,
} from "../src/core/sessions/prefix-stability.ts";

function userMessage(text: string, timestamp = 1): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function toolResultMessage(text: string, timestamp = 2): Message {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function requestContext(overrides: Partial<Context> = {}): Context {
	return {
		systemPrompt: "system prompt",
		tools: [
			{ name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) },
			{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
		],
		messages: [userMessage("first turn")],
		...overrides,
	};
}

/** True when `result` equals `expected` including the optional divergence index. */
function diffEquals(result: PrefixDiffResult, expected: PrefixDiffResult): void {
	expect(result).toEqual(expected);
}

describe("serializeRequestPrefix", () => {
	it("serializes structurally equal contexts to identical strings", () => {
		const first = requestContext();
		const second = requestContext();

		expect(serializeRequestPrefix(second)).toBe(serializeRequestPrefix(first));
	});

	it("distinguishes tool order and schema changes", () => {
		const base = serializeRequestPrefix(requestContext());
		const reordered = serializeRequestPrefix(
			requestContext({
				tools: [
					{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
					{ name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) },
				],
			}),
		);
		const reschemaed = serializeRequestPrefix(
			requestContext({
				tools: [
					{
						name: "bash",
						description: "Run a command",
						parameters: Type.Object({ command: Type.String(), cwd: Type.String() }),
					},
					{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
				],
			}),
		);

		expect(reordered).not.toBe(base);
		expect(reschemaed).not.toBe(base);
	});

	it("distinguishes message content and system prompt changes", () => {
		const base = serializeRequestPrefix(requestContext());
		const otherMessage = serializeRequestPrefix(requestContext({ messages: [userMessage("other")] }));
		const otherPrompt = serializeRequestPrefix(requestContext({ systemPrompt: "other prompt" }));

		expect(otherMessage).not.toBe(base);
		expect(otherPrompt).not.toBe(base);
	});
});

describe("diffRequestPrefix", () => {
	it("reports reset when there is no previous request", () => {
		diffEquals(diffRequestPrefix(undefined, serializeRequestPrefix(requestContext())), {
			stable: true,
			cause: "reset",
		});
	});

	it("accepts an append-only extension", () => {
		const previous = serializeRequestPrefix(
			requestContext({ messages: [userMessage("first turn"), toolResultMessage("output")] }),
		);
		const next = serializeRequestPrefix(
			requestContext({
				messages: [userMessage("first turn"), toolResultMessage("output"), userMessage("second turn", 3)],
			}),
		);

		diffEquals(diffRequestPrefix(previous, next), { stable: true, cause: "append-only" });
	});

	it("accepts an identical re-sent request (retry shape)", () => {
		const serialized = serializeRequestPrefix(requestContext());

		diffEquals(diffRequestPrefix(serialized, serializeRequestPrefix(requestContext())), {
			stable: true,
			cause: "append-only",
		});
	});

	it("rejects a truncated history", () => {
		const previous = serializeRequestPrefix(
			requestContext({ messages: [userMessage("first turn"), toolResultMessage("output")] }),
		);
		const next = serializeRequestPrefix(requestContext({ messages: [userMessage("first turn")] }));

		diffEquals(diffRequestPrefix(previous, next), { stable: false, cause: "history", firstDivergenceIndex: 1 });
	});

	it("reports the first diverging message index for a history mutation", () => {
		const previous = serializeRequestPrefix(
			requestContext({
				messages: [userMessage("first turn"), toolResultMessage("output"), userMessage("second turn", 3)],
			}),
		);
		const mutatedAtOne = serializeRequestPrefix(
			requestContext({
				messages: [userMessage("first turn"), toolResultMessage("tampered"), userMessage("second turn", 3)],
			}),
		);
		const mutatedAtTwo = serializeRequestPrefix(
			requestContext({
				messages: [userMessage("first turn"), toolResultMessage("output"), userMessage("rewritten", 3)],
			}),
		);

		diffEquals(diffRequestPrefix(previous, mutatedAtOne), {
			stable: false,
			cause: "history",
			firstDivergenceIndex: 1,
		});
		diffEquals(diffRequestPrefix(previous, mutatedAtTwo), {
			stable: false,
			cause: "history",
			firstDivergenceIndex: 2,
		});
	});

	it("attributes a system prompt change before history", () => {
		const previous = serializeRequestPrefix(requestContext({ messages: [userMessage("a")] }));
		const next = serializeRequestPrefix(
			requestContext({ systemPrompt: "other prompt", messages: [userMessage("b")] }),
		);

		diffEquals(diffRequestPrefix(previous, next), { stable: false, cause: "system-prompt" });
	});

	it("attributes a tool set change before history", () => {
		const previous = serializeRequestPrefix(requestContext({ messages: [userMessage("a")] }));
		const next = serializeRequestPrefix(
			requestContext({
				tools: [
					{ name: "bash", description: "Run a command", parameters: Type.Object({ command: Type.String() }) },
				],
				messages: [userMessage("b")],
			}),
		);

		diffEquals(diffRequestPrefix(previous, next), { stable: false, cause: "tools" });
	});
});

describe("attributeUnannouncedInvalidation", () => {
	it("maps each diff cause to its unexpected attribution", () => {
		expect(attributeUnannouncedInvalidation({ stable: false, cause: "system-prompt" }, false)).toBe(
			"unexpected-system-prompt-change",
		);
		expect(attributeUnannouncedInvalidation({ stable: false, cause: "tools" }, false)).toBe(
			"unexpected-tools-change",
		);
		expect(
			attributeUnannouncedInvalidation({ stable: false, cause: "history", firstDivergenceIndex: 3 }, false),
		).toBe("unexpected-history-change");
	});

	it("attributes a byte-stable request under a different model to the model", () => {
		expect(attributeUnannouncedInvalidation({ stable: true, cause: "append-only" }, true)).toBe(
			"unexpected-model-change",
		);
	});
});
