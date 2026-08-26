/**
 * Key-gated e2e cache-hit verification (issue #55).
 *
 * The only test class that verifies real provider cache behavior: it drives a
 * real multi-turn conversation (including one tool turn) plus a manual
 * compaction against the live Anthropic API and asserts:
 *   - every assistant response after the first reads prompt-cache tokens,
 *   - the compaction summarizer call itself created/read cache
 *     (SessionStats.cacheUsageByKind, issue #42),
 *   - no request diverged from its announced prefix during the run
 *     (no `unexpected-*` causes in prefixInvalidationsByCause, issue #51 class),
 *   - the replaying summarizer request carried the session routing id
 *     (issue #51), keeping it in the regular requests' cache bucket.
 *
 * How to run (from packages/coding-agent):
 *   env ANTHROPIC_API_KEY=<key> \
 *     node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
 *     --run test/e2e-cache-verification.test.ts
 *
 * Env vars:
 *   ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN - required; without either the
 *     suite skips, so CI stays hermetic (same gate as compaction-extensions.test.ts).
 *   PI_E2E_CACHE_MODEL - optional Anthropic model id. Default claude-sonnet-4-5
 *     (matching compaction-extensions.test.ts); an id missing from the catalog
 *     falls back to the default.
 *
 * Cost/duration: ~6-8 requests with a ~2.5k-token padded system prompt and
 * tiny outputs - a few US cents on claude-sonnet-4-5 (mostly cache-write
 * pricing), roughly 30-60 s.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { CacheRetention, ToolChoice } from "@earendil-works/pi-ai";
import { type AssistantMessage, getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createCodingTools } from "../src/index.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const API_KEY = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

const MODEL_ID = process.env.PI_E2E_CACHE_MODEL || "claude-sonnet-4-5";

/**
 * Anthropic caches only prefixes of at least 1024 tokens, so the system prompt
 * is padded past that minimum (the coding tools already contribute, but the
 * padding alone must carry the block). The run marker makes each run's cache
 * prefix unique, so the first request is a guaranteed cold miss even when the
 * test is re-run within the provider's cache TTL.
 */
const RUN_MARKER = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const CACHE_TEST_PADDING = [
	"CACHE-TEST PADDING (synthetic filler; safe to ignore, carries no instructions).",
	"This block exists only to push the system prompt past the provider's 1024-token minimum cacheable prefix so this test can measure real cache hits.",
	`Run marker: ${RUN_MARKER}`,
	...Array.from(
		{ length: 80 },
		(_, i) =>
			`Filler ${i + 1}: pack my box with five dozen liquor jugs while the quick brown fox jumps over the lazy dog.`,
	),
].join("\n");

/** Final request options of one provider request, recorded under the session's stream observers. */
interface ObservedRequest {
	toolChoice: ToolChoice | undefined;
	cacheRetention: CacheRetention | undefined;
	sessionId: string | undefined;
}

