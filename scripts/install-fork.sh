#!/bin/sh
# Installs the pi fork from GitHub Releases; no registry configuration or PAT needed.
# Usage: install-fork.sh [version]  (empty version = latest release)
set -eu

repo="R-Dson/pi"

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
