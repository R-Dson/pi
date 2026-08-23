import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntimeDiagnostic } from "../../src/core/agent-session-services.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { allowNetwork } from "../test-network-env.ts";
import { createHarness, getAssistantTexts } from "./harness.ts";

function render(container: Container): string {
	return container.children.flatMap((child) => child.render(120)).join("\n");
}

/**
 * Issue #32: the fork's runtime must perform zero outbound requests to
 * tracking hosts. A representative session (faux-provider prompt plus the
 * interactive-mode startup background checks) must not touch the network at
 * all: provider traffic goes through the faux provider and every pi.dev
 * fetch site (version check, install ping, catalog overlay) is purged.
 */
describe("no tracking traffic (issue #32)", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("performs no network requests during a representative session", async () => {
		// Tests run with PI_OFFLINE=1 by default; unset it so startup network
		// code paths are live, exactly like a real interactive session.
		allowNetwork();
		const requests: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				requests.push(typeof input === "string" ? input : String(input));
				return Response.json({ version: "0.0.0" });
			}),
		);

		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("hello");
			expect(getAssistantTexts(harness)).toEqual(["ok"]);

			// Drive the interactive-mode startup background checks the way
			// regressions/7829 does: call run() on a stubbed context. The
			// catalog refresh, version check, and update notification used to
			// phone home from here.
			const chatContainer = new Container();
			const startupDiagnostics: AgentSessionRuntimeDiagnostic[] = [{ type: "warning", message: "startup check" }];
			const context = {
				init: vi.fn(async () => {}),
				options: { startupDiagnostics },
				chatContainer,
				outputPad: 1,
				ui: { requestRender: vi.fn() },
				version: "test",
				showWarning: (InteractiveMode.prototype as unknown as { showWarning(message: string): void }).showWarning,
				session: harness.session,
				checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
				maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
				getUserInput: vi.fn(() => new Promise<string>(() => {})),
			};
			const run = (InteractiveMode.prototype as unknown as { run(this: typeof context): Promise<void> }).run;

			void run.call(context);

			await vi.waitFor(() => {
				expect(render(chatContainer)).toContain("Warning: startup check");
			});
			// Let the fire-and-forget startup promises settle.
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(requests).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
});
