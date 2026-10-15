# Contributing

Thanks for helping improve `@qodalis/mcp-cli`.

## Layout

```
src/config.ts     environment configuration (QCLI_* / QODALIS_CLI_*)
src/env-file.ts   .env parser for --env-file / QCLI_ENV_FILE
src/remote.ts     connection to the server's MCP endpoint: sign-in, retry, tool-list cache
src/errors.ts     turns HTTP / network failures into actionable messages
src/filters.ts    read-only mode and the QCLI_TOOLS / QCLI_EXCLUDE lists
src/server.ts     the local MCP server (tools/list, tools/call)
src/cli.ts        the `mcp-cli` bin: args, env file, stdio, shutdown
tests/helpers     a fake Qodalis CLI server (MCP endpoint + sessions API) and test wiring
tests/unit        config, filters, errors and proxy behaviour
tests/e2e         the built CLI over stdio with the MCP client SDK
```

The MCP endpoint the proxy talks to is specified in the web-cli repository:
`docs/superpowers/specs/2026-10-15-mcp-and-api-tokens-design.md`.

## Development setup

```bash
git clone https://github.com/qodalis-solutions/mcp-cli.git
cd mcp-cli
npm install
npm run build
npm test            # needs the build for the stdio end-to-end tests
npm run typecheck
npm run check-format
```

Run the proxy from source against a server:

```bash
cp .env.example .env    # edit QCLI_URL and the credentials
npm run dev -- --env-file .env
```

## Tests

- Everything runs against the in-process fake server in
  `tests/helpers/fake-qcli-server.ts`; no real Qodalis server is needed.
- `tests/e2e` spawns `dist/src/cli.js`, so run `npm run build` first (the suite
  is skipped when the build is missing).
- Coverage thresholds are enforced by `npm run test:coverage`.
- `scripts/check-packed.sh` packs the package, installs the tarball outside the
  repo and runs the CLI. Run it before a release: inside the repo a missing
  dependency still resolves through `node_modules`.

## Conventions

- TypeScript, ESM, 4-space indentation, single quotes, Prettier (`npm run format`).
- Write the test first. Every behaviour change ships with a test that fails
  without it.
- The proxy has no tool-specific code: tools, schemas and annotations come from
  the server unchanged.
- Nothing may be written to stdout at runtime: it is the MCP transport. Log to
  stderr.
- Never log or return a token or password.

## Branches and releases

1. Work on `feature/*` branches and open pull requests into `develop`; CI runs
   format, build, typecheck, tests and the packed-install check.
2. Update `CHANGELOG.md` and bump `version` in `package.json`.
3. Merge `develop` into `main` (squash or rebase). Pushing to `main` publishes
   the version to npm if it is not there yet, with provenance. Authentication
   uses the organisation's `NPM_TOKEN` secret, or npm trusted publishing (OIDC)
   when the secret is absent.
