/**
 * Model discovery for models.json custom providers (fork feature).
 *
 * A provider configured with `discover` fetches its model list from the
 * server itself instead of requiring hand-maintained `models` entries.
 * Discovered models are a baseline layer: explicit models.json entries
 * and modelOverrides keep applying on top (see provider-composer.ts).
 */

import type { AnyModel, Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ModelsJsonProvider } from "./model-config.ts";
import { resolveHeadersOrThrow } from "./resolve-config-value.ts";

export type DiscoveryProtocol = "openai" | "ollama";

export interface DiscoveryTarget {
	providerId: string;
	/** Inference base URL; conventionally ends with `/v1` for OpenAI-compatible servers. */
	baseUrl: string;
	protocol: DiscoveryProtocol;
	/** Wire API assigned to discovered models (provider `api`, default openai-completions). */
	api: Api;
	apiKey?: string;
	headers?: Record<string, string>;
}

interface DiscoveredModelInfo {
	contextWindow?: number;
	reasoning?: boolean;
	vision?: boolean;
}

const DEFAULT_CONTEXT_WINDOW = 128000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Thinking-level map proven for qwen-style `enable_thinking` chat templates (llama.cpp builtin). */
const CHAT_TEMPLATE_THINKING_LEVEL_MAP = {
	off: "off",
	minimal: null,
	low: null,
	medium: "medium",
	high: null,
	xhigh: null,
} as const;

export function discoveryProtocolOf(config: ModelsJsonProvider): DiscoveryProtocol | undefined {
	return config.discover ? (config.discover === true ? "openai" : config.discover) : undefined;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function invalidListingError(target: DiscoveryTarget): Error {
	return new Error(
		`Provider ${target.providerId}: model discovery returned an invalid listing from ${target.baseUrl}`,
	);
}

function buildDiscoveredModel(target: DiscoveryTarget, id: string, info: DiscoveredModelInfo): Model<Api> {
	const contextWindow = info.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const reasoning = info.reasoning === true;
	const model: Model<Api> = {
		id,
		name: id,
		api: target.api,
		provider: target.providerId,
		baseUrl: target.baseUrl,
		reasoning,
		...(reasoning ? { thinkingLevelMap: { ...CHAT_TEMPLATE_THINKING_LEVEL_MAP } } : {}),
		input: info.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow,
	};
	if (target.api === "openai-completions") {
		// Conservative defaults for self-hosted servers; provider-level compat in
		// models.json merges over these via the composer.
		model.compat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			...(reasoning ? { thinkingFormat: "qwen-chat-template" as const } : {}),
		};
	}
	return model;
}

async function fetchJson(target: DiscoveryTarget, url: string, signal: AbortSignal, body?: string): Promise<unknown> {
	const headers: Record<string, string> = { accept: "application/json", ...(target.headers ?? {}) };
	if (body !== undefined) headers["content-type"] = "application/json";
	if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(url, {
		...(body !== undefined ? { method: "POST", body } : {}),
		headers,
		signal: AbortSignal.any([signal, timeout]),
	});
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		payload = undefined;
	}
	if (!response.ok) {
		throw new Error(
			`Provider ${target.providerId}: model discovery request to ${url} failed: HTTP ${response.status}`,
		);
	}
	return payload;
}

/** Management root of an OpenAI-compatible base URL (strips a trailing `/v1`). */
function controlRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

function isOpenAiListing(payload: unknown): payload is { data: unknown[] } {
	return typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data);
}

async function discoverOpenAiModels(target: DiscoveryTarget, signal: AbortSignal): Promise<readonly Model<Api>[]> {
	const payload = await fetchJson(target, `${target.baseUrl.replace(/\/+$/u, "")}/models`, signal);
	const entries = isOpenAiListing(payload) ? payload.data : Array.isArray(payload) ? payload : undefined;
	if (!entries) throw invalidListingError(target);
	const infos = entries
		.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
		.filter((entry) => typeof entry.id === "string" && entry.id)
		.map((entry) => ({
			id: entry.id as string,
			contextWindow:
				positiveInt(entry.max_model_len) ??
				positiveInt(entry.context_length) ??
				positiveInt(entry.max_context_length) ??
				positiveInt(entry.context_window),
		}));
	if (infos.length === 0) return [];

	// llama.cpp's OpenAI-compatible listing carries only ids. Its server-level
	// /props (single-model servers) fills in the context window and chat
	// template; a non-llama.cpp server 404s and the probe is skipped silently.
	// Findings apply to all listed entries, matching the single-model reality.
	let propsContext: number | undefined;
	let propsReasoning = false;
	if (infos.some((info) => info.contextWindow === undefined)) {
		try {
			const props = await fetchJson(target, `${controlRoot(target.baseUrl)}/props`, signal);
			if (typeof props === "object" && props !== null) {
				const { n_ctx, chat_template } = props as { n_ctx?: unknown; chat_template?: unknown };
				propsContext = positiveInt(n_ctx);
				propsReasoning = typeof chat_template === "string" && chat_template.includes("enable_thinking");
			}
		} catch {
			// Not a llama.cpp server (or /props unreachable): listing data stands.
		}
	}
	if (signal.aborted) return [];
	return infos.map((info) =>
		buildDiscoveredModel(target, info.id, {
			contextWindow: info.contextWindow ?? propsContext,
			reasoning: propsReasoning,
		}),
	);
}

