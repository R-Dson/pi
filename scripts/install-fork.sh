#!/bin/sh
# Installs the pi fork from GitHub Releases; no registry configuration or PAT needed.
# Usage: install-fork.sh [version]  (empty version = latest release)
set -eu

repo="R-Dson/pi"

# Best-effort semver compare for the downgrade warning: exits 0 when $1 > $2.
# Handles x.y.z with an optional -fork.N prerelease (x.y.z > x.y.z-fork.N).
# Unparseable input compares as not-greater; the check is advisory only.
semver_gt() {
  awk 'function norm(v,  parts, base, pre, fields, out, i) {
    sub(/^v/, "", v)
    split(v, parts, "-")
    base = parts[1]
    pre = (parts[2] == "" ? "" : parts[2])
    split(base, fields, ".")
    for (i = 1; i <= 3; i++) out = out sprintf("%012d", fields[i] + 0)
    if (pre == "") return out "2"
    if (pre ~ /^fork\.[0-9]+$/) return out "1" sprintf("%012d", substr(pre, 6) + 0)
    return out "0" pre
  }
  BEGIN { exit !(norm(ARGV[1]) > norm(ARGV[2])) }' "$1" "$2"
}

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm not found. Install Node.js >= 22 first (https://nodejs.org)." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl not found." >&2
  exit 1
fi

if [ "$#" -gt 0 ]; then
  version="$1"
  # Accept both "0.84.2-fork.2" and "v0.84.2-fork.2"; reject anything that
  # cannot name a release tag, so a typo cannot produce a mangled URL.
  version="${version#v}"
  if ! echo "$version" | grep -Eq '^[0-9A-Za-z._-]+$'; then
    echo "error: invalid version: $1" >&2
    exit 1
  fi
  url="https://github.com/${repo}/releases/download/v${version}/pi-fork.tgz"
else
  url="https://github.com/${repo}/releases/latest/download/pi-fork.tgz"
fi

# Warn before downgrading: a typo naming an older real release must not
# quietly replace a newer install. Warning only, never a prompt (the script
# runs under `curl | sh` with no tty guarantee), so downgrades stay possible.
# The latest path needs no check: releases/latest always serves the newest
# complete release.
if [ "$#" -gt 0 ] && command -v pi >/dev/null 2>&1; then
  installed="$(pi --version 2>/dev/null || true)"
  if [ -n "$installed" ] && semver_gt "$installed" "$version"; then
    echo "warning: downgrade requested: pi ${installed} is installed, but version ${version} was asked for." >&2
    echo "  To keep ${installed}, re-run with: sh -s ${installed} (or omit the version to track the latest release)." >&2
  fi
fi

# Keep the .tgz suffix: npm infers tarball-vs-directory from the file name.
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Downloading ${url}"
curl -fsSL "$url" -o "$tmpdir/pi-fork.tgz"
npm install -g --ignore-scripts "$tmpdir/pi-fork.tgz"

# Best-effort report: the current shell may not have npm's bin dir on PATH yet.
if command -v pi >/dev/null 2>&1; then
  echo "Installed pi $(pi --version 2>/dev/null || echo '(version unknown)')"
fi
echo "Re-run this script any time to upgrade."
