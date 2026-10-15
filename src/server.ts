import { createRequire } from 'node:module';
import { ProtocolError, Server, type CallToolResult } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
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

export const buildInstructions = (config: Config): string =>
    [
        `Proxy to the Qodalis CLI server at ${config.url}.`,
        "The tools are the server's CLI commands and features (files, data explorer, jobs, plugins), limited by the permissions of the configured account.",
        'Call server_info first to see the server version and which features are enabled.',
        config.readOnly
            ? 'Read-only mode: only tools the server marks as read-only are available.'
            : 'Tools that change data are available; check a tool’s description before calling it.',
        'After a network or VPN interruption simply retry the call: the proxy reconnects automatically.',
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

/**
 * The local MCP server Claude Code talks to over stdio: `tools/list` returns the
 * remote tools (unchanged) that pass the client-side filters, `tools/call` is forwarded.
 */
export const createProxyServer = (remote: RemoteServer, config: Config): Server => {
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION, websiteUrl: WEBSITE_URL },
        {
            capabilities: { tools: { listChanged: false } },
            instructions: buildInstructions(config),
        },
    );

    server.setRequestHandler('tools/list', async () => {
        try {
            const tools = await remote.listTools();
            return { tools: tools.filter((tool) => isToolAllowed(tool, config)) };
        } catch (error) {
            if (error instanceof ProtocolError) {
                throw error;
            }
            throw new ProtocolError(INTERNAL_ERROR, (error as Error).message);
        }
    });

    server.setRequestHandler('tools/call', async (request, ctx) => {
        const params = request.params;
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

    return server;
};
