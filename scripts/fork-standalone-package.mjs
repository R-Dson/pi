#!/usr/bin/env node

// Fork-only packager: stages a self-contained @r-dson/pi-standalone package from
// the coding-agent release bundle and packs it to a stable pi-fork.tgz. The bundle
// already inlines every workspace package, so the derived manifest keeps only the
// non-workspace dependencies (verbatim pins) and installs resolve everything from
// the public npm registry — no GitHub authentication, no registry configuration.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UPSTREAM_SCOPE = "@earendil-works/";
const STANDALONE_NAME = "@r-dson/pi-standalone";
const CODING_AGENT_DIR = join(REPO_ROOT, "packages", "coding-agent");
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// Sections copied verbatim from the source manifest when present. description,
// license, and type are scalars; engines and overrides are objects (overrides
// nests, so object sections are deep-copied). The overrides pin known-bad
// transitives (protobufjs, rimraf) that the excluded shrinkwrap would otherwise
// cover; their keys reference external packages only, so no scope rewrite.
const COPIED_SECTIONS = ["description", "license", "type", "engines", "overrides"];

export function deriveStandaloneManifest(manifest, { version }) {
	const filterWorkspaceDeps = (deps) => {
		const filtered = {};
		for (const [name, specifier] of Object.entries(deps ?? {})) {
			if (!name.startsWith(UPSTREAM_SCOPE)) {
				filtered[name] = specifier;
			}
		}
		return filtered;
	};

	// The CLI reads package-relative assets at runtime (themes, export templates,
	// assets, docs, examples) outside dist/bundle, so the standalone ships the
	// same file set as the upstream npm package, minus the shrinkwrap.
	const derived = {
		name: STANDALONE_NAME,
		version,
		bin: { pi: "dist/bundle/cli.js" },
		files: ["dist", "docs", "examples", "containerization.md", "CHANGELOG.md"],
		dependencies: filterWorkspaceDeps(manifest.dependencies),
		optionalDependencies: filterWorkspaceDeps(manifest.optionalDependencies),
	};

	if (Object.keys(derived.optionalDependencies).length === 0) {
		delete derived.optionalDependencies;
	}

	for (const section of COPIED_SECTIONS) {
		if (manifest[section] !== undefined) {
			derived[section] = typeof manifest[section] === "object" ? structuredClone(manifest[section]) : manifest[section];
		}
	}

	return derived;
}

export function stageStandaloneDirectory(sourcePackageDir, packDirectory, manifest) {
	rmSync(packDirectory, { recursive: true, force: true });
	mkdirSync(packDirectory, { recursive: true });
	for (const entry of ["dist", "docs", "examples", "containerization.md", "CHANGELOG.md"]) {
		const source = join(sourcePackageDir, entry);
		if (existsSync(source)) {
			cpSync(source, join(packDirectory, entry), { recursive: true });
		}
	}
	writeFileSync(join(packDirectory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

function parseArgs(args) {
	const options = {
		version: undefined,
		packDirectory: join(REPO_ROOT, ".fork-publish", "standalone"),
		output: join(REPO_ROOT, ".fork-publish", "pi-fork.tgz"),
	};
	const valueArgs = {
		"--version": "version",
		"--pack-directory": "packDirectory",
		"--output": "output",
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		const key = valueArgs[arg];
		if (key === undefined) {
			throw new Error(`Unknown argument: ${arg}\n${usage()}`);
		}

		const value = args[++index];
		if (value === undefined) {
			throw new Error(`Missing value for ${arg}\n${usage()}`);
		}
		options[key] = value;
	}

	if (options.version === undefined) {
		throw new Error(`--version <semver> is required\n${usage()}`);
	}
	if (!SEMVER_PATTERN.test(options.version)) {
		throw new Error(`Invalid version (expected x.y.z with optional -prerelease): ${options.version}`);
	}

	return options;
}

function usage() {
	return "Usage: node scripts/fork-standalone-package.mjs --version <semver> [--pack-directory <dir>] [--output <path>]";
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result;
}

function pack(directory) {
	const result = run("npm", ["pack", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	// npm emits either an array (npm <=11.0) or an object keyed by package name (npm >=11.1).
	const parsed = JSON.parse(result.stdout);
	const packed = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]];
	if (!packed || typeof packed !== "object") {
		throw new Error(`Unexpected npm pack output shape in ${directory}`);
	}
	return {
		filename: packed.filename,
		fileCount: packed.files.length,
		size: packed.size,
		unpackedSize: packed.unpackedSize,
	};
}

function main() {
	const options = parseArgs(process.argv.slice(2));

	const bundleEntry = join(CODING_AGENT_DIR, "dist", "bundle", "cli.js");
	if (!existsSync(bundleEntry)) {
		throw new Error(`${relative(REPO_ROOT, bundleEntry)} does not exist. Run npm run build before packaging the standalone tarball.`);
	}

	const sourceManifest = JSON.parse(readFileSync(join(CODING_AGENT_DIR, "package.json"), "utf8"));
	const manifest = deriveStandaloneManifest(sourceManifest, { version: options.version });

	const packDirectory = resolve(REPO_ROOT, options.packDirectory);
	const output = resolve(REPO_ROOT, options.output);
	// Only the standalone staging directory is wiped, never .fork-publish itself:
	// the release workflow still reads .fork-publish/summary.json afterwards.
	stageStandaloneDirectory(CODING_AGENT_DIR, packDirectory, manifest);

	const packed = pack(packDirectory);
	mkdirSync(dirname(output), { recursive: true });
	renameSync(join(packDirectory, packed.filename), output);

	console.log(`${STANDALONE_NAME}@${options.version} -> ${relative(REPO_ROOT, output)}`);
	console.log(`  ${packed.fileCount} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
	console.log("Dependencies resolved from the public npm registry:");
	for (const [name, specifier] of Object.entries(manifest.dependencies)) {
		console.log(`  ${name}@${specifier}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
