import { describe, expect, it } from "vitest";
import {
	evaluatePermissionLayered,
	type PermissionDecision,
	type PermissionRule,
	resolveProfileConfig,
	type ToolCapability,
	type ToolProfile,
} from "../src/core/tools/permissions.ts";

const REVIEW_RULES = resolveProfileConfig("review");

function evaluateLayered(
	rules: PermissionRule[],
	args: {
		toolName?: string;
		capability?: ToolCapability;
		args?: Record<string, unknown>;
	},
): PermissionDecision {
	return evaluatePermissionLayered({
		toolName: args.toolName ?? "edit",
		capability: args.capability,
		args: args.args ?? { path: "/repo/a.ts", oldString: "a", newString: "b" },
		baseRules: REVIEW_RULES,
		rules,
		defaultEffect: "allow",
	});
}

describe("resolveProfileConfig", () => {
	it("resolves code (the default) to no rules", () => {
		expect(resolveProfileConfig("code")).toEqual([]);
		expect(resolveProfileConfig(undefined)).toEqual([]);
	});

	it("treats an unknown profile as code", () => {
		expect(resolveProfileConfig("lite" as unknown as ToolProfile)).toEqual([]);
	});

	it("resolves review to read-only rules: allow reads, deny+hide writes and process execution", () => {
		expect(resolveProfileConfig("review")).toEqual([
			{ capability: "filesystem.read", effect: "allow" },
			{ capability: "filesystem.write", effect: "deny", hide: true },
			{ capability: "process.execute", effect: "deny", hide: true },
		]);
	});

	it("resolves minimal to static deny+hide rules for the non-core builtins", () => {
		expect(resolveProfileConfig("minimal")).toEqual([
			{ tool: "bash", effect: "deny", hide: true },
			{ tool: "powershell", effect: "deny", hide: true },
			{ tool: "edit", effect: "deny", hide: true },
			{ tool: "write", effect: "deny", hide: true },
		]);
	});

	it("returns a fresh rule list per call so callers cannot corrupt the preset", () => {
		const rules = resolveProfileConfig("review");
		rules.push({ tool: "tamper", effect: "deny" });
		expect(resolveProfileConfig("review")).toHaveLength(3);
	});
});

describe("evaluatePermissionLayered", () => {
	it("applies the profile deny+hide when no user rule matches", () => {
		const decision = evaluateLayered([], { toolName: "edit", capability: "filesystem.write" });
		expect(decision.kind).toBe("deny");
		expect(decision.hidden).toBe(true);
	});

	it("lets a user allow rule override the profile deny", () => {
		const decision = evaluateLayered([{ tool: "edit", effect: "allow" }], {
			toolName: "edit",
			capability: "filesystem.write",
		});
		expect(decision.kind).toBe("allow");
		expect(decision.hidden).toBe(false);
	});

	it("keeps profile rules for calls the user rules do not match", () => {
		const decision = evaluateLayered([{ tool: "read", effect: "allow" }], {
			toolName: "bash",
			capability: "process.execute",
			args: { command: "ls" },
		});
		expect(decision.kind).toBe("deny");
		expect(decision.hidden).toBe(true);
	});

	it("keeps deny > ask > allow within the user layer", () => {
		const decision = evaluateLayered(
			[
				{ tool: "edit", effect: "allow" },
				{ tool: "edit", effect: "deny" },
			],
			{ toolName: "edit", capability: "filesystem.write" },
		);
		expect(decision.kind).toBe("deny");
	});

	it("a user rule that matches decides even when weaker than a profile rule", () => {
		// Profile would deny; a matching user ask rule wins because user rules
		// form the override layer.
		const decision = evaluateLayered([{ tool: "edit", effect: "ask" }], {
			toolName: "edit",
			capability: "filesystem.write",
		});
		expect(decision.kind).toBe("ask");
		expect(decision.hidden).toBe(false);
	});

	it("falls back to the default when neither layer matches", () => {
		const decision = evaluateLayered([], { toolName: "custom_tool", args: {} });
		expect(decision.kind).toBe("allow");
		expect(decision.matched).toBe(false);
	});

	it("behaves exactly like plain evaluation when no profile rules are set", () => {
		const decision = evaluatePermissionLayered({
			toolName: "bash",
			capability: "process.execute",
			args: { command: "git status" },
			baseRules: [],
			rules: [{ capability: "process.execute", effect: "deny" }],
			defaultEffect: "allow",
		});
		expect(decision.kind).toBe("deny");
		expect(decision.matched).toBe(true);
	});

	it("cannot hide via arg-dependent rules: with no args the profile never matches them", () => {
		// Visibility filtering evaluates with args {}, so a profile rule with a
		// command matcher does not hide the tool.
		const decision = evaluatePermissionLayered({
			toolName: "bash",
			capability: "process.execute",
			args: {},
			baseRules: [{ command: "rm", effect: "deny", hide: true }],
			rules: [],
			defaultEffect: "allow",
		});
		expect(decision.kind).toBe("allow");
		expect(decision.hidden).toBe(false);
	});
});
