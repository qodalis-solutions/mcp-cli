import {
    Client,
    ProtocolError,
    StreamableHTTPClientTransport,
    type CallToolRequestParams,
    type CallToolResult,
    type FetchLike,
} from '@modelcontextprotocol/client';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Config } from './config.js';
import {
    classify,
    httpStatus,
    isRetryableNetworkError,
    networkCode,
    RemoteError,
} from './errors.js';
import type { RemoteTool } from './filters.js';

export const MCP_PATH = '/api/qcli/mcp';
export const SESSIONS_PATH = '/api/v1/qcli/sessions';
/** How long a fetched tool list is reused before `tools/list` asks the server again. */
export const TOOLS_TTL_MS = 60_000;

export type RemoteOptions = {
    /** Client name/version announced to the server */
    clientInfo: { name: string; version: string };
    /** Overrides the HTTP client (tests) */
    fetch?: FetchLike;
    log?: (message: string) => void;
    now?: () => number;
    toolsTtlMs?: number;
};

/** HTTP client honouring QCLI_CONNECTION_TIMEOUT, QCLI_REQUEST_TIMEOUT and QCLI_TRUST_CERT. */
export const createFetch = (config: Config): { close: () => Promise<void>; fetch: FetchLike } => {
    const agent = new Agent({
        connect: { rejectUnauthorized: !config.trustCert, timeout: config.connectionTimeoutMs },
    });
    const fetchFn: FetchLike = (url, init) => {
        const timeout = AbortSignal.timeout(config.requestTimeoutMs);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        return undiciFetch(url as string, {
            ...(init as object),
            dispatcher: agent,
            signal,
        }) as unknown as Promise<Response>;
    };
    return { close: () => agent.close(), fetch: fetchFn };
};

/**
 * Connection to the Qodalis CLI server's MCP endpoint.
 *
 * - Connects on first use; a failed connect is never cached.
 * - A connection-level error (refused, reset, DNS) drops the client and retries once.
 * - With QCLI_USER / QCLI_PASSWORD it signs in, and signs in again after a 401.
 * - The tool list is cached for {@link TOOLS_TTL_MS}.
 */
export class RemoteServer {
    private client: Client | undefined;
    private connecting: Promise<Client> | undefined;
    private sessionToken: string | undefined;
    private toolsCache: { at: number; tools: RemoteTool[] } | undefined;
    private readonly fetchFn: FetchLike;
    private readonly closeFetch: () => Promise<void>;
    private readonly log: (message: string) => void;
    private readonly now: () => number;

    constructor(
        private readonly config: Config,
        private readonly options: RemoteOptions,
    ) {
        if (options.fetch) {
            this.fetchFn = options.fetch;
            this.closeFetch = async () => undefined;
        } else {
            const created = createFetch(config);
            this.fetchFn = created.fetch;
            this.closeFetch = created.close;
        }
        this.log = options.log ?? (() => undefined);
        this.now = options.now ?? Date.now;
    }

    /** Remote tools (unfiltered), from the cache unless it is older than the TTL or `refresh`. */
    async listTools(refresh = false): Promise<RemoteTool[]> {
        const ttl = this.options.toolsTtlMs ?? TOOLS_TTL_MS;
        const cached = this.toolsCache;
        if (!refresh && cached && this.now() - cached.at < ttl) {
            return cached.tools;
        }
        const tools = await this.run(async (client) => {
            const all: RemoteTool[] = [];
            let cursor: string | undefined;
            do {
                const page = await client.listTools(cursor ? { cursor } : {}, {
                    timeout: this.config.requestTimeoutMs,
                });
                all.push(...(page.tools as RemoteTool[]));
                cursor = page.nextCursor;
            } while (cursor);
            return all;
        }, true);
        this.toolsCache = { at: this.now(), tools };
        return tools;
    }

    /** Find a tool, asking the server again when it is not in the cached list. */
    async findTool(name: string): Promise<RemoteTool | undefined> {
        const cached = (await this.listTools()).find((t) => t.name === name);
        return cached ?? (await this.listTools(true)).find((t) => t.name === name);
    }

    /** Forward `tools/call`; remote JSON-RPC errors are rethrown unchanged. */
    async callTool(params: CallToolRequestParams, signal?: AbortSignal): Promise<CallToolResult> {
        try {
            return (await this.run(
                (client) =>
                    client.callTool(params, {
                        timeout: this.config.requestTimeoutMs,
                        ...(signal ? { signal } : {}),
                    }),
                true,
            )) as CallToolResult;
        } catch (error) {
            if (error instanceof ProtocolError && /unknown tool/i.test(error.message)) {
                this.toolsCache = undefined; // the server's commands changed
            }
            throw error;
        }
    }

