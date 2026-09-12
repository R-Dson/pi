import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ContextUsage } from "../src/core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	usingSubscription?: boolean;
	contextUsage?: ContextUsage;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => options.contextUsage ?? { tokens: 24_600, contextWindow: 200_000, percent: 12.3 },
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent context usage display", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("shows tokens, window, and percent together", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1] ?? "");
		expect(statsLine).toContain("25k/200k (12.3%) (auto)");
	});

	it("falls back to the unknown form after compaction", () => {
		const session = createSession({
			sessionName: "",
			contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1] ?? "");
		expect(statsLine).toContain("?/200k (auto)");
	});

	it("drops the auto indicator when auto-compaction is disabled", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1));
		footer.setAutoCompactEnabled(false);

		const statsLine = stripAnsi(footer.render(120)[1] ?? "");
		expect(statsLine).toContain("25k/200k (12.3%)");
		expect(statsLine).not.toContain("(auto)");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("$1.250");
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("Cache 25.0%");
	});

	it("marks Kimi Coding costs as subscription estimates", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[1])).toContain("$1.234 (sub)");
	});

	it("marks explicitly identified subscription auth", () => {
		const session = createSession({ sessionName: "", provider: "anthropic", usingSubscription: true });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[1])).toContain("$0.000 (sub)");
	});

	it("does not mark generic OAuth sign-in as a subscription", () => {
		const session = createSession({
			sessionName: "",
			provider: "openrouter",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const stats = stripAnsi(footer.render(120)[1]);

		expect(stats).toContain("$1.234");
		expect(stats).not.toContain("(sub)");
	});
});

describe("FooterComponent transient status", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("replaces the pwd line until the message expires", () => {
		vi.useFakeTimers();
		try {
			const session = createSession({ sessionName: "" });
			const footer = new FooterComponent(session, createFooterData(1));
			let renderRequests = 0;
			footer.setTransientStatus("Thinking blocks: hidden", () => {
				renderRequests++;
			});

			const during = footer.render(120).map(stripAnsi);
			expect(during[0]).toContain("Thinking blocks: hidden");
			expect(during[0]).not.toContain("/tmp/project");

			vi.advanceTimersByTime(3000);
			expect(renderRequests).toBeGreaterThan(0);

			const after = footer.render(120).map(stripAnsi);
			expect(after[0]).toContain("/tmp/project");
			expect(after[0]).not.toContain("Thinking blocks");
		} finally {
			vi.useRealTimers();
		}
	});

	it("replaces an active message and resets its timer", () => {
		vi.useFakeTimers();
		try {
			const session = createSession({ sessionName: "" });
			const footer = new FooterComponent(session, createFooterData(1));
			footer.setTransientStatus("first", () => {});
			footer.setTransientStatus("second", () => {});

			expect(footer.render(120).map(stripAnsi)[0]).toContain("second");

			// 3s after the FIRST call, but < 3s after the second: still showing.
			vi.advanceTimersByTime(2000);
			expect(footer.render(120).map(stripAnsi)[0]).toContain("second");

			vi.advanceTimersByTime(1000);
			expect(footer.render(120).map(stripAnsi)[0]).not.toContain("second");
		} finally {
			vi.useRealTimers();
		}
	});
});
