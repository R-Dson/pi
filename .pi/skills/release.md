---
name: release
description: Prepare, publish, verify, and recover Pi Fork releases. Use for release preparation, local release smoke tests, dispatching the Fork Release workflow, and failed release runs.
---

# Releasing Pi Fork

Run repository commands from the repo root (two directories above this skill), unless instructed otherwise.

**Versioning**: fork releases are `<upstream-version>-fork.<run number>`, computed at publish time from `packages/coding-agent/package.json` plus the Fork Release workflow's run number. Repo versions follow upstream via syncs; a release never bumps versions, edits changelog sections, commits, or tags locally. Do not run `npm run release:patch`/`release:minor` here: they implement upstream's tag-triggered npmjs.org flow, which this fork disabled (see the ledger's `build-binaries.yml` row).

1. **Audit CHANGELOGs**: every commit since the last release needs a matching `[Unreleased]` entry in the package it touched. Run the `/cl` prompt on the latest commit on `main`; if that is not available, audit by hand (`git log <last-release-commit>..HEAD` against each package's changelog) before dispatching.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

   Load and follow [interactive-testing.md](interactive-testing.md) for the tmux workflow. Start each release binary from `/tmp`, not the repo root.

3. **Dispatch the release**:
   ```bash
   gh workflow run fork-release.yml --repo R-Dson/pi --ref main
   ```
   The workflow publishes all `@r-dson/*` packages to the GitHub Packages npm registry, tags `v<upstream-version>-fork.<run>`, and creates the GitHub Release (titled `Pi Fork <tag>`) with the `pi-fork.tgz` standalone asset. The version is checked against existing tags before anything publishes, so a collision fails while the run is still retryable.

4. **Verify**: watch the run to green (`gh run watch <id> --repo R-Dson/pi`), then confirm the release is marked Latest and carries `pi-fork.tgz`. Failure recovery: a run that failed before publishing can be rerun (`gh run rerun <id>` — the version is still free); a run that failed after publishing cannot, because the rerun keeps the same run number and trips the tag-free guard by design, so dispatch fresh instead (the new run number yields a new version).
