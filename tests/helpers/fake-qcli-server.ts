import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Tool definition as the fake server lists it. */
export type FakeTool = {
    annotations?: Record<string, unknown>;
    description: string;
    inputSchema: Record<string, unknown>;
    name: string;
};

export type FakeServerState = {
    /** Every tools/call received: tool name and arguments */
    calls: Array<{ arguments: unknown; name: string }>;
    /** Accepted bearer tokens (API tokens or the static MCP token) */
    tokens: Set<string>;
    /** Users that may sign in: name -> password */
    users: Map<string, string>;
    /** Session tokens issued by POST /api/v1/qcli/sessions */
    sessions: Set<string>;
    /** false: /api/qcli/mcp answers 404 */
    mcpEnabled: boolean;
    /** Requests seen (method, path, Authorization header, JSON-RPC method) */
    requests: Array<{ auth: string | undefined; method: string; path: string; rpc?: string }>;
    tools: FakeTool[];
    /** Number of sign-ins */
    logins: number;
};

export type FakeServer = {
    close: () => Promise<void>;
    state: FakeServerState;
    url: string;
};

export const DEFAULT_TOOLS: FakeTool[] = [
    {
        annotations: { readOnlyHint: true },
        description: 'Server version, capabilities and features',
        inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
        name: 'server_info',
    },
    {
        description: 'Echo the value',
        inputSchema: {
            additionalProperties: false,
            properties: { value: { type: 'string' } },
            required: ['value'],
            type: 'object',
        },
        name: 'echo',
    },
    {
        annotations: { readOnlyHint: true },
        description: 'List a directory',
        inputSchema: {
            additionalProperties: false,
            properties: { path: { type: 'string' } },
            required: ['path'],
            type: 'object',
        },
        name: 'fs_list',
    },
    {
        annotations: { destructiveHint: true },
        description: 'Delete a file',
        inputSchema: {
            additionalProperties: false,
            properties: { path: { type: 'string' } },
            required: ['path'],
            type: 'object',
        },
        name: 'fs_delete',
    },
];

type JsonRpc = { id?: number | string | null; method?: string; params?: any };

/** A minimal Qodalis CLI server: the stateless JSON MCP endpoint and the sessions API. */
export const startFakeServer = async (
    options: { tokens?: string[]; tools?: FakeTool[] } = {},
): Promise<FakeServer> => {
    const state: FakeServerState = {
        calls: [],
        logins: 0,
        mcpEnabled: true,
        requests: [],
        sessions: new Set(),
        tokens: new Set(options.tokens ?? ['qcli_pat_valid']),
        tools: options.tools ?? DEFAULT_TOOLS,
        users: new Map([['root', 'secret']]),
    };
    let next = 1;

    const send = (res: http.ServerResponse, status: number, body?: unknown): void => {
        res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    const handleRpc = (msg: JsonRpc): Record<string, unknown> => {
        switch (msg.method) {
            case 'initialize':
                return {
                    result: {
                        capabilities: { tools: { listChanged: false } },
                        instructions: 'Qodalis CLI server (fake).',
                        protocolVersion:
                            msg.params?.protocolVersion === '2025-03-26'
                                ? '2025-03-26'
                                : '2025-06-18',
                        serverInfo: { name: 'qodalis-cli-server', version: '1.0.0-beta.7' },
                    },
                };
            case 'ping':
                return { result: {} };
            case 'tools/list':
                return { result: { tools: state.tools } };
            case 'tools/call': {
                const name = msg.params?.name as string;
                const args = msg.params?.arguments ?? {};
                state.calls.push({ arguments: args, name });
                if (!state.tools.some((t) => t.name === name)) {
                    return { error: { code: -32602, message: `Unknown tool: ${name}` } };
                }
                if (name === 'server_info') {
                    return {
                        result: {
                            content: [{ text: '{"version":"1.0.0-beta.7"}', type: 'text' }],
                            isError: false,
                            structuredContent: { version: '1.0.0-beta.7' },
                        },
                    };
                }
                return {
                    result: {
                        content: [{ text: `${name}: ${JSON.stringify(args)}`, type: 'text' }],
                        isError: false,
                    },
                };
            }
            default:
                return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
        }
    };

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        req.on('end', () => {
            const path = new URL(req.url ?? '/', 'http://x').pathname;
            const auth = req.headers.authorization;
            const bearer = (auth ?? '').replace(/^Bearer /, '');
            let body: any;
            try {
                body = raw ? JSON.parse(raw) : undefined;
            } catch {
                body = undefined;
            }
            state.requests.push({ auth, method: req.method ?? '', path, rpc: body?.method });

            if (path === '/api/qcli/mcp') {
                if (!state.mcpEnabled) return send(res, 404, { error: 'not found' });
                if (req.method !== 'POST') {
                    res.setHeader('Allow', 'POST');
                    return send(res, 405, { error: 'method not allowed' });
                }
                if (!state.tokens.has(bearer) && !state.sessions.has(bearer)) {
                    return send(res, 401, { error: 'not authenticated' });
                }
                if (!body) {
                    return send(res, 200, {
                        error: { code: -32700, message: 'Parse error' },
                        id: null,
                        jsonrpc: '2.0',
                    });
                }
                if (body.id === undefined) return send(res, 202);
                return send(res, 200, { id: body.id, jsonrpc: '2.0', ...handleRpc(body) });
            }
            if (path === '/api/v1/qcli/sessions' && req.method === 'POST') {
                if (state.users.get(body?.username) !== body?.password) {
                    return send(res, 401, { error: 'invalid credentials' });
                }
                state.logins++;
                const token = `session-${next++}`;
                state.sessions.add(token);
                return send(res, 200, { session: { id: token }, token });
            }
            return send(res, 404, { error: 'not found' });
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
        state,
        url: `http://127.0.0.1:${port}`,
    };
};
