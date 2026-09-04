/**
 * Permission Policies built-in extension
 *
 * The fork's permission engine as a hidden built-in extension: token-boundary
 * command matching, normalized path matching, deny > ask > allow precedence,
 * code/review/minimal profiles, and hide-from-the-model, with zero core
 * surface beyond the exported evaluator. It activates only when a policy file
 * exists — `~/.pi/agent/permissions.json` (global) or `.pi/permissions.json`
 * (project, trusted projects only) — and otherwise does nothing: no
 * visibility change, no call-time decisions. Core performs no permission
 * enforcement; this is still extension territory.
 *
 * Configuration lives in policy files instead of settings.json (extensions
 * cannot read pi settings). Precedence, exactly as the evaluator computes it:
 * a matching PROJECT rule decides outright; otherwise the GLOBAL rules and
 * the profile preset compose as one base layer under deny > ask > allow — a
 * global rule can strengthen a profile (deny over its ask/allow) but a global
 * allow cannot un-deny a profile preset, so put allow-overrides in the
 * project file. Shape (all fields optional):
 *
 * {
 *   "profile": "review",
 *   "rules": [
 *     { "tool": "bash", "command": "git push", "effect": "deny" },
 *     { "capability": "process.execute", "effect": "ask" },
 *     { "path": "~/notes", "effect": "deny", "hide": false }
 *   ]
 * }
 *
 * `ask` opens an interactive approval dialog when the run has UI (interactive
 * and RPC modes); in print / json modes it blocks with a reason the model can
 * relay (the dialog is the one thing this extension can do that a core policy
 * mode cannot).
 *
 * The project file counts only in a trusted project: a built-in loads in
 * every directory, so an untrusted checkout's `.pi/permissions.json` must
 * not steer enforcement (under the old copy-to-install model the user's
 * install was the opt-in). Trust granted mid-session starts call-time
 * enforcement at the next tool call (the lazy reload in the handler
 * re-checks) and visibility changes at the next session_start or /reload.
 *
 * Ordering: `tool_call` handlers run in extension load order, so rules judge
 * the call as this extension sees it — an earlier-loaded extension may have
 * mutated the arguments, and a later one can still rewrite an allowed call.
 * Deny/ask rules are the safe use; real isolation needs containerization.
 *
 * Interaction: each session_start re-applies visibility by subtracting hidden
 * tools from the active list — plus anything this extension hid before, so
 * removing a hide rule and running /reload restores the tool — which
 * preserves a narrower active-tool set another extension installed.
 * A tool registered mid-session stays visible until the next session_start
 * or /reload (there is no tool-registration event to hook), but call-time
 * deny/ask rules apply to it immediately. `/reload` re-reads the policy
 * files.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolInfo } from "../../core/extensions/types.ts";
import {
	evaluatePermissionLayered,
	type PermissionDecision,
	type PermissionRule,
	resolveProfileConfig,
	type ToolCapability,
	type ToolProfile,
} from "../../core/tools/permissions.ts";

interface PermissionFile {
	profile?: ToolProfile;
	rules?: PermissionRule[];
}

/** Layered configuration resolved from the global and project policy files. */
interface ResolvedPermissionConfig {
	profile: ToolProfile;
	/**
	 * Base layer: profile preset plus the global rules. They compose under
	 * deny > ask > allow (within one effect kind, the later rule wins), so a
	 * global rule can strengthen the profile but not un-deny it.
	 */
	baseRules: PermissionRule[];
	/** Override layer: project rules; any match beats the base layer. */
	rules: PermissionRule[];
	globalPath: string;
	projectPath: string;
}

function policyPaths(cwd: string): { globalPath: string; projectPath: string } {
	// Env override is a test seam (same pattern as PI_PACKAGE_DIR); unset in
	// production, where the global policy always lives in the home directory.
	const globalPath = process.env.PI_PERMISSION_POLICIES_GLOBAL ?? join(homedir(), ".pi", "agent", "permissions.json");
	return { globalPath, projectPath: join(cwd, ".pi", "permissions.json") };
}

/**
 * Whether any policy file exists that this extension may read: the global
 * file always, the project file only in a trusted project.
 */
export function policyFileExists(cwd: string, projectTrusted: boolean): boolean {
	const { globalPath, projectPath } = policyPaths(cwd);
	return existsSync(globalPath) || (projectTrusted && existsSync(projectPath));
}

