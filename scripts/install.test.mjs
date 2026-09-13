import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptUnderTest = join(dirname(fileURLToPath(import.meta.url)), "install.sh");

// The installer runs under a stubbed environment: `curl` serves fixture files
// keyed by URL basename (a missing fixture is a 404, exit 22), `npm` records
// every invocation and models install/ls/uninstall state, `uname` reports the
// platform under test. Everything else (sh, tar, node) is the real system.

const CURL_STUB = `#!/bin/sh
log=""
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) out="$2"; shift 2 ;;
    -*) shift ;;
    *) if [ -z "$url" ]; then url="$1"; fi; shift ;;
  esac
done
printf '%s\\n' "$url" >>"$CURL_LOG"
fixture="$FIXTURES/$(basename "$url")"
if [ ! -f "$fixture" ]; then
  echo "curl: (22) The requested URL returned error: 404" >&2
  exit 22
fi
cp "$fixture" "$out"
`;

const NPM_STUB = `#!/bin/sh
printf 'npm %s\\n' "$*" >>"$NPM_LOG"
cmd="$1"
prefix="$NPM_GLOBAL_PREFIX"
while [ $# -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix="$2"; break; fi
  shift
done
case "$cmd" in
  prefix) echo "$prefix" ;;
  ls) [ -f "$NPM_STATE/installed" ] ;;
  install)
    touch "$NPM_STATE/installed"
    mkdir -p "$prefix/bin"
    printf '#!/bin/sh\\necho "%s"\\n' "$NPM_FAKE_VERSION" >"$prefix/bin/pi"
    chmod +x "$prefix/bin/pi"
    ;;
  uninstall) rm -f "$NPM_STATE/installed"; echo ok ;;
esac
`;

const UNAME_STUB = `#!/bin/sh
case "$1" in
  -s) echo "\${FAKE_UNAME_S:-Linux}" ;;
  -m) echo "\${FAKE_UNAME_M:-x86_64}" ;;
esac
`;

