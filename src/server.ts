import { createRequire } from 'node:module';
import { ProtocolError, Server, type CallToolResult } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { PromptError } from './dev/prompts.js';
import type { DevTools } from './dev/tools.js';
import { RemoteError } from './errors.js';
import { isToolAllowed, type RemoteTool } from './filters.js';
import type { RemoteServer } from './remote.js';

const require = createRequire(import.meta.url);

/** package.json sits one level up from src/ and two levels up from dist/src/. */
const readPackageJson = (): { name: string; version: string } => {
    for (const candidate of ['../package.json', '../../package.json']) {
        try {
            return require(candidate) as { name: string; version: string };
        } catch {
            // try the next location
        }
    }
    return { name: '@qodalis/mcp-cli', version: '0.0.0' };
};

const packageJson = readPackageJson();

export const SERVER_NAME = packageJson.name;
export const SERVER_VERSION = packageJson.version;
export const WEBSITE_URL = 'https://github.com/qodalis-solutions/mcp-cli';

const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export const buildInstructions = (config: Config, dev = config.devTools): string =>
    [
        ...(config.url
            ? [
                  `Proxy to the Qodalis CLI server at ${config.url}.`,
                  "The server tools are the server's CLI commands and features (files, data explorer, jobs, plugins), limited by the permissions of the configured account.",
                  'Call server_info first to see the server version and which features are enabled.',
                  config.readOnly
                      ? 'Read-only mode: only tools marked read-only are available.'
                      : 'Tools that change data are available; check a tool’s description before calling it.',
                  'After a network or VPN interruption simply retry the call: the proxy reconnects automatically.',
              ]
            : ['Qodalis CLI plugin-development tools (developer mode: no server is configured).']),
        ...(dev
            ? [
                  'To build Qodalis CLI plugins (web terminal commands, or Node/.NET/Python server commands): search the guide with qcli_docs_search, read a topic with qcli_docs_read, get exact TypeScript declarations with qcli_api (e.g. ICliCommandProcessor, ICliExecutionContext, ICliModule) instead of guessing, and create a plugin project with qcli_scaffold_plugin. The prompts create-web-plugin and create-server-command walk through the whole task.',
              ]
            : []),
    ].join('\n');

const errorResult = (message: string): CallToolResult => ({
    content: [{ text: message, type: 'text' }],
    isError: true,
});

/** Why a tool the server knows is hidden by the client-side settings. */
const hiddenReason = (tool: RemoteTool, config: Config): string =>
    config.readOnly && tool.annotations?.readOnlyHint !== true
        ? `Tool ${tool.name} is not available: QCLI_READ_ONLY allows only read-only tools.`
        : `Tool ${tool.name} is not available: excluded by QCLI_TOOLS / QCLI_EXCLUDE.`;

export type ProxyServerOptions = {
    /** Plugin-development tools, prompts and docs resources served locally */
    dev?: DevTools | undefined;
    log?: (message: string) => void;
};

const asProtocolError = (error: unknown): ProtocolError =>
    error instanceof ProtocolError
        ? error
        : new ProtocolError(INTERNAL_ERROR, (error as Error)?.message ?? String(error));

/**
 * The local MCP server Claude Code talks to over stdio: `tools/list` returns the
 * remote tools (unchanged) that pass the client-side filters, `tools/call` is forwarded.
 * With `options.dev` it also serves the `qcli_*` plugin-development tools (listed
 * first, same filters), the prompts and the docs topics as resources; without a
 * `remote` (no QCLI_URL) it serves only those.
 */
export const createProxyServer = (
    remote: RemoteServer | undefined,
    config: Config,
    options: ProxyServerOptions = {},
): Server => {
    const dev = options.dev;
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION, websiteUrl: WEBSITE_URL },
        {
            capabilities: {
                tools: { listChanged: false },
                ...(dev
                    ? { prompts: { listChanged: false }, resources: { listChanged: false } }
                    : {}),
            },
            instructions: buildInstructions(config, dev !== undefined),
        },
    );

    server.setRequestHandler('tools/list', async () => {
        const local = dev?.tools() ?? [];
        if (!remote) {
            return { tools: local };
        }
        try {
            const tools = await remote.listTools();
            const remoteTools = tools.filter(
                (tool) => isToolAllowed(tool, config) && !dev?.has(tool.name),
            );
            return { tools: [...local, ...remoteTools] };
        } catch (error) {
            if (local.length > 0) {
                // The local tools stay usable while the server is unreachable.
                options.log?.(
                    `tools/list: ${(error as Error)?.message}; listing the local tools only`,
                );
                return { tools: local };
            }
            throw asProtocolError(error);
        }
    });

    server.setRequestHandler('tools/call', async (request, ctx) => {
        const params = request.params;
        if (dev?.has(params.name)) {
            const hidden = dev.hiddenReason(params.name);
            if (hidden) {
                throw new ProtocolError(INVALID_PARAMS, hidden);
            }
            return dev.call(params.name, params.arguments ?? {}, ctx.mcpReq?.signal);
        }
        if (!remote) {
            throw new ProtocolError(
                INVALID_PARAMS,
                `Unknown tool: ${params.name} (developer mode: set QCLI_URL to use a server's tools).`,
            );
        }
        try {
            const tool = await remote.findTool(params.name);
            if (!tool) {
                throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${params.name}`);
            }
            if (!isToolAllowed(tool, config)) {
                throw new ProtocolError(INVALID_PARAMS, hiddenReason(tool, config));
            }
            return await remote.callTool(
                { arguments: params.arguments ?? {}, name: params.name },
                ctx.mcpReq?.signal,
            );
        } catch (error) {
            if (error instanceof ProtocolError) {
                throw error;
            }
            if (error instanceof RemoteError) {
                return errorResult(error.message);
            }
            return errorResult((error as Error)?.message ?? String(error));
        }
    });

    if (dev) {
        server.setRequestHandler('prompts/list', async () => ({ prompts: dev.prompts() }));
        server.setRequestHandler('prompts/get', async (request) => {
            try {
                return dev.getPrompt(request.params.name, request.params.arguments);
            } catch (error) {
                throw error instanceof PromptError
                    ? new ProtocolError(INVALID_PARAMS, error.message)
                    : asProtocolError(error);
            }
        });
        server.setRequestHandler('resources/list', async () => {
            try {
                return { resources: await dev.resources() };
            } catch (error) {
                throw asProtocolError(error);
            }
        });
        server.setRequestHandler('resources/read', async (request) => {
            const uri = request.params.uri;
            const markdown = await dev.readResource(uri).catch((error: unknown) => {
                throw asProtocolError(error);
            });
            if (markdown === undefined) {
                throw new ProtocolError(INVALID_PARAMS, `Unknown resource: ${uri}`);
            }
            return { contents: [{ mimeType: 'text/markdown', text: markdown, uri }] };
        });
    }

    return server;
};
