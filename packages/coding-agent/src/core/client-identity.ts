import type { ClientAttribution, ClientIdentity } from "@earendil-works/pi-ai";
import type { SettingsManager } from "./settings-manager.ts";

/**
 * Fork attribution values (issue #32): the OpenRouter app-identification headers name this fork,
 * not upstream. No `userAgent` is set — the fork sends no app User-Agent unless a caller sets one.
 */
const FORK_ATTRIBUTION: ClientAttribution = {
	name: "pi-fork",
	url: "https://github.com/R-Dson/pi",
	categories: ["cli-agent"],
};

/**
 * How pi's requests identify themselves to providers: no User-Agent, and the OpenRouter
 * attribution headers strictly opt-in via the `providerAttribution` setting (read per request
 * so mid-session changes apply at once). Without the setting, requests carry no attribution.
 */
export function getClientIdentity(settingsManager: SettingsManager): ClientIdentity {
	return {
		attribution: settingsManager.getProviderAttributionEnabled() ? FORK_ATTRIBUTION : null,
	};
}
