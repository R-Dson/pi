/**
 * Verify the built-in permission-policies extension wires correctly against
 * the public extension API: activation gating on policy-file existence and
 * project trust, layered config from policy files, visibility filtering at
 * session_start, and call-time deny/ask enforcement with interactive
 * approval.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	ToolCallEventResult,
	ToolInfo,
} from "../src/core/extensions/index.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import permissionPolicies, {
	policyFileExists,
	resolvePermissionConfig,
} from "../src/extensions/permission-policies.ts";

type Handler = (event: never, ctx: never) => unknown;

const tempDirs: string[] = [];

beforeEach(() => {
	// Point the global policy file at a nonexistent temp path so tests never
	// read the real ~/.pi/agent/permissions.json.
	process.env.PI_PERMISSION_POLICIES_GLOBAL = join(tmpdir(), `pi-perm-ext-global-${process.pid}.json`);
});

afterEach(() => {
	delete process.env.PI_PERMISSION_POLICIES_GLOBAL;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTool(name: string, capability?: string): ToolInfo {
	return {
		name,
		description: `The ${name} tool`,
		parameters: {},
		promptGuidelines: undefined,
		...(capability ? { capability: capability as ToolInfo["capability"] } : {}),
		sourceInfo: createSyntheticSourceInfo(`example:${name}`, { source: "example" }),
	};
}

interface InstallOptions {
	tools?: ToolInfo[];
	confirmAnswer?: boolean;
	hasUI?: boolean;
	/** Active list as another extension or the SDK left it before session_start. */
	initialActive?: string[];
	/** Trust state reported by the context; defaults to trusted. */
	isProjectTrusted?: boolean;
}

function install(cwd: string, options: InstallOptions = {}) {
	const handlers = new Map<string, Handler>();
	const notifications: string[] = [];
	let active: string[] | undefined;
	let confirmPrompt: string | undefined;
	const tools = options.tools ?? [makeTool("read", "filesystem.read"), makeTool("bash", "process.execute")];
	const initialActive = options.initialActive ?? tools.map((tool) => tool.name);

	const ctx = {
		cwd,
		hasUI: options.hasUI ?? false,
		isProjectTrusted: () => options.isProjectTrusted ?? true,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
			confirm: async (title: string, message: string) => {
				confirmPrompt = `${title}: ${message}`;
				return options.confirmAnswer ?? false;
			},
		},
	} as unknown as ExtensionContext;

	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getAllTools: () => tools,
		getActiveTools: () => active ?? initialActive,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	} as unknown as ExtensionAPI;

	permissionPolicies(pi);

	return {
		notifications,
		confirmPrompt: () => confirmPrompt,
		active: () => active,
		sessionStart: (reason: SessionStartEvent["reason"]) =>
			handlers.get("session_start")?.({ type: "session_start", reason } as never, ctx as never),
		toolCall: async (toolName: string, input: Record<string, unknown> = {}) =>
			(await handlers.get("tool_call")?.(
				{ type: "tool_call", toolCallId: "c1", toolName, input } as never,
				ctx as never,
			)) as ToolCallEventResult | undefined,
	};
}

function projectWithPolicy(policy: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-perm-ext-")));
	tempDirs.push(dir);
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi", "permissions.json"), policy);
	return dir;
}

function projectWithoutPolicy(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-perm-ext-")));
	tempDirs.push(dir);
	return dir;
}

