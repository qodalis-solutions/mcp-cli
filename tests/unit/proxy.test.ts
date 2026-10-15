import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TOOLS, startFakeServer, type FakeServer } from '../helpers/fake-qcli-server.js';
import { startProxy, text, type Proxy } from '../helpers/proxy.js';

let srv: FakeServer;
const proxies: Proxy[] = [];
const proxy = async (...args: Parameters<typeof startProxy>): Promise<Proxy> => {
    const p = await startProxy(...args);
    proxies.push(p);
    return p;
};

beforeEach(async () => {
    srv = await startFakeServer();
});
afterEach(async () => {
    await Promise.all(proxies.splice(0).map((p) => p.close()));
    await srv.close();
});

const tokenEnv = () => ({ QCLI_TOKEN: 'qcli_pat_valid', QCLI_URL: srv.url });

describe('passthrough', () => {
    it('lists the remote tools unchanged', async () => {
        const p = await proxy(tokenEnv());
        const { tools } = await p.client.listTools();
        expect(tools).toEqual(DEFAULT_TOOLS);
        expect(srv.state.requests.find((r) => r.rpc === 'tools/list')?.auth).toBe(
            'Bearer qcli_pat_valid',
        );
    });

    it('forwards tools/call, including server_info structured content', async () => {
        const p = await proxy(tokenEnv());
        const echo = await p.client.callTool({ arguments: { value: 'hi' }, name: 'echo' });
        expect(echo).toEqual({
            content: [{ text: 'echo: {"value":"hi"}', type: 'text' }],
            isError: false,
        });
        expect(srv.state.calls.at(-1)).toEqual({ arguments: { value: 'hi' }, name: 'echo' });
        const info = await p.client.callTool({ arguments: {}, name: 'server_info' });
        expect(info.structuredContent).toEqual({ version: '1.0.0-beta.7' });
    });

    it('announces itself with instructions that point at server_info', async () => {
        const p = await proxy(tokenEnv());
        expect(p.client.getServerVersion()?.name).toBe('@qodalis/mcp-cli');
        expect(p.client.getInstructions()).toContain(`Qodalis CLI server at ${srv.url}`);
        expect(p.client.getInstructions()).toContain('server_info');
    });

    it('connects on first use, not at startup', async () => {
        await proxy(tokenEnv());
        expect(srv.state.requests).toHaveLength(0);
    });

    it('rejects unknown tools with -32602', async () => {
        const p = await proxy(tokenEnv());
        await expect(p.client.callTool({ arguments: {}, name: 'nope' })).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining('Unknown tool: nope'),
        });
    });

    it('caches the tool list for 60 s and refreshes it for a tool it does not know yet', async () => {
        let now = 1_000;
        const p = await proxy(tokenEnv(), { now: () => now });
        await p.client.listTools();
        await p.client.listTools();
        const lists = () => srv.state.requests.filter((r) => r.rpc === 'tools/list').length;
        expect(lists()).toBe(1);
        now += 60_001;
        await p.client.listTools();
        expect(lists()).toBe(2);

        srv.state.tools = [...DEFAULT_TOOLS, { ...DEFAULT_TOOLS[1]!, name: 'weather' }];
        const result = await p.client.callTool({ arguments: { value: 'x' }, name: 'weather' });
        expect(text(result)).toBe('weather: {"value":"x"}');
        expect(lists()).toBe(3);
    });
});

describe('client-side filters', () => {
    it('read-only mode lists and allows only readOnlyHint tools', async () => {
        const p = await proxy({ ...tokenEnv(), QCLI_READ_ONLY: 'true' });
        const { tools } = await p.client.listTools();
        expect(tools.map((t) => t.name)).toEqual(['server_info', 'fs_list']);
        await expect(
            p.client.callTool({ arguments: { path: '/' }, name: 'fs_delete' }),
        ).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining('QCLI_READ_ONLY allows only read-only tools'),
        });
        expect(srv.state.calls).toHaveLength(0);
        expect(
            text(await p.client.callTool({ arguments: { path: '/' }, name: 'fs_list' })),
        ).toContain('fs_list');
    });

    it('applies QCLI_TOOLS and QCLI_EXCLUDE', async () => {
        const p = await proxy({
            ...tokenEnv(),
            QCLI_EXCLUDE: 'fs_delete',
            QCLI_TOOLS: 'fs_*,server_info',
        });
        const { tools } = await p.client.listTools();
        expect(tools.map((t) => t.name)).toEqual(['server_info', 'fs_list']);
        await expect(
            p.client.callTool({ arguments: { value: 'x' }, name: 'echo' }),
        ).rejects.toMatchObject({
            message: expect.stringContaining('excluded by QCLI_TOOLS / QCLI_EXCLUDE'),
        });
    });
});

