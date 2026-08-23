/**
 * Tool permission policy: capability vocabulary and rule evaluator.
 *
 * Pure module (no fs, no runtime state). The rule evaluator decides whether a
 * tool call is allowed, requires approval, or is denied, based on an ordered
 * rule list. Execution-time enforcement lives in AgentSession's beforeToolCall
 * hook (opt-in via `tools.permissions.mode: "policy"`).
 *
 * Matching semantics:
 * - A rule matches when every field specified on the rule matches the call.
 *   `effect`-only rules match everything (catch-all).
 * - `tool`: exact tool name.
 * - `capability`: exact capability. A rule with `capability` never matches a
 *   tool whose definition has no (or a different) capability; a rule without
 *   `capability` matches any tool.
 * - `path`: path-segment prefix match on the call's path-like argument. All
 *   built-in tools name that argument `path`, which is the canonical name;
 *   `file` and `target` are also accepted so custom tools using those spellings
 *   can be constrained. `/repo/src` matches `/repo/src` and `/repo/src/a.ts`
 *   but not `/repo/src-other/a.ts`.
 * - `command`: plain string prefix match on the call's string `command`
 *   argument (the bash tool). `git` matches `git status --short`.
 * - Unrecognized args fields are ignored by matching.
 *
 * Precedence: deny > ask > allow > default. Rule-list order does not change
 * which kind wins; among multiple matching rules of the winning kind, the LAST
 * matching rule wins (list order is the user's specificity mechanism). The
 * returned reason names the matched rule (index plus fields) so blocked tool
 * results can explain themselves to the model.
 *
 * Visibility: a deny rule with `hide: true` additionally removes matching tools
 * from the model-visible tool list in policy mode. Visibility is evaluated with
 * the tool's definition and NO call args, so rules whose matchers need a
 * `path`/`command` value never hide a tool (they still apply at call time).
 * Hidden tools stay registered internally; a stale model call to one fails in
 * the agent loop with a terminal "Tool <name> not found" error result before
 * the policy check runs.
 *
 * Profiles (`code`/`review`/`minimal`) resolve to ordinary base-layer rules
 * (see `resolveProfileConfig`); user rules override them through layered
 * evaluation (see `evaluatePermissionLayered`). Profiles apply only in policy
 * mode — legacy mode ignores them entirely.
 */

/** Capability a tool exercises, used by permission policy evaluation. */
export type ToolCapability =
	| "filesystem.read"
	| "filesystem.write"
	| "process.execute"
	| "network.access"
	| "session.modify";

/** Effect kinds, strongest first. */
const EFFECT_STRENGTH: Record<PermissionRule["effect"], number> = {
	deny: 3,
	ask: 2,
	allow: 1,
};

/** One permission rule. Unspecified matchers are ignored; a bare effect is a catch-all. */
export interface PermissionRule {
	/** Exact tool name to match. */
	tool?: string;
	/** Exact capability to match. */
	capability?: ToolCapability;
	/** Path-segment prefix matched against the call's `path` (or `file`/`target`) argument. */
	path?: string;
	/** String prefix matched against the call's `command` argument. */
	command?: string;
	/** What to do when the rule matches. */
	effect: "allow" | "ask" | "deny";
	/**
	 * Deny-only: also remove matching tools from the model-visible tool list in
	 * policy mode. Meaningless on allow/ask rules (ignored by the evaluator).
	 * Visibility is evaluated with no call args, so rules whose matchers need a
	 * `path`/`command` value never hide a tool — they still apply at call time.
	 */
	hide?: boolean;
}

/** Structured outcome of evaluating a call against a rule list. */
export type PermissionDecision = {
	kind: "allow" | "ask" | "deny";
	/** Human-readable explanation naming what matched (rule index plus fields). */
	reason: string;
	/** Whether a rule matched; false means the default effect decided. */
	matched: boolean;
	/**
	 * True only when the winning rule is a deny rule with `hide: true`. Used by
	 * policy-mode visibility filtering; `hide` on allow/ask rules has no effect.
	 */
	hidden: boolean;
};

/** Argument names checked, in order, for the path-like field of a call. */
const PATH_ARG_NAMES = ["path", "file", "target"] as const;

function isPathPrefix(rulePath: string, argPath: string): boolean {
	const rule = rulePath.endsWith("/") && rulePath !== "/" ? rulePath.slice(0, -1) : rulePath;
	return argPath === rule || argPath.startsWith(rule === "/" ? "/" : `${rule}/`);
}

function describeRule(rule: PermissionRule, index: number): string {
	const matchers: string[] = [];
	if (rule.tool) matchers.push(`tool=${rule.tool}`);
	if (rule.capability) matchers.push(`capability=${rule.capability}`);
	if (rule.path) matchers.push(`path=${rule.path}`);
	if (rule.command) matchers.push(`command=${rule.command}`);
	const matcherText = matchers.length > 0 ? matchers.join(", ") : "catch-all";
	return `permission rule #${index} (${matcherText}, effect ${rule.effect})`;
}

/**
 * Tool profile: a named preset that resolves to ordinary permission rules
 * (see `resolveProfileConfig`). Profiles apply only in policy mode.
 */
export type ToolProfile = "code" | "review" | "minimal";

