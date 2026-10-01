import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import modelHandoffExtension from "./model-handoff/index.ts";
import permissionPoliciesExtension from "./permission-policies/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	// No-ops unless a policy file exists (see the module doc); hidden so an
	// inert entry never shows in the startup Extensions list.
	{ name: "permission-policies", factory: permissionPoliciesExtension, hidden: true },
	// No-ops unless a handoff config file exists (see the module doc).
	{ name: "model-handoff", factory: modelHandoffExtension, hidden: true },
];
