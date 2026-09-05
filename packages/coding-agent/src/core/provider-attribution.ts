import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";

const OPENCODE_HOST = "opencode.ai";
const OPENROUTER_HOST = "openrouter.ai";

function matchesHost(baseUrl: string, expectedHost: string): boolean {
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

/**
 * Optional OpenRouter app-identification headers, used only when the user opts
 * in (`providerAttribution` setting, default off) so OpenRouter attributes
 * usage to the app in its rankings. All other providers are never sent
 * identifying headers.
 */
export function openRouterAttributionHeaders(model: Model<Api>): Record<string, string> | undefined {
	const isOpenRouter = model.provider === "openrouter" || matchesHost(model.baseUrl, OPENROUTER_HOST);
	if (!isOpenRouter) {
		return undefined;
	}
	return {
		"HTTP-Referer": "https://github.com/R-Dson/pi",
		"X-OpenRouter-Title": "pi-fork",
		"X-OpenRouter-Categories": "cli-agent",
	};
}

function getSessionHeaders(model: Model<Api>, sessionId: string | undefined): Record<string, string> | undefined {
	if (!sessionId) return undefined;
	if (
		model.provider !== "opencode" &&
		model.provider !== "opencode-go" &&
		!matchesHost(model.baseUrl, OPENCODE_HOST)
	) {
		return undefined;
	}
	// Provider-required: the OpenCode Zen gateway serves anonymous requests
	// (missing these headers) from a heavily restricted rate-limit tier, so
	// these headers are the minimum needed for usable service. See upstream
	// issue earendil-works/pi#2824.
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

export function mergeProviderAttributionHeaders(
	model: Model<Api>,
	sessionId: string | undefined,
	...headerSources: Array<ProviderHeaders | undefined>
): ProviderHeaders | undefined {
	const merged: ProviderHeaders = {
		...getSessionHeaders(model, sessionId),
	};

	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}
