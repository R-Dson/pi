import { type ClientIdentityTarget, getIdentityHeaders } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getClientIdentity } from "../src/core/client-identity.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const openrouter: ClientIdentityTarget = { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" };
const opencode: ClientIdentityTarget = { provider: "opencode", baseUrl: "https://opencode.ai/inference" };

describe("client identity (issue #32: zero telemetry, opt-in attribution)", () => {
	it("carries no User-Agent and no attribution by default", () => {
		const identity = getClientIdentity(SettingsManager.inMemory({}));
		expect(identity.userAgent).toBeUndefined();
		expect(identity.attribution).toBeNull();
		expect(getIdentityHeaders(openrouter, identity)).toEqual({});
	});

	it("emits the fork's OpenRouter attribution only when providerAttribution is enabled", () => {
		const identity = getClientIdentity(SettingsManager.inMemory({ providerAttribution: true }));
		const headers = getIdentityHeaders(openrouter, identity);
		expect(headers).toEqual({
			"HTTP-Referer": "https://github.com/R-Dson/pi",
			"X-OpenRouter-Title": "pi-fork",
			"X-OpenRouter-Categories": "cli-agent",
		});
		expect(headers["User-Agent"]).toBeUndefined();
	});

	it("always sends the provider-required OpenCode client header, even without attribution", () => {
		const off = getIdentityHeaders(opencode, getClientIdentity(SettingsManager.inMemory({})));
		expect(off["x-opencode-client"]).toBe("pi");
		const on = getIdentityHeaders(
			opencode,
			getClientIdentity(SettingsManager.inMemory({ providerAttribution: true })),
		);
		expect(on["x-opencode-client"]).toBe("pi-fork");
	});

	it("sends a User-Agent only when an identity explicitly sets one", () => {
		const headers = getIdentityHeaders(openrouter, { userAgent: "short" });
		expect(headers["User-Agent"]).toBe("pi");
		expect(getIdentityHeaders(openrouter, {})).toEqual({});
	});
});
