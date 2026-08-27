import { describe, expect, it } from "vitest";
import {
	evaluatePermission,
	type PermissionDecision,
	type PermissionRule,
	TOOL_CAPABILITIES,
	type ToolCapability,
} from "../src/core/tools/permissions.ts";

function evaluate(
	rules: PermissionRule[],
	args: {
		toolName?: string;
		capability?: ToolCapability;
		args?: Record<string, unknown>;
		defaultEffect?: "allow" | "deny";
	},
): PermissionDecision {
	return evaluatePermission({
		toolName: args.toolName ?? "bash",
		capability: args.capability,
		args: args.args ?? { command: "git status" },
		rules,
		defaultEffect: args.defaultEffect ?? "allow",
	});
}

describe("evaluatePermission matching", () => {
	it("returns the default when no rules match", () => {
		const decision = evaluate([{ tool: "read", effect: "deny" }], {
			toolName: "bash",
			capability: "process.execute",
			defaultEffect: "allow",
		});
		expect(decision.kind).toBe("allow");
		expect(decision.reason).toContain("bash");
		expect(decision.reason).toContain("default");
	});

	it("matches rules on exact tool name", () => {
		const decision = evaluate([{ tool: "bash", effect: "deny" }], { toolName: "bash" });
		expect(decision.kind).toBe("deny");
		expect(decision.reason).toContain("bash");
		expect(decision.reason).toContain("rule #0");
	});

	it("does not match a rule for a different tool name", () => {
		const decision = evaluate([{ tool: "read", effect: "deny" }], { toolName: "bash" });
		expect(decision.kind).toBe("allow");
	});

	it("matches rules on equal capability", () => {
		const decision = evaluate([{ capability: "process.execute", effect: "deny" }], {
			toolName: "bash",
			capability: "process.execute",
		});
		expect(decision.kind).toBe("deny");
	});

	it("does not match a capability rule when the tool has a different capability", () => {
		const decision = evaluate([{ capability: "filesystem.write", effect: "deny" }], {
			toolName: "read",
			capability: "filesystem.read",
			args: { path: "/tmp/a.txt" },
		});
		expect(decision.kind).toBe("allow");
	});

	it("does not match a capability rule when the tool has no capability", () => {
		const decision = evaluate([{ capability: "process.execute", effect: "deny" }], {
			toolName: "custom_tool",
			capability: undefined,
		});
		expect(decision.kind).toBe("allow");
	});

	it("matches a rule without capability against a tool with a capability", () => {
		const decision = evaluate([{ tool: "bash", effect: "ask" }], {
			toolName: "bash",
			capability: "process.execute",
		});
		expect(decision.kind).toBe("ask");
	});
});

describe("evaluatePermission path matching", () => {
	it("matches on path-segment prefix of the args path field", () => {
		const decision = evaluate([{ path: "/repo/src", effect: "deny" }], {
			toolName: "read",
			capability: "filesystem.read",
			args: { path: "/repo/src/main.ts" },
		});
		expect(decision.kind).toBe("deny");
	});

	it("matches an exact path", () => {
		const decision = evaluate([{ path: "/repo/src/main.ts", effect: "deny" }], {
			toolName: "read",
			args: { path: "/repo/src/main.ts" },
		});
		expect(decision.kind).toBe("deny");
	});

	it("does not match when the rule path is a string prefix but not a path-segment prefix", () => {
		const decision = evaluate([{ path: "/repo/src", effect: "deny" }], {
			toolName: "read",
			args: { path: "/repo/src-other/main.ts" },
		});
		expect(decision.kind).toBe("allow");
	});

	it("does not match when the args have no path field", () => {
		const decision = evaluate([{ path: "/repo", effect: "deny" }], {
			toolName: "bash",
			args: { command: "ls" },
		});
		expect(decision.kind).toBe("allow");
	});

	it("does not match when the path arg is not a string", () => {
		const decision = evaluate([{ path: "/repo", effect: "deny" }], {
			toolName: "read",
			args: { path: 42 },
		});
		expect(decision.kind).toBe("allow");
	});

	it("matches relative path prefixes segment-wise", () => {
		const decision = evaluate([{ path: "src", effect: "ask" }], {
			toolName: "grep",
			args: { path: "src/lib/util.ts" },
		});
		expect(decision.kind).toBe("ask");
	});
});

describe("evaluatePermission command matching", () => {
	it("matches on string prefix of the args command field", () => {
		const decision = evaluate([{ command: "git", effect: "ask" }], {
			toolName: "bash",
			capability: "process.execute",
			args: { command: "git status --short" },
		});
		expect(decision.kind).toBe("ask");
	});

	it("does not match a non-prefix command", () => {
		const decision = evaluate([{ command: "rm", effect: "deny" }], {
			toolName: "bash",
			args: { command: "git rm file.txt" },
		});
		expect(decision.kind).toBe("allow");
	});

	it("does not match when the args have no command field", () => {
		const decision = evaluate([{ command: "git", effect: "deny" }], {
			toolName: "read",
			args: { path: "/tmp/a" },
		});
		expect(decision.kind).toBe("allow");
	});
});

