import {
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "fs";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, getSettingsPath, PACKAGE_NAME } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { DefaultPackageManager, type ResolvedResource } from "../core/package-manager.ts";
import { classifySelfUpdateInstall } from "../core/self-update-source.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import { SYSTEM_THEME_NAME } from "../modes/interactive/theme/system-theme.ts";
import {
	getAvailableThemes,
	getTerminalTheme,
	initTheme,
	loadThemeFromPath,
	markTerminalColorsPending,
	resolveThemeSetting,
	setRegisteredThemes,
	setTerminalColors,
	setTheme,
	type Theme,
} from "../modes/interactive/theme/theme.ts";
import { requestTerminalColors } from "../modes/interactive/theme/theme-controller.ts";

const OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const OFFICIAL_APP_NAME = "pi";
const OFFICIAL_CONFIG_DIR_NAME = ".pi";

interface DistributionMetadata {
	packageName: string;
	appName: string;
	configDirName: string;
}

function isOfficialDistribution({ packageName, appName, configDirName }: DistributionMetadata): boolean {
	return (
		packageName === OFFICIAL_PACKAGE_NAME &&
		appName === OFFICIAL_APP_NAME &&
		configDirName === OFFICIAL_CONFIG_DIR_NAME
	);
}

function loadThemes(resources: ResolvedResource[]): Theme[] {
	const themes: Theme[] = [];
	const seen = new Set<string>();
	for (const resource of resources) {
		if (!resource.enabled) continue;
		try {
			const loadedTheme = loadThemeFromPath(resource.path);
			if (loadedTheme.name) {
				if (seen.has(loadedTheme.name)) continue;
				seen.add(loadedTheme.name);
			}
			themes.push(loadedTheme);
		} catch {
			// Startup prompts should not fail because a theme is broken. The normal
			// resource loader reports theme diagnostics later in startup.
		}
	}
	return themes;
}

async function loadStartupThemes(settingsManager: SettingsManager): Promise<Theme[]> {
	const globalSettingsManager = SettingsManager.inMemory(settingsManager.getGlobalSettings(), {
		projectTrusted: false,
	});
	const packageManager = new DefaultPackageManager({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		settingsManager: globalSettingsManager,
	});
	const resolvedPaths = await packageManager.resolve(async () => "skip");
	return loadThemes(resolvedPaths.themes);
}

export async function createStartupTui(settingsManager: SettingsManager): Promise<TUI> {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	setRegisteredThemes(await loadStartupThemes(settingsManager));
	// The system theme starts in grayscale until the terminal reports its colors.
	markTerminalColorsPending();
	initTheme(resolveThemeSetting(settingsManager.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME);
	setKeybindings(KeybindingsManager.create());
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

export function startStartupTui(ui: TUI, settingsManager: SettingsManager): void {
	ui.start();
	const themeSetting = settingsManager.getThemeSetting();
	queryStartupTerminalColors(ui, () => {
		setTheme(resolveThemeSetting(themeSetting, getTerminalTheme()) ?? SYSTEM_THEME_NAME);
	});
}

/**
 * Query the terminal's colors without waiting for them. When they arrive, including after the timeout,
 * record them for the system theme and "" (terminal default) tokens, run `onColors`, and re-render.
 */
function queryStartupTerminalColors(ui: TUI, onColors: () => void): void {
	void requestTerminalColors(ui, (colors) => {
		setTerminalColors(colors);
		onColors();
		ui.invalidate();
		ui.requestRender();
	});
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * First-time setup runs once per distribution:
 * - fresh installs (no settings.json), and
 * - existing installs that have never answered the privacy questions — the
 *   `updateCheck`/`providerAttribution` keys are absent until the wizard or
 *   /settings first writes them, so unanswered users are asked exactly once.
 * Runs for the official distribution and fork releases; skipped under a
 * custom agent dir override.
 */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	if (process.env[ENV_AGENT_DIR]) {
		return false;
	}
	const isOfficial = isOfficialDistribution({
		packageName: PACKAGE_NAME,
		appName: APP_NAME,
		configDirName: CONFIG_DIR_NAME,
	});
	const forkKind = classifySelfUpdateInstall(PACKAGE_NAME);
	if (!isOfficial && forkKind !== "fork-standalone" && forkKind !== "fork-registry") {
		return false;
	}
	if (!existsSync(settingsPath)) {
		return true;
	}
	return !hasPrivacyAnswers(settingsPath);
}

/** True when at least one privacy question has an answer on record. */
function hasPrivacyAnswers(settingsPath: string): boolean {
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		return "updateCheck" in settings || "providerAttribution" in settings;
	} catch {
		return false;
	}
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settingsManager);
	});
}

/** Show the first-time setup dialog and persist the result */
export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	const ui = await createStartupTui(settingsManager);
	// A set theme means the install already chose one (old wizard, /settings,
	// or a previous run): skip the theme question so confirming cannot
	// overwrite it with the preselected Automatic.
	const skipTheme = settingsManager.getThemeSetting() !== undefined;
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			if (result?.theme !== undefined) {
				settingsManager.setTheme(result.theme);
			}
			// Completing and skipping both record the privacy answers (skipping
			// declines both) so the wizard never asks the same user twice.
			settingsManager.setUpdateCheck(result?.updateCheck ?? false);
			settingsManager.setProviderAttribution(result?.providerAttribution ?? false);
			await settingsManager.flush();
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};

		ui.start();
		// The system theme is the default selection; the terminal's colors regenerate
		// it, and re-rendering rebuilds the dialog with them. A set theme keeps
		// coloring the dialog instead — the theme step is skipped for that install.
		let previewTheme = SYSTEM_THEME_NAME;
		if (!skipTheme) {
			setTheme(previewTheme);
		}
		const component = new FirstTimeSetupComponent({
			skipTheme,
			// System first — the fresh-install default; then every registered theme
			// (createStartupTui already registered built-in + resource themes, System
			// included, so this stays a de-duplicated ordered list).
			themes: [SYSTEM_THEME_NAME, ...getAvailableThemes().filter((name) => name !== SYSTEM_THEME_NAME)],
			onThemePreview: (themeName) => {
				previewTheme = themeName;
				setTheme(themeName);
				ui.requestRender();
			},
			onSubmit: (result) => void finish(result),
			onCancel: () => void finish(undefined),
		});
		ui.addChild(component);
		ui.setFocus(component);
		ui.requestRender();
		// The terminal's colors regenerate the system theme; re-rendering rebuilds the dialog with it.
		queryStartupTerminalColors(ui, () => {
			if (!skipTheme) {
				setTheme(previewTheme);
			}
		});
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
			},
		);
		ui.addChild(input);
		ui.setFocus(input);
		startStartupTui(ui, settingsManager);
	});
}
