import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelsPublication, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { discoverProviderModels } from "../src/core/model-discovery.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

const servers: Server[] = [];

async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${address.port}` };
}

function json(response: ServerResponse, value: unknown): void {
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

describe("model discovery", () => {
	describe("ollama protocol", () => {
		it("lists /api/tags and probes /api/show for context, vision, and thinking", async () => {
			const showRequests: Array<{ method: string | undefined; body: unknown }> = [];
			const { url } = await listen((request, response) => {
				if (request.url === "/api/tags") {
					json(response, {
						models: [
							{ name: "llama3.1:8b", details: { family: "llama", families: ["llama"] } },
							{ name: "qwen3:4b", details: { family: "qwen3", families: ["qwen3"] } },
							{ name: "llama3.2-vision:11b", details: { family: "mllama", families: ["llama", "mllama"] } },
						],
					});
					return;
				}
				if (request.url === "/api/show") {
					let body = "";
					request.on("data", (chunk) => {
						body += chunk;
					});
					request.on("end", () => {
						showRequests.push({ method: request.method, body: JSON.parse(body) });
						const model = (JSON.parse(body) as { model: string }).model;
						if (model === "llama3.1:8b") {
							json(response, {
								model_info: { "llama.context_length": 131072 },
								capabilities: ["completion", "tools"],
							});
						} else if (model === "qwen3:4b") {
							json(response, {
								model_info: { "qwen3.context_length": 40960 },
								template: "{% if enable_thinking %}think{% endif %}",
							});
						} else if (model === "llama3.2-vision:11b") {
							json(response, { capabilities: ["completion", "vision"] });
						} else {
							response.writeHead(404).end();
						}
					});
					return;
				}
				response.writeHead(404).end();
			});

			const models = await discoverProviderModels(
				{ providerId: "ollama", baseUrl: `${url}/v1`, protocol: "ollama", api: "openai-completions" },
				new AbortController().signal,
			);

			expect(showRequests).toEqual([
				{ method: "POST", body: { model: "llama3.1:8b" } },
				{ method: "POST", body: { model: "qwen3:4b" } },
				{ method: "POST", body: { model: "llama3.2-vision:11b" } },
			]);
			expect(models).toEqual([
				expect.objectContaining({
					id: "llama3.1:8b",
					baseUrl: `${url}/v1`,
					contextWindow: 131072,
					input: ["text"],
					reasoning: false,
				}),
				expect.objectContaining({
					id: "qwen3:4b",
					contextWindow: 40960,
					reasoning: true,
					thinkingLevelMap: {
						off: "off",
						minimal: null,
						low: null,
						medium: "medium",
						high: null,
						xhigh: null,
					},
					compat: expect.objectContaining({ thinkingFormat: "qwen-chat-template" }),
				}),
				expect.objectContaining({
					id: "llama3.2-vision:11b",
					contextWindow: 128000,
					input: ["text", "image"],
				}),
			]);
		});

		it("keeps a model with defaults when its /api/show probe fails", async () => {
			const { url } = await listen((request, response) => {
				if (request.url === "/api/tags") {
					json(response, { models: [{ name: "broken:1b" }, { name: "fine:1b" }] });
					return;
				}
				if (request.url === "/api/show") {
					let body = "";
					request.on("data", (chunk) => {
						body += chunk;
					});
					request.on("end", () => {
						const model = (JSON.parse(body) as { model: string }).model;
						if (model === "broken:1b") response.writeHead(500).end();
						else json(response, { model_info: { "llama.context_length": 8192 } });
					});
					return;
				}
				response.writeHead(404).end();
			});

			const models = await discoverProviderModels(
				{ providerId: "ollama", baseUrl: url, protocol: "ollama", api: "openai-completions" },
				new AbortController().signal,
			);

			expect(models).toEqual([
				expect.objectContaining({ id: "broken:1b", contextWindow: 128000, reasoning: false }),
				expect.objectContaining({ id: "fine:1b", contextWindow: 8192 }),
			]);
		});

		it("fails when /api/tags is unshaped", async () => {
			const { url } = await listen((_request, response) => {
				json(response, { data: [] });
			});

			await expect(
				discoverProviderModels(
					{ providerId: "ollama", baseUrl: url, protocol: "ollama", api: "openai-completions" },
					new AbortController().signal,
				),
			).rejects.toThrow("returned an invalid listing");
		});
	});

	describe("openai protocol", () => {
		it("lists models with server-reported context, auth, and custom headers", async () => {
			const { url } = await listen((request, response) => {
				expect(request.url).toBe("/v1/models");
				expect(request.headers.authorization).toBe("Bearer secret");
				expect(request.headers["x-custom"]).toBe("gateway-value");
				json(response, {
					data: [
						{ id: "model-a", max_model_len: 8192 },
						{ id: "model-b", context_length: 131072 },
					],
				});
			});

			const models = await discoverProviderModels(
				{
					providerId: "local",
					baseUrl: `${url}/v1`,
					protocol: "openai",
					api: "openai-completions",
					apiKey: "secret",
					headers: { "x-custom": "gateway-value" },
				},
				new AbortController().signal,
			);

			expect(models).toEqual([
				expect.objectContaining({
					id: "model-a",
					provider: "local",
					api: "openai-completions",
					baseUrl: `${url}/v1`,
					contextWindow: 8192,
					maxTokens: 8192,
					input: ["text"],
					reasoning: false,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}),
				expect.objectContaining({ id: "model-b", contextWindow: 131072, maxTokens: 131072 }),
			]);
		});

		it("tolerates a bare-array listing and defaults the context window", async () => {
			const { url } = await listen((request, response) => {
				if (request.url === "/props") {
					response.writeHead(404).end();
					return;
				}
				json(response, [{ id: "bare" }]);
			});

			const models = await discoverProviderModels(
				{ providerId: "local", baseUrl: `${url}/v1`, protocol: "openai", api: "openai-completions" },
				new AbortController().signal,
			);

			expect(models).toEqual([expect.objectContaining({ id: "bare", contextWindow: 128000 })]);
		});

		it("fails with the request URL on a non-200 listing response", async () => {
			const { url } = await listen((_request, response) => {
				response.writeHead(500).end();
			});

			await expect(
				discoverProviderModels(
					{ providerId: "local", baseUrl: `${url}/v1`, protocol: "openai", api: "openai-completions" },
					new AbortController().signal,
				),
			).rejects.toThrow(`Provider local: model discovery request to ${url}/v1/models failed: HTTP 500`);
		});

		it("fails on an unshaped listing payload", async () => {
			const { url } = await listen((_request, response) => {
				json(response, { unexpected: true });
			});

			await expect(
				discoverProviderModels(
					{ providerId: "local", baseUrl: `${url}/v1`, protocol: "openai", api: "openai-completions" },
					new AbortController().signal,
				),
			).rejects.toThrow("returned an invalid listing");
		});

		it("probes llama.cpp /props once when the listing lacks context metadata", async () => {
			const propsRequests: string[] = [];
			const { url } = await listen((request, response) => {
				if (request.url === "/v1/models") {
					json(response, { data: [{ id: "qwen3" }] });
					return;
				}
				if (request.url === "/props") {
					propsRequests.push(request.url);
					json(response, { chat_template: "{% if enable_thinking %}think{% endif %}" });
					return;
				}
				response.writeHead(404).end();
			});

			const models = await discoverProviderModels(
				{ providerId: "local", baseUrl: `${url}/v1`, protocol: "openai", api: "openai-completions" },
				new AbortController().signal,
			);

			expect(propsRequests).toEqual(["/props"]);
			expect(models).toEqual([
				expect.objectContaining({
					id: "qwen3",
					reasoning: true,
					thinkingLevelMap: {
						off: "off",
						minimal: null,
						low: null,
						medium: "medium",
						high: null,
						xhigh: null,
					},
					compat: expect.objectContaining({ thinkingFormat: "qwen-chat-template" }),
				}),
			]);
		});

		it("skips the /props probe silently when the server is not llama.cpp", async () => {
			const propsRequests = { count: 0 };
			const { url } = await listen((request, response) => {
				if (request.url === "/v1/models") {
					json(response, { data: [{ id: "vllm-model", max_model_len: 4096 }] });
					return;
				}
				propsRequests.count++;
				response.writeHead(404).end();
			});

			const models = await discoverProviderModels(
				{ providerId: "local", baseUrl: `${url}/v1`, protocol: "openai", api: "openai-completions" },
				new AbortController().signal,
			);

			// The listing already carried context metadata, so /props is not even attempted.
			expect(propsRequests.count).toBe(0);
			expect(models).toEqual([expect.objectContaining({ id: "vllm-model", contextWindow: 4096, reasoning: false })]);
		});

		it("falls back to /props context when the listing has none and the server is llama.cpp", async () => {
			const { url } = await listen((request, response) => {
				if (request.url === "/v1/models") {
					json(response, { data: [{ id: "llama-model" }] });
					return;
				}
				if (request.url === "/props") {
					json(response, { n_ctx: 16384 });
					return;
				}
				response.writeHead(404).end();
			});

			const models = await discoverProviderModels(
				{ providerId: "local", baseUrl: `${url}/v1`, protocol: "openai", api: "openai-completions" },
				new AbortController().signal,
			);

			expect(models).toEqual([expect.objectContaining({ id: "llama-model", contextWindow: 16384 })]);
		});
	});
});

describe("discovery in the composed provider", () => {
	const tempDirs: string[] = [];

	async function loadConfig(providers: Record<string, unknown>): Promise<ModelConfig> {
		const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-"));
		tempDirs.push(dir);
		const path = join(dir, "models.json");
		writeFileSync(path, JSON.stringify({ providers }));
		return ModelConfig.load(path);
	}

	function fakePublish(state: { persisted?: ModelsStoreEntry }) {
		return async (publication: ModelsPublication): Promise<boolean> => {
			if (publication.persist === null) state.persisted = undefined;
			else if (publication.persist !== undefined) state.persisted = structuredClone(publication.persist);
			publication.update?.();
			return true;
		};
	}

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("requires baseUrl when discover is set", async () => {
		const config = await loadConfig({
			local: {
				api: "openai-completions",
				apiKey: "test-key",
				discover: true,
				modelOverrides: { x: { reasoning: true } },
			},
		});
		expect(() => composeModelProvider("local", undefined, config, undefined)).toThrow(
			'Provider local: "baseUrl" is required when "discover" is set.',
		);
	});

	it("layers discovered models beneath explicit models.json entries and modelOverrides", async () => {
		const { url } = await listen((request, response) => {
			if (request.url === "/v1/models") {
				json(response, { data: [{ id: "model-a", max_model_len: 8192 }, { id: "model-b" }] });
				return;
			}
			response.writeHead(404).end();
		});
		const config = await loadConfig({
			local: {
				baseUrl: `${url}/v1`,
				api: "openai-completions",
				apiKey: "test-key",
				discover: true,
				models: [{ id: "model-b", contextWindow: 4096 }],
				modelOverrides: { "model-a": { contextWindow: 2048 } },
			},
		});
		const provider = composeModelProvider("local", undefined, config, undefined);

		// Before any refresh, only the explicit entry exists.
		expect(provider.getModels().map((model) => model.id)).toEqual(["model-b"]);

		const state: { persisted?: ModelsStoreEntry } = {};
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			stored: undefined,
			publish: fakePublish(state),
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		const models = provider.getModels();
		expect(models).toEqual([
			// Discovered baseline, overridden by modelOverrides.
			expect.objectContaining({ id: "model-a", contextWindow: 2048 }),
			// Explicit models.json entry replaces the discovered model-b.
			expect.objectContaining({ id: "model-b", contextWindow: 4096 }),
		]);
	});

	it("persists the discovered catalog and restores it without network", async () => {
		const { url } = await listen((request, response) => {
			if (request.url === "/v1/models") {
				json(response, { data: [{ id: "model-a", max_model_len: 8192 }] });
				return;
			}
			response.writeHead(404).end();
		});
		const config = await loadConfig({
			local: { baseUrl: `${url}/v1`, api: "openai-completions", apiKey: "test-key", discover: true },
		});

		const state: { persisted?: ModelsStoreEntry } = {};
		const first = composeModelProvider("local", undefined, config, undefined);
		await first.refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			stored: undefined,
			publish: fakePublish(state),
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(state.persisted?.models.map((model) => model.id)).toEqual(["model-a"]);
		expect(state.persisted?.checkedAt).toBeGreaterThan(0);

		// A fresh composition (e.g. next startup) restores from the store with no network.
		let networkHit = false;
		const offline = await listen((_request, response) => {
			networkHit = true;
			response.writeHead(500).end();
		});
		const offlineConfig = await loadConfig({
			local: { baseUrl: `${offline.url}/v1`, api: "openai-completions", apiKey: "test-key", discover: true },
		});
		const second = composeModelProvider("local", undefined, offlineConfig, undefined);
		await second.refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			stored: state.persisted,
			publish: fakePublish({}),
			allowNetwork: false,
			signal: new AbortController().signal,
		});

		expect(networkHit).toBe(false);
		// The composer rewrites every model's baseUrl to the current config's,
		// so the restored entry points at the new server, ready for its next fetch.
		expect(second.getModels()).toEqual([
			expect.objectContaining({ id: "model-a", contextWindow: 8192, baseUrl: `${offline.url}/v1` }),
		]);
	});

	it("keeps the last-discovered list when a live discovery fetch fails", async () => {
		let failListing = false;
		const { url } = await listen((request, response) => {
			if (request.url === "/v1/models" && !failListing) {
				json(response, { data: [{ id: "model-a" }] });
				return;
			}
			response.writeHead(500).end();
		});
		const config = await loadConfig({
			local: { baseUrl: `${url}/v1`, api: "openai-completions", apiKey: "test-key", discover: true },
		});
		const provider = composeModelProvider("local", undefined, config, undefined);
		const state: { persisted?: ModelsStoreEntry } = {};
		const refresh = (stored: ModelsStoreEntry | undefined) =>
			provider.refreshModels?.({
				credential: { type: "api_key", key: "test-key" },
				stored: stored,
				publish: fakePublish(state),
				allowNetwork: true,
				signal: new AbortController().signal,
			});

		await refresh(undefined);
		expect(provider.getModels().map((model) => model.id)).toEqual(["model-a"]);

		failListing = true;
		await expect(refresh(state.persisted)).rejects.toThrow("HTTP 500");
		expect(provider.getModels().map((model) => model.id)).toEqual(["model-a"]);
	});

	it("stops discovery when the refresh signal aborts mid-fetch", async () => {
		const controller = new AbortController();
		const { url } = await listen((request, response) => {
			if (request.url === "/v1/models") {
				controller.abort();
				response.writeHead(500).end();
				return;
			}
			response.writeHead(404).end();
		});
		const config = await loadConfig({
			local: { baseUrl: `${url}/v1`, api: "openai-completions", apiKey: "test-key", discover: true },
		});
		const provider = composeModelProvider("local", undefined, config, undefined);

		await provider.refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			stored: undefined,
			publish: fakePublish({}),
			allowNetwork: true,
			signal: controller.signal,
		});

		expect(provider.getModels()).toEqual([]);
	});
});
