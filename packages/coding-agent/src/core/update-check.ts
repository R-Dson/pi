import { gt, valid } from "semver";

// The fork's only phone-home that can exist: a release check against the
// fork's own GitHub repo (there is no fork backend to ping). Opt-in via the
// `updateCheck` setting; the default install performs zero fetches.

const FORK_RELEASES_API_URL = "https://api.github.com/repos/R-Dson/pi/releases/latest";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Check the fork's GitHub releases for a version newer than `currentVersion`.
 * Returns a user-facing notice, or undefined when up to date, unparsable, or
 * unreachable — failures are silent because an update notice must never turn
 * into a startup error. A hung connection is aborted after 10 s.
 */
export async function checkForForkUpdate(currentVersion: string): Promise<string | undefined> {
	let latest: string;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(FORK_RELEASES_API_URL, { signal: controller.signal });
		if (!response.ok) {
			return undefined;
		}
		const body = (await response.json()) as { tag_name?: unknown };
		if (typeof body.tag_name !== "string") {
			return undefined;
		}
		latest = body.tag_name.replace(/^v/, "");
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
	if (!valid(latest) || !valid(currentVersion) || !gt(latest, currentVersion)) {
		return undefined;
	}
	return `Pi Fork update available: ${latest} (running ${currentVersion}) — run 'pi update --self'`;
}
