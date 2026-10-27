#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, describeConfig, ENV_FILE_VARIABLES, loadConfig } from './config.js';
import { DevTools } from './dev/tools.js';
import { applyEnvFile } from './env-file.js';
import { RemoteServer } from './remote.js';
import { createProxyServer, SERVER_NAME, SERVER_VERSION } from './server.js';

const SHUTDOWN_GRACE_MS = 5000;

const usage = `Plugin-development tools for Qodalis CLI (docs search, API declarations, plugin
scaffolding) and a proxy to a Qodalis CLI server's MCP endpoint (<QCLI_URL>/api/qcli/mcp).
Without QCLI_URL it runs in developer mode: only the plugin-development tools.
Configuration is read from the environment (QCLI_* or QODALIS_CLI_* names):
  QCLI_URL                         server base URL, e.g. http://localhost:8047 (optional)
  QCLI_TOKEN                       API token (token create in the web CLI) or the server's mcp token
  QCLI_USER, QCLI_PASSWORD         sign in with a password instead (signs in again on 401)
  QCLI_READ_ONLY (false)           only tools the server marks read-only
  QCLI_TOOLS                       comma-separated allow-list of tool names (trailing * allowed)
  QCLI_EXCLUDE                     comma-separated deny-list, applied after QCLI_TOOLS
  QCLI_CONNECTION_TIMEOUT (8000 ms)  QCLI_REQUEST_TIMEOUT (60000 ms)
  QCLI_TRUST_CERT (false)          accept a self-signed TLS certificate
  QCLI_ENV_FILE                    path to a .env file (same as --env-file)
  QCLI_DEV_TOOLS (true)            the qcli_* plugin-development tools, prompts and docs resources
  QCLI_DOCS_URL                    plugin docs (default https://cli.qodalis.com/llms-full.txt)
`;

const log = (message: string): void => {
    // Anything written to stdout corrupts the JSON-RPC stream: all logging goes to stderr.
    process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
};

const parseArgs = (argv: string[]): { envFile?: string } => {
    const result: { envFile?: string } = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            process.stdout.write(
                `Usage: mcp-cli [--env-file <path>] [--help] [--version]\n\n${usage}`,
            );
            process.exit(0);
        }
        if (arg === '--version' || arg === '-v') {
            process.stdout.write(`${SERVER_VERSION}\n`);
            process.exit(0);
        }
        if (arg === '--env-file') {
            const value = argv[i + 1];
            if (!value) {
                throw new ConfigError('--env-file requires a path.');
            }
            result.envFile = value;
            i++;
            continue;
        }
        throw new ConfigError(`Unknown argument "${arg}".`);
    }
    return result;
};

const main = (): void => {
    try {
        const args = parseArgs(process.argv.slice(2));
        const envFile =
            args.envFile ?? ENV_FILE_VARIABLES.map((name) => process.env[name]).find(Boolean);
        if (envFile) {
            applyEnvFile(envFile, process.env);
        }
        const config = loadConfig(process.env);
        if (config.trustCert) {
            log('QCLI_TRUST_CERT=true: TLS certificates are not verified');
        }
        if (!config.url && config.auth.kind !== 'none') {
            log('QCLI_TOKEN / QCLI_USER are set but QCLI_URL is not: no server is used');
        }
        const remote = config.url
            ? new RemoteServer(config, {
                  clientInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                  log,
              })
            : undefined;
        const dev = config.devTools ? new DevTools(config, { log }) : undefined;
        const handle = serveStdio(() => createProxyServer(remote, config, { dev, log }), {
            onerror: (error) => log(`transport error: ${error.message}`),
        });
        log(
            `v${SERVER_VERSION} ready for ${describeConfig(config)}${remote ? '; connects on first use' : ''}`,
        );

        let shuttingDown = false;
        const shutdown = async (reason: string): Promise<void> => {
            if (shuttingDown) {
                return;
            }
            shuttingDown = true;
            log(`shutting down (${reason})`);
            setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
            await handle.close().catch(() => undefined);
            await remote?.close();
            process.exit(0);
        };
        process.once('SIGINT', () => void shutdown('SIGINT'));
        process.once('SIGTERM', () => void shutdown('SIGTERM'));
        process.stdin.once('end', () => void shutdown('stdin closed'));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`fatal: ${message}`);
        process.exit(1);
    }
};

main();
