import {
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

const neverAbortedSignal = new AbortController().signal;

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function testProvider(localGeneratedAt?: number) {
	return withRemoteCatalog(
		createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model("static")],
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		}),
		localGeneratedAt,
	);
}

async function refreshProvider(
	provider: Provider,
	store: InMemoryModelsStore,
	overrides: Partial<Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal">> = {},
): Promise<void> {
	const publish = async (publication: ModelsPublication): Promise<boolean> => {
		if (publication.persist === null) await store.delete(provider.id);
		else if (publication.persist !== undefined) await store.write(provider.id, publication.persist);
		publication.update?.();
		return true;
	};
	await provider.refreshModels?.({
		credential: { type: "api_key" },
		stored: await store.read(provider.id),
		publish,
		allowNetwork: overrides.allowNetwork ?? true,
		force: overrides.force,
		signal: overrides.signal ?? neverAbortedSignal,
	});
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog provider (issue #32: no network)", () => {
	it("restores a persisted overlay without any network request", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await store.write(provider.id, {
			models: [model("dynamic")],
			checkedAt: Date.now(),
			lastModified: 0,
		});

		await refreshProvider(provider, store);

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("never fetches even when network refreshes are allowed and forced", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store, { allowNetwork: true, force: true });
		await refreshProvider(provider, store, { allowNetwork: true, force: true });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("ignores stored overlays older than the generated builtin catalog", async () => {
		const localGeneratedAt = Date.now();
		const provider = testProvider(localGeneratedAt);
		const store = new InMemoryModelsStore();
		await store.write(provider.id, {
			models: [model("stale-dynamic")],
			checkedAt: Date.now(),
			lastModified: localGeneratedAt - 1000,
		});

		await refreshProvider(provider, store, { allowNetwork: true, force: true });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
	});
});
