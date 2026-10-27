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
if QCLI_DEV_TOOLS=false ./node_modules/.bin/mcp-cli 2>/dev/null; then
    echo "expected a configuration error without QCLI_URL and dev tools" >&2
    exit 1
fi

# Developer mode (no QCLI_URL): the docs come from the bundled snapshot when the
# URL is unreachable, which proves docs/llms-full.txt is in the package.
reply="$(
    {
        echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}'
        echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
        echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"qcli_docs_search","arguments":{"query":"module"}}}'
        sleep 3
    } | QCLI_DOCS_URL=http://127.0.0.1:9/llms-full.txt ./node_modules/.bin/mcp-cli 2>/dev/null
)"
if ! grep -q 'source: bundled snapshot' <<<"$reply"; then
    echo "developer mode did not answer from the bundled docs snapshot:" >&2
    echo "$reply" >&2
    exit 1
fi
echo "packed install OK"