function readPermissionFile(path: string, warn: (message: string) => void): PermissionFile {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PermissionFile;
	} catch (error) {
		// A present-but-unreadable policy file must not silently disable policy:
		// say so, then treat it as absent (fix the file, or remove it).
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return {};
		warn(`permission-policies: ignoring unreadable ${path}: ${String(error)}`);
		return {};
	}
}

export function resolvePermissionConfig(
	cwd: string,
	warn: (message: string) => void,
	projectTrusted = true,
): ResolvedPermissionConfig {
	const { globalPath, projectPath } = policyPaths(cwd);
	const globalFile = readPermissionFile(globalPath, warn);
	const projectFile = projectTrusted ? readPermissionFile(projectPath, warn) : {};

	const profile = projectFile.profile ?? globalFile.profile ?? "code";
	const baseRules = [...resolveProfileConfig(profile), ...(globalFile.rules ?? [])];
	return { profile, baseRules, rules: projectFile.rules ?? [], globalPath, projectPath };
}

function capabilityOf(tools: ToolInfo[], toolName: string): ToolCapability | undefined {
	return tools.find((tool) => tool.name === toolName)?.capability;
}

function describeDecision(decision: PermissionDecision, config: ResolvedPermissionConfig, howToAllow: string): string {
	const source = decision.matched ? "" : ` (profile "${config.profile}", default)`;
	return `permission-policies: ${decision.kind}${source} — ${decision.reason}. ${howToAllow}`;
}

export default function permissionPolicies(pi: ExtensionAPI) {
	let config: ResolvedPermissionConfig | undefined;
	// Tools hidden at the last applyVisibility call; they left the active
	// list, so only this memory can bring them back when a hide rule goes.
	let hiddenByUs: string[] = [];

	const reload = (ctx: ExtensionContext) => {
		const warn = (message: string) => ctx.ui.notify(message, "warning");
		config = policyFileExists(ctx.cwd, ctx.isProjectTrusted())
			? resolvePermissionConfig(ctx.cwd, warn, ctx.isProjectTrusted())
			: undefined;
	};

	const applyVisibility = () => {
		const resolved = config;
		if (!resolved) return;
		const tools = pi.getAllTools();
		// Subtract, never broaden: candidates are the current active list plus
		// what we hid before. Another extension's narrower active set survives,
		// and a removed hide rule restores its tool on the next session_start.
		const candidates = [...new Set([...pi.getActiveTools(), ...hiddenByUs])];
		const visible: string[] = [];
		const hidden: string[] = [];
		for (const name of candidates) {
			const decision = evaluatePermissionLayered({
				toolName: name,
				capability: capabilityOf(tools, name),
				args: {},
				baseRules: resolved.baseRules,
				rules: resolved.rules,
				defaultEffect: "allow",
			});
			(decision.hidden ? hidden : visible).push(name);
		}
		hiddenByUs = hidden;
		pi.setActiveTools(visible);
	};

	// session_start fires for every reason (startup, new, resume, fork, reload),
	// so config edits apply after /reload and hiding survives session switches.
	pi.on("session_start", (_event, ctx) => {
		reload(ctx);
		applyVisibility();
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		// Lazy fallback for sessions whose session_start has not run yet; with
		// no policy file anywhere this stays undefined and the call proceeds.
		if (!config) reload(ctx);
		if (!config) return;
		const tools = pi.getAllTools();
		const decision = evaluatePermissionLayered({
			toolName: event.toolName,
			capability: capabilityOf(tools, event.toolName),
			args: event.input as Record<string, unknown>,
			baseRules: config.baseRules,
			rules: config.rules,
			defaultEffect: "allow",
			// Relative path rules resolve against the session cwd, not the
			// process working directory.
			cwd: ctx.cwd,
		});
		if (decision.kind === "allow") return;

		const howToAllow = `Adjust rules in ${config.projectPath} (project) or ${config.globalPath} (global), then /reload.`;
		if (decision.kind === "deny") {
			return { block: true, reason: describeDecision(decision, config, howToAllow) };
		}

		// ask: interactive approval when a dialog is available; otherwise the
		// call blocks with the reason so the model relays it to the user.
		if (ctx.hasUI) {
			const approved = await ctx.ui.confirm(
				`Allow ${event.toolName}?`,
				describeDecision(decision, config, "Approving runs this call once; add an allow rule to stop being asked."),
			);
			if (approved) return;
		}
		return { block: true, reason: describeDecision(decision, config, howToAllow) };
	});
}
