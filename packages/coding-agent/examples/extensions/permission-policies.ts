/**
 * Permission Policies Extension
 *
 * The fork's permission engine as a plain extension: token-boundary command
 * matching, normalized path matching, deny > ask > allow precedence,
 * code/review/minimal profiles, and hide-from-the-model, with zero core
 * surface beyond the exported evaluator. Install by copying this file into
 * ~/.pi/agent/extensions/ (global) or a project's .pi/extensions/ (trusted
 * projects only).
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
 * relay (the dialog is the one thing this extension can do that core policy
 * mode cannot).
 *
 * Ordering: `tool_call` handlers run in extension load order, so rules judge
 * the call as this extension sees it — an earlier-loaded extension may have
 * mutated the arguments, and a later one can still rewrite an allowed call.
 * Deny/ask rules are the safe use; real isolation needs containerization.
 *
 * Interaction: each session_start re-applies visibility by re-activating
 * every non-hidden tool, which overrides a narrower active-tool set another
 * extension installed (read-only-mode and this extension both reshape the
 * list; last session_start wins). `/reload` re-reads the policy files.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	evaluatePermissionLayered,
	type PermissionDecision,
	type PermissionRule,
	resolveProfileConfig,
	type ToolCapability,
	type ToolProfile,
} from "@earendil-works/pi-coding-agent";

interface PermissionFile {
	profile?: ToolProfile;
	rules?: PermissionRule[];
}

/** Layered configuration resolved from the global and project policy files. */
export interface ResolvedPermissionConfig {
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

export function resolvePermissionConfig(cwd: string, warn: (message: string) => void): ResolvedPermissionConfig {
	// Env override is a test seam (same pattern as PI_PACKAGE_DIR); unset in
	// production, where the global policy always lives in the home directory.
	const globalPath = process.env.PI_PERMISSION_POLICIES_GLOBAL ?? join(homedir(), ".pi", "agent", "permissions.json");
	const projectPath = join(cwd, ".pi", "permissions.json");
	const globalFile = readPermissionFile(globalPath, warn);
	const projectFile = readPermissionFile(projectPath, warn);

	const profile = projectFile.profile ?? globalFile.profile ?? "code";
	const baseRules = [...resolveProfileConfig(profile).permissionRules, ...(globalFile.rules ?? [])];
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

	const reload = (cwd: string, warn: (message: string) => void) => {
		config = resolvePermissionConfig(cwd, warn);
	};

	const applyVisibility = () => {
		const resolved = config;
		if (!resolved) return;
		const tools = pi.getAllTools();
		const visible = tools
			.filter((tool) => {
				const decision = evaluatePermissionLayered({
					toolName: tool.name,
					capability: tool.capability,
					args: {},
					baseRules: resolved.baseRules,
					rules: resolved.rules,
					defaultEffect: "allow",
				});
				return !decision.hidden;
			})
			.map((tool) => tool.name);
		pi.setActiveTools(visible);
	};

	// session_start fires for every reason (startup, new, resume, fork, reload),
	// so config edits apply after /reload and hiding survives session switches.
	pi.on("session_start", (_event, ctx) => {
		const warn = (message: string) => ctx.ui.notify(message, "warning");
		reload(ctx.cwd, warn);
		applyVisibility();
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!config) reload(ctx.cwd, () => {});
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
