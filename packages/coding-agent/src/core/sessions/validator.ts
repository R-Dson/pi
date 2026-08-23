/**
 * Session file validation and recovery.
 *
 * The validator checks structural invariants of stored session files and
 * reports issues without modifying anything. Loading stays tolerant
 * (loadEntriesFromFile skips bad lines silently and SessionManager.open keeps
 * working unchanged); these functions explain what a tolerant load would
 * silently discard or mis-project.
 *
 * Unknown entry types and unknown optional fields are NOT issues: readers must
 * tolerate them, so the validator stays silent about them.
 */

import { existsSync, readFileSync } from "fs";
import { normalizePath } from "../../utils/paths.ts";
import { buildSessionPath, type CompactionEntry, type FileEntry, type SessionEntry } from "./projector.ts";

export interface SessionValidationIssue {
	severity: "error" | "warning";
	code: string;
	message: string;
	line?: number;
	entryId?: string;
}

export interface SessionValidationReport {
	issues: SessionValidationIssue[];
}

/** Recovered read result: tolerantly parsed entries plus the line-level issues found. */
export interface SessionRecovery {
	entries: FileEntry[];
	issues: SessionValidationIssue[];
}

/** Parse one physical line the same way loading does: blank lines and malformed JSON are skipped. */
// Mirrors session-manager's unexported parseSessionEntryLine; kept local so the
// fork does not widen the upstream diff just to share three lines.
function parseSessionLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		return null;
	}
}

/**
 * Tolerant line scan of raw session file content, mirroring loadEntriesFromFile
 * parse behavior (malformed lines are skipped) while recording what happened:
 * a malformed final line without trailing newline is a torn tail; any other
 * malformed line is a mid-file error.
 */
function scanSessionContent(content: string): SessionRecovery {
	const endsWithNewline = content.endsWith("\n");
	const lines = (endsWithNewline ? content.slice(0, -1) : content).split("\n");
	const entries: FileEntry[] = [];
	const issues: SessionValidationIssue[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isFinalLine = i === lines.length - 1 && !endsWithNewline;
		const entry = parseSessionLine(line);
		if (entry) {
			entries.push(entry);
			continue;
		}
		if (!line.trim()) continue;
		if (isFinalLine) {
			issues.push({
				severity: "error",
				code: "torn-tail",
				message: `final line is incomplete JSON (${Buffer.byteLength(line, "utf8")} bytes); likely torn by an interrupted append`,
				line: i + 1,
			});
		} else {
			issues.push({
				severity: "error",
				code: "malformed-line",
				message: "line is not valid JSON",
				line: i + 1,
			});
		}
	}

	return { entries, issues };
}

/** Read and scan a session file without modifying it. Throws when the file is missing or unreadable. */
function readSessionFile(path: string): string {
	const resolvedPath = normalizePath(path);
	if (!existsSync(resolvedPath)) {
		throw new Error(`Session file not found: ${resolvedPath}`);
	}
	return readFileSync(resolvedPath, "utf8");
}

/**
 * Recovery read path: parse a session file tolerantly (same skipping behavior
 * as loadEntriesFromFile), detect the torn tail, and return both the entries
 * and the line-level issues. Structural validation is validateEntries' job.
 */
export function recoverSessionEntries(path: string): SessionRecovery {
	return scanSessionContent(readSessionFile(path));
}

/**
 * Validate a session file on disk. Combines line-level issues (torn tail,
 * malformed lines) with the structural checks from validateEntries and never
 * mutates or rewrites the file.
 */
export function validateSessionFile(path: string): SessionValidationReport {
	const { entries, issues } = scanSessionContent(readSessionFile(path));
	const structural = validateEntries(entries);
	return { issues: [...issues, ...structural.issues] };
}

/** True when the report contains at least one error-severity issue (the CLI's exit-1 condition). */
export function hasErrors(report: SessionValidationReport): boolean {
	return report.issues.some((issue) => issue.severity === "error");
}