describe("evaluatePermission combined-field matching", () => {
	it("requires every specified field to match", () => {
		const rules: PermissionRule[] = [{ tool: "bash", capability: "process.execute", command: "git", effect: "deny" }];
		expect(
			evaluate(rules, {
				toolName: "bash",
				capability: "process.execute",
				args: { command: "git status" },
			}).kind,
		).toBe("deny");
		expect(evaluate(rules, { args: { command: "ls" } }).kind).toBe("allow");
		expect(
			evaluate(rules, {
				toolName: "read",
				capability: "filesystem.read",
				args: { path: "/tmp/a", command: "git" },
			}).kind,
		).toBe("allow");
	});

	it("ignores unrecognized args fields", () => {
		const decision = evaluate([{ tool: "read", effect: "deny" }], {
			toolName: "read",
			args: { path: "/tmp/a", mystery: { nested: true } },
		});
		expect(decision.kind).toBe("deny");
	});

	it("matches an empty rule (effect only) against everything", () => {
		const decision = evaluate([{ effect: "deny" }], {
			toolName: "anything",
			args: { whatever: 1 },
			defaultEffect: "allow",
		});
		expect(decision.kind).toBe("deny");
	});
});

describe("evaluatePermission precedence", () => {
	it("deny beats ask and allow regardless of order", () => {
		const rules: PermissionRule[] = [
			{ tool: "bash", effect: "allow" },
			{ tool: "bash", effect: "ask" },
			{ tool: "bash", effect: "deny" },
		];
		expect(evaluate(rules, { args: { command: "ls" } }).kind).toBe("deny");

		const reordered: PermissionRule[] = [
			{ tool: "bash", effect: "deny" },
			{ tool: "bash", effect: "ask" },
			{ tool: "bash", effect: "allow" },
		];
		expect(evaluate(reordered, { args: { command: "ls" } }).kind).toBe("deny");
	});

	it("ask beats allow regardless of order", () => {
		const rules: PermissionRule[] = [
			{ tool: "bash", effect: "allow" },
			{ tool: "bash", effect: "ask" },
		];
		expect(evaluate(rules, { args: { command: "ls" } }).kind).toBe("ask");

		const reordered: PermissionRule[] = [
			{ tool: "bash", effect: "ask" },
			{ tool: "bash", effect: "allow" },
		];
		expect(evaluate(reordered, { args: { command: "ls" } }).kind).toBe("ask");
	});

	it("matched rules beat the default, including deny default", () => {
		const decision = evaluate([{ tool: "bash", effect: "allow" }], {
			args: { command: "ls" },
			defaultEffect: "deny",
		});
		expect(decision.kind).toBe("allow");
	});

	it("the last matching rule of the strongest kind wins", () => {
		const rules: PermissionRule[] = [
			{ command: "git", effect: "deny" },
			{ capability: "process.execute", effect: "deny" },
		];
		const decision = evaluate(rules, {
			toolName: "bash",
			capability: "process.execute",
			args: { command: "git status" },
		});
		expect(decision.kind).toBe("deny");
		expect(decision.reason).toContain("rule #1");
	});

	// Table-driven sweep: for combinations of matching allow/ask/deny rules in
	// every order, a deny match always wins, then ask, then allow, then default.
	const KINDS: Array<"allow" | "ask" | "deny"> = ["allow", "ask", "deny"];
	const COMBOS: Array<Array<"allow" | "ask" | "deny" | undefined>> = (() => {
		const result: Array<Array<"allow" | "ask" | "deny" | undefined>> = [];
		for (const first of [undefined, ...KINDS]) {
			for (const second of [undefined, ...KINDS]) {
				for (const third of [undefined, ...KINDS]) {
					result.push([first, second, third]);
				}
			}
		}
		return result;
	})();

	it("sweeps rule combinations: deny > ask > allow > default", () => {
		for (const combo of COMBOS) {
			const kinds = combo.filter((kind): kind is "allow" | "ask" | "deny" => kind !== undefined);
			const expected = kinds.includes("deny")
				? "deny"
				: kinds.includes("ask")
					? "ask"
					: kinds.includes("allow")
						? "allow"
						: "deny";
			const rules = combo.map((kind) =>
				kind === undefined ? undefined : ({ tool: "bash", effect: kind, command: "cmd" } as PermissionRule),
			);
			const present = rules.filter((rule): rule is PermissionRule => rule !== undefined);
			// Every present rule matches the call, so the strongest kind present wins.
			const decision = evaluate(present, {
				toolName: "bash",
				capability: "process.execute",
				args: { command: "cmd args" },
				defaultEffect: "deny",
			});
			expect(decision.kind, `combo ${combo.join(",")}`).toBe(expected);
		}
	});
});

