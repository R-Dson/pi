import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	buildSessionContext,
	buildSessionPath,
	type FileEntry,
	type SessionEntry,
} from "../src/core/sessions/projector.ts";

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

	it("terminates on cyclic ancestry and returns the entries below the cycle", () => {
		// normal.jsonl entries: [u1, a1, u2, a2] with a1.parentId = u1; repointing
		// u1 at a1 closes a two-entry cycle (same construction as the validator's
		// cycle test). The default leaf (a2) must still project the chain below it.
		const entries = loadFixtureEntries("normal.jsonl");
		entries[0].parentId = entries[1].id;

		const path = buildSessionPath(entries);
		expect(path.map((entry) => entry.id)).toEqual(["e5632b6e", "24260eb7", "9a0b53f7", "5a6b2f8f"]);
	});
});
