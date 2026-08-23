import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { loadEntriesFromFile } from "../src/core/session-manager.ts";
import type { CompactionEntry, FileEntry, SessionEntry } from "../src/core/sessions/projector.ts";
import {
	formatValidationReport,
	hasErrors,
	recoverSessionEntries,
	type SessionValidationReport,
	validateEntries,
	validateSessionFile,
} from "../src/core/sessions/validator.ts";

/**
 * Session validator seam tests.
 *
 * validateEntries/validateSessionFile/recoverSessionEntries are the public
 * seams from core/sessions/validator.ts. They check the structural invariants
 * of stored session files without modifying them; loading stays tolerant.
 */

const FIXTURES_DIR = join(__dirname, "fixtures", "sessions");

function loadFixtureFileEntries(name: string): ReturnType<typeof loadEntriesFromFile> {
	return loadEntriesFromFile(join(FIXTURES_DIR, name));
}

const VALID_FIXTURES = [
	"normal.jsonl",
	"tool-success.jsonl",
	"tool-failure.jsonl",
	"model-switch.jsonl",
	"compacted.jsonl",
	"branched.jsonl",
	"unknown-fields.jsonl",
];

describe("validateEntries", () => {
	it("interrupted-turn.jsonl reports an incomplete-final-turn warning and no errors", () => {
		const report = validateEntries(loadFixtureFileEntries("interrupted-turn.jsonl"));
		expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
		expect(report.issues.map((issue) => issue.code)).toEqual(["incomplete-final-turn"]);
		expect(report.issues[0]?.entryId).toBe("f303ed09");
	});

	it.each(VALID_FIXTURES)("%s reports no issues", (name) => {
		const report = validateEntries(loadFixtureFileEntries(name));
		expect(report.issues).toEqual([]);
	});
});

describe("validateSessionFile", () => {
	it("truncated-tail.jsonl reports a torn-tail error with the fragment byte length", () => {
		const report = validateSessionFile(join(FIXTURES_DIR, "truncated-tail.jsonl"));
		const tornTail = report.issues.filter((issue) => issue.code === "torn-tail");
		expect(tornTail).toHaveLength(1);
		expect(tornTail[0]?.severity).toBe("error");
		expect(tornTail[0]?.line).toBe(5);
		// The fragment is the partial final line of the fixture; its byte length is stated.
		expect(tornTail[0]?.message).toMatch(/\d+ bytes/);
		// A torn tail is not a mid-file malformed line.
		expect(report.issues.some((issue) => issue.code === "malformed-line")).toBe(false);
	});

	it("truncated-tail.jsonl recovers to the valid prefix: normal.jsonl minus its last entry", () => {
		const path = join(FIXTURES_DIR, "truncated-tail.jsonl");
		const { entries } = recoverSessionEntries(path);
		const normal = loadEntriesFromFile(join(FIXTURES_DIR, "normal.jsonl"));
		expect(entries).toEqual(normal.slice(0, -1));
	});

	it("reports each mid-file malformed line as an error with its line number", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-validator-"));
		try {
			const file = join(dir, "midfile.jsonl");
			const lines = readFileSync(join(FIXTURES_DIR, "normal.jsonl"), "utf8").trimEnd().split("\n");
			lines.splice(2, 0, '{"type": "message", broken');
			writeFileSync(file, `${lines.join("\n")}\n`);

			const report = validateSessionFile(file);
			const malformed = report.issues.filter((issue) => issue.code === "malformed-line");
			expect(malformed).toHaveLength(1);
			expect(malformed[0]?.severity).toBe("error");
			expect(malformed[0]?.line).toBe(3);
			expect(report.issues.some((issue) => issue.code === "torn-tail")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accepts a final line that parses but lacks the trailing newline", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-validator-"));
		try {
			const file = join(dir, "no-newline.jsonl");
			const content = readFileSync(join(FIXTURES_DIR, "normal.jsonl"), "utf8");
			writeFileSync(file, content.trimEnd());

			const report = validateSessionFile(file);
			expect(report.issues).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws for a missing file", () => {
		expect(() => validateSessionFile(join(FIXTURES_DIR, "does-not-exist.jsonl"))).toThrow(/not found/);
	});
});

