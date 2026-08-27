/**
 * Read-Only Mode Extension
 *
 * Turns the session into a review pass: write and process tools are hidden
 * from the model's tool list, and a tool that regresses later (registered
 * after the filter ran) is blocked at call time with a reason the model can
 * relay to the user.
 *
 * Built on pi's public extension API — the same `setActiveTools`,
 * `getAllTools`, and `tool_call` seams the fork's opt-in permission policies
 * use in core. Capability matching needs the fork's `ToolInfo.capability`;
 * on upstream pi the same file runs with the builtin-name fallback. Copy it
 * into ~/.pi/agent/extensions/ (global) or a project's .pi/extensions/
 * (trusted projects only) to use it; no settings are involved.
 *
 * Limitations that come with staying on the public API: tools without
 * capability metadata and without a known name (some MCP or custom tools) are
 * neither hidden nor blocked, and the filter re-applies on session_start
 * (every reason: startup, new, resume, fork, reload) rather than on every
 * registry change.
 */

import type { ExtensionAPI, ToolCallEvent, ToolInfo } from "@earendil-works/pi-coding-agent";

/** Capabilities a review pass must not exercise. */
const BLOCKED_CAPABILITIES = new Set(["filesystem.write", "process.execute"]);

/** Builtin names for the same tools, as the fallback when capability is absent. */
const BLOCKED_NAMES = new Set(["edit", "write", "bash", "powershell"]);

function isBlockedTool(tool: Pick<ToolInfo, "name" | "capability">): boolean {
	return (tool.capability !== undefined && BLOCKED_CAPABILITIES.has(tool.capability)) || BLOCKED_NAMES.has(tool.name);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		const visible = pi
			.getAllTools()
			.filter((tool) => !isBlockedTool(tool))
			.map((tool) => tool.name);
		pi.setActiveTools(visible);
	});

	pi.on("tool_call", async (event: ToolCallEvent) => {
		const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
		if (tool && isBlockedTool(tool)) {
			return {
				block: true,
				reason: `read-only mode: the ${event.toolName} tool is disabled for this review pass. Tell the user to remove read-only-mode.ts from their extensions directory to allow changes.`,
			};
		}
	});
}
