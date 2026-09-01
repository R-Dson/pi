/**
 * Model handoff built-in extension (#106, ticket #107).
 *
 * The active model hands the whole conversation to another configured tier
 * (e.g. fast/smart) by calling switch_model. The agent loop re-reads the
 * session model before every provider request, so the next assistant turn of
 * the same run comes from the target tier. The tool result is the baton: it
 * tells the incoming model who handed off, why, and with what brief. Same
 * transcript, no subagent, no context copy.
 *
 * Configuration lives in handoff.json (extensions cannot read pi settings):
 * `{ "tiers": { "fast": { "provider": "...", "modelId": "...", "description":
 * "..." } } }`, machine config dir by default, plus a project file under .pi
 * in trusted projects; tiers merge and the project file wins on a name
 * collision. Inert without any file; fewer than two registry-resolvable tiers
 * in the merged set is also inert (deactivated by subtraction from the active
 * tool list), with a warning. The refusal guards landed with #108,
 * returnAfterRun with #109, project config with #110.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";

/** Raw tier entry from handoff.json. */
interface TierConfig {
	provider: string;
	modelId: string;
	description?: string;
}

/** A TierConfig that resolved in the model registry, bound to its tier name. */
type Tier = TierConfig & { name: string };

/** Tiers from one config file, undefined when the file is absent or unreadable. */
function readTierFile(path: string, ctx: ExtensionContext): Record<string, TierConfig> | undefined {
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		ctx.ui.notify(`model-handoff: ignoring unreadable ${path}: ${String(error)}`, "warning");
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		ctx.ui.notify(`model-handoff: ignoring unreadable ${path}: expected a JSON object`, "warning");
		return undefined;
	}
	return (parsed as { tiers?: Record<string, TierConfig> }).tiers ?? {};
}

function readTiers(ctx: ExtensionContext): { tiers: Tier[]; configFilePresent: boolean } {
	// The env override is a test seam (same pattern as PI_PERMISSION_POLICIES_GLOBAL).
	const machinePath = process.env.PI_HANDOFF_GLOBAL ?? join(homedir(), ".pi", "agent", "handoff.json");
	const machine = readTierFile(machinePath, ctx);
	// The project file counts only in a trusted project: an untrusted
	// checkout's .pi directory must not steer handoffs.
	const project = ctx.isProjectTrusted() ? readTierFile(join(ctx.cwd, ".pi", "handoff.json"), ctx) : undefined;
	const merged = new Map<string, TierConfig>();
	for (const [name, config] of Object.entries(machine ?? {})) merged.set(name, config);
	for (const [name, config] of Object.entries(project ?? {})) merged.set(name, config);
	const tiers: Tier[] = [];
	for (const [name, config] of merged) {
		if (!config) {
			ctx.ui.notify(
				`model-handoff: skipping tier "${name}": entry must be {provider, modelId, description?}`,
				"warning",
			);
			continue;
		}
		if (!ctx.modelRegistry.find(config.provider, config.modelId)) {
			ctx.ui.notify(
				`model-handoff: skipping tier "${name}": ${config.provider}/${config.modelId} is not in the model registry`,
				"warning",
			);
			continue;
		}
		tiers.push({ name, ...config });
	}
	return { tiers, configFilePresent: machine !== undefined || project !== undefined };
}

function textResult(text: string) {
	return { details: undefined, content: [{ type: "text" as const, text }] };
}

/** The switch_model call row: tier and reason on one line, the brief only when expanded. */
export function handoffCallSummary(
	args: { target?: string; reason?: string; brief?: string },
	expanded: boolean,
): string {
	const reason = args.reason ? `: ${args.reason}` : "";
	const brief = expanded && args.brief ? `\nBrief: ${args.brief}` : "";
	return `Handoff -> ${args.target ?? "?"}${reason}${brief}`;
}