describe("validateEntries synthetic corruption", () => {
	/** normal.jsonl entries deep-cloned: [header, u1, a1, u2, a2] with ids e5632b6e/24260eb7/9a0b53f7/5a6b2f8f. */
	function cloneNormalFileEntries(): FileEntry[] {
		return structuredClone(loadEntriesFromFile(join(FIXTURES_DIR, "normal.jsonl")));
	}

	it("reports each duplicate entry id occurrence", () => {
		const entries = cloneNormalFileEntries();
		const duplicated = (entries[1] as SessionEntry).id;
		(entries[3] as SessionEntry).id = duplicated;
		(entries[4] as SessionEntry).id = duplicated;

		const report = validateEntries(entries);
		const duplicates = report.issues.filter((issue) => issue.code === "duplicate-entry-id");
		expect(duplicates).toHaveLength(2);
		expect(duplicates.every((issue) => issue.severity === "error" && issue.entryId === duplicated)).toBe(true);
	});

	it("reports a toolResult whose tool call is not earlier on its path (orphan)", () => {
		// tool-success.jsonl: [header, u, a(call_1), tr(call_1), a2]. Reparent the
		// result onto the user message: the leaf path (a2 -> tr -> u) reaches the
		// result without ever passing the assistant carrying call_1.
		const entries = structuredClone(loadEntriesFromFile(join(FIXTURES_DIR, "tool-success.jsonl")));
		const user = entries[1] as SessionEntry;
		const result = entries[3] as SessionEntry;
		result.parentId = user.id;

		const report = validateEntries(entries);
		expect(report.issues).toEqual([
			{
				severity: "error",
				code: "orphan-tool-result",
				message: `entry ${result.id} references toolCallId call_1 with no earlier tool call on the path`,
				entryId: result.id,
			},
		]);
	});

	it("reports a second toolResult for an already-answered tool call (duplicate)", () => {
		const entries = structuredClone(loadEntriesFromFile(join(FIXTURES_DIR, "tool-success.jsonl")));
		const result = entries[3] as SessionEntry;
		const closing = entries[4] as SessionEntry;
		// Splice a second result for call_1 between the original result and the
		// closing assistant, chained onto the original result.
		const duplicate = { ...structuredClone(result), id: "dupresult" } as SessionEntry;
		duplicate.parentId = result.id;
		closing.parentId = duplicate.id;
		entries.splice(4, 0, duplicate);

		const report = validateEntries(entries);
		expect(report.issues).toEqual([
			{
				severity: "error",
				code: "duplicate-tool-result",
				message: "entry dupresult duplicates a toolResult for toolCallId call_1",
				entryId: "dupresult",
			},
		]);
	});

	it("reports a broken parent reference", () => {
		const entries = cloneNormalFileEntries();
		(entries[2] as SessionEntry).parentId = "deadbeef";

		const report = validateEntries(entries);
		expect(report.issues).toEqual([
			{
				severity: "error",
				code: "broken-parent-ref",
				message: "entry 24260eb7 references missing parent deadbeef",
				entryId: "24260eb7",
			},
		]);
	});

	it("detects a two-entry ancestry cycle without hanging", () => {
		const entries = cloneNormalFileEntries();
		const u1 = entries[1] as SessionEntry;
		const a1 = entries[2] as SessionEntry;
		// u1 -> a1 -> u1: a1.parentId already points at u1, so repointing u1 creates a real cycle.
		u1.parentId = a1.id;

		const report = validateEntries(entries);
		expect(report.issues).toEqual([expect.objectContaining({ severity: "error", code: "cyclic-ancestry" })]);
	});

	it("flags malformed identity fields instead of walking unsafe ancestry (cycle via non-string id)", () => {
		// u1.parentId is the numeric id of a1; a1.parentId points back at u1.
		// buildSessionPath follows any truthy parentId, so this cycle hangs the
		// projector unless the validator flags the malformed ids and skips the walk.
		const entries = cloneNormalFileEntries();
		Object.assign(entries[1] as object, { parentId: 1 });
		Object.assign(entries[2] as object, { id: 1, parentId: "e5632b6e" });

		const report = validateEntries(entries);
		const codes = report.issues.map((issue) => issue.code);
		expect(codes).toContain("invalid-entry-id");
		expect(codes).toContain("invalid-parent-id");
		expect(hasErrors(report)).toBe(true);
	});

	it("flags a non-string parentId as an error", () => {
		const entries = cloneNormalFileEntries();
		Object.assign(entries[1] as object, { parentId: 42 });

		const report = validateEntries(entries);
		expect(report.issues).toEqual([
			{
				severity: "error",
				code: "invalid-parent-id",
				message: "entry e5632b6e has a non-string parentId (number)",
				entryId: "e5632b6e",
			},
		]);
	});

	it("warns on an additional root entry without erroring", () => {
		const entries = cloneNormalFileEntries();
		(entries[4] as SessionEntry).parentId = null;

		const report = validateEntries(entries);
		expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
		expect(report.issues.map((issue) => issue.code)).toEqual(["multiple-roots"]);
	});

	it("reports a missing or invalid session header", () => {
		const entries = cloneNormalFileEntries();
		expect(validateEntries(entries.slice(1)).issues.map((issue) => issue.code)).toEqual(["invalid-header"]);
		expect(validateEntries([]).issues.map((issue) => issue.code)).toEqual(["invalid-header"]);
	});

	it("reports a compaction whose firstKeptEntryId is off the compaction's path", () => {
		const header: FileEntry = {
			type: "session",
			version: 3,
			id: "synthetic-session",
			timestamp: "2025-08-22T00:00:00.000Z",
			cwd: "/tmp",
		};
		const node = (id: string, parentId: string | null): SessionEntry => ({
			type: "custom",
			customType: "test",
			id,
			parentId,
			timestamp: "2025-08-22T00:00:00.000Z",
		});
		const compaction = (firstKeptEntryId: string): CompactionEntry => ({
			type: "compaction",
			id: "k",
			parentId: "b",
			timestamp: "2025-08-22T00:00:00.000Z",
			summary: "summary",
			firstKeptEntryId,
			tokensBefore: 10,
		});

		// root -> a -> b plus sibling branch c under root; compaction under b.
		const entries: FileEntry[] = [
			header,
			node("root", null),
			node("a", "root"),
			node("c", "root"),
			node("b", "a"),
			compaction("c"),
		];
		expect(validateEntries(entries).issues.map((issue) => issue.code)).toEqual(["off-path-compaction"]);

		// firstKeptEntryId on the compaction's own root path (root -> a -> b -> k) is fine.
		expect(validateEntries([...entries.slice(0, 5), compaction("root")]).issues).toEqual([]);
	});
});

