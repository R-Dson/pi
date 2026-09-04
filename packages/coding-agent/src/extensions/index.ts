import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import modelHandoffExtension from "./model-handoff/index.ts";
import permissionPoliciesExtension from "./permission-policies/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	// No-ops unless a policy file exists (see the module doc); hidden so an
	// inert entry never shows in the startup Extensions list.
	{ name: "permission-policies", factory: permissionPoliciesExtension, hidden: true },
	// No-ops unless a handoff config file exists (see the module doc).
	{ name: "model-handoff", factory: modelHandoffExtension, hidden: true },
];
