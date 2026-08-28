/**
 * Verify the permission-policies example wires correctly against the public
 * extension API: layered config from policy files, visibility filtering at
 * session_start, and call-time deny/ask enforcement with interactive approval.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import permissionPolicies, { resolvePermissionConfig } from "../examples/extensions/permission-policies.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	ToolCallEventResult,
	ToolInfo,
} from "../src/core/extensions/index.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

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
}

function install(cwd: string, options: InstallOptions = {}) {
	const handlers = new Map<string, Handler>();
	const notifications: string[] = [];
	let active: string[] | undefined;
	let confirmPrompt: string | undefined;
	const tools = options.tools ?? [makeTool("read", "filesystem.read"), makeTool("bash", "process.execute")];

	const ctx = {
		cwd,
		hasUI: options.hasUI ?? false,
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

describe("permission-policies example", () => {
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
