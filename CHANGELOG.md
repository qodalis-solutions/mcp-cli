# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