describe('authentication', () => {
    it('a rejected token gives a clear tool error', async () => {
        const p = await proxy({ QCLI_TOKEN: 'qcli_pat_revoked', QCLI_URL: srv.url });
        const result = await p.client.callTool({ arguments: { value: 'x' }, name: 'echo' });
        expect(result.isError).toBe(true);
        expect(text(result)).toMatch(/answered 401.*QCLI_TOKEN is wrong, expired or revoked/);
        await expect(p.client.listTools()).rejects.toThrow(
            /QCLI_TOKEN is wrong, expired or revoked/,
        );
    });

    it('signs in with QCLI_USER / QCLI_PASSWORD and again after a 401', async () => {
        const p = await proxy({ QCLI_PASSWORD: 'secret', QCLI_URL: srv.url, QCLI_USER: 'root' });
        expect(
            text(await p.client.callTool({ arguments: { value: '1' }, name: 'echo' })),
        ).toContain('"1"');
        expect(srv.state.logins).toBe(1);
        const mcpAuth = srv.state.requests.find((r) => r.rpc === 'initialize')?.auth;
        expect(mcpAuth).toMatch(/^Bearer session-/);

        srv.state.sessions.clear(); // the session expired on the server
        expect(
            text(await p.client.callTool({ arguments: { value: '2' }, name: 'echo' })),
        ).toContain('"2"');
        expect(srv.state.logins).toBe(2);
        expect(p.logs).toContain('session rejected (401); signing in again');
        expect(p.logs.join('\n')).not.toContain('secret');
    });

    it('wrong credentials are reported without retry loops', async () => {
        const p = await proxy({ QCLI_PASSWORD: 'wrong', QCLI_URL: srv.url, QCLI_USER: 'root' });
        const result = await p.client.callTool({ arguments: { value: 'x' }, name: 'echo' });
        expect(text(result)).toBe(
            `${srv.url} rejected QCLI_USER / QCLI_PASSWORD for "root" (401: invalid credentials).`,
        );
        expect(srv.state.requests.filter((r) => r.path === '/api/v1/qcli/sessions')).toHaveLength(
            1,
        );
    });
});

describe('resilience', () => {
    it('retries once when the connection drops, then succeeds', async () => {
        let failNext = false;
        const flaky = async (url: string | URL, init?: RequestInit): Promise<Response> => {
            if (failNext && String(url).endsWith('/api/qcli/mcp')) {
                failNext = false;
                throw new TypeError('fetch failed', {
                    cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
                });
            }
            return fetch(url, init);
        };
        const p = await proxy(tokenEnv(), { fetch: flaky });
        await p.client.callTool({ arguments: { value: '1' }, name: 'echo' });
        failNext = true;
        const result = await p.client.callTool({ arguments: { value: '2' }, name: 'echo' });
        expect(result.isError).toBe(false);
        expect(p.logs).toContain('connection lost (ECONNRESET); retrying once');
    });

    it('fails fast with a clear message when the server is unreachable', async () => {
        const url = srv.url;
        await srv.close();
        srv = await startFakeServer(); // keep afterEach happy
        const p = await proxy({ QCLI_TOKEN: 't', QCLI_URL: url });
        const started = Date.now();
        const result = await p.client.callTool({ arguments: { value: 'x' }, name: 'echo' });
        expect(Date.now() - started).toBeLessThan(3000);
        expect(result.isError).toBe(true);
        expect(text(result)).toBe(`Cannot reach ${url} (ECONNREFUSED). Check QCLI_URL / VPN.`);
        expect(p.logs).toContain('connection lost (ECONNREFUSED); retrying once');
    });

    it('reports MCP not enabled (404) and does not cache the failed connect', async () => {
        srv.state.mcpEnabled = false;
        const p = await proxy(tokenEnv());
        const result = await p.client.callTool({ arguments: { value: 'x' }, name: 'echo' });
        expect(text(result)).toBe(
            `MCP is not enabled on this server (enable the mcp option): 404 from ${srv.url}/api/qcli/mcp.`,
        );
        srv.state.mcpEnabled = true;
        const ok = await p.client.callTool({ arguments: { value: 'y' }, name: 'echo' });
        expect(ok.isError).toBe(false);
    });

    it('a request timeout is reported, not retried', async () => {
        const slow = async (url: string | URL, init?: RequestInit): Promise<Response> => {
            if (
                String(url).endsWith('/api/qcli/mcp') &&
                String(init?.body).includes('tools/call')
            ) {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            return fetch(url, init);
        };
        const p = await proxy({ ...tokenEnv(), QCLI_REQUEST_TIMEOUT: '100' }, { fetch: slow });
        const result = await p.client.callTool({ arguments: { value: 'x' }, name: 'echo' });
        expect(text(result)).toBe(
            `${srv.url} did not answer within 100 ms (QCLI_REQUEST_TIMEOUT).`,
        );
    });
});
