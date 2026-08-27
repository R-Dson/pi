import { readFileSync } from "node:fs";
import { getPackageJsonPath } from "../config.ts";
import { stripBom } from "../utils/text.ts";

// Self-update channel selection (issues #29/#74): the running install's
// package name identifies where updates must come from. Fork installs must
// never be updated from npmjs under the upstream package name — that would
// replace the fork with upstream pi.

export const FORK_STANDALONE_PACKAGE_NAME = "@r-dson/pi-standalone";
// GitHub Packages publishes the fork's workspace packages under this scope;
// only @r-dson/pi-standalone (the standalone tarball) is not a registry name.
const FORK_REGISTRY_SCOPE = "@r-dson/";
// The install spec for GitHub Packages installs: the user's .npmrc scope
// mapping resolves @r-dson to npm.pkg.github.com (docs/fork/install-from-github.md).
export const FORK_REGISTRY_PACKAGE_NAME = "@r-dson/pi-coding-agent";
const UPSTREAM_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
// Same asset install-fork.sh downloads; npm fetches public GitHub release
// assets and npmjs dependencies without authentication.
export const FORK_STANDALONE_TARBALL_URL = "https://github.com/R-Dson/pi/releases/latest/download/pi-fork.tgz";
export const FORK_INSTALL_COMMAND =
	"curl -fsSL https://raw.githubusercontent.com/R-Dson/pi/main/scripts/install-fork.sh | sh";

export type SelfUpdateInstallKind = "fork-standalone" | "fork-registry" | "upstream-package" | "other";

export function classifySelfUpdateInstall(packageName: string): SelfUpdateInstallKind {
	if (packageName === FORK_STANDALONE_PACKAGE_NAME) {
		return "fork-standalone";
	}
	if (packageName === UPSTREAM_PACKAGE_NAME) {
		return "upstream-package";
	}
	if (packageName.startsWith(FORK_REGISTRY_SCOPE)) {
		return "fork-registry";
	}
	return "other";
}

/**
 * Name of the package the running install resolves to, read from the resolved
 * package dir (honors PI_PACKAGE_DIR). Empty when no package.json resolves
 * (bun binary, unpackaged checkout).
 */
export function resolveRunningPackageName(): string {
	try {
		const manifest = JSON.parse(stripBom(readFileSync(getPackageJsonPath(), "utf-8"))) as { name?: unknown };
		return typeof manifest.name === "string" ? manifest.name : "";
	} catch {
		return "";
	}
}
