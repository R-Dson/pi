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
 * "..." } } }`, machine config dir by default. Inert without a file; fewer than
 * two registry-resolvable tiers is also inert, with a warning. Guards and
 * returnAfterRun land with #108/#109.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";

interface TierConfig {
	provider: string;
	modelId: string;
	description?: string;
}

interface HandoffConfig {
	tiers?: Record<string, TierConfig>;
}

interface Tier {
	name: string;
	provider: string;
	modelId: string;
	description?: string;
}

function readTiers(ctx: ExtensionContext): { tiers: Tier[]; configured: boolean } {
	// The env override is a test seam (same pattern as PI_PERMISSION_POLICIES_GLOBAL).
	const path = process.env.PI_HANDOFF_GLOBAL ?? join(homedir(), ".pi", "agent", "handoff.json");
	if (!existsSync(path)) return { tiers: [], configured: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		// A present-but-unreadable file warns once and counts as not configured,
		// so it never also triggers the fewer-than-two-tiers warning.
		ctx.ui.notify(`model-handoff: ignoring unreadable ${path}: ${String(error)}`, "warning");
		return { tiers: [], configured: false };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		ctx.ui.notify(`model-handoff: ignoring unreadable ${path}: expected a JSON object`, "warning");
		return { tiers: [], configured: false };
	}
	const tiers: Tier[] = [];
	for (const [name, config] of Object.entries((parsed as HandoffConfig).tiers ?? {})) {
		if (!config) {
			ctx.ui.notify(
				`model-handoff: skipping tier "${name}": entry must be {provider, modelId, description?}`,
				"warning",
			);
			continue;
		}
		if (!ctx.modelRegistry.find(config.provider, config.modelId)) {
			ctx.ui.notify(
				`model-handoff: skipping tier "${name}": ${config.provider ?? "?"}/${config.modelId ?? "?"} is not in the model registry`,
				"warning",
			);
			continue;
		}
		tiers.push({ name, provider: config.provider, modelId: config.modelId, description: config.description });
	}
	return { tiers, configured: true };
}

function textResult(text: string) {
	return { details: undefined, content: [{ type: "text" as const, text }] };
}

export default function modelHandoff(pi: ExtensionAPI): void {
	// session_start fires for every reason (startup, new, resume, fork, reload);
	// registerTool overwrites by name, so re-registering is the refresh path.
	pi.on("session_start", (_event, ctx) => {
		const { tiers, configured } = readTiers(ctx);
		if (tiers.length < 2) {
			if (configured) {
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
				"Hand the whole conversation to another configured model tier. The incoming model " +
				"receives the full history plus your reason and brief, and continues this task from the next turn.\n" +
				`Tiers:\n${tierList}`,
			promptSnippet: "switch_model: hand the whole conversation to another configured model tier.",
			promptGuidelines: [
				"switch_model transfers the conversation to another tier; it does not spawn a helper. The incoming model sees everything and continues the task.",
				"Escalate when the work needs planning, architecture decisions, or stubborn debugging. Hand down when a written plan makes the remaining work mechanical, and carry the plan as the brief.",
				"Hand off at task boundaries, not per message: every switch re-reads the target tier's cached prefix.",
			],
			parameters: Type.Object({
				target: Type.Union(
					tiers.map((tier) => Type.Literal(tier.name)),
					{
						description: "Tier to hand off to",
					},
				),
				reason: Type.String({ description: "Short justification, shown to the user and the incoming model" }),
				brief: Type.Optional(
					Type.String({ description: "Instructions for the incoming model; carry the plan when handing down" }),
				),
			}),
			// Sequential: two switch_model calls in one assistant message would
			// otherwise race in execute() and both claim the baton.
			executionMode: "sequential",
			// Re-resolve through the context on every call: a Model cached at
			// activation would go stale against the live registry (#108 relies on this).
			async execute(_toolCallId, params, _signal, _onUpdate, execCtx) {
				const tier = tiers.find((candidate) => candidate.name === params.target);
				const target = tier ? execCtx.modelRegistry.find(tier.provider, tier.modelId) : undefined;
				if (!tier || !target) {
					return textResult(
						`switch_model: tier "${params.target}" is not available; staying on the current model.`,
					);
				}
				const from = execCtx.model;
				try {
					if (!(await pi.setModel(target))) {
						return textResult(
							`switch_model: no credentials for ${target.provider}/${target.id}; staying on the current model. Ask the user to log in.`,
						);
					}
				} catch (error) {
					return textResult(
						`switch_model: switching to ${target.provider}/${target.id} failed (${String(error)}); staying on the current model.`,
					);
				}
				const lines = [
					`Handed off from ${from ? `${from.provider}/${from.id}` : "unknown"} to ${tier.name} (${target.provider}/${target.id}).`,
					`Reason: ${params.reason}`,
					...(params.brief ? [`Brief: ${params.brief}`] : []),
					"You hold the baton now: continue the task from here with the conversation above.",
				];
				return textResult(lines.join("\n"));
			},
		});
	});
}
