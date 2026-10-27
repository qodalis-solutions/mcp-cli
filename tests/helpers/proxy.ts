import { Client, InMemoryTransport, type FetchLike } from '@modelcontextprotocol/client';
import { loadConfig, type Env } from '../../src/config.js';
import { DevTools, type DevToolsOptions } from '../../src/dev/tools.js';
import { RemoteServer, type RemoteOptions } from '../../src/remote.js';
import { createProxyServer } from '../../src/server.js';

export type Proxy = {
    client: Client;
    close: () => Promise<void>;
    logs: string[];
    remote: RemoteServer;
};

export type DevProxy = {
    client: Client;
    close: () => Promise<void>;
    dev: DevTools;
    logs: string[];
    remote: RemoteServer | undefined;
};

/**
 * The server with the plugin-development tools for `env` (proxying too when it sets
 * QCLI_URL), with an MCP client connected in memory.
 */
export const startDevProxy = async (
    env: Env,
    devOptions: DevToolsOptions = {},
    remoteOptions: Partial<RemoteOptions> & { fetch?: FetchLike } = {},
): Promise<DevProxy> => {
    const config = loadConfig(env);
    const logs: string[] = [];
    const log = (message: string): number => logs.push(message);
    const remote = config.url
        ? new RemoteServer(config, {
              clientInfo: { name: 'test-proxy', version: '0.0.0' },
              log,
              ...remoteOptions,
          })
        : undefined;
    const dev = new DevTools(config, { log, ...devOptions });
    const server = createProxyServer(remote, config, { dev, log });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientSide);
    return {
        client,
        close: async () => {
            await client.close();
            await server.close();
            await remote?.close();
        },
        dev,
        logs,
        remote,
    };
};

/** The proxy for `env`, with an MCP client connected to it in memory. */
export const startProxy = async (
    env: Env,
    options: Partial<RemoteOptions> & { fetch?: FetchLike } = {},
): Promise<Proxy> => {
    const config = loadConfig(env);
    const logs: string[] = [];
    const remote = new RemoteServer(config, {
        clientInfo: { name: 'test-proxy', version: '0.0.0' },
        log: (message) => logs.push(message),
        ...options,
    });
    const server = createProxyServer(remote, config);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientSide);
    return {
        client,
        close: async () => {
            await client.close();
            await server.close();
            await remote.close();
        },
        logs,
        remote,
    };
};

/** Text of the first content block of a tool result. */
export const text = (result: unknown): string =>
    ((result as { content: Array<{ text?: string }> }).content[0]?.text ?? '') as string;
