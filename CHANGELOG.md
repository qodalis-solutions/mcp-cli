# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-27

### Added

- Plugin-development tools, served locally: `qcli_docs_search` and
  `qcli_docs_read` over the plugin guide (`llms-full.txt` from
  `QCLI_DOCS_URL`, default https://cli.qodalis.com/llms-full.txt, cached for an
  hour, with a snapshot bundled in the package for offline use), `qcli_api`
  (TypeScript declarations of the `@qodalis/*` packages from the project's
  node_modules or the latest npm version) and `qcli_scaffold_plugin`
  (`@qodalis/create-cli-plugin`).
- MCP prompts `create-web-plugin` and `create-server-command`, and the docs
  topics as resources (`qcli-docs://<section>/<topic>`).
- `QCLI_DEV_TOOLS` (default `true`) and `QCLI_DOCS_URL`; `npm run sync-docs`
  refreshes the bundled docs snapshot.

### Changed

- `QCLI_URL` is optional: without it the server runs in developer mode with only
  the plugin-development tools. With it, the dev tools are listed before the
  server's tools, and still listed when the server is unreachable.
- `QCLI_READ_ONLY`, `QCLI_TOOLS` and `QCLI_EXCLUDE` apply to the dev tools too
  (read-only mode hides `qcli_scaffold_plugin`).
- `createProxyServer(remote, config, { dev })` accepts the dev tools and an
  `undefined` remote.

## [0.1.0] - 2026-10-15

### Added

- First release: a stdio MCP server that proxies Claude Code (or any MCP client)
  to a Qodalis CLI server's MCP endpoint (`<QCLI_URL>/api/qcli/mcp`). Tools are
  taken from the server's `tools/list` and passed through unchanged; calls are
  forwarded.
- Authentication with an API token or the server's static MCP token
  (`QCLI_TOKEN`), or with `QCLI_USER` / `QCLI_PASSWORD` (signs in again after a
  401).
- `QCLI_READ_ONLY`, `QCLI_TOOLS` and `QCLI_EXCLUDE` client-side tool filters.
- Resilience: connect on first use, failed connects are not cached, one retry on
  connection loss, fast failure (`QCLI_CONNECTION_TIMEOUT`) with actionable
  messages for unreachable servers, rejected credentials, missing permissions and
  MCP not enabled; 60 s tool-list cache refreshed for unknown tools.
- `QCLI_REQUEST_TIMEOUT`, `QCLI_TRUST_CERT`, `--env-file` / `QCLI_ENV_FILE`,
  `QODALIS_CLI_*` aliases, `--help`, `--version`.
