import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildSessionContext, type FileEntry, type SessionEntry } from "../src/core/sessions/projector.ts";

/**
 * Projector module seam test.
 *
 * Imports from core/sessions/projector.ts directly (not the session-manager
 * re-export) and loads the fixture without any session-manager code, proving the
 * projector module works standalone. Values pin the same normal.jsonl projection
 * as the golden suite; this file intentionally does not duplicate it.
 */

const FIXTURES_DIR = join(__dirname, "fixtures", "sessions");

function loadFixtureEntries(name: string): SessionEntry[] {
	return readFileSync(join(FIXTURES_DIR, name), "utf8")
		.split("\n")
		.flatMap((line): SessionEntry[] => {
			if (!line.trim()) return [];
			const entry = JSON.parse(line) as FileEntry;
			return entry.type === "session" ? [] : [entry];
		});
}

describe("session projector module", () => {
	it("projects the normal fixture conversation through the projector module path", () => {
		const ctx = buildSessionContext(loadFixtureEntries("normal.jsonl"));
		expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);

		const first = ctx.messages[0];
		if (first.role !== "user") throw new Error("expected user message");
		expect(first.content).toBe("What is 2+2?");
	});

	it("derives thinking level and model from the projected path", () => {
		const ctx = buildSessionContext(loadFixtureEntries("normal.jsonl"));
		expect(ctx.thinkingLevel).toBe("off");
		expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	});
});
