import type { Container } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../src/modes/interactive/components/first-time-setup.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function render(container: Container): string {
	// Strip ANSI so assertions match on visible text only.
	return container.children
		.flatMap((child) => child.render(120))
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("FirstTimeSetupComponent theme step", () => {
	beforeAll(() => initTheme("dark"));

	it("offers every registered theme and submits the selected one", () => {
		const previews: string[] = [];
		let submitted: FirstTimeSetupResult | undefined;
		const component = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			themes: ["dark", "light", "dracula"],
			onThemePreview: (theme) => previews.push(theme),
			onSubmit: (result) => {
				submitted = result;
			},
			onCancel: () => {},
		});

		const rendered = render(component);
		expect(rendered).toContain("dark");
		expect(rendered).toContain("light");
		expect(rendered).toContain("dracula");

		// j/k fallbacks move the selection; two downs select "dracula".
		component.handleInput("j");
		component.handleInput("j");
		expect(previews.at(-1)).toBe("dracula");

		// Enter advances theme → update check → attribution, then submits.
		component.handleInput("\n");
		component.handleInput("\n");
		component.handleInput("\n");
		expect(submitted?.theme).toBe("dracula");
		expect(submitted?.updateCheck).toBe(false);
		expect(submitted?.providerAttribution).toBe(false);
	});

	it("preselects the detected appearance when present", () => {
		const component = new FirstTimeSetupComponent({
			detectedTheme: "light",
			themes: ["dark", "light", "dracula"],
			onThemePreview: () => {},
			onSubmit: () => {},
			onCancel: () => {},
		});
		expect(render(component)).toContain("→ light");
	});

	it("always starts at the theme step, preselecting the current theme", () => {
		const component = new FirstTimeSetupComponent({
			detectedTheme: "light",
			themes: ["dark", "light", "dracula"],
			currentTheme: "dracula",
			onThemePreview: () => {},
			onSubmit: () => {},
			onCancel: () => {},
		});

		const rendered = render(component);
		// First screen is the theme step even though a theme is already set.
		expect(rendered).toContain("Pick a theme.");
		expect(rendered).toContain("→ dracula");
		expect(rendered).not.toContain("→ light");

		// Confirming without navigating keeps the current theme.
		let submitted: FirstTimeSetupResult | undefined;
		const confirming = new FirstTimeSetupComponent({
			detectedTheme: "light",
			themes: ["dark", "light", "dracula"],
			currentTheme: "dracula",
			onThemePreview: () => {},
			onSubmit: (result) => {
				submitted = result;
			},
			onCancel: () => {},
		});
		confirming.handleInput("\n");
		confirming.handleInput("\n");
		confirming.handleInput("\n");
		expect(submitted?.theme).toBe("dracula");
	});

	it("falls back to the detected appearance when the current theme is unknown", () => {
		const component = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			themes: ["dark", "light"],
			currentTheme: "nonexistent",
			onThemePreview: () => {},
			onSubmit: () => {},
			onCancel: () => {},
		});
		expect(render(component)).toContain("→ dark");
	});
});

describe("shouldRunFirstTimeSetup", () => {
	const originalAgentDir = process.env[ENV_AGENT_DIR];
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-first-time-setup-"));
		settingsPath = join(tempDir, "settings.json");
		delete process.env[ENV_AGENT_DIR];
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("returns true for a fresh install", () => {
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("returns false when a custom agent dir is set", () => {
		process.env[ENV_AGENT_DIR] = tempDir;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("asks once when settings.json exists without privacy answers", () => {
		writeFileSync(settingsPath, "{}", "utf-8");

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("does not ask again once the privacy questions have been answered", () => {
		writeFileSync(settingsPath, JSON.stringify({ updateCheck: false, providerAttribution: false }), "utf-8");

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});
