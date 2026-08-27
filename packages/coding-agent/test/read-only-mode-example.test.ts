/**
 * Verify the read-only-mode example wires correctly against the public
 * extension API surface it uses: the tool filter at session_start and the
 * call-time block for tools that regressed after the filter ran.
 */

import { describe, expect, it } from "vitest";
import readOnlyMode from "../examples/extensions/read-only-mode.ts";
import type { ExtensionAPI, SessionStartEvent, ToolCallEventResult, ToolInfo } from "../src/core/extensions/index.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

type Handler = (event: never, ctx?: never) => unknown;

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

function install(tools: ToolInfo[]) {
	const handlers = new Map<string, Handler>();
	let active: string[] = [];
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getAllTools: () => tools,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	} as unknown as ExtensionAPI;
	readOnlyMode(pi);
	return {
		active: () => active,
		sessionStart: (reason: SessionStartEvent["reason"]) =>
			handlers.get("session_start")?.({ type: "session_start", reason } as never),
		toolCall: async (toolName: string) =>
			(await handlers.get("tool_call")?.({ type: "tool_call", toolCallId: "c1", toolName, input: {} } as never)) as
				| ToolCallEventResult
				| undefined,
	};
}

describe("read-only-mode example", () => {
	it("hides write and process tools from the model's tool list at session start", () => {
		const { active, sessionStart } = install([
			makeTool("read", "filesystem.read"),
			makeTool("grep"),
			makeTool("edit", "filesystem.write"),
			makeTool("write", "filesystem.write"),
			makeTool("bash", "process.execute"),
			makeTool("mcp_custom", undefined),
		]);

		sessionStart("startup");

		expect(active()).toEqual(["read", "grep", "mcp_custom"]);
	});

	it("re-applies the filter on reload and resume", () => {
		const { active, sessionStart } = install([makeTool("read"), makeTool("bash", "process.execute")]);

		sessionStart("resume");
		expect(active()).toEqual(["read"]);
		active().push("bash");
		sessionStart("reload");
		expect(active()).toEqual(["read"]);
	});

	it("blocks a call to a write or process tool with a reason the model can relay", async () => {
		const { toolCall } = install([makeTool("read", "filesystem.read"), makeTool("bash", "process.execute")]);

		const blocked = await toolCall("bash");
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("read-only mode");

		expect((await toolCall("read"))?.block).toBeUndefined();
	});

	it("matches builtin names when capability metadata is absent", async () => {
		const { toolCall, active, sessionStart } = install([makeTool("edit"), makeTool("read")]);

		sessionStart("startup");
		expect(active()).toEqual(["read"]);

		const blocked = await toolCall("edit");
		expect(blocked?.block).toBe(true);
	});
});
