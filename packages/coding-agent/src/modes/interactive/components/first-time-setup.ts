import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../config.ts";
import { type TerminalTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface FirstTimeSetupResult {
	theme: string;
	updateCheck: boolean;
	providerAttribution: boolean;
}

export interface FirstTimeSetupOptions {
	detectedTheme: TerminalTheme;
	/** Every registered theme name; "dark"/"light" are always present. */
	themes: string[];
	/** Theme already chosen by the user, if any; preselected over the detected appearance. */
	currentTheme?: string;
	onThemePreview: (themeName: string) => void;
	onSubmit: (result: FirstTimeSetupResult) => void;
	onCancel: () => void;
}

// Privacy-first: "Off" is the first (default-selected) option on every
// question; cancelling setup leaves every setting off.
const YES_NO_OPTIONS = ["Off", "On"];

const SETUP_LOGO_LINES = ["██████", "██  ██", "████  ██", "██    ██"];

type YesNoStep = "updateCheck" | "attribution";
type Step = "theme" | YesNoStep;

const YES_NO_STEPS: Record<YesNoStep, { question: string; explanation: string }> = {
	updateCheck: {
		question: "Check GitHub for new fork releases on startup?",
		explanation: "Off by default. This is the only automatic request the fork can make besides your providers.",
	},
	attribution: {
		question: "Identify the app to OpenRouter?",
		explanation:
			"Off by default. Sends attribution headers on OpenRouter requests only, so usage shows up in OpenRouter rankings.",
	},
};

// The theme-setting value for "follow terminal appearance" (same value the
// /settings theme submenu calls Automatic); rendered with a friendlier label.
const AUTOMATIC_THEME = "/";

const THEME_LABELS: Record<string, string> = {
	[AUTOMATIC_THEME]: "Automatic",
};

/**
 * First-time setup dialog: theme choice, then opt-in questions for the fork's
 * two phone-home features (update check, OpenRouter attribution). Every
 * question defaults to Off; cancelling skips the whole setup and leaves
 * everything off.
 */
export class FirstTimeSetupComponent extends Container {
	private step: Step = "theme";
	private themeIndex: number;
	private readonly themes: string[];
	// The domain value stored directly; the option-list index is derived at render.
	private readonly yesNo: Record<YesNoStep, boolean> = { updateCheck: false, attribution: false };
	private readonly options: FirstTimeSetupOptions;

	constructor(options: FirstTimeSetupOptions) {
		super();
		this.options = options;
		this.themes = options.themes;
		// The theme question is always first; preselect the user's current
		// theme so confirming without navigating keeps it, else Automatic
		// (follow the detected terminal appearance) when offered.
		const preferred =
			options.currentTheme && this.themes.includes(options.currentTheme) ? options.currentTheme : AUTOMATIC_THEME;
		this.themeIndex = Math.max(0, this.themes.indexOf(preferred));
		this.update();
	}

	// Rebuild the whole dialog on every change so theme previews recolor all text.
	private update(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		if (this.step === "theme") {
			this.addChild(new Text(theme.fg("accent", SETUP_LOGO_LINES.join("\n")), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(theme.fg("accent", theme.bold(`Welcome to ${APP_NAME}, the minimal coding agent.`)), 1, 0),
			);
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("text", "Pick a theme."), 1, 0));
			this.addChild(new Text(theme.fg("muted", `Detected system appearance: ${this.options.detectedTheme}`), 1, 0));
			this.addChild(new Spacer(1));
			this.addOptionList(this.themes, this.themeIndex);
		} else {
			const { question, explanation } = YES_NO_STEPS[this.step];
			this.addChild(new Text(theme.fg("accent", theme.bold("Privacy")), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("text", question), 1, 0));
			this.addChild(new Text(theme.fg("muted", explanation)));
			this.addOptionList(YES_NO_OPTIONS, this.yesNo[this.step] ? 1 : 0);
		}

		this.addChild(new Spacer(1));
		const confirmLabel = this.step === "attribution" ? "finish" : "continue";
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", confirmLabel) +
					"  " +
					keyHint("tui.select.cancel", "skip setup"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private addOptionList(labels: string[], selectedIndex: number): void {
		for (let i = 0; i < labels.length; i++) {
			const isSelected = i === selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected
				? theme.fg("accent", THEME_LABELS[labels[i]] ?? labels[i])
				: theme.fg("text", THEME_LABELS[labels[i]] ?? labels[i]);
			this.addChild(new Text(`${prefix}${label}`, 1, 0));
		}
	}

	private moveThemeSelection(delta: number): void {
		const next = Math.max(0, Math.min(this.themes.length - 1, this.themeIndex + delta));
		if (next !== this.themeIndex) {
			this.themeIndex = next;
			this.options.onThemePreview(this.themes[this.themeIndex]);
		}
		this.update();
	}

	private moveYesNoSelection(delta: number): void {
		if (this.step === "theme") {
			return;
		}
		// Two options, Off first: down selects On, up selects Off.
		this.yesNo[this.step] = delta > 0;
		this.update();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.onCancel();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			if (this.step === "theme") {
				this.moveThemeSelection(-1);
			} else {
				this.moveYesNoSelection(-1);
			}
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			if (this.step === "theme") {
				this.moveThemeSelection(1);
			} else {
				this.moveYesNoSelection(1);
			}
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			if (this.step === "theme") {
				this.step = "updateCheck";
				this.update();
			} else if (this.step === "updateCheck") {
				this.step = "attribution";
				this.update();
			} else {
				this.options.onSubmit({
					theme: this.themes[this.themeIndex],
					updateCheck: this.yesNo.updateCheck,
					providerAttribution: this.yesNo.attribution,
				});
			}
		}
	}
}
