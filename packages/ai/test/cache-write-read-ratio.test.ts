import { describe, expect, it } from "vitest";
import { cacheWriteReadRatio } from "../src/models.ts";
import type { Model, ModelCost } from "../src/types.ts";

function modelWithCost(cost: ModelCost): Model<"anthropic-messages"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "test",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 100000,
		maxTokens: 8192,
	};
}

describe("cacheWriteReadRatio", () => {
	it("returns cacheWrite / cacheRead from base rates", () => {
		expect(cacheWriteReadRatio(modelWithCost({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }))).toBe(12.5);
	});

	it("returns 0 when cache writes are free", () => {
		expect(cacheWriteReadRatio(modelWithCost({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }))).toBe(0);
	});

	it("returns undefined when cache reads are free or unrated", () => {
		expect(
			cacheWriteReadRatio(modelWithCost({ input: 3, output: 15, cacheRead: 0, cacheWrite: 3.75 })),
		).toBeUndefined();
	});
});
