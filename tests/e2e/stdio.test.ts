import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeServer, type FakeServer } from '../helpers/fake-qcli-server.js';

const CLI = path.resolve(import.meta.dirname, '../../dist/src/cli.js');
const DEV_TOOLS = ['qcli_docs_search', 'qcli_docs_read', 'qcli_api', 'qcli_scaffold_plugin'];
/** A docs URL that refuses connections, so the bundled snapshot is used offline. */
const OFFLINE_DOCS = { QCLI_DOCS_URL: 'http://127.0.0.1:9/llms-full.txt' };

/** Spawns the built `mcp-cli` over stdio with the given environment and connects a client. */
const connect = async (
    env: Record<string, string>,
): Promise<{ client: Client; stderr: () => string }> => {
    const transport = new StdioClientTransport({
        args: [CLI],
        command: process.execPath,
        env: { PATH: process.env['PATH'] ?? '', ...env },
        stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    await client.connect(transport);
    return { client, stderr: () => stderr };
};

describe.skipIf(!existsSync(CLI))('mcp-cli over stdio (run `npm run build` first)', () => {
    let srv: FakeServer;
    beforeAll(async () => {
        srv = await startFakeServer();
    });
    afterAll(async () => {
        await srv.close();
    });

    it('proxies tools/list and tools/call to the server', async () => {
        const { client, stderr } = await connect({
            QCLI_TOKEN: 'qcli_pat_valid',
            QCLI_URL: srv.url,
        });
        try {
            expect(client.getServerVersion()?.name).toBe('@qodalis/mcp-cli');
            const { tools } = await client.listTools();
            expect(tools.map((t) => t.name)).toEqual([
                ...DEV_TOOLS,
                'server_info',
                'echo',
                'fs_list',
                'fs_delete',
            ]);
            const result = await client.callTool({
                arguments: { value: 'over stdio' },
                name: 'echo',
            });
            expect(result.content).toEqual([
                { text: 'echo: {"value":"over stdio"}', type: 'text' },
            ]);
            expect(stderr()).toContain(`ready for ${srv.url} (token auth; all tools)`);
            expect(stderr()).not.toContain('qcli_pat_valid');
        } finally {
            await client.close();
        }
    });

    it('reads an env file and applies read-only mode', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'mcp-cli-e2e-'));
        const envFile = path.join(dir, '.env');
        writeFileSync(
            envFile,
            `QCLI_URL=${srv.url}\nQCLI_USER=root\nQCLI_PASSWORD=secret\nQCLI_READ_ONLY=true\n`,
        );
        const { client, stderr } = await connect({ QCLI_ENV_FILE: envFile });
        try {
            const { tools } = await client.listTools();
            expect(tools.map((t) => t.name)).toEqual([
                'qcli_docs_search',
                'qcli_docs_read',
                'qcli_api',
                'server_info',
                'fs_list',
            ]);
            expect(stderr()).toContain('signs in as root; read-only tools');
            expect(stderr()).not.toContain('secret');
        } finally {
            await client.close();
        }
    });

    it('runs in developer mode without QCLI_URL, serving the bundled docs', async () => {
        const { client, stderr } = await connect(OFFLINE_DOCS);
        try {
            const { tools } = await client.listTools();
            expect(tools.map((t) => t.name)).toEqual(DEV_TOOLS);
            const search = await client.callTool({
                arguments: { query: 'register module' },
                name: 'qcli_docs_search',
            });
            expect(search.isError).toBeFalsy();
            expect((search.content as Array<{ text: string }>)[0]!.text).toContain(
                'source: bundled snapshot',
            );
            const { prompts } = await client.listPrompts();
            expect(prompts.map((p) => p.name)).toEqual([
                'create-web-plugin',
                'create-server-command',
            ]);
            expect((await client.listResources()).resources.length).toBeGreaterThan(5);
            expect(stderr()).toContain('ready for developer mode');
            expect(stderr()).toContain('using the bundled snapshot');
        } finally {
            await client.close();
        }
    });

    it('fails at startup when there is nothing to serve', async () => {
        await expect(connect({ QCLI_DEV_TOOLS: 'false' })).rejects.toThrow();
    });

    it('reports an unreachable server in the tool result', async () => {
        const closed = await startFakeServer();
        const url = closed.url;
        await closed.close();
        const { client } = await connect({ QCLI_TOKEN: 't', QCLI_URL: url });
        try {
            const result = await client.callTool({ arguments: {}, name: 'server_info' });
            expect(result.isError).toBe(true);
            expect(result.content).toEqual([
                { text: `Cannot reach ${url} (ECONNREFUSED). Check QCLI_URL / VPN.`, type: 'text' },
            ]);
        } finally {
            await client.close();
        }
    });
});