describe("evaluatePermission reasons", () => {
	it("names the matched fields and rule index", () => {
		const decision = evaluate([{ tool: "bash", capability: "process.execute", effect: "deny" }], {
			toolName: "bash",
			capability: "process.execute",
			args: { command: "ls" },
		});
		expect(decision.reason).toContain("tool=bash");
		expect(decision.reason).toContain("capability=process.execute");
		expect(decision.reason).toContain("rule #0");
		expect(decision.reason).toContain("deny");
	});

	it("names a matched path and command", () => {
		const decision = evaluate([{ path: "/repo", command: "git", effect: "ask" }], {
			toolName: "bash",
			args: { command: "git status", path: "/repo/x" },
		});
		expect(decision.reason).toContain("path=/repo");
		expect(decision.reason).toContain("command=git");
	});

	it("names the tool and default effect when nothing matches", () => {
		const decision = evaluate([], {
			toolName: "grep",
			capability: "filesystem.read",
			args: { path: "/tmp" },
			defaultEffect: "deny",
		});
		expect(decision.reason).toContain("grep");
		expect(decision.reason).toContain("filesystem.read");
		expect(decision.reason).toContain("deny");
	});
});

describe("evaluatePermission hide flag and match reporting", () => {
	it("marks the decision hidden when the winning deny rule has hide", () => {
		const decision = evaluate([{ tool: "edit", effect: "deny", hide: true }], {
			toolName: "edit",
			capability: "filesystem.write",
			args: {},
		});
		expect(decision.kind).toBe("deny");
		expect(decision.matched).toBe(true);
		expect(decision.hidden).toBe(true);
	});

	it("does not mark hidden when the winning deny rule lacks hide", () => {
		const decision = evaluate([{ tool: "edit", effect: "deny" }], {
			toolName: "edit",
			capability: "filesystem.write",
			args: {},
		});
		expect(decision.kind).toBe("deny");
		expect(decision.hidden).toBe(false);
	});

	it("reports matched false and hidden false when no rule matched", () => {
		const decision = evaluate([{ tool: "read", effect: "deny" }], {
			toolName: "edit",
			args: {},
			defaultEffect: "allow",
		});
		expect(decision.kind).toBe("allow");
		expect(decision.matched).toBe(false);
		expect(decision.hidden).toBe(false);
	});

	it("the last matching deny rule decides hiding: a later deny without hide un-hides", () => {
		const decision = evaluate(
			[
				{ tool: "edit", effect: "deny", hide: true },
				{ tool: "edit", effect: "deny" },
			],
			{ toolName: "edit", args: {} },
		);
		expect(decision.kind).toBe("deny");
		expect(decision.hidden).toBe(false);
	});

	it("ignores hide on allow and ask rules", () => {
		for (const effect of ["allow", "ask"] as const) {
			const decision = evaluate([{ tool: "bash", effect, hide: true }], {
				toolName: "bash",
				capability: "process.execute",
				args: { command: "ls" },
			});
			expect(decision.kind, effect).toBe(effect);
			expect(decision.hidden, effect).toBe(false);
		}
	});

	it("arg-dependent rules cannot hide: with no args, path and command matchers do not match", () => {
		// Visibility filtering evaluates with no call args, so a deny rule whose
		// matcher needs a path/command value never decides hiding.
		const pathDecision = evaluate([{ path: "/etc", effect: "deny", hide: true }], {
			toolName: "write",
			args: {},
			defaultEffect: "allow",
		});
		expect(pathDecision.kind).toBe("allow");
		expect(pathDecision.hidden).toBe(false);

		const commandDecision = evaluate([{ command: "rm", effect: "deny", hide: true }], {
			toolName: "bash",
			args: {},
			defaultEffect: "allow",
		});
		expect(commandDecision.kind).toBe("allow");
		expect(commandDecision.hidden).toBe(false);
	});
});

describe("evaluatePermission capability coverage", () => {
	it("accepts every capability value the module exports", () => {
		// Derived from TOOL_CAPABILITIES so adding a capability here fails this
		// test until the evaluator proves it matches like the existing ones.
		for (const capability of TOOL_CAPABILITIES) {
			const decision = evaluate([{ capability, effect: "ask" }], {
				toolName: "tool",
				capability,
				args: {},
			});
			expect(decision.kind, capability).toBe("ask");
		}
	});
});

describe("evaluatePermission malformed rules", () => {
	it("skips rules with an unrecognized effect instead of mis-deciding", () => {
		const decision = evaluate(
			[
				{ tool: "bash", effect: "block" },
				{ tool: "bash", effect: "deny" },
			] as unknown as PermissionRule[],
			{ toolName: "bash" },
		);
		expect(decision.kind).toBe("deny");
		expect(decision.reason).toContain("rule #1");
	});

	it("falls back to the default effect when every rule is malformed", () => {
		const decision = evaluate([{ effect: "maybe" }] as unknown as PermissionRule[], {
			toolName: "bash",
			defaultEffect: "deny",
		});
		expect(decision.kind).toBe("deny");
		expect(decision.reason).toContain("default");
	});

	it("treats an empty-string matcher as a catch-all rather than matching nothing", () => {
		const decision = evaluate([{ path: "", effect: "deny" }], {
			toolName: "read",
			args: { path: "/etc/passwd" },
			defaultEffect: "allow",
		});
		expect(decision.kind).toBe("deny");
		expect(decision.reason).toContain("catch-all");
	});
});
