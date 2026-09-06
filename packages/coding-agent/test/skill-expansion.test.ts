import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSkillSegments } from "../src/core/agent-session.ts";
import { expandSkillCommands, type Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

describe("skill command expansion", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-skill-expansion-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	function makeSkill(name: string, body: string, withFrontmatter = true): Skill {
		const dir = join(tempRoot, name);
		const filePath = join(dir, "SKILL.md");
		const content = withFrontmatter ? `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n${body}` : body;
		mkdirSync(dir, { recursive: true });
		writeFileSync(filePath, content, "utf-8");
		return {
			name,
			description: `Test skill ${name}.`,
			filePath,
			baseDir: dir,
			sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
			disableModelInvocation: false,
		};
	}

	function blockFor(skill: Skill, body: string): string {
		return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	}

	it("expands a leading skill command with args", () => {
		const skill = makeSkill("tdd", "TDD body");
		const result = expandSkillCommands("/skill:tdd fix the bug", [skill]);
		expect(result).toBe(`${blockFor(skill, "TDD body")}\n\nfix the bug`);
	});

	it("expands a leading skill command without args", () => {
		const skill = makeSkill("tdd", "TDD body");
		const result = expandSkillCommands("/skill:tdd", [skill]);
		expect(result).toBe(blockFor(skill, "TDD body"));
	});

	it("expands multiple chained skill commands", () => {
		const ponytail = makeSkill("ponytail", "Ponytail body");
		const tdd = makeSkill("tdd", "TDD body");
		const toSpec = makeSkill("to-spec", "Spec body");
		const result = expandSkillCommands("/skill:ponytail /skill:tdd /skill:to-spec", [ponytail, tdd, toSpec]);
		expect(result).toBe(
			[blockFor(ponytail, "Ponytail body"), blockFor(tdd, "TDD body"), blockFor(toSpec, "Spec body")].join("\n\n"),
		);
	});

	it("expands a skill invoked mid-text", () => {
		const skill = makeSkill("ponytail", "Ponytail body");
		const result = expandSkillCommands("first do X /skill:ponytail then do Y", [skill]);
		expect(result).toBe(`first do X\n\n${blockFor(skill, "Ponytail body")}\n\nthen do Y`);
	});

	it("expands multiple skills interleaved with prose, keeping order", () => {
		const a = makeSkill("tdd", "TDD body");
		const b = makeSkill("to-spec", "Spec body");
		const result = expandSkillCommands("please /skill:tdd also /skill:to-spec thanks", [a, b]);
		expect(result).toBe(`please\n\n${blockFor(a, "TDD body")}\n\nalso\n\n${blockFor(b, "Spec body")}\n\nthanks`);
	});

	it("expands a skill at the start of a later line", () => {
		const skill = makeSkill("tdd", "TDD body");
		const result = expandSkillCommands("plan:\n/skill:tdd go", [skill]);
		expect(result).toBe(`plan:\n\n${blockFor(skill, "TDD body")}\n\ngo`);
	});

	it("expands the same skill twice", () => {
		const skill = makeSkill("tdd", "TDD body");
		const result = expandSkillCommands("/skill:tdd /skill:tdd", [skill]);
		expect(result).toBe([blockFor(skill, "TDD body"), blockFor(skill, "TDD body")].join("\n\n"));
	});

	it("passes through unknown skill names unchanged", () => {
		const skill = makeSkill("tdd", "TDD body");
		const text = "/skill:nope fix /skill:tdd";
		// /skill:nope is unknown: stays literal, known skill after it still expands
		const result = expandSkillCommands(text, [skill]);
		expect(result).toBe(`/skill:nope fix\n\n${blockFor(skill, "TDD body")}`);
		expect(expandSkillCommands("/skill:nope args", [skill])).toBe("/skill:nope args");
	});

	it("returns text without skill tokens unchanged", () => {
		const skill = makeSkill("tdd", "TDD body");
		expect(expandSkillCommands("plain prompt", [skill])).toBe("plain prompt");
		expect(expandSkillCommands("", [skill])).toBe("");
	});

	it("does not expand tokens not at a whitespace boundary", () => {
		const skill = makeSkill("tdd", "TDD body");
		expect(expandSkillCommands("path/to/skill:tdd", [skill])).toBe("path/to/skill:tdd");
		expect(expandSkillCommands("see (/skill:tdd)", [skill])).toBe("see (/skill:tdd)");
	});

	it("resolves names followed by punctuation", () => {
		const skill = makeSkill("tdd", "TDD body");
		const result = expandSkillCommands("/skill:tdd, then /skill:tdd.", [skill]);
		expect(result).toBe(`${blockFor(skill, "TDD body")}\n\n, then\n\n${blockFor(skill, "TDD body")}\n\n.`);
	});

	it("leaves the token literal and reports when the skill file cannot be read", () => {
		const skill = makeSkill("tdd", "TDD body");
		const other = makeSkill("to-spec", "Spec body");
		rmSync(join(tempRoot, "tdd"), { recursive: true, force: true });

		const errors: Array<{ filePath: string; message: string }> = [];
		const result = expandSkillCommands("/skill:tdd and /skill:to-spec", [skill, other], (error) =>
			errors.push(error),
		);

		expect(errors).toHaveLength(1);
		expect(errors[0].filePath).toBe(skill.filePath);
		expect(result).toBe(`/skill:tdd and\n\n${blockFor(other, "Spec body")}`);
	});

	it("returns the original text when no token resolves", () => {
		const skill = makeSkill("tdd", "TDD body");
		rmSync(join(tempRoot, "tdd"), { recursive: true, force: true });

		const result = expandSkillCommands("/skill:tdd fix this", [skill], () => {});
		expect(result).toBe("/skill:tdd fix this");
	});
});

describe("parseSkillSegments", () => {
	const block = (name: string, content: string) =>
		`<skill name="${name}" location="/skills/${name}/SKILL.md">\n${content}\n</skill>`;

	it("returns a single text segment when there is no skill block", () => {
		expect(parseSkillSegments("hello world")).toEqual([{ type: "text", text: "hello world" }]);
	});

	it("splits a leading block from its trailing user message", () => {
		const segments = parseSkillSegments(`${block("tdd", "TDD body")}\n\nfix the bug`);
		expect(segments).toEqual([
			{
				type: "skill",
				block: { name: "tdd", location: "/skills/tdd/SKILL.md", content: "TDD body", userMessage: undefined },
			},
			{ type: "text", text: "fix the bug" },
		]);
	});

	it("splits mid-text and multiple blocks in order", () => {
		const segments = parseSkillSegments(`do X\n\n${block("a", "A body")}\n\nthen Y\n\n${block("b", "B body")}`);
		expect(segments).toEqual([
			{ type: "text", text: "do X" },
			{
				type: "skill",
				block: { name: "a", location: "/skills/a/SKILL.md", content: "A body", userMessage: undefined },
			},
			{ type: "text", text: "then Y" },
			{
				type: "skill",
				block: { name: "b", location: "/skills/b/SKILL.md", content: "B body", userMessage: undefined },
			},
		]);
	});

	it("drops whitespace-only text between blocks", () => {
		const segments = parseSkillSegments(`${block("a", "A body")}\n\n${block("b", "B body")}`);
		expect(segments).toHaveLength(2);
		expect(segments[0].type).toBe("skill");
		expect(segments[1].type).toBe("skill");
	});
});
