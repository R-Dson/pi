# Installing the Fork

The fork distributes `pi` from GitHub only. Every release attaches a self-contained npm tarball (`pi-fork.tgz`) and precompiled single-file binaries (`pi-<os>-<arch>.tar.gz`/`.zip`) to its GitHub Release, and publishes the individual workspace packages to the GitHub Packages registry under the `@r-dson` scope. Nothing is published to npmjs.org.

## Triggering a release

Releases are manual:

1. Open the repo's **Actions** tab and select **Fork Release**.
2. Click **Run workflow**, choose `main` as the branch (the workflow refuses to release from any other ref).
3. Optionally fill **Release version**. Leave it empty for the default `<upstream-version>-fork.<run number>` (for example `0.84.2-fork.42`).

The workflow builds the workspace, verifies the `v<version>` tag does not already exist (before anything is published, so a colliding version fails while the run is still retryable), stages every public package with its manifest rewritten to the fork scope, publishes to GitHub Packages, tags `v<version>`, builds the standalone tarball, compiles the platform binaries (their `package.json` stamped to `@r-dson/pi-standalone@<version>`, so `pi --version` and `pi update --self` identify binary installs as the fork's standalone channel), and creates the GitHub Release as a draft that is published and marked latest only after every asset is attached — `releases/latest/download/...` therefore never resolves to a release without its assets. It commits nothing: the only git object it produces is the tag, and the workspace — including the binary-manifest stamp — exists only on the ephemeral runner.

## Install (recommended: install script)

The install script is the zero-friction path. It is non-interactive (`curl | sh` gives no tty guarantee): every decision has a safe default and warnings name the command to run.

On darwin and linux (x64, arm64) it installs the prebuilt, self-contained binary — no Node.js, no npm; `curl` and `tar` are the only tools needed. The binary and its asset files land in `<prefix>/lib/pi-fork` with a symlink at `<prefix>/bin/pi`. Extensions and packages still work: the binary loads them as source (the loader and the pi APIs are compiled in), so a package manager is only needed to fetch third-party packages via `pi install`, never to run pi or dependency-free extensions. On other platforms, when no binary asset exists for the machine, or when the release predates binary assets, it falls back to the npm tarball path (which needs npm and Node >= 22.19 and installs `@r-dson/pi-standalone` with dependencies resolved from the public npm registry). `PI_INSTALL_METHOD=binary|npm` forces one path:

```sh
curl -fsSL https://raw.githubusercontent.com/R-Dson/pi/main/scripts/install.sh | sh
```

Pass a release version (with or without the leading `v`) to pin instead of tracking the latest:

```sh
curl -fsSL https://raw.githubusercontent.com/R-Dson/pi/main/scripts/install.sh | sh -s 0.84.2-fork.42
```

Prefix selection: `PI_INSTALL_PREFIX` chooses explicitly. Otherwise binary installs default to `~/.local`; npm installs prefer npm's global prefix when its bin directory is writable (excluding version-managed prefixes — mise/nvm/asdf/volta/fnm — where globals vanish on node switches) and fall back to `~/.local`. The script warns before a downgrade of the install it replaces, refuses to overwrite a `pi` it does not own, and refuses to switch install methods without an explicit `--uninstall` first. After installing it verifies the binary starts and tells you when PATH resolves `pi` somewhere else. `--uninstall` removes whichever flavor is present.

The direct npm URL form also works, but npm >= 12 blocks remote-tarball installs by default (`EALLOWREMOTE`), so it needs one opt-in flag:

```sh
npm install -g --allow-remote=all https://github.com/R-Dson/pi/releases/latest/download/pi-fork.tgz
```

A binary archive can also be fetched and unpacked by hand — extract it anywhere on PATH's reach and run `pi` from it; it carries everything it needs.

The binary is `pi`, same as upstream; the installed package is `@r-dson/pi-standalone` (the manifest inside the binary archives identifies itself the same way). Re-running any install command upgrades in place.

The asset filenames are identical across releases, so `releases/latest/download/...` always resolves to the newest release. Assets are served by GitHub Releases over TLS; npm-tarball dependencies come from the public npm registry only, so installing never touches GitHub authentication.

## Install via GitHub Packages

Secondary channel: use it when you want the individual `@r-dson/*` packages as libraries rather than just the CLI. Unlike the standalone tarball, this channel always requires a PAT (see below).

Map the fork scope to the GitHub Packages registry in your `.npmrc` (usually `~/.npmrc`):

```sh
echo '@r-dson:registry=https://npm.pkg.github.com' >> ~/.npmrc
```

Then install globally:

```sh
npm install -g @r-dson/pi-coding-agent
```

The binary is `pi`, same as upstream.

### Authentication (required)

GitHub Packages always authenticates npm requests, even for public packages — anonymous installs fail with `E401`. Create a [classic PAT](https://github.com/settings/tokens) with the `read:packages` scope (no expiration or a long one is fine; it is only read) and add it to the same `.npmrc`:

```
//npm.pkg.github.com/:_authToken=<PAT>
```

Note: OAuth tokens from `gh auth login` are rejected by the npm registry; it must be a PAT.

## What gets published

- All public workspace packages (9 total), renamed `@earendil-works/X` → `@r-dson/X`. The rename happens at publish time only; repo manifests stay identical to upstream so merges stay clean.
- Inter-package dependencies are rewritten to the `@r-dson` scope and pinned to the exact release version, so a fork install cannot accidentally resolve upstream `@earendil-works` packages from npmjs.org.
- `pi-fork.tgz`, the standalone tarball: a `@r-dson/pi-standalone` package assembled from the coding-agent bundle. Its manifest is derived mechanically from `packages/coding-agent/package.json` — dependencies minus the `@earendil-works/*` entries (verbatim pins), `optionalDependencies`, `overrides`, and `engines` copied — so there is no curated dependency list to keep in sync.
- `pi-<os>-<arch>.tar.gz`/`.zip` for darwin/linux/windows x64/arm64: single-file binaries compiled with `bun build --compile` by `scripts/build-binaries.sh`, packaged with the runtime asset files (themes, wasm, native prebuilds, docs). The `package.json` inside each archive is stamped to `@r-dson/pi-standalone@<version>` so a binary install reports the fork version and `pi update --self` classifies it as the fork's standalone channel instead of the upstream npm package.
- `npm-shrinkwrap.json` and `install-lock` are excluded from registry publishes: the shrinkwrap pins `@earendil-works/*` names that do not exist on the fork registry. Dependency integrity is partial by design: direct dependencies are pinned exactly in the rewritten manifests, the carried `overrides` block pins the known-bad transitives (`protobufjs`, `rimraf`), and no shrinkwrap ships, so full transitive resolution is npm's.
- Staging also drops `node_modules`, `src`, `test`, and dotfiles; the staged `.npmrc` is written by the publish script itself.

## Versioning scheme

- Lockstep, like upstream: every fork release publishes all packages at one version.
- Default version: `<upstream-version>-fork.<workflow run number>`, for example `0.84.2-fork.42`. The prerelease suffix keeps fork versions distinguishable from upstream releases of the same base.
- Explicit version: pass it in the workflow's **Release version** input (must match `x.y.z` with an optional `-prerelease`).
- Each release tags `v<version>` and creates a GitHub Release with `pi-fork.tgz` and the binary assets attached under stable names; re-running the workflow for an already-published version skips the existing packages.