/** Human-readable report: one line per issue (severity prefix), then a summary line. */
export function formatValidationReport(report: SessionValidationReport): string {
	const lines = report.issues.map((issue) => {
		const location =
			issue.line !== undefined
				? ` (line ${issue.line})`
				: issue.entryId !== undefined
					? ` (entry ${issue.entryId})`
					: "";
		return `${issue.severity} ${issue.code}: ${issue.message}${location}`;
	});
	if (lines.length === 0) return "no issues";
	const errors = report.issues.filter((issue) => issue.severity === "error").length;
	const warnings = report.issues.length - errors;
	lines.push(`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
	return lines.join("\n");
}

/** Tool call ids contained in an assistant message content (empty for other shapes). */
function assistantToolCallIds(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const ids: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "toolCall" &&
			typeof (block as { id?: unknown }).id === "string"
		) {
			ids.push((block as { id: string }).id);
		}
	}
	return ids;
}

/**
 * Validate already-parsed session entries (header included).
 *
 * Checks: header validity, duplicate ids, broken parent references, cyclic
 * ancestry (iterative, terminates on cycles), extra roots / orphaned subtrees
 * (warning), compaction firstKeptEntryId on the compaction's ancestor path,
 * and an interrupted final turn on the current leaf path (warning).
 */
export function validateEntries(fileEntries: FileEntry[]): SessionValidationReport {
	const issues: SessionValidationIssue[] = [];

	// Header: the first entry must be a session header with a string id.
	const first = fileEntries[0] as { type?: unknown; id?: unknown } | undefined;
	if (!first || first.type !== "session" || typeof first.id !== "string") {
		issues.push({
			severity: "error",
			code: "invalid-header",
			message: first ? "first entry is not a valid session header" : "no session header entry",
		});
	}

	// Index entries defensively: parsed JSON may contain anything, and the
	// validator must report issues, never crash on them.
	const sessionEntries: SessionEntry[] = [];
	for (const entry of fileEntries) {
		if (typeof entry === "object" && entry !== null && entry.type !== "session") {
			sessionEntries.push(entry);
		}
	}

	const byId = new Map<string, SessionEntry>();
	for (const entry of sessionEntries) {
		if (typeof entry.id !== "string") continue;
		if (byId.has(entry.id)) {
			issues.push({
				severity: "error",
				code: "duplicate-entry-id",
				message: `duplicate entry id ${entry.id}`,
				entryId: entry.id,
			});
			continue;
		}
		byId.set(entry.id, entry);
	}

	// Broken parent references (error) and extra roots / orphaned subtrees
	// (warning: sessions can legitimately gain these via resetLeaf, and
	// getTree already tolerates them).
	//
	// Malformed identity fields (non-string id, truthy non-string parentId) are
	// errors, and any of them makes the ancestry unsafe to walk: buildSessionPath
	// follows any truthy parentId, and a Map keyed by a non-string id can form
	// cycles the string-only cycle walk below cannot see.
	let structureUnsafe = false;
	for (const entry of sessionEntries) {
		if (typeof entry.id !== "string") {
			structureUnsafe = true;
			issues.push({
				severity: "error",
				code: "invalid-entry-id",
				message: `entry id is ${entry.id === null ? "null" : typeof entry.id}, not a string`,
			});
			continue;
		}
		const parentId = entry.parentId;
		if (parentId !== null && parentId !== undefined && typeof parentId !== "string") {
			structureUnsafe = true;
			issues.push({
				severity: "error",
				code: "invalid-parent-id",
				message: `entry ${entry.id} has a non-string parentId (${typeof parentId})`,
				entryId: entry.id,
			});
		}
	}
	let seenFirstEntry = true;
	for (const entry of sessionEntries) {
		if (typeof entry.id !== "string") continue;
		const parentId = entry.parentId;
		if (parentId === null || parentId === undefined) {
			if (!seenFirstEntry) {
				issues.push({
					severity: "warning",
					code: "multiple-roots",
					message: `entry ${entry.id} has no parent and forms an additional root; getTree treats it as a separate tree`,
					entryId: entry.id,
				});
			}
		} else if (typeof parentId === "string" && !byId.has(parentId)) {
			issues.push({
				severity: "error",
				code: "broken-parent-ref",
				message: `entry ${entry.id} references missing parent ${parentId}`,
				entryId: entry.id,
			});
		}
		seenFirstEntry = false;
	}

	// Cyclic ancestry. Iterative walk with a visited set per walk; ids already
	// proven acyclic are memoized so the whole pass stays linear in practice.
	// buildSessionPath would loop forever on a cycle, so the validator must
	// detect every cycle before any path walk below.
	const acyclic = new Set<string>();
	const reportedCycles = new Set<string>();
	for (const entry of sessionEntries) {
		if (typeof entry.id !== "string" || acyclic.has(entry.id)) continue;
		const walkIds: string[] = [];
		const onPath = new Set<string>();
		let current: SessionEntry | undefined = entry;
		let cycleDetected = false;
		while (current !== undefined && typeof current.id === "string") {
			if (acyclic.has(current.id)) break;
			if (onPath.has(current.id)) {
				cycleDetected = true;
				const cycle = walkIds.slice(walkIds.indexOf(current.id));
				const cycleKey = [...cycle].sort().join(",");
				if (!reportedCycles.has(cycleKey)) {
					reportedCycles.add(cycleKey);
					issues.push({
						severity: "error",
						code: "cyclic-ancestry",
						message: `cyclic ancestry: ${[...cycle, cycle[0]].join(" -> ")}`,
						entryId: cycle[0],
					});
				}
				break;
			}
			onPath.add(current.id);
			walkIds.push(current.id);
			current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
		}
		if (!cycleDetected) {
			for (const id of onPath) acyclic.add(id);
		}
	}
	const hasCycles = reportedCycles.size > 0;
	structureUnsafe ||= hasCycles;

	// Compaction entries must keep from an ancestor of the compaction entry:
	// buildContextEntries only finds firstKeptEntryId on the path before the
	// compaction, so an off-path reference silently summarizes everything.
	for (const entry of sessionEntries) {
		if (entry.type !== "compaction") continue;
		const compaction = entry as CompactionEntry;
		const ancestors = new Set<string>();
		const visited = new Set<string>([entry.id]);
		let parentId = entry.parentId;
		while (typeof parentId === "string" && !visited.has(parentId)) {
			const parent = byId.get(parentId);
			if (!parent) break;
			visited.add(parentId);
			ancestors.add(parentId);
			parentId = parent.parentId;
		}
		if (typeof compaction.firstKeptEntryId !== "string" || !ancestors.has(compaction.firstKeptEntryId)) {
			issues.push({
				severity: "error",
				code: "off-path-compaction",
				message: `compaction ${entry.id} keeps from ${String(compaction.firstKeptEntryId)}, which is not an ancestor of the compaction entry`,
				entryId: entry.id,
			});
		}
	}

	// Incomplete final turn: only the last message on the current leaf path.
	// Tool pairs earlier in a compacted or branched history may legitimately be
	// summarized away, so nothing earlier is checked. buildSessionPath cannot
	// run on unsafe ancestry (cycles or malformed ids would not terminate),
	// hence the guard.
	if (!structureUnsafe) {
		const path = buildSessionPath(sessionEntries);
		for (let i = path.length - 1; i >= 0; i--) {
			const entry = path[i];
			if (entry.type !== "message") continue;
			const message = entry.message as { role?: unknown; content?: unknown } | null | undefined;
			if (message && typeof message === "object" && message.role === "assistant") {
				const toolCallIds = assistantToolCallIds(message.content);
				if (toolCallIds.length > 0) {
					issues.push({
						severity: "warning",
						code: "incomplete-final-turn",
						message: `final assistant message has tool calls without results (${toolCallIds.join(", ")}); the turn was likely interrupted`,
						entryId: entry.id,
					});
				}
			}
			break;
		}
	}

	return { issues };
}