describe("crash-safety: truncation at arbitrary byte offsets", () => {
	it.each([0.1, 0.35, 0.6, 0.85, 0.99])(
		"recovering a prefix cut at %s%% of the file yields only complete lines and flags the torn tail",
		(fraction) => {
			const sourcePath = join(FIXTURES_DIR, "normal.jsonl");
			const bytes = readFileSync(sourcePath);
			const fullEntries = loadEntriesFromFile(sourcePath);

			const dir = mkdtempSync(join(tmpdir(), "pi-validator-crash-"));
			try {
				const cut = Math.floor(bytes.length * fraction);
				const truncatedPath = join(dir, `cut-${fraction}.jsonl`);
				writeFileSync(truncatedPath, bytes.subarray(0, cut));

				// Invariant: recovered entries never contain a partial entry and always
				// equal a prefix of the full entry list.
				const { entries } = recoverSessionEntries(truncatedPath);
				expect(entries).toEqual(fullEntries.slice(0, entries.length));

				// Independent expectation: the prefix's complete-line count (the fixture
				// has one JSON entry per line, no blank lines).
				const completeLines = Array.from(bytes.subarray(0, cut)).filter((byte) => byte === 0x0a).length;
				expect(entries).toHaveLength(completeLines);

				// A cut mid-line is a torn tail; a cut exactly on a newline is clean.
				const endsOnNewline = cut > 0 && bytes[cut - 1] === 0x0a;
				const report = validateSessionFile(truncatedPath);
				const tornTail = report.issues.filter((issue) => issue.code === "torn-tail");
				expect(tornTail).toHaveLength(endsOnNewline ? 0 : 1);
				if (endsOnNewline) {
					expect(report.issues).toEqual([]);
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("report formatting and exit-code decision", () => {
	it("formats one line per issue plus a summary line", () => {
		const report: SessionValidationReport = {
			issues: [
				{
					severity: "error",
					code: "torn-tail",
					message: "final line is incomplete JSON (42 bytes); likely torn by an interrupted append",
					line: 5,
				},
				{
					severity: "warning",
					code: "multiple-roots",
					message: "entry abc has no parent and forms an additional root; getTree treats it as a separate tree",
					entryId: "abc",
				},
			],
		};

		expect(formatValidationReport(report).split("\n")).toEqual([
			"error torn-tail: final line is incomplete JSON (42 bytes); likely torn by an interrupted append (line 5)",
			"warning multiple-roots: entry abc has no parent and forms an additional root; getTree treats it as a separate tree (entry abc)",
			"1 error, 1 warning",
		]);
	});

	it("formats a clean report", () => {
		expect(formatValidationReport({ issues: [] })).toBe("no issues");
	});

	it("hasErrors is true only when an error-severity issue exists", () => {
		expect(hasErrors({ issues: [] })).toBe(false);
		expect(hasErrors({ issues: [{ severity: "warning", code: "c", message: "m" }] })).toBe(false);
		expect(
			hasErrors({
				issues: [
					{ severity: "warning", code: "c", message: "m" },
					{ severity: "error", code: "c", message: "m" },
				],
			}),
		).toBe(true);
	});
});