describe.skipIf(!API_KEY)("E2E cache verification (real provider)", () => {
	let session: AgentSession;
	let tempDir: string;
	let observedRequests: ObservedRequest[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-e2e-cache-verification-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		observedRequests = [];
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(): Promise<AgentSession> {
		// Resolve the (possibly overridden) model id against the catalog; an id
		// missing from the catalog falls back to the pinned default.
		const model =
			getBuiltinModels("anthropic").find((candidate) => candidate.id === MODEL_ID) ??
			getModel("anthropic", "claude-sonnet-4-5")!;

		// Recording wrapper installed under the session's own stream observers:
		// every provider request (regular turns and summarizer calls alike)
		// passes through here with its final request options. The `unwrapped`
		// marker keeps AgentSession's default-stream detection seeing streamSimple
		// through both wrapper layers.
		const recordingStreamFn: StreamFn = async (requestModel, context, options) => {
			observedRequests.push({
				toolChoice: options?.toolChoice,
				cacheRetention: options?.cacheRetention,
				sessionId: options?.sessionId,
			});
			return streamSimple(requestModel, context, options);
		};
		(recordingStreamFn as StreamFn & { unwrapped?: StreamFn }).unwrapped = streamSimple;

		const sessionManager = SessionManager.create(tempDir);
		const agent = new Agent({
			getApiKey: () => API_KEY,
			streamFn: recordingStreamFn,
			// Routing id regular requests carry (sdk.ts wires the same value in
			// real sessions); the compaction replay must forward it (issue #51).
			sessionId: sessionManager.getSessionId(),
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools: createCodingTools(tempDir),
			},
		});

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		// Small sessions compact only with a tiny keep window (same override as
		// compaction-extensions.test.ts).
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage);

		const resourceLoader = {
			...createTestResourceLoader(),
			// Pad the system prompt past Anthropic's 1024-token cache minimum.
			getAppendSystemPrompt: () => [CACHE_TEST_PADDING],
		};

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader,
		});

		return session;
	}

	async function turn(text: string): Promise<void> {
		await session.prompt(text);
		await session.agent.waitForIdle();
	}

	it("reads prompt cache on every request after the first and attributes compaction cache", async () => {
		await createSession();

		const dataFile = join(tempDir, "cache-probe.txt");
		writeFileSync(dataFile, "alpha-cache-probe first line\nsecond line\n", "utf-8");

		await turn("Reply with exactly: ok-1");
		await turn(
			`Use the read tool to read the file at ${dataFile}, then reply with only the first line of its contents.`,
		);
		await turn("In one short sentence: what was the first line of the file you just read?");

		// Cache assertions over the real conversation, collected before
		// compaction rewrites history.
		const replies = session.messages.filter((m): m is AssistantMessage => m.role === "assistant");
		expect(replies.length).toBeGreaterThanOrEqual(3);

		// Cold prefix: the unique run marker in the padded system prompt
		// guarantees the first request cannot hit a prior run's cache.
		expect(replies[0].usage.cacheRead).toBe(0);
		for (const [index, reply] of replies.slice(1).entries()) {
			expect(reply.usage.cacheRead, `assistant reply ${index + 2}`).toBeGreaterThan(0);
		}
		expect(replies.some((r) => r.usage.cacheWrite > 0)).toBe(true);

		// The tool turn actually used a tool.
		expect(session.getSessionStats().toolCalls).toBeGreaterThan(0);

		// Manual compaction: the replaying summarizer call must itself
		// create/read provider cache; the per-kind attribution (issue #42)
		// proves it.
		const result = await session.compact();
		expect(result.summary.length).toBeGreaterThan(0);

		const stats = session.getSessionStats();

		const compaction = stats.cacheUsageByKind.compaction;
		expect(compaction).toBeDefined();
		// The replay call's whole point is reading the warm prefix: prior turns
		// wrote it, so the summarizer must READ cache, not merely write a new one.
		expect(compaction!.cacheRead).toBeGreaterThan(0);

		// Routing regression class (issue #51): no request during the whole
		// run diverged from its announced prefix.
		const unexpected = Object.keys(stats.prefixInvalidationsByCause).filter((cause) =>
			cause.startsWith("unexpected-"),
		);
		expect(unexpected).toEqual([]);

		// And the replaying summarizer request(s) carried the session routing
		// id: `toolChoice: "none"` marks summarizer calls; the standalone
		// split-turn request additionally opts out with `cacheRetention:
		// "none"` and is excluded (it deliberately takes a throwaway id).
		const summarizerRequests = observedRequests.filter((r) => r.toolChoice === "none");
		const replaying = summarizerRequests.filter((r) => r.cacheRetention !== "none");
		expect(replaying.length).toBeGreaterThanOrEqual(1);
		for (const request of replaying) {
			expect(request.sessionId).toBe(session.sessionId);
		}
		// Regular turns carry the same routing id.
		for (const request of observedRequests) {
			if (request.toolChoice !== "none") {
				expect(request.sessionId).toBe(session.sessionId);
			}
		}
	}, 300000);
});
