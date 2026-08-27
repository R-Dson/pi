import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classifySelfUpdateInstall,
	FORK_STANDALONE_PACKAGE_NAME,
	resolveRunningPackageName,
} from "../src/core/self-update-source.ts";

describe("self-update install classification", () => {
	it("classifies the fork standalone package name", () => {
		expect(classifySelfUpdateInstall("@r-dson/pi-standalone")).toBe("fork-standalone");
	});

	it("classifies GitHub Packages installs under the fork scope as fork-registry", () => {
		// Issue #74: any @r-dson/* name other than the standalone package is a
		// GitHub Packages install and must update from the fork registry.
		expect(classifySelfUpdateInstall("@r-dson/pi-coding-agent")).toBe("fork-registry");
		expect(classifySelfUpdateInstall("@r-dson/pi-ai")).toBe("fork-registry");
	});

	it("classifies the upstream npm package name", () => {
		expect(classifySelfUpdateInstall("@earendil-works/pi-coding-agent")).toBe("upstream-package");
	});

	it("classifies any other resolved package as other", () => {
		expect(classifySelfUpdateInstall("pi")).toBe("other");
		expect(classifySelfUpdateInstall("")).toBe("other");
		expect(classifySelfUpdateInstall("@other-scope/pi-coding-agent")).toBe("other");
	});

	it("never classifies the fork standalone name as upstream or other", () => {
		// The one classification that must never regress: a fork standalone
		// install updating from npmjs would replace the fork with upstream pi.
		expect(classifySelfUpdateInstall(FORK_STANDALONE_PACKAGE_NAME)).toBe("fork-standalone");
	});
});

describe("resolveRunningPackageName", () => {
	let tempDir: string;
	let originalPiPackageDir: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-self-update-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		originalPiPackageDir = process.env.PI_PACKAGE_DIR;
	});

	afterEach(() => {
		if (originalPiPackageDir === undefined) {
			delete process.env.PI_PACKAGE_DIR;
		} else {
			process.env.PI_PACKAGE_DIR = originalPiPackageDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads the package name from the resolved package dir", () => {
		process.env.PI_PACKAGE_DIR = tempDir;
		writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "@r-dson/pi-standalone" }));

		expect(resolveRunningPackageName()).toBe("@r-dson/pi-standalone");
	});

	it("returns an empty name when no package.json resolves", () => {
		process.env.PI_PACKAGE_DIR = tempDir;

		expect(resolveRunningPackageName()).toBe("");
	});
});
