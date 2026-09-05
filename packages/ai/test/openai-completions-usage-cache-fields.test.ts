import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	usage: undefined as Record<string, unknown> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: { content: "ok" }, finish_reason: undefined }],
							};
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: mockState.usage,
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	return {
		...(baseModel as Omit<Model<"openai-completions">, "api">),
		api: "openai-completions",
	};
}

async function usageFor(rawUsage: Record<string, unknown>) {
	mockState.usage = rawUsage;
	const message = await streamOpenAICompletions(
		createModel(),
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key" },
	).result();
	return message.usage;
}

describe("openai-completions usage cache fields", () => {
	beforeEach(() => {
		mockState.usage = undefined;
	});

	it("maps vLLM's prompt_tokens_details (flag on), including created_cache_tokens as cache writes", async () => {
		const usage = await usageFor({
			prompt_tokens: 1000,
			completion_tokens: 5,
			prompt_tokens_details: { cached_tokens: 700, created_cache_tokens: 250 },
		});

		expect(usage).toMatchObject({ input: 50, output: 5, cacheRead: 700, cacheWrite: 250 });
	});

	it("maps OpenRouter/ds4 cache_write_tokens as cache writes", async () => {
		const usage = await usageFor({
			prompt_tokens: 500,
			completion_tokens: 5,
			prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
		});

		expect(usage).toMatchObject({ input: 100, output: 5, cacheRead: 300, cacheWrite: 100 });
	});

	it("maps DeepSeek's prompt_cache_hit_tokens", async () => {
		const usage = await usageFor({
			prompt_tokens: 500,
			completion_tokens: 5,
			prompt_cache_hit_tokens: 400,
		});

		expect(usage).toMatchObject({ input: 100, output: 5, cacheRead: 400, cacheWrite: 0 });
	});

	it("maps Kimi's top-level cached_tokens", async () => {
		const usage = await usageFor({
			prompt_tokens: 300,
			completion_tokens: 5,
			cached_tokens: 200,
		});

		expect(usage).toMatchObject({ input: 100, output: 5, cacheRead: 200, cacheWrite: 0 });
	});

	it("reports zero cache buckets when the provider sends no cache fields (vLLM without --enable-prompt-tokens-details)", async () => {
		const usage = await usageFor({
			prompt_tokens: 279000,
			completion_tokens: 3400,
			prompt_tokens_details: null,
		});

		expect(usage).toMatchObject({ input: 279000, output: 3400, cacheRead: 0, cacheWrite: 0 });
	});
});
