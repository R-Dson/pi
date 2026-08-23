import { readFileSync } from "node:fs";
import { getPackageJsonPath } from "../config.ts";
import { stripBom } from "../utils/text.ts";

// Self-update channel selection (issue #29): the running install's package
// name identifies where updates must come from. The fork standalone install
// must never be updated from npmjs under the upstream package name — that
// would replace the fork with upstream pi.

export const FORK_STANDALONE_PACKAGE_NAME = "@r-dson/pi-standalone";
export const UPSTREAM_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
// Same asset install-fork.sh downloads; npm fetches public GitHub release
// assets and npmjs dependencies without authentication.
export const FORK_STANDALONE_TARBALL_URL = "https://github.com/R-Dson/pi/releases/latest/download/pi-fork.tgz";
export const FORK_INSTALL_COMMAND =
	"curl -fsSL https://raw.githubusercontent.com/R-Dson/pi/main/scripts/install-fork.sh | sh";

export type SelfUpdateInstallKind = "fork-standalone" | "upstream-package" | "other";

export function classifySelfUpdateInstall(packageName: string): SelfUpdateInstallKind {
	if (packageName === FORK_STANDALONE_PACKAGE_NAME) {
		return "fork-standalone";
	}
	if (packageName === UPSTREAM_PACKAGE_NAME) {
		return "upstream-package";
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