export default function modelHandoff(pi: ExtensionAPI): void {
	// Guard state lives at factory scope: never module scope (built-ins stay
	// imported across session switches, so module state would leak between
	// sessions) and never inside session_start (the test harness re-fires it
	// on one runner, which would pile up duplicate subscriptions).
	const batonHolders = new Set<string>();
	let awaitingNewRun = true;
	// #109: one pending-return slot; a handoff with returnAfterRun records its
	// caller, the next handoff replaces or cancels it, and the settle-time
	// return consumes it. Memory only: a crash drops it and resume restores
	// the delegatee through the recorded model change.
	let pendingReturn: { provider: string; modelId: string } | undefined;
	// model_select fires inside pi.setModel's await; the model this extension is
	// currently switching to distinguishes its switches from the user's manual
	// ones (keybindings, /model). A user switch to that same model is
	// indistinguishable, but also inconsequential.
	let inFlightTargetKey: string | undefined;

	// The bounce guard covers one settled run: agent_start also fires for
	// retry, compaction, and queued-message continuations inside a run, so the
	// reset happens only at the first agent_start after an agent_settled.
	pi.on("agent_settled", async (_event, ctx) => {
		awaitingNewRun = true;
		const pending = pendingReturn;
		pendingReturn = undefined;
		if (!pending) return;
		const current = ctx.model;
		if (current && current.provider === pending.provider && current.id === pending.modelId) return;
		const requester = ctx.modelRegistry.find(pending.provider, pending.modelId);
		if (!requester) {
			ctx.ui.notify(
				`model-handoff: cannot return to ${pending.provider}/${pending.modelId}: not in the model registry`,
				"warning",
			);
			return;
		}
		// The return is extension-initiated, not a tool call, so it bypasses the
		// bounce guard: the requester held the baton earlier in the finished run.
		inFlightTargetKey = `${pending.provider}/${pending.modelId}`;
		try {
			if (!(await pi.setModel(requester))) {
				ctx.ui.notify(
					`model-handoff: cannot return to ${pending.provider}/${pending.modelId}: no credentials`,
					"warning",
				);
			}
		} catch (error) {
			ctx.ui.notify(
				`model-handoff: return to ${pending.provider}/${pending.modelId} failed: ${String(error)}`,
				"warning",
			);
		} finally {
			inFlightTargetKey = undefined;
		}
	});
	pi.on("agent_start", () => {
		if (awaitingNewRun) {
			batonHolders.clear();
			awaitingNewRun = false;
		}
	});
	// A manual switch by the user wins over the delegation promise.
	pi.on("model_select", (event) => {
		if (`${event.model.provider}/${event.model.id}` !== inFlightTargetKey) pendingReturn = undefined;
	});
	// The extension API has no unregister, so deactivation subtracts the tool
	// from the active list (permission-policies' pattern). toolActive tracks
	// whether the active list currently contains it by our doing.
	let toolActive = false;

	// session_start is the only handler with the context (cwd, trust, registry)
	// config reading needs, and it fires for every reason (startup, new, resume,
	// fork, reload). Production reload re-runs factories, so registerTool's
	// overwrite-by-name only matters in the test harness; either way the
	// serialized tool bytes must not change within a session or the provider
	// prefix cache busts as an unexpected tools-change.
	pi.on("session_start", (_event, ctx) => {
		const { tiers, configFilePresent } = readTiers(ctx);
		if (tiers.length < 2) {
			if (toolActive) {
				pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "switch_model"));
				toolActive = false;
			}
			if (configFilePresent) {
				ctx.ui.notify(
					`model-handoff: needs at least two resolvable tiers, found ${tiers.length}; staying inactive`,
					"warning",
				);
			}
			return;
		}

		const tierList = tiers
			.map(
				(tier) =>
					`- ${tier.name}: ${tier.provider}/${tier.modelId}${tier.description ? ` — ${tier.description}` : ""}`,
			)
			.join("\n");

		pi.registerTool({
			name: "switch_model",
			label: "Switch model",
			description:
				"Hand the whole conversation to another configured model tier. The incoming model sees the full history, your reason, and your brief, and continues the task from the next turn. Set returnAfterRun to take control back when the run finishes (plan, delegate, review).\n" +
				`Tiers:\n${tierList}`,
			promptSnippet: "Hand the whole conversation to another configured model tier.",
			promptGuidelines: [
				"switch_model is a handoff, not a helper: the incoming model takes over the same conversation.",
				"Escalate for planning, architecture decisions, or stubborn debugging; hand down when a written plan makes the remaining work mechanical, carrying the plan as the brief.",
				"Hand off at task boundaries, not per message.",
			],
			parameters: Type.Object({
				target: Type.Union(
					tiers.map((tier) => Type.Literal(tier.name)),
					{ description: "Tier to hand off to" },
				),
				reason: Type.String({ description: "Short justification, shown to the user and the incoming model" }),
				brief: Type.Optional(
					Type.String({ description: "Instructions for the incoming model; carry the plan when handing down" }),
				),
				returnAfterRun: Type.Optional(
					Type.Boolean({
						description: "Hand control back to this model when the current run finishes (plan, delegate, review)",
					}),
				),
			}),
			// Sequential: two switch_model calls in one assistant message would
			// otherwise race in execute() and both claim the baton.
			executionMode: "sequential",
			// The brief stays out of the collapsed row (HTML export renders calls
			// collapsed, so the brief reaches export through the result text).
			renderCall: (args, renderTheme, context) =>
				new Text(renderTheme.fg("toolTitle", handoffCallSummary(args, context.expanded)), 0, 0),
			// Re-resolve through the context on every call: a Model cached at
			// activation would go stale against the live registry (#108 relies on this).
			async execute(_toolCallId, params, _signal, _onUpdate, execCtx) {
				const tier = tiers.find((candidate) => candidate.name === params.target);
				const target = tier ? execCtx.modelRegistry.find(tier.provider, tier.modelId) : undefined;
				if (!tier || !target) {
					return textResult(
						`switch_model: tier "${params.target}" is not available. Continue on the current model.`,
					);
				}
				const from = execCtx.model;
				const fromKey = from ? `${from.provider}/${from.id}` : undefined;
				const targetKey = `${target.provider}/${target.id}`;
				if (fromKey === targetKey) {
					return textResult(`switch_model: tier "${params.target}" (${targetKey}) is already the active model.`);
				}
				if (fromKey && batonHolders.has(targetKey)) {
					return textResult(
						`switch_model: ${targetKey} held the baton earlier in this run; do the work or surface the problem to the user instead of bouncing back.`,
					);
				}
				inFlightTargetKey = targetKey;
				try {
					if (!(await pi.setModel(target))) {
						return textResult(
							`switch_model: no credentials for ${targetKey}; staying on the current model. Ask the user to log in.`,
						);
					}
				} catch (error) {
					return textResult(
						`switch_model: switching to ${targetKey} failed (${String(error)}). Continue on the current model.`,
					);
				} finally {
					inFlightTargetKey = undefined;
				}
				if (fromKey) batonHolders.add(fromKey);
				pendingReturn = params.returnAfterRun && from ? { provider: from.provider, modelId: from.id } : undefined;
				const lines = [
					`Handed off from ${fromKey ?? "unknown"} to ${tier.name} (${targetKey}).`,
					`Reason: ${params.reason}`,
					...(params.brief ? [`Brief: ${params.brief}`] : []),
					"You hold the baton now: continue the task from here with the conversation above.",
				];
				return textResult(lines.join("\n"));
			},
		});
		if (!toolActive) {
			// Reactivate explicitly, but only from OUR deactivation: a
			// re-registered name is not new to the registry, so the refresh does
			// not reactivate a subtracted tool on its own, while re-adding
			// unconditionally would defeat an earlier-loaded extension's removal
			// (e.g. a permission-policies hide rule on switch_model).
			pi.setActiveTools([...new Set([...pi.getActiveTools(), "switch_model"])]);
		}
		toolActive = true;
	});
}