/** A profile preset resolved to plain configuration. */
export interface ProfileConfig {
	/**
	 * Base-layer permission rules. Any matching user rule overrides them (see
	 * `evaluatePermissionLayered`); non-matching profile rules still apply.
	 */
	permissionRules: PermissionRule[];
}

/**
 * Static profile presets. Kept as plain rule lists — no runtime cleverness:
 * - code (default): all tools, default-allow.
 * - review: read-only analysis. Deny+hide every write and process tool
 *   (matching by capability, so custom tools carrying the metadata follow),
 *   allow reads for self-documentation.
 * - minimal: reduced core toolset (read/grep/find/ls remain). A static deny+hide
 *   list for the non-core builtins (bash/edit/write); capability rules cannot
 *   express "everything except" under deny > ask > allow, and custom/extension
 *   tools have no static name list, so they stay visible.
 */
const PROFILE_PRESETS: Record<ToolProfile, ProfileConfig> = {
	code: { permissionRules: [] },
	review: {
		permissionRules: [
			{ capability: "filesystem.read", effect: "allow" },
			{ capability: "filesystem.write", effect: "deny", hide: true },
			{ capability: "process.execute", effect: "deny", hide: true },
		],
	},
	minimal: {
		permissionRules: [
			{ tool: "bash", effect: "deny", hide: true },
			{ tool: "edit", effect: "deny", hide: true },
			{ tool: "write", effect: "deny", hide: true },
		],
	},
};

/** Resolve a profile name to its preset. Undefined and unknown values resolve to `code`. */
export function resolveProfileConfig(profile: ToolProfile | undefined): ProfileConfig {
	const preset = PROFILE_PRESETS[profile ?? "code"] ?? PROFILE_PRESETS.code;
	// Fresh list per call so callers cannot corrupt the shared preset.
	return { permissionRules: [...preset.permissionRules] };
}

/**
 * Evaluate a tool call against a base rule layer (resolved profile preset) and
 * an override layer (user rules).
 *
 * Layering implements "user rules override the profile": if any user rule
 * matches, the user layer decides alone; otherwise the profile layer decides;
 * otherwise the default effect applies. Plain concatenation cannot express
 * this because deny > ask > allow regardless of list order, so a profile deny
 * would be unbeatable by a user allow. Within each layer the documented
 * precedence (deny > ask > allow, last matching rule of the winning kind wins)
 * is unchanged.
 */
export function evaluatePermissionLayered(input: {
	toolName: string;
	capability?: ToolCapability;
	args: Record<string, unknown>;
	/** Base layer: resolved profile rules. */
	baseRules: PermissionRule[];
	/** Override layer: user rules; any match here wins over the base layer. */
	rules: PermissionRule[];
	defaultEffect: "allow" | "deny";
}): PermissionDecision {
	const { toolName, capability, args, baseRules, rules, defaultEffect } = input;

	const userDecision = evaluatePermission({ toolName, capability, args, rules, defaultEffect });
	if (userDecision.matched) {
		return userDecision;
	}

	const baseDecision = evaluatePermission({ toolName, capability, args, rules: baseRules, defaultEffect });
	return baseDecision.matched ? baseDecision : userDecision;
}

/**
 * Evaluate a tool call against an ordered permission rule list.
 *
 * Returns the strongest matching decision: deny > ask > allow > default. Ties
 * within the strongest kind are resolved in favor of the last matching rule.
 */
export function evaluatePermission(input: {
	toolName: string;
	capability?: ToolCapability;
	args: Record<string, unknown>;
	rules: PermissionRule[];
	defaultEffect: "allow" | "deny";
}): PermissionDecision {
	const { toolName, capability, args, rules, defaultEffect } = input;

	let winner: { rule: PermissionRule; index: number } | undefined;
	for (let index = 0; index < rules.length; index++) {
		const rule = rules[index];
		// Rules come from user settings JSON; malformed entries are skipped rather
		// than trusted. Empty-string matchers would match everything, so they count
		// as unspecified.
		if (!EFFECT_STRENGTH[rule.effect]) continue;
		if (rule.tool !== undefined && rule.tool !== toolName) continue;
		if (rule.capability !== undefined && rule.capability !== capability) continue;
		if (rule.path !== undefined && rule.path !== "") {
			const argPath = PATH_ARG_NAMES.map((name) => args[name]).find(
				(value): value is string => typeof value === "string",
			);
			if (argPath === undefined || !isPathPrefix(rule.path, argPath)) continue;
		}
		if (rule.command !== undefined && rule.command !== "") {
			const argCommand = args.command;
			if (typeof argCommand !== "string" || !argCommand.startsWith(rule.command)) continue;
		}
		// Later matches of the same strength replace earlier ones; stronger kinds
		// replace weaker ones regardless of list order.
		if (winner === undefined || EFFECT_STRENGTH[rule.effect] >= EFFECT_STRENGTH[winner.rule.effect]) {
			winner = { rule, index };
		}
	}

	if (winner === undefined) {
		const capabilityText = capability ? ` (capability ${capability})` : "";
		return {
			kind: defaultEffect,
			reason: `No permission rule matched tool "${toolName}"${capabilityText}; default effect is ${defaultEffect}.`,
			matched: false,
			hidden: false,
		};
	}

	return {
		kind: winner.rule.effect,
		reason: `${winner.rule.effect} by ${describeRule(winner.rule, winner.index)}`,
		matched: true,
		hidden: winner.rule.effect === "deny" && winner.rule.hide === true,
	};
}
