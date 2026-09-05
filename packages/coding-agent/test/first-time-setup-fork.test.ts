import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({ packageName: "@example/pi-coding-agent" }));

vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...(actual as Record<string, unknown>),
		get PACKAGE_NAME() {
			return mockConfig.packageName;
		},
	};
});

import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";

describe("shouldRunFirstTimeSetup in forked distributions", () => {
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-first-time-setup-fork-"));
		settingsPath = join(tempDir, "settings.json");
		mockConfig.packageName = "@r-dson/pi-coding-agent";
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalPiExperimental === undefined) {
			delete process.env.PI_EXPERIMENTAL;
		} else {
			process.env.PI_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("runs for fork releases without the experimental flag", () => {
		delete process.env.PI_EXPERIMENTAL;
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("runs for the fork standalone package", () => {
		delete process.env.PI_EXPERIMENTAL;
		mockConfig.packageName = "@r-dson/pi-standalone";
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("asks existing fork users once when the privacy questions are unanswered", () => {
		mockConfig.packageName = "@r-dson/pi-coding-agent";
		writeFileSync(settingsPath, "{}", "utf-8");
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("does not ask existing fork users again after the questions were answered", () => {
		mockConfig.packageName = "@r-dson/pi-coding-agent";
		writeFileSync(settingsPath, JSON.stringify({ updateCheck: true, providerAttribution: false }), "utf-8");
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("still skips unknown distributions", () => {
		delete process.env.PI_EXPERIMENTAL;
		mockConfig.packageName = "@example/pi-coding-agent";
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});