function ollamaShowInfo(show: Record<string, unknown>): DiscoveredModelInfo {
	const info: DiscoveredModelInfo = {};
	const modelInfo = show.model_info;
	if (typeof modelInfo === "object" && modelInfo !== null) {
		for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
			if (!key.endsWith(".context_length")) continue;
			const context = positiveInt(value);
			if (context !== undefined) info.contextWindow = context;
		}
	}
	const details = show.details;
	const families =
		typeof details === "object" && details !== null ? (details as { families?: unknown }).families : undefined;
	const capabilities = show.capabilities;
	if (
		(Array.isArray(capabilities) && capabilities.includes("vision")) ||
		(Array.isArray(families) && families.includes("mllama"))
	) {
		info.vision = true;
	}
	const template = show.template;
	if (typeof template === "string" && template.includes("enable_thinking")) {
		info.reasoning = true;
	}
	return info;
}

async function discoverOllamaModels(target: DiscoveryTarget, signal: AbortSignal): Promise<readonly Model<Api>[]> {
	const root = controlRoot(target.baseUrl);
	const payload = await fetchJson(target, `${root}/api/tags`, signal);
	const tags =
		typeof payload === "object" && payload !== null && Array.isArray((payload as { models?: unknown }).models)
			? (payload as { models: unknown[] }).models
			: undefined;
	if (!tags) throw invalidListingError(target);
	const models: Model<Api>[] = [];
	for (const tag of tags) {
		if (typeof tag !== "object" || tag === null) continue;
		const id = (tag as { name?: unknown }).name;
		if (typeof id !== "string" || !id) continue;
		if (signal.aborted) return models;
		let info: DiscoveredModelInfo = {};
		// A failed per-model probe keeps the model listed with defaults; only
		// the listing itself is fatal to discovery.
		try {
			const show = await fetchJson(target, `${root}/api/show`, signal, JSON.stringify({ model: id }));
			if (typeof show === "object" && show !== null) {
				info = ollamaShowInfo(show as Record<string, unknown>);
			}
		} catch {
			// Model stays listed with defaults.
		}
		models.push(buildDiscoveredModel(target, id, info));
	}
	return models;
}

export async function discoverProviderModels(
	target: DiscoveryTarget,
	signal: AbortSignal,
): Promise<readonly Model<Api>[]> {
	return target.protocol === "ollama" ? discoverOllamaModels(target, signal) : discoverOpenAiModels(target, signal);
}

/**
 * One composed-provider refresh step for a discovery-enabled models.json
 * provider: restore the persisted catalog, then fetch a fresh one when the
 * network phase is active. Returns false when the composed refresh should
 * stop (publication generation lost or the signal aborted); real fetch
 * failures propagate so the refresh orchestration surfaces them while the
 * previously discovered list stands.
 */
export async function refreshDiscoveredModels(
	providerId: string,
	config: ModelsJsonProvider,
	context: RefreshModelsContext,
	setDiscoveredModels: (models: readonly AnyModel[]) => void,
): Promise<boolean> {
	const protocol = discoveryProtocolOf(config);
	if (!protocol || !config.baseUrl) return true;
	if (context.stored) {
		const restored = context.stored.models.filter((model) => model.provider === providerId);
		if (!(await context.publish({ update: () => setDiscoveredModels(restored) }))) return false;
	}
	if (!context.allowNetwork || context.signal.aborted) return true;
	const headers = resolveHeadersOrThrow(
		config.headers,
		`provider "${providerId}"`,
		context.credential?.type === "api_key" ? context.credential.env : undefined,
	);
	let models: readonly Model<Api>[];
	try {
		models = await discoverProviderModels(
			{
				providerId,
				baseUrl: config.baseUrl,
				protocol,
				api: (config.api ?? "openai-completions") as Api,
				apiKey: context.credential?.type === "api_key" ? context.credential.key || undefined : undefined,
				headers,
			},
			context.signal,
		);
	} catch (error) {
		// Abort mid-fetch ends the refresh quietly (the orchestrator swallows
		// aborts); real failures surface and keep the last list.
		if (context.signal.aborted) return false;
		throw error;
	}
	if (context.signal.aborted) return false;
	if (
		!(await context.publish({
			persist: { models, checkedAt: Date.now() },
			update: () => setDiscoveredModels(models),
		}))
	) {
		return false;
	}
	return true;
}
