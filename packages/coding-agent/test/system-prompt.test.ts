import { describe, expect, test } from "vitest";
import { getDocsPath, getExamplesPath, getReadmePath } from "../src/config.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test.each([
			[["powershell"], "Use PowerShell for file operations"],
			[["bash", "powershell"], "Use bash or PowerShell for file operations"],
		] as const)("uses shell-specific guidance for %j", (selectedTools, expected) => {
			const prompt = buildSystemPrompt({
				selectedTools: [...selectedTools],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(expected);
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
			expect(prompt).toContain("environment variables (docs/environment-variables.md)");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});

// ---------------------------------------------------------------------------
// Golden output — fork equivalence baseline (issue #12, plan phase 7)
//
// Seam: `buildSystemPrompt` (src/core/system-prompt.ts), called with fixed
// inputs (fixed cwd string, fixed tool lists/snippets, fixed context file
// contents, fixed skills). These tests pin the exact prompt bytes produced
// today as the equivalence baseline for fork prompt-assembly work: issue #12
// part 2 normalizes tool ordering and schema serialization, and must prove
// equivalence against these expectations. Any deliberate change to prompt
// construction must update them on purpose, never as unnoticed drift.
//
// Determinism: buildSystemPrompt embeds no dates or randomness. The only
// environment-dependent values are the three absolute doc paths (README,
// docs, examples) resolved from the package directory; they are normalized
// to <README>/<DOCS>/<EXAMPLES> placeholders below, and nothing else varies.
// ---------------------------------------------------------------------------

const GOLDEN_CWD = "/workspace/project";

// Hand-written expected sections. Placeholders stand for the normalized doc paths.
const GOLDEN_HEADER =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const GOLDEN_CUSTOM_TOOLS_NOTE =
	"In addition to the tools above, you may have access to other custom tools depending on the project.";

const GOLDEN_DOCS_SECTION = `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: <README>
- Additional docs: <DOCS>
- Examples: <EXAMPLES> (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

const GOLDEN_ALWAYS_GUIDELINES = ["Be concise in your responses", "Show file paths clearly when working with files"];

const docPathPlaceholders: Array<[string, string]> = [
	[getReadmePath(), "<README>"],
	[getDocsPath(), "<DOCS>"],
	[getExamplesPath(), "<EXAMPLES>"],
];

function normalizeDocPaths(prompt: string): string {
	let normalized = prompt;
	for (const [path, placeholder] of docPathPlaceholders) {
		normalized = normalized.replaceAll(path, placeholder);
	}
	return normalized;
}

function goldenSkill(options: {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation?: boolean;
}): Skill {
	return {
		name: options.name,
		description: options.description,
		filePath: options.filePath,
		baseDir: "/workspace/project/.pi/skills",
		sourceInfo: createSyntheticSourceInfo(options.filePath, {
			source: "local",
			scope: "project",
			origin: "top-level",
			baseDir: "/workspace/project/.pi/skills",
		}),
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
}

describe("buildSystemPrompt golden output (issue #12 equivalence baseline)", () => {
	test("base startup: default tools with snippets, no context files or skills", () => {
		const prompt = normalizeDocPaths(
			buildSystemPrompt({
				cwd: GOLDEN_CWD,
				selectedTools: ["read", "bash", "edit", "write"],
				toolSnippets: {
					read: "Read files",
					bash: "Run shell commands",
					edit: "Apply surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
			}),
		);

		expect(prompt).toBe(`${GOLDEN_HEADER}

Available tools:
- read: Read files
- bash: Run shell commands
- edit: Apply surgical edits
- write: Create or overwrite files

${GOLDEN_CUSTOM_TOOLS_NOTE}

Guidelines:
- Use bash for file operations like ls, rg, find
${GOLDEN_ALWAYS_GUIDELINES.map((g) => `- ${g}`).join("\n")}

${GOLDEN_DOCS_SECTION}
Current working directory: /workspace/project`);
	});

	test("read-only tool set: bash guideline dropped, single tool listed", () => {
		const prompt = normalizeDocPaths(
			buildSystemPrompt({
				cwd: GOLDEN_CWD,
				selectedTools: ["read"],
				toolSnippets: { read: "Read files" },
				contextFiles: [],
				skills: [],
			}),
		);

		expect(prompt).toBe(`${GOLDEN_HEADER}

Available tools:
- read: Read files

${GOLDEN_CUSTOM_TOOLS_NOTE}

Guidelines:
${GOLDEN_ALWAYS_GUIDELINES.map((g) => `- ${g}`).join("\n")}

${GOLDEN_DOCS_SECTION}
Current working directory: /workspace/project`);
	});

	test("bash alongside grep/find/ls drops the bash guideline; tools without snippets stay hidden; custom guidelines keep order", () => {
		const prompt = normalizeDocPaths(
			buildSystemPrompt({
				cwd: GOLDEN_CWD,
				selectedTools: ["read", "bash", "grep", "find", "ls", "secret_tool"],
				toolSnippets: {
					read: "Read files",
					bash: "Run shell commands",
					grep: "Search file contents",
					find: "Find files by name",
					ls: "List directories",
					// secret_tool deliberately has no snippet: it must not appear in the list
				},
				promptGuidelines: [
					"Prefer grep over bash for searching.",
					"  Prefer grep over bash for searching.  ",
					"   ",
				],
				contextFiles: [],
				skills: [],
			}),
		);

		expect(prompt).toBe(`${GOLDEN_HEADER}

Available tools:
- read: Read files
- bash: Run shell commands
- grep: Search file contents
- find: Find files by name
- ls: List directories

${GOLDEN_CUSTOM_TOOLS_NOTE}

Guidelines:
- Prefer grep over bash for searching.
${GOLDEN_ALWAYS_GUIDELINES.map((g) => `- ${g}`).join("\n")}

${GOLDEN_DOCS_SECTION}
Current working directory: /workspace/project`);
	});

	test("project instructions render in order under <project_context>", () => {
		const prompt = normalizeDocPaths(
			buildSystemPrompt({
				cwd: GOLDEN_CWD,
				selectedTools: ["read"],
				toolSnippets: { read: "Read files" },
				contextFiles: [
					{ path: "/workspace/project/AGENTS.md", content: "Keep answers short." },
					{
						path: "/workspace/project/docs/CONTRIBUTING.md",
						content: "Run ./test.sh before pushing.\nSign the commit.",
					},
				],
				skills: [],
			}),
		);

		expect(prompt).toBe(`${GOLDEN_HEADER}

Available tools:
- read: Read files

${GOLDEN_CUSTOM_TOOLS_NOTE}

Guidelines:
${GOLDEN_ALWAYS_GUIDELINES.map((g) => `- ${g}`).join("\n")}

${GOLDEN_DOCS_SECTION}

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/workspace/project/AGENTS.md">
Keep answers short.
</project_instructions>

<project_instructions path="/workspace/project/docs/CONTRIBUTING.md">
Run ./test.sh before pushing.
Sign the commit.
</project_instructions>

</project_context>

Current working directory: /workspace/project`);
	});

	test("appendSystemPrompt renders between the docs section and the cwd line", () => {
		const prompt = normalizeDocPaths(
			buildSystemPrompt({
				cwd: GOLDEN_CWD,
				selectedTools: ["read"],
				toolSnippets: { read: "Read files" },
				appendSystemPrompt: "Extra rules apply.",
				contextFiles: [],
				skills: [],
			}),
		);

		expect(prompt).toBe(`${GOLDEN_HEADER}

Available tools:
- read: Read files

${GOLDEN_CUSTOM_TOOLS_NOTE}

Guidelines:
${GOLDEN_ALWAYS_GUIDELINES.map((g) => `- ${g}`).join("\n")}

${GOLDEN_DOCS_SECTION}

Extra rules apply.
Current working directory: /workspace/project`);
	});

	test("skills render XML-escaped after the docs section; disabled skills are excluded", () => {
		const prompt = normalizeDocPaths(
			buildSystemPrompt({
				cwd: GOLDEN_CWD,
				selectedTools: ["read"],
				toolSnippets: { read: "Read files" },
				contextFiles: [],
				skills: [
					goldenSkill({
						name: "commit",
						description: "Write commit messages & follow conventions",
						filePath: "/workspace/project/.pi/skills/commit/SKILL.md",
					}),
					goldenSkill({
						name: "internal-only",
						description: "Never shown",
						filePath: "/workspace/project/.pi/skills/internal-only/SKILL.md",
						disableModelInvocation: true,
					}),
				],
			}),
		);

		expect(prompt).toBe(`${GOLDEN_HEADER}

Available tools:
- read: Read files

${GOLDEN_CUSTOM_TOOLS_NOTE}

Guidelines:
${GOLDEN_ALWAYS_GUIDELINES.map((g) => `- ${g}`).join("\n")}

${GOLDEN_DOCS_SECTION}

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>commit</name>
    <description>Write commit messages &amp; follow conventions</description>
    <location>/workspace/project/.pi/skills/commit/SKILL.md</location>
  </skill>
</available_skills>
Current working directory: /workspace/project`);
	});

	test("combined section order: docs, append, project context, skills, cwd", () => {
		const prompt = normalizeDocPaths(
			buildSystemPrompt({
				cwd: GOLDEN_CWD,
				selectedTools: ["read", "bash", "edit", "write"],
				toolSnippets: {
					read: "Read files",
					bash: "Run shell commands",
					edit: "Apply surgical edits",
					write: "Create or overwrite files",
				},
				appendSystemPrompt: "Extra rules apply.",
				contextFiles: [{ path: "/workspace/project/AGENTS.md", content: "Keep answers short." }],
				skills: [
					goldenSkill({
						name: "review",
						description: "Review diffs before merge",
						filePath: "/workspace/project/.pi/skills/review/SKILL.md",
					}),
				],
			}),
		);

		expect(prompt).toBe(`${GOLDEN_HEADER}

Available tools:
- read: Read files
- bash: Run shell commands
- edit: Apply surgical edits
- write: Create or overwrite files

${GOLDEN_CUSTOM_TOOLS_NOTE}

Guidelines:
- Use bash for file operations like ls, rg, find
${GOLDEN_ALWAYS_GUIDELINES.map((g) => `- ${g}`).join("\n")}

${GOLDEN_DOCS_SECTION}

Extra rules apply.

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/workspace/project/AGENTS.md">
Keep answers short.
</project_instructions>

</project_context>


The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>review</name>
    <description>Review diffs before merge</description>
    <location>/workspace/project/.pi/skills/review/SKILL.md</location>
  </skill>
</available_skills>
Current working directory: /workspace/project`);
	});

	test("customPrompt replaces the default prompt but keeps append, context, skills, and cwd", () => {
		const prompt = normalizeDocPaths(
			buildSystemPrompt({
				cwd: GOLDEN_CWD,
				customPrompt: "You are a terse code reviewer.",
				appendSystemPrompt: "Appended reviewer rules.",
				contextFiles: [{ path: "/workspace/project/AGENTS.md", content: "Review only what changed." }],
				skills: [
					goldenSkill({
						name: "review",
						description: "Review diffs before merge",
						filePath: "/workspace/project/.pi/skills/review/SKILL.md",
					}),
				],
			}),
		);

		expect(prompt).toBe(`You are a terse code reviewer.

Appended reviewer rules.

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/workspace/project/AGENTS.md">
Review only what changed.
</project_instructions>

</project_context>


The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>review</name>
    <description>Review diffs before merge</description>
    <location>/workspace/project/.pi/skills/review/SKILL.md</location>
  </skill>
</available_skills>
Current working directory: /workspace/project
`);
	});

	test("customPrompt without the read tool omits the skills section and the docs section", () => {
		const prompt = normalizeDocPaths(
			buildSystemPrompt({
				cwd: GOLDEN_CWD,
				customPrompt: "You are a deployment checker.",
				selectedTools: ["bash"],
				toolSnippets: { bash: "Run shell commands" },
				contextFiles: [],
				skills: [
					goldenSkill({
						name: "review",
						description: "Review diffs before merge",
						filePath: "/workspace/project/.pi/skills/review/SKILL.md",
					}),
				],
			}),
		);

		expect(prompt).toBe(`You are a deployment checker.
Current working directory: /workspace/project
`);
	});

	test("normalizes backslashes in the cwd line", () => {
		const prompt = normalizeDocPaths(
			buildSystemPrompt({
				cwd: "C:\\workspace\\project",
				selectedTools: [],
				contextFiles: [],
				skills: [],
			}),
		);

		expect(prompt.endsWith("\nCurrent working directory: C:/workspace/project")).toBe(true);
	});
});
