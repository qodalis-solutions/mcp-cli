# @qodalis/mcp-cli

A resilient [Model Context Protocol](https://modelcontextprotocol.io) server that
gives [Claude Code](https://code.claude.com) a [Qodalis CLI](https://cli.qodalis.com)
server: its CLI commands, files, data explorer, jobs and plugin tools.

Every Qodalis CLI server (.NET, Node or Python) can expose an MCP endpoint at
`<server>/api/qcli/mcp`. `mcp-cli` runs on your machine as a stdio MCP server
and proxies to that endpoint: Claude Code sees exactly the server's tools, with
the permissions of the account you configure. It handles sign-in, reconnects
after network drops and lets you narrow what the assistant may use.

## Highlights

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

```bash
npx -y @qodalis/mcp-cli --help
```

The server must have MCP enabled (`mcp` option; see
[MCP endpoint](https://cli.qodalis.com/docs/server-integration#mcp-endpoint)).
Default ports: .NET `8046`, Node `8047`, Python `8048`.

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

Pin a version in shared configs (`@qodalis/mcp-cli@0.1.0`) so an upgrade is a
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

## Configuration

Every setting is an environment variable. `QODALIS_CLI_*` names are accepted as
aliases for every key.

| Variable                  | Default  | Description                                                                                        |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `QCLI_URL`                | required | Server base URL, e.g. `https://cli.example.com` (a pasted `…/api/qcli/mcp` URL is accepted).       |
| `QCLI_TOKEN`              | none     | API token (`token create` in the web CLI) or the server's static `mcp.token`.                      |
| `QCLI_USER`               | none     | Sign in with this user name instead of a token (needs `QCLI_PASSWORD`).                            |
| `QCLI_PASSWORD`           | none     | Password for `QCLI_USER`. Never logged.                                                            |
| `QCLI_READ_ONLY`          | `false`  | Expose and allow only tools annotated `readOnlyHint: true`. See [read-only mode](#read-only-mode). |
| `QCLI_TOOLS`              | all      | Comma-separated allow-list of tool names; a trailing `*` matches a prefix (`fs_*`).                |
| `QCLI_EXCLUDE`            | none     | Comma-separated deny-list, same syntax, applied after `QCLI_TOOLS`.                                |
| `QCLI_CONNECTION_TIMEOUT` | `8000`   | Milliseconds to wait for the TCP/TLS connection before reporting the server unreachable.           |
| `QCLI_REQUEST_TIMEOUT`    | `60000`  | Milliseconds a single request (`tools/list`, `tools/call`) may take.                               |
| `QCLI_TRUST_CERT`         | `false`  | Accept a self-signed TLS certificate.                                                              |
| `QCLI_ENV_FILE`           | none     | Path to a `.env` file (same as `--env-file`). Variables already set in the environment win.        |

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
| `QCLI_URL … is required` at startup                                           | The `env` block is missing or the variable name is misspelled; `npx -y @qodalis/mcp-cli --help` lists every variable.                                     |

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

## Development

```bash
npm install
npm run build
npm test             # unit tests and stdio end-to-end tests against a fake server (build first)
npm run typecheck
npm run check-format
npm run dev -- --env-file .env   # run from source
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Qodalis Solutions SRL
