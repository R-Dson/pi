import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

const parameters = Type.Object({});

function agentTool(timeoutMs?: number): AgentTool<typeof parameters> {
	return {
		name: "probe",
		label: "Probe",
		description: "Probe tool",
		parameters,
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

describe("tool definition wrapper timeoutMs forwarding", () => {
	it("carries timeoutMs from an AgentTool onto the synthesized ToolDefinition", () => {
		const definition = createToolDefinitionFromAgentTool(agentTool(2500));
		expect(definition.timeoutMs).toBe(2500);
	});

	it("keeps an unset timeoutMs unset in both wrap directions", () => {
		expect(createToolDefinitionFromAgentTool(agentTool()).timeoutMs).toBeUndefined();
		const wrapped = wrapToolDefinition({
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		});
		expect(wrapped.timeoutMs).toBeUndefined();
	});

	it("carries timeoutMs from a ToolDefinition onto the wrapped AgentTool", () => {
		const wrapped = wrapToolDefinition({
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters,
			timeoutMs: 1500,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		});
		expect(wrapped.timeoutMs).toBe(1500);
	});
});
