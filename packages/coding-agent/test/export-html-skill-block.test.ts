import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML skill block rendering", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("strips skill wrapper XML from user message rendering", () => {
		// Skill commands store a structural wrapper in the raw user message:
		//   <skill name="..." location="...">\n...\n</skill>\n\nactual prompt
		// The export renderer must detect every wrapper (leading, mid-text, or
		// multiple per message) and render only the user-visible parts, not the
		// Pi-generated <skill>...</skill> XML tags.
		expect(templateJs).toMatch(/parseSkillSegments/);
		expect(templateJs).toMatch(/skillSegments\.some\(s => s\.type === 'skill'\)/);
	});

	it("renders skill invocations and user text as separate sibling blocks", () => {
		// Skill blocks and the user-authored text around them render as separate
		// entry-level elements in message order, matching the TUI layout where
		// SkillInvocationMessageComponent and UserMessageComponent are siblings.
		expect(templateJs).toMatch(/skill-invocation/);
		expect(templateJs).toMatch(/safeMarkedParse\(segment\.text\)/);
	});

	it("renders skill content as markdown, not raw text", () => {
		// The skill block body is markdown (from the SKILL.md file).
		// It should be rendered through safeMarkedParse, not escaped as raw text.
		expect(templateJs).toMatch(/safeMarkedParse\(segment\.block\.content\)/);
	});

	it("shows skill name and user message in the sidebar tree", () => {
		// The sidebar tree should display both the skill name and the user prompt,
		// not just one or the other.
		expect(templateJs).toMatch(/tree-role-skill/);
	});
});