describe("permission-policies builtin", () => {
	it("is registered as a hidden builtInExtensions entry", () => {
		const entry = builtInExtensions.find(
			(extension) => typeof extension === "object" && extension.name === "permission-policies",
		);
		expect(entry).toEqual({ name: "permission-policies", factory: permissionPolicies, hidden: true });
	});

	it("stays inert with no policy file anywhere", async () => {
		const cwd = projectWithoutPolicy();
		expect(policyFileExists(cwd, true)).toBe(false);

		const { active, sessionStart, toolCall, notifications } = install(cwd);
		sessionStart("startup");
		// No visibility rewrite happened...
		expect(active()).toBeUndefined();
		// ...and even a would-be-deniable call proceeds untouched.
		expect((await toolCall("bash", { command: "git push --force" }))?.block).toBeUndefined();
		expect(notifications).toEqual([]);
	});

	it("ignores a project policy file in an untrusted project", async () => {
		const cwd = projectWithPolicy(`{ "rules": [{ "tool": "bash", "command": "git push", "effect": "deny" }] }`);
		expect(policyFileExists(cwd, false)).toBe(false);

		const { active, sessionStart, toolCall } = install(cwd, { isProjectTrusted: false });
		sessionStart("startup");
		expect(active()).toBeUndefined();
		expect((await toolCall("bash", { command: "git push --force" }))?.block).toBeUndefined();
	});

	it("still applies the global policy file in an untrusted project", () => {
		const globalPath = process.env.PI_PERMISSION_POLICIES_GLOBAL as string;
		writeFileSync(globalPath, `{ "profile": "review" }`);
		tempDirs.push(globalPath);
		const cwd = projectWithPolicy(`{ "rules": [{ "tool": "bash", "effect": "allow" }] }`);

		// Untrusted: the project allow is not read, so the global review
		// preset's deny+hide decides.
		const { active, sessionStart } = install(cwd, {
			tools: [makeTool("read", "filesystem.read"), makeTool("bash", "process.execute")],
			isProjectTrusted: false,
		});
		sessionStart("startup");
		expect(active()).toEqual(["read"]);
	});

	it("activates from the global policy file alone", () => {
		const globalPath = process.env.PI_PERMISSION_POLICIES_GLOBAL as string;
		writeFileSync(globalPath, `{ "profile": "review" }`);
		tempDirs.push(globalPath);
		const cwd = projectWithoutPolicy();

		const { active, sessionStart } = install(cwd, {
			tools: [
				makeTool("read", "filesystem.read"),
				makeTool("edit", "filesystem.write"),
				makeTool("bash", "process.execute"),
			],
		});
		sessionStart("startup");
		expect(active()).toEqual(["read"]);
	});

	it("layers project rules over global rules over the profile preset", () => {
		const cwd = projectWithPolicy(`{ "rules": [{ "tool": "bash", "command": "git push", "effect": "deny" }] }`);
		const config = resolvePermissionConfig(cwd, () => {});
		expect(config.profile).toBe("code");
		expect(config.rules).toHaveLength(1);
		expect(config.baseRules).toEqual([]);

		const withProfile = projectWithPolicy(`{ "profile": "review" }`);
		const reviewConfig = resolvePermissionConfig(withProfile, () => {});
		expect(reviewConfig.profile).toBe("review");
		expect(reviewConfig.baseRules.length).toBeGreaterThan(0);
	});

	it("reads global rules as the base layer under project rules", () => {
		const globalPath = process.env.PI_PERMISSION_POLICIES_GLOBAL as string;
		writeFileSync(globalPath, `{ "rules": [{ "capability": "process.execute", "effect": "deny", "hide": true }] }`);
		tempDirs.push(globalPath);
		const cwd = projectWithPolicy(`{ "rules": [{ "tool": "bash", "effect": "allow" }] }`);

		const config = resolvePermissionConfig(cwd, () => {});
		expect(config.baseRules).toHaveLength(1);
		expect(config.rules).toHaveLength(1);

		// A project allow beats the global deny at call time, but hiding is
		// decided per layer winner: the project rule matches, so bash stays visible.
		const { active, sessionStart } = install(cwd, {
			tools: [makeTool("read", "filesystem.read"), makeTool("bash", "process.execute")],
		});
		sessionStart("startup");
		expect(active()).toEqual(["read", "bash"]);
	});

	it("a global allow cannot un-deny a profile preset (same base layer)", () => {
		const globalPath = process.env.PI_PERMISSION_POLICIES_GLOBAL as string;
		writeFileSync(globalPath, `{ "rules": [{ "capability": "process.execute", "effect": "allow" }] }`);
		tempDirs.push(globalPath);
		const cwd = projectWithPolicy(`{ "profile": "review" }`);

		// Global allow and the review preset compose under deny > ask > allow
		// within the base layer: the preset's deny+hide wins, and only a
		// project rule could override it.
		const { active, sessionStart } = install(cwd, {
			tools: [makeTool("read", "filesystem.read"), makeTool("bash", "process.execute")],
		});
		sessionStart("startup");
		expect(active()).toEqual(["read"]);
	});

	it("warns and ignores an unreadable policy file", () => {
		const cwd = projectWithPolicy(`{ not json`);
		const warnings: string[] = [];
		const config = resolvePermissionConfig(cwd, (message) => warnings.push(message));
		expect(config.rules).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("permission-policies");
	});

	it("hides tools the profile denies with hide", () => {
		const cwd = projectWithPolicy(`{ "profile": "review" }`);
		const { active, sessionStart } = install(cwd, {
			tools: [
				makeTool("read", "filesystem.read"),
				makeTool("edit", "filesystem.write"),
				makeTool("bash", "process.execute"),
			],
		});

		sessionStart("startup");
		expect(active()).toEqual(["read"]);
	});

	it("a project allow rule unhides what the profile hides", () => {
		const cwd = projectWithPolicy(`{ "profile": "review", "rules": [{ "tool": "bash", "effect": "allow" }] }`);
		const { active, sessionStart } = install(cwd, {
			tools: [makeTool("read", "filesystem.read"), makeTool("bash", "process.execute")],
		});

		sessionStart("startup");
		expect(active()).toEqual(["read", "bash"]);
	});

	it("preserves another extension's narrower active set instead of broadening it", () => {
		const cwd = projectWithPolicy(`{}`);
		const { active, sessionStart } = install(cwd, {
			tools: [makeTool("read", "filesystem.read"), makeTool("bash", "process.execute")],
			// Someone deactivated bash before this extension loaded; no hide
			// rule exists, so visibility must subtract nothing and add nothing.
			initialActive: ["read"],
		});

		sessionStart("startup");
		expect(active()).toEqual(["read"]);
	});

	it("restores a tool after its hide rule disappears on reload", () => {
		const dir = projectWithPolicy(`{ "rules": [{ "tool": "bash", "effect": "deny", "hide": true }] }`);
		const { active, sessionStart } = install(dir, {
			tools: [makeTool("read", "filesystem.read"), makeTool("bash", "process.execute")],
		});

		sessionStart("startup");
		expect(active()).toEqual(["read"]);

		writeFileSync(join(dir, ".pi", "permissions.json"), `{}`);
		sessionStart("reload");
		expect(active()).toEqual(["read", "bash"]);
	});

	it("denies a matching command with an actionable reason", async () => {
		const cwd = projectWithPolicy(`{ "rules": [{ "tool": "bash", "command": "git push", "effect": "deny" }] }`);
		const { toolCall } = install(cwd);

		const blocked = await toolCall("bash", { command: "git push --force" });
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("git push");
		expect(blocked?.reason).toContain("permissions.json");

		expect((await toolCall("bash", { command: "git status" }))?.block).toBeUndefined();
		expect((await toolCall("read", { path: "src/a.ts" }))?.block).toBeUndefined();
	});

	it("ask blocks with a reason without UI, and approves through the dialog with UI", async () => {
		const cwd = projectWithPolicy(`{ "rules": [{ "capability": "process.execute", "effect": "ask" }] }`);

		const headless = install(cwd);
		const blocked = await headless.toolCall("bash", { command: "ls" });
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("ask");

		const interactive = install(cwd, { hasUI: true, confirmAnswer: true });
		expect((await interactive.toolCall("bash", { command: "ls" }))?.block).toBeUndefined();
		expect(interactive.confirmPrompt()).toContain("Allow bash?");

		const declined = install(cwd, { hasUI: true, confirmAnswer: false });
		expect((await declined.toolCall("bash", { command: "ls" }))?.block).toBe(true);
	});
});