    async close(): Promise<void> {
        const client = this.client;
        this.client = undefined;
        await client?.close().catch(() => undefined);
        if (this.sessionToken) {
            // End the password session we opened (best effort)
            await this.fetchFn(`${this.config.url}${SESSIONS_PATH}/current`, {
                headers: { Authorization: `Bearer ${this.sessionToken}` },
                method: 'DELETE',
                signal: AbortSignal.timeout(2000),
            }).catch(() => undefined);
            this.sessionToken = undefined;
        }
        await this.closeFetch().catch(() => undefined);
    }

    /** Run an operation with a connected client: one retry on connection loss, one re-login on 401. */
    private async run<T>(
        operation: (client: Client) => Promise<T>,
        retryNetwork: boolean,
    ): Promise<T> {
        let signedInAgain = false;
        let retried = false;
        for (;;) {
            try {
                const client = await this.connect();
                return await operation(client);
            } catch (error) {
                if (error instanceof ProtocolError || error instanceof RemoteError) {
                    throw error;
                }
                await this.dropClient();
                const status = httpStatus(error);
                if (status === 401 && this.config.auth.kind === 'password' && !signedInAgain) {
                    signedInAgain = true;
                    this.sessionToken = undefined;
                    this.log('session rejected (401); signing in again');
                    continue;
                }
                if (retryNetwork && !retried && isRetryableNetworkError(error)) {
                    retried = true;
                    this.log(`connection lost (${networkCode(error)}); retrying once`);
                    continue;
                }
                throw classify(error, this.classifyContext());
            }
        }
    }

    private connect(): Promise<Client> {
        if (this.client) {
            return Promise.resolve(this.client);
        }
        // Concurrent first calls share one connect; a failure is not cached
        this.connecting ??= this.open().finally(() => {
            this.connecting = undefined;
        });
        return this.connecting;
    }

    private async open(): Promise<Client> {
        const token = await this.bearerToken();
        const transport = new StreamableHTTPClientTransport(
            new URL(`${this.config.url}${MCP_PATH}`),
            {
                fetch: this.fetchFn,
                requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
            },
        );
        const client = new Client(this.options.clientInfo);
        try {
            await client.connect(transport, { timeout: this.config.connectionTimeoutMs });
        } catch (error) {
            await client.close().catch(() => undefined);
            throw error;
        }
        const info = client.getServerVersion();
        this.log(`connected to ${this.config.url}${info ? ` (${info.name} ${info.version})` : ''}`);
        this.client = client;
        return client;
    }

    private async dropClient(): Promise<void> {
        const client = this.client;
        this.client = undefined;
        await client?.close().catch(() => undefined);
    }

    private async bearerToken(): Promise<string | undefined> {
        const auth = this.config.auth;
        if (auth.kind === 'token') {
            return auth.token;
        }
        if (auth.kind === 'none') {
            return undefined;
        }
        this.sessionToken ??= await this.signIn(auth.user, auth.password);
        return this.sessionToken;
    }

    /** POST /api/v1/qcli/sessions with QCLI_USER / QCLI_PASSWORD. */
    private async signIn(user: string, password: string): Promise<string> {
        const response = await this.fetchFn(`${this.config.url}${SESSIONS_PATH}`, {
            body: JSON.stringify({ password, username: user }),
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            method: 'POST',
        });
        const text = await response.text();
        if (response.status === 401 || response.status === 400 || response.status === 403) {
            throw new RemoteError(
                'login',
                `${this.config.url} rejected QCLI_USER / QCLI_PASSWORD for "${user}" (${response.status}${errorText(text)}).`,
            );
        }
        if (response.status === 404) {
            throw new RemoteError(
                'login',
                `${this.config.url} has no users plugin (404 on ${SESSIONS_PATH}): use QCLI_TOKEN with the server's mcp token instead of QCLI_USER / QCLI_PASSWORD.`,
            );
        }
        if (response.status === 429) {
            throw new RemoteError(
                'login',
                `${this.config.url}: too many failed sign-ins for "${user}"; try again later.`,
            );
        }
        if (!response.ok) {
            throw classify(
                Object.assign(new Error(text), { status: response.status, data: { text } }),
                this.classifyContext(),
            );
        }
        const token = (JSON.parse(text) as { token?: unknown }).token;
        if (typeof token !== 'string' || !token) {
            throw new RemoteError('login', `${this.config.url} did not return a session token.`);
        }
        this.log(`signed in to ${this.config.url} as ${user}`);
        return token;
    }

    private classifyContext() {
        return {
            auth: this.config.auth.kind,
            connectionTimeoutMs: this.config.connectionTimeoutMs,
            requestTimeoutMs: this.config.requestTimeoutMs,
            url: this.config.url,
        };
    }
}

const errorText = (text: string): string => {
    try {
        const body = JSON.parse(text) as { error?: unknown };
        return typeof body.error === 'string' ? `: ${body.error.slice(0, 200)}` : '';
    } catch {
        return '';
    }
};