function makeBinaryFixture(path, { version, broken = false }) {
	const dir = join(dirname(path), `fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(dir, "pi"), { recursive: true });
	writeFileSync(join(dir, "pi", "package.json"), `${JSON.stringify({ name: "@r-dson/pi-standalone", version }, null, "\t")}\n`);
	const pi = broken ? '#!/bin/sh\necho "startup boom" >&2\nexit 1\n' : `#!/bin/sh\necho "${version}"\n`;
	writeFileSync(join(dir, "pi", "pi"), pi);
	chmodSync(join(dir, "pi", "pi"), 0o755);
	spawnSync("tar", ["-czf", path, "pi"], { cwd: dir });
	rmSync(dir, { recursive: true, force: true });
}

function makeSandbox(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-install-test-"));
	for (const entry of ["home", "tmp", "prefix", "fixtures", "logs", "npm-state", "stubs"]) {
		mkdirSync(join(root, entry), { recursive: true });
	}
	writeFileSync(join(root, "stubs", "curl"), CURL_STUB);
	writeFileSync(join(root, "stubs", "npm"), NPM_STUB);
	writeFileSync(join(root, "stubs", "uname"), UNAME_STUB);
	for (const name of ["curl", "npm", "uname"]) {
		chmodSync(join(root, "stubs", name), 0o755);
	}
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function installerEnv(root, { method, unameS, unameM } = {}) {
	const env = {
		PATH: `${join(root, "stubs")}:${process.env.PATH}`,
		HOME: join(root, "home"),
		TMPDIR: join(root, "tmp"),
		PI_INSTALL_PREFIX: join(root, "prefix"),
		FIXTURES: join(root, "fixtures"),
		CURL_LOG: join(root, "logs", "curl.log"),
		NPM_LOG: join(root, "logs", "npm.log"),
		NPM_STATE: join(root, "npm-state"),
		NPM_GLOBAL_PREFIX: join(root, "prefix"),
		NPM_FAKE_VERSION: "1.0.0-fork.1",
	};
	if (method) env.PI_INSTALL_METHOD = method;
	if (unameS) env.FAKE_UNAME_S = unameS;
	if (unameM) env.FAKE_UNAME_M = unameM;
	return env;
}

function runInstaller(root, env, args) {
	const result = spawnSync("sh", [scriptUnderTest, ...args], { env, encoding: "utf8" });
	assert.equal(result.error, undefined, `spawn failed: ${result.error}`);
	return result;
}

function readLog(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

test("binary install on a supported platform needs no npm", (t) => {
	const root = makeSandbox(t);
	makeBinaryFixture(join(root, "fixtures", "pi-linux-x64.tar.gz"), { version: "1.0.0-fork.1" });
	const result = runInstaller(root, installerEnv(root), []);
	assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
	assert.equal(readLog(join(root, "logs", "npm.log")), "");
	assert.match(readLog(join(root, "logs", "curl.log")), /releases\/latest\/download\/pi-linux-x64\.tar\.gz/);
	const bin = join(root, "prefix", "bin", "pi");
	assert.equal(readlinkSync(bin), "../lib/pi-fork/pi");
	const target = join(root, "prefix", "lib", "pi-fork", "pi");
	assert.ok(existsSync(target), "installed binary missing");
	const version = spawnSync(target, ["--version"], { encoding: "utf8" });
	assert.equal(version.status, 0);
	assert.match(result.stdout, /1\.0\.0-fork\.1/);
});

test("pinned version downloads the versioned binary asset URL", (t) => {
	const root = makeSandbox(t);
	makeBinaryFixture(join(root, "fixtures", "pi-linux-x64.tar.gz"), { version: "0.85.5-fork.1" });
	const result = runInstaller(root, installerEnv(root), ["0.85.5-fork.1"]);
	assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
	assert.match(readLog(join(root, "logs", "curl.log")), /\/download\/v0\.85\.5-fork\.1\/pi-linux-x64\.tar\.gz/);
});

test("unsupported platform falls back to the npm tarball", (t) => {
	const root = makeSandbox(t);
	writeFileSync(join(root, "fixtures", "pi-fork.tgz"), "fixture-tarball");
	const result = runInstaller(root, installerEnv(root, { unameM: "ppc64le" }), []);
	assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
	const npmLog = readLog(join(root, "logs", "npm.log"));
	assert.match(npmLog, /npm install -g --ignore-scripts/);
	assert.match(npmLog, /pi-fork\.tgz/);
	assert.equal(existsSync(join(root, "prefix", "bin", "pi")), true);
});

test("missing binary asset falls back to npm when the method is automatic", (t) => {
	const root = makeSandbox(t);
	writeFileSync(join(root, "fixtures", "pi-fork.tgz"), "fixture-tarball");
	const result = runInstaller(root, installerEnv(root), []);
	assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
	assert.match(readLog(join(root, "logs", "npm.log")), /npm install -g --ignore-scripts/);
});

test("PI_INSTALL_METHOD=binary treats a missing asset as fatal", (t) => {
	const root = makeSandbox(t);
	const result = runInstaller(root, installerEnv(root, { method: "binary" }), []);
	assert.notEqual(result.status, 0);
	assert.equal(readLog(join(root, "logs", "npm.log")), "");
	assert.equal(existsSync(join(root, "prefix", "bin", "pi")), false);
});

test("PI_INSTALL_METHOD=npm skips the binary path even with a binary asset", (t) => {
	const root = makeSandbox(t);
	makeBinaryFixture(join(root, "fixtures", "pi-linux-x64.tar.gz"), { version: "1.0.0-fork.1" });
	writeFileSync(join(root, "fixtures", "pi-fork.tgz"), "fixture-tarball");
	const result = runInstaller(root, installerEnv(root, { method: "npm" }), []);
	assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
	assert.match(readLog(join(root, "logs", "npm.log")), /npm install -g --ignore-scripts/);
	assert.equal(readLog(join(root, "logs", "curl.log")).includes("pi-linux-x64.tar.gz"), false);
});

test("uninstall removes a binary install without npm", (t) => {
	const root = makeSandbox(t);
	makeBinaryFixture(join(root, "fixtures", "pi-linux-x64.tar.gz"), { version: "1.0.0-fork.1" });
	const env = installerEnv(root);
	assert.equal(runInstaller(root, env, []).status, 0);
	const result = runInstaller(root, env, ["--uninstall"]);
	assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
	assert.equal(readLog(join(root, "logs", "npm.log")), "");
	assert.equal(existsSync(join(root, "prefix", "bin", "pi")), false);
	assert.equal(existsSync(join(root, "prefix", "lib", "pi-fork")), false);
});

test("a foreign pi in the bin dir is refused, not overwritten", (t) => {
	const root = makeSandbox(t);
	makeBinaryFixture(join(root, "fixtures", "pi-linux-x64.tar.gz"), { version: "1.0.0-fork.1" });
	const foreign = join(root, "prefix", "bin", "pi");
	mkdirSync(dirname(foreign), { recursive: true });
	writeFileSync(foreign, "#!/bin/sh\necho mine\n");
	chmodSync(foreign, 0o755);
	const result = runInstaller(root, installerEnv(root), []);
	assert.notEqual(result.status, 0);
	assert.equal(readFileSync(foreign, "utf8"), "#!/bin/sh\necho mine\n");
	assert.equal(existsSync(join(root, "prefix", "lib", "pi-fork")), false);
});

test("switching from an npm install to binary is refused with an uninstall hint", (t) => {
	const root = makeSandbox(t);
	makeBinaryFixture(join(root, "fixtures", "pi-linux-x64.tar.gz"), { version: "1.0.0-fork.1" });
	writeFileSync(join(root, "fixtures", "pi-fork.tgz"), "fixture-tarball");
	const env = installerEnv(root);
	// Establish an npm-owned install: the stub's install creates bin/pi and the
	// marker that makes `npm ls -g` succeed.
	assert.equal(runInstaller(root, { ...env, PI_INSTALL_METHOD: "npm" }, []).status, 0);
	const result = runInstaller(root, env, []);
	assert.notEqual(result.status, 0);
	const combined = `${result.stdout}${result.stderr}`;
	assert.match(combined, /--uninstall/);
	assert.equal(existsSync(join(root, "prefix", "lib", "pi-fork")), false);
});

test("downgrade warning fires when pinning below the installed version", (t) => {
	const root = makeSandbox(t);
	makeBinaryFixture(join(root, "fixtures", "pi-linux-x64.tar.gz"), { version: "9.9.9-fork.9" });
	const env = installerEnv(root);
	assert.equal(runInstaller(root, env, []).status, 0);
	const result = runInstaller(root, env, ["1.0.0-fork.1"]);
	assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
	assert.match(`${result.stdout}${result.stderr}`, /downgrade/);
});

test("a binary that fails its startup smoke test fails the install", (t) => {
	const root = makeSandbox(t);
	makeBinaryFixture(join(root, "fixtures", "pi-linux-x64.tar.gz"), { version: "1.0.0-fork.1", broken: true });
	const result = runInstaller(root, installerEnv(root), []);
	assert.notEqual(result.status, 0);
	assert.notEqual(`${result.stdout}${result.stderr}`.trim(), "");
});

test("--help exits 0 with usage", (t) => {
	const root = makeSandbox(t);
	const result = runInstaller(root, installerEnv(root), ["--help"]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /install\.sh/);
});

test("an invalid PI_INSTALL_METHOD value is a usage error", (t) => {
	const root = makeSandbox(t);
	const result = runInstaller(root, installerEnv(root, { method: "yes" }), []);
	assert.equal(result.status, 2);
});
