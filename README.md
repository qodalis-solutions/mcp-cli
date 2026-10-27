# @qodalis/mcp-cli

A [Model Context Protocol](https://modelcontextprotocol.io) server that helps
[Claude Code](https://code.claude.com) **build [Qodalis CLI](https://cli.qodalis.com) plugins** (docs search, exact API
declarations, scaffolding) and gives it the commands, files, data explorer, jobs and plugin tools of a running
Qodalis CLI server through a resilient proxy.

[![npm](https://img.shields.io/npm/v/@qodalis/mcp-cli)](https://www.npmjs.com/package/@qodalis/mcp-cli)
[![Build & Test](https://github.com/qodalis-solutions/mcp-cli/actions/workflows/build.yml/badge.svg)](https://github.com/qodalis-solutions/mcp-cli/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`mcp-cli` runs on your machine as a stdio MCP server in one of two modes:

- **Developer mode** (no `QCLI_URL`): the [plugin-development tools](#plugin-development) only. No server needed.
- **Server mode** (`QCLI_URL` set): the same tools plus a proxy to the server's MCP endpoint
  (`<server>/api/qcli/mcp`): Claude Code sees exactly the server's tools, with the permissions of the account you
  configure. It handles sign-in, reconnects after network drops and lets you narrow what the assistant may use.

## Where it fits

| Repository                                                                                                                                                                                                                        | Role                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [web-cli](https://github.com/qodalis-solutions/web-cli)                                                                                                                                                                           | The browser terminal (Angular, React, Vue) and its plugins, including `token create` for API tokens |
| [cli-server-node](https://github.com/qodalis-solutions/cli-server-node), [cli-server-dotnet](https://github.com/qodalis-solutions/cli-server-dotnet), [cli-server-python](https://github.com/qodalis-solutions/cli-server-python) | The servers that host the MCP endpoint                                                              |
| [cli-server-dashboard](https://github.com/qodalis-solutions/cli-server-dashboard)                                                                                                                                                 | Admin dashboard served by the servers                                                               |
| [pwa-cli](https://github.com/qodalis-solutions/pwa-cli)                                                                                                                                                                           | The CLI as a PWA and Android app                                                                    |
| **mcp-cli**                                                                                                                                                                                                                       | This repository: the bridge from Claude Code to a server                                            |

## Highlights

- **Plugin development built in.** Search the plugin guide, read the exact
  TypeScript declarations of `@qodalis/cli-core` and scaffold a plugin, with
  prompts that walk the assistant through a web plugin or a server command.
- **No tool-specific code.** Tools come from the server's `tools/list` and are
  passed through unchanged (names, schemas, annotations); calls are forwarded.
  New commands on the server show up without updating the proxy.
- **Token or password.** Use an API token (`QCLI_TOKEN`), or sign in with
  `QCLI_USER` / `QCLI_PASSWORD`; an expired session is renewed automatically on
  the next call.
- **Read-only mode** (`QCLI_READ_ONLY=true`) exposes only the tools the server
  marks read-only, and refuses calls to anything else.
- **Client-side allow and deny lists** (`QCLI_TOOLS`, `QCLI_EXCLUDE`, trailing
  `*` allowed) on top of the server's own permissions.
- **Self-healing connection.** It connects on first use, never caches a failed
  connect, retries once when the connection drops, and fails fast (8 s) when the
  server is unreachable, with a message that says what to check.
- **Clear errors**: a rejected token, MCP not enabled on the server, a missing
  permission or an unreachable host each come back as one actionable sentence.

## Quick start

For plugin development, nothing else is needed:

```bash
claude mcp add qcli -- npx -y @qodalis/mcp-cli
```

Then ask, for example, _"Create a Qodalis CLI plugin that converts temperatures"_ or run the
`/mcp__qcli__create-web-plugin` prompt. See [Plugin development](#plugin-development).

To also reach a running server, add `QCLI_URL` and credentials as described below.

```bash
npx -y @qodalis/mcp-cli --help
```

The server must have MCP enabled (default ports: .NET `8046`, Node `8047`, Python `8048`):

| Server | Enable MCP                                     |
| ------ | ---------------------------------------------- |
| Node   | `createCliServer({ mcp: true })`               |
| Python | `CliServerOptions(mcp=True)`                   |
| .NET   | `builder.Services.AddCli(cli => cli.AddMcp())` |

Each also takes options (tool allow/deny lists, a static token, instructions); see
[MCP endpoint](https://cli.qodalis.com/docs/server-integration#mcp-endpoint).

### Claude Code

```bash
claude mcp add qcli -- npx -y @qodalis/mcp-cli
```

then set the environment in `~/.claude.json`:

```json
{
  "mcpServers": {
    "qcli": {
      "command": "npx",
      "args": ["-y", "@qodalis/mcp-cli"],
      "env": {
        "QCLI_URL": "http://localhost:8047",
        "QCLI_TOKEN": "qcli_pat_..."
      }
    }
  }
}
```

or sign in with a user name and password instead of a token:

```json
"env": {
  "QCLI_URL": "http://localhost:8047",
  "QCLI_USER": "ops",
  "QCLI_PASSWORD": "********"
}
```

The same in one command, with `-e` flags:

```bash
claude mcp add qcli -e QCLI_URL=http://localhost:8047 -e QCLI_TOKEN=qcli_pat_... -- npx -y @qodalis/mcp-cli
```

Add `--scope user` to make it available in every project. With
`--scope project` the entry goes into the project's `.mcp.json`, which is
usually committed: keep the secret out of it with
`"QCLI_TOKEN": "${QCLI_TOKEN}"` and set the variable in your shell. A `.env`
file works too:

```json
{ "command": "npx", "args": ["-y", "@qodalis/mcp-cli", "--env-file", "/path/to/.env"] }
```

Pin a version in shared configs (`@qodalis/mcp-cli@0.2.0`) so an upgrade is a
deliberate change.

### Getting a token

In the web CLI connected to the server (users plugin), signed in as the account
the assistant should act as:

```bash
token create claude --expires=90
# token create claude --permissions=commands:execute,files:read   (narrower scope)
```

The token (`qcli_pat_…`) is shown once. Without the web CLI, sign in and create
one with curl:

```bash
SESSION=$(curl -s http://localhost:8047/api/v1/qcli/sessions \
  -H 'Content-Type: application/json' -d '{"username":"ops","password":"..."}' | jq -r .token)
curl -s http://localhost:8047/api/v1/qcli/tokens -H "Authorization: Bearer $SESSION" \
  -H 'Content-Type: application/json' -d '{"name":"claude","expiresInDays":90}' | jq -r .token
curl -s -X DELETE http://localhost:8047/api/v1/qcli/sessions/current -H "Authorization: Bearer $SESSION"
```

A server **without** the users plugin protects its endpoint with a static token
(its `mcp.token` option): put that value in `QCLI_TOKEN`. If it sets none, the
endpoint is open and no auth variable is needed.

## Plugin development

These tools are served locally and work without a server (developer mode) or next to
a server's tools. Turn them off with `QCLI_DEV_TOOLS=false`.

```bash
claude mcp add qcli -- npx -y @qodalis/mcp-cli                 # developer mode
claude mcp add qcli --scope user -- npx -y @qodalis/mcp-cli    # in every project
```

### Tools

| Tool                   | Arguments                                              | What it does                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qcli_docs_search`     | `query`, `limit?` (default 5, max 20)                  | Ranked topics of the plugin guide as `Section › Topic`, with their summary and an excerpt.                                                                                                                                      |
| `qcli_docs_read`       | `topic`                                                | A topic in full (heading match, case-insensitive; `Section › Topic` when a heading is in several sections), or a whole section (`Web plugins`). Lists the topics when nothing matches.                                          |
| `qcli_api`             | `symbol`, `package?` (default `@qodalis/cli-core`)     | The TypeScript declaration of an interface, type, class, function, enum or constant, with its JSDoc and the related declarations to look up next. `package` takes any `@qodalis/*` package (`cli` is short for `@qodalis/cli`). |
| `qcli_scaffold_plugin` | `name`, `description?`, `processorName?`, `directory?` | Runs `npx -y @qodalis/create-cli-plugin@latest` and returns the created files and next steps. Inside a web-cli checkout it creates `packages/plugins/<name>`; elsewhere a standalone `qodalis-cli-<name>` project.              |

Where the data comes from:

- **Docs**: [`https://cli.qodalis.com/llms-full.txt`](https://cli.qodalis.com/llms-full.txt)
  (`QCLI_DOCS_URL`), cached for an hour. When it cannot be fetched, the last
  download is reused, else the snapshot bundled in the package
  (`docs/llms-full.txt`), so the tools work offline.
- **API declarations**: the project's `node_modules` (the MCP server's working
  directory and its parents) when the package is installed there, so the answer
  matches the version you build against. Otherwise the `latest` version on npm,
  downloaded from jsDelivr (unpkg as fallback) and cached in memory and in
  `<tmp>/qodalis-mcp-cli`; offline, the newest cached version is used.
- **Scaffolding**: validates the name (lowercase letters, digits and hyphens, no
  `cli-` prefix), refuses an existing target directory, runs without a TTY and
  stops after 5 minutes. The standalone project installs its dependencies.

### Prompts

| Prompt                  | Arguments                                          | Walks the assistant through                                                                                                             |
| ----------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `create-web-plugin`     | `name`, `description`                              | Reading the guide, looking up the contracts with `qcli_api`, scaffolding, implementing the processor and module, tests, registering it. |
| `create-server-command` | `language` (`node`, `dotnet`, `python`), `command` | Adding a command processor to a Node, .NET or Python server, registering it and testing it.                                             |

In Claude Code they appear as `/mcp__qcli__create-web-plugin` and
`/mcp__qcli__create-server-command`. The docs topics are also MCP resources
(`qcli-docs://<section>/<topic>`), which Claude Code can attach with `@`.

### Example requests

- _"Search the Qodalis plugin docs for reading user input."_ → `qcli_docs_search`
- _"Show me ICliExecutionContext."_ → `qcli_api { "symbol": "ICliExecutionContext" }`
- _"Which options does CliEngine take?"_ → `qcli_api { "symbol": "CliEngine", "package": "cli" }`
- _"Scaffold a plugin called json-tools."_ → `qcli_scaffold_plugin { "name": "json-tools" }`

### Filters and read-only mode

The dev tools are tools like any other: `QCLI_TOOLS` and `QCLI_EXCLUDE` apply to
them (`QCLI_EXCLUDE=qcli_scaffold_plugin`, or `QCLI_TOOLS=qcli_*` for the dev
tools alone), and `QCLI_READ_ONLY=true` hides and refuses `qcli_scaffold_plugin`
(the docs and API tools are read-only). A server tool with the same name as a dev
tool is hidden. When the server is unreachable, `tools/list` still returns the
dev tools.

## Configuration

Every setting is an environment variable. `QODALIS_CLI_*` names are accepted as
aliases for every key.

| Variable                  | Default                                 | Description                                                                                                              |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `QCLI_URL`                | none                                    | Server base URL, e.g. `https://cli.example.com` (a pasted `…/api/qcli/mcp` URL is accepted). Without it: developer mode. |
| `QCLI_TOKEN`              | none                                    | API token (`token create` in the web CLI) or the server's static `mcp.token`.                                            |
| `QCLI_USER`               | none                                    | Sign in with this user name instead of a token (needs `QCLI_PASSWORD`).                                                  |
| `QCLI_PASSWORD`           | none                                    | Password for `QCLI_USER`. Never logged.                                                                                  |
| `QCLI_READ_ONLY`          | `false`                                 | Expose and allow only tools annotated `readOnlyHint: true`. See [read-only mode](#read-only-mode).                       |
| `QCLI_TOOLS`              | all                                     | Comma-separated allow-list of tool names; a trailing `*` matches a prefix (`fs_*`).                                      |
| `QCLI_EXCLUDE`            | none                                    | Comma-separated deny-list, same syntax, applied after `QCLI_TOOLS`.                                                      |
| `QCLI_CONNECTION_TIMEOUT` | `8000`                                  | Milliseconds to wait for the TCP/TLS connection before reporting the server unreachable.                                 |
| `QCLI_REQUEST_TIMEOUT`    | `60000`                                 | Milliseconds a single request (`tools/list`, `tools/call`) may take.                                                     |
| `QCLI_TRUST_CERT`         | `false`                                 | Accept a self-signed TLS certificate.                                                                                    |
| `QCLI_ENV_FILE`           | none                                    | Path to a `.env` file (same as `--env-file`). Variables already set in the environment win.                              |
| `QCLI_DEV_TOOLS`          | `true`                                  | The `qcli_*` plugin-development tools, prompts and docs resources. `false` requires `QCLI_URL`.                          |
| `QCLI_DOCS_URL`           | `https://cli.qodalis.com/llms-full.txt` | Where the plugin guide is fetched from (falls back to the bundled snapshot).                                             |

Set either `QCLI_TOKEN` or `QCLI_USER` + `QCLI_PASSWORD`, not both.

## Tools

The tools are whatever the server exposes to your account. A typical server
offers:

| Tools                                                                | Available when                         |
| -------------------------------------------------------------------- | -------------------------------------- |
| `server_info`                                                        | always: version, enabled features      |
| one tool per CLI command (`weather`, `weather_current`, ...)         | always                                 |
| `fs_list`, `fs_stat`, `fs_read`, `fs_write`, `fs_mkdir`, `fs_delete` | the server's filesystem API is enabled |
| `data_sources`, `data_schema`, `data_query`                          | the data explorer is enabled           |
| `jobs_list`, `jobs_get`, `jobs_history`, `jobs_trigger`, ...         | the jobs plugin is installed           |
| plugin tools                                                         | a server plugin contributes them       |

Each one is limited by the account's permissions on the server (for example
`commands:execute`, `files:read` / `files:write`, `data:query`, `jobs:manage`),
and by the token's scope when it was created with `--permissions`.

## Read-only mode

With `QCLI_READ_ONLY=true` the proxy lists only the tools the server annotates
`readOnlyHint: true` (such as `server_info`, `fs_list`, `fs_read`,
`data_schema`, `jobs_list`) and refuses calls to any other tool before they
reach the server. Command tools carry no read-only annotation, so they are
hidden in this mode; add the ones you want with a separate, non-read-only entry
and `QCLI_TOOLS`.

The filter is defence in depth. The real boundary is the account: give the
assistant a user (or a token scope) with only the permissions it should have.

## Several servers

Add one entry per server (and per access level) with a distinct name:

```json
{
  "mcpServers": {
    "qcli-dev": {
      "command": "npx",
      "args": ["-y", "@qodalis/mcp-cli"],
      "env": { "QCLI_URL": "http://localhost:8047", "QCLI_TOKEN": "qcli_pat_dev..." }
    },
    "qcli-prod": {
      "command": "npx",
      "args": ["-y", "@qodalis/mcp-cli"],
      "env": {
        "QCLI_URL": "https://cli.example.com",
        "QCLI_TOKEN": "qcli_pat_prod...",
        "QCLI_READ_ONLY": "true"
      }
    },
    "qcli-prod-jobs": {
      "command": "npx",
      "args": ["-y", "@qodalis/mcp-cli"],
      "env": {
        "QCLI_URL": "https://cli.example.com",
        "QCLI_TOKEN": "qcli_pat_prod...",
        "QCLI_TOOLS": "jobs_*,server_info",
        "QCLI_EXCLUDE": "jobs_cancel"
      }
    }
  }
}
```

## Troubleshooting

`claude mcp list` shows whether each server connects; inside a session `/mcp`
shows its status and tools and lets you reconnect. The proxy logs to stderr
(`claude --debug` shows it).

| Message                                                                       | What to do                                                                                                                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `… answered 401 (not authenticated): QCLI_TOKEN is wrong, expired or revoked` | Create a new token (`token create claude`) and update `QCLI_TOKEN`. `token list` in the web CLI shows expiry dates.                                       |
| `… rejected QCLI_USER / QCLI_PASSWORD`                                        | Check the credentials; the account may be disabled or locked out after failed sign-ins.                                                                   |
| `… answered 403 …`                                                            | The account lacks `commands:execute`, or the server rejected the request origin.                                                                          |
| `MCP is not enabled on this server (enable the mcp option)`                   | Turn on the server's `mcp` option and restart it; check `QCLI_URL` (base URL, not a page of the web app).                                                 |
| `Cannot reach … Check QCLI_URL / VPN.`                                        | The server is down, the URL or port is wrong, or the VPN is disconnected. Retry the call once it is back: the proxy reconnects by itself.                 |
| `… did not answer within 60000 ms`                                            | A slow command; raise `QCLI_REQUEST_TIMEOUT`.                                                                                                             |
| A tool is missing                                                             | The account (or token scope) lacks its permission, the feature is not enabled on the server, or `QCLI_READ_ONLY` / `QCLI_TOOLS` / `QCLI_EXCLUDE` hide it. |
| `Nothing to serve: set QCLI_URL …` at startup                                 | `QCLI_DEV_TOOLS=false` without `QCLI_URL`: set the URL (check the variable name; `npx -y @qodalis/mcp-cli --help` lists every variable).                  |
| Only the `qcli_*` tools are listed                                            | No `QCLI_URL` (developer mode), or the server is unreachable: the log says which.                                                                         |

## How reconnection works

1. The proxy connects to the endpoint on the first `tools/list` or
   `tools/call`, not at startup, so Claude Code starts even when the server is
   down.
2. A failed connect is not cached: the next call tries again.
3. A connection-level error (refused, reset, socket closed, DNS failure) drops
   the connection and retries the request once on a fresh one. A connect timeout
   is not retried, so an unreachable host fails within `QCLI_CONNECTION_TIMEOUT`.
4. With `QCLI_USER` / `QCLI_PASSWORD`, a 401 signs in again and retries once.
5. The tool list is cached for 60 s; a call to a tool the proxy does not know
   yet refreshes it first, so new server commands work without a restart.

## Security notes

- Tokens and passwords are read from the environment, sent only to `QCLI_URL`,
  and never written to logs or tool results.
- Prefer an API token with a narrow `--permissions` scope and an expiry over a
  password; revoke it with `token revoke <id>` when it is no longer needed.
- Use `https://` for anything but `localhost`. `QCLI_TRUST_CERT=true` disables
  certificate verification for this process; use it only for self-signed
  certificates you control.
- Nothing is written to stdout except the MCP protocol stream.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Library use

The pieces are exported for embedding:

```ts
import { createProxyServer, loadConfig, RemoteServer } from '@qodalis/mcp-cli';

const config = loadConfig(process.env);
const remote = new RemoteServer(config, { clientInfo: { name: 'my-app', version: '1.0.0' } });
const server = createProxyServer(remote, config); // a low-level MCP Server: connect any transport
```

With the plugin-development tools (`remote` may be `undefined` for developer mode):

```ts
import { createProxyServer, DevTools, loadConfig } from '@qodalis/mcp-cli';

const config = loadConfig(process.env);
const server = createProxyServer(undefined, config, { dev: new DevTools(config) });
```

## Development

```bash
npm install
npm run build
npm test             # unit tests and stdio end-to-end tests against a fake server (build first)
npm run typecheck
npm run check-format
npm run dev -- --env-file .env   # run from source
npm run sync-docs                # refresh docs/llms-full.txt (from ../web-cli, a path/URL argument, or the site)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Qodalis Solutions SRL
