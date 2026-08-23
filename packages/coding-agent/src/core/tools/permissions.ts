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
}

/** Structured outcome of evaluating a call against a rule list. */
export type PermissionDecision = {
	kind: "allow" | "ask" | "deny";
	/** Human-readable explanation naming what matched (rule index plus fields). */
	reason: string;
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
		};
	}

	return {
		kind: winner.rule.effect,
		reason: `${winner.rule.effect} by ${describeRule(winner.rule, winner.index)}`,
	};
}
