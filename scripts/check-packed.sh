#!/usr/bin/env bash
# Packs the package and installs the tarball in a directory outside the repo,
# then runs the CLI. Inside the repo a missing dependency still resolves
# through node_modules; this is the only check that proves the published
# artefact can actually install and start.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cd "$root"
npm pack --pack-destination "$tmp" >/dev/null

cd "$tmp"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error ./*.tgz >/dev/null

version="$(./node_modules/.bin/mcp-cli --version)"
echo "mcp-cli: $version"
./node_modules/.bin/mcp-cli --help >/dev/null
if ./node_modules/.bin/mcp-cli 2>/dev/null; then
    echo "expected a configuration error without QCLI_URL" >&2
    exit 1
fi
echo "packed install OK"
