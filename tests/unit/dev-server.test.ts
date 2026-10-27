import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DevToolsOptions } from '../../src/dev/tools.js';
import type { Runner } from '../../src/dev/scaffold.js';
import { startFakeServer, type FakeServer } from '../helpers/fake-qcli-server.js';
import { startDevProxy, text, type DevProxy } from '../helpers/proxy.js';

const DOCS = readFileSync(path.resolve(import.meta.dirname, '../fixtures/llms-full.txt'), 'utf8');
const SAMPLE = readFileSync(
    path.resolve(import.meta.dirname, '../fixtures/sample.d.ts.txt'),
    'utf8',
);

/** Docs from a fake URL, declarations from a fake registry/CDN, npx mocked. */
const offline = (runner?: Runner): DevToolsOptions => ({
    api: {
        cacheDir: null,
        cdns: ['https://cdn.test'],
        cwd: mkdtempSync(path.join(tmpdir(), 'mcp-cli-dev-')),
        fetch: (async (url: string) =>
            url === 'https://registry.test/@qodalis/cli-core/latest'
                ? new Response(JSON.stringify({ types: 'index.d.ts', version: '2.0.0' }))
                : url.endsWith('/index.d.ts')
                  ? new Response(SAMPLE)
                  : new Response('', { status: 404 })) as unknown as typeof fetch,
        registryUrl: 'https://registry.test',
    },
    docs: { fetch: (async () => new Response(DOCS)) as unknown as typeof fetch },
    ...(runner ? { runner } : {}),
});

const servers: Array<DevProxy | FakeServer> = [];
const start = async (...args: Parameters<typeof startDevProxy>): Promise<DevProxy> => {
    const p = await startDevProxy(...args);
    servers.push(p);
    return p;
};
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

const DEV_NAMES = ['qcli_docs_search', 'qcli_docs_read', 'qcli_api', 'qcli_scaffold_plugin'];

describe('developer mode (no QCLI_URL)', () => {
    it('lists only the dev tools and explains the mode', async () => {
        const p = await start({}, offline());
        const { tools } = await p.client.listTools();
        expect(tools.map((t) => t.name)).toEqual(DEV_NAMES);
        expect(p.client.getInstructions()).toContain('developer mode');
        expect(p.client.getInstructions()).toContain('qcli_api');
        expect(p.client.getServerCapabilities()).toMatchObject({
            prompts: {},
            resources: {},
            tools: {},
        });
    });

    it('searches and reads the docs', async () => {
        const p = await start({}, offline());
        const search = await p.client.callTool({
            arguments: { limit: 2, query: 'reading input' },
            name: 'qcli_docs_search',
        });
        expect(text(search)).toContain('**Web plugins › Reading input**');
        expect(text(search)).toContain('source: https://cli.qodalis.com/llms-full.txt');
        const read = await p.client.callTool({
            arguments: { topic: 'Node.js processor' },
            name: 'qcli_docs_read',
        });
        expect(text(read)).toMatch(/^### Node\.js processor\n/);
        const both = await p.client.callTool({
            arguments: { topic: 'testing' },
            name: 'qcli_docs_read',
        });
        expect(text(both)).toContain('<!-- Web plugins › Testing -->');
        expect(text(both)).toContain('<!-- Server plugins › Testing -->');
        const missing = await p.client.callTool({
            arguments: { topic: 'kubernetes' },
            name: 'qcli_docs_read',
        });
        expect(missing.isError).toBe(true);
        expect(text(missing)).toContain('Available topics:');
        const none = await p.client.callTool({
            arguments: { query: 'kubernetes' },
            name: 'qcli_docs_search',
        });
        expect(text(none)).toContain('No topic matches "kubernetes"');
    });

    it('looks up declarations and reports bad input as tool errors', async () => {
        const p = await start({}, offline());
        const api = await p.client.callTool({
            arguments: { symbol: 'ICliCommandProcessor' },
            name: 'qcli_api',
        });
        expect(api.isError).toBeFalsy();
        expect(text(api)).toContain(
            '@qodalis/cli-core@2.0.0 from https://cdn.test/@qodalis/cli-core@2.0.0',
        );
        expect(text(api)).toContain('interface ICliCommandProcessor {');
        const unknown = await p.client.callTool({
            arguments: { symbol: 'Nope' },
            name: 'qcli_api',
        });
        expect(unknown.isError).toBe(true);
        const bad = await p.client.callTool({ arguments: { symbol: 'a b' }, name: 'qcli_api' });
        expect(text(bad)).toMatch(/not an identifier/);
        const foreign = await p.client.callTool({
            arguments: { package: '@evil/left-pad', symbol: 'X' },
            name: 'qcli_api',
        });
        expect(text(foreign)).toMatch(/not a @qodalis package/);
        const missingArg = await p.client.callTool({ arguments: {}, name: 'qcli_api' });
        expect(text(missingArg)).toBe('Missing required argument "symbol".');
        const unpublished = await p.client.callTool({
            arguments: { package: 'cli-nope', symbol: 'X' },
            name: 'qcli_api',
        });
        expect(text(unpublished)).toMatch(/^Could not load the declarations of @qodalis\/cli-nope/);
    });

    it('scaffolds through npx and validates the name first', async () => {
        const runner = vi.fn<Runner>(async () => ({ code: 0, output: 'Done!', timedOut: false }));
        const p = await start({}, offline(runner));
        const dir = mkdtempSync(path.join(tmpdir(), 'mcp-cli-dev-'));
        const bad = await p.client.callTool({
            arguments: { directory: dir, name: 'Bad Name' },
            name: 'qcli_scaffold_plugin',
        });
        expect(bad.isError).toBe(true);
        expect(text(bad)).toMatch(/Invalid plugin name/);
        expect(runner).not.toHaveBeenCalled();
        const ok = await p.client.callTool({
            arguments: { description: 'Weather', directory: dir, name: 'weather' },
            name: 'qcli_scaffold_plugin',
        });
        expect(ok.isError).toBeFalsy();
        expect(runner).toHaveBeenCalledOnce();
        expect(runner.mock.calls[0]![1]).toContain('--name');
        expect(
            p.logs.some((l) => l.startsWith('scaffold: npx -y @qodalis/create-cli-plugin@latest')),
        ).toBe(true);
    });

    it('serves the prompts', async () => {
        const p = await start({}, offline());
        const { prompts } = await p.client.listPrompts();
        expect(prompts.map((x) => x.name)).toEqual(['create-web-plugin', 'create-server-command']);
        const web = await p.client.getPrompt({
            arguments: { description: 'Weather forecasts', name: 'weather' },
            name: 'create-web-plugin',
        });
        const webText = (web.messages[0]!.content as { text: string }).text;
        expect(webText).toContain('Create a Qodalis web CLI plugin named "weather"');
        expect(webText).toContain('qcli_scaffold_plugin');
        expect(webText).toContain('qcli_api');
        for (const language of ['node', 'dotnet', 'python', '.NET']) {
            const server = await p.client.getPrompt({
                arguments: { command: 'weather', language },
                name: 'create-server-command',
            });
            expect((server.messages[0]!.content as { text: string }).text).toContain(
                'qcli_docs_read',
            );
        }
        await expect(
            p.client.getPrompt({
                arguments: { command: 'weather', language: 'cobol' },
                name: 'create-server-command',
            }),
        ).rejects.toThrow(/Unknown language "cobol"/);
        await expect(
            p.client.getPrompt({ arguments: { name: 'x' }, name: 'create-web-plugin' }),
        ).rejects.toThrow(/Missing required argument "description"/);
        await expect(p.client.getPrompt({ name: 'nope' })).rejects.toThrow(/Unknown prompt/);
    });

    it('exposes the docs topics as resources', async () => {
        const p = await start({}, offline());
        const { resources } = await p.client.listResources();
        expect(resources[0]).toEqual({
            description: 'Commands are processors registered through modules.',
            mimeType: 'text/markdown',
            name: 'Overview › Architecture',
            title: 'Architecture',
            uri: 'qcli-docs://overview/architecture',
        });
        const read = await p.client.readResource({ uri: 'qcli-docs://web-plugins/reading-input' });
        expect(read.contents[0]).toMatchObject({ mimeType: 'text/markdown' });
        expect((read.contents[0] as { text: string }).text).toMatch(/^### Reading input/);
        await expect(p.client.readResource({ uri: 'qcli-docs://nope/nope' })).rejects.toThrow(
            /Unknown resource/,
        );
        await expect(p.client.readResource({ uri: 'file:///etc/passwd' })).rejects.toThrow(
            /Unknown resource/,
        );
    });

    it('rejects unknown tools with a hint about QCLI_URL', async () => {
        const p = await start({}, offline());
        await expect(p.client.callTool({ arguments: {}, name: 'echo' })).rejects.toThrow(
            /developer mode: set QCLI_URL/,
        );
    });
});

describe('filters on the dev tools', () => {
    it('read-only mode hides and refuses the scaffold tool, and adapts the prompt', async () => {
        const runner = vi.fn<Runner>();
        const p = await start({ QCLI_READ_ONLY: 'true' }, offline(runner));
        const { tools } = await p.client.listTools();
        expect(tools.map((t) => t.name)).toEqual([
            'qcli_docs_search',
            'qcli_docs_read',
            'qcli_api',
        ]);
        await expect(
            p.client.callTool({ arguments: { name: 'x' }, name: 'qcli_scaffold_plugin' }),
        ).rejects.toThrow(/QCLI_READ_ONLY allows only read-only tools/);
        expect(runner).not.toHaveBeenCalled();
        const web = await p.client.getPrompt({
            arguments: { description: 'd', name: 'x' },
            name: 'create-web-plugin',
        });
        expect((web.messages[0]!.content as { text: string }).text).toContain(
            'qcli_scaffold_plugin is not available in this session',
        );
    });

    it('QCLI_TOOLS / QCLI_EXCLUDE apply to the dev tools too', async () => {
        const p = await start({ QCLI_EXCLUDE: 'qcli_api', QCLI_TOOLS: 'qcli_*' }, offline());
        const { tools } = await p.client.listTools();
        expect(tools.map((t) => t.name)).toEqual([
            'qcli_docs_search',
            'qcli_docs_read',
            'qcli_scaffold_plugin',
        ]);
        await expect(
            p.client.callTool({ arguments: { symbol: 'X' }, name: 'qcli_api' }),
        ).rejects.toThrow(/excluded by QCLI_TOOLS \/ QCLI_EXCLUDE/);
    });
});

describe('dev tools next to a server', () => {
    it('lists the dev tools first, then the server tools, and routes calls', async () => {
        const srv = await startFakeServer();
        servers.push(srv);
        const p = await start({ QCLI_TOKEN: 'qcli_pat_valid', QCLI_URL: srv.url }, offline());
        const { tools } = await p.client.listTools();
        expect(tools.map((t) => t.name)).toEqual([
            ...DEV_NAMES,
            'server_info',
            'echo',
            'fs_list',
            'fs_delete',
        ]);
        expect(p.client.getInstructions()).toContain(`Qodalis CLI server at ${srv.url}`);
        expect(p.client.getInstructions()).toContain('qcli_docs_search');
        const echo = await p.client.callTool({ arguments: { value: 'hi' }, name: 'echo' });
        expect(text(echo)).toBe('echo: {"value":"hi"}');
        const docs = await p.client.callTool({
            arguments: { query: 'modules' },
            name: 'qcli_docs_search',
        });
        expect(docs.isError).toBeFalsy();
        expect(srv.state.calls.map((c) => c.name)).toEqual(['echo']);
    });

    it('keeps the dev tools listed while the server is unreachable', async () => {
        const closed = await startFakeServer();
        const url = closed.url;
        await closed.close();
        const p = await start({ QCLI_TOKEN: 't', QCLI_URL: url }, offline());
        const { tools } = await p.client.listTools();
        expect(tools.map((t) => t.name)).toEqual(DEV_NAMES);
        expect(p.logs.some((l) => l.includes('listing the local tools only'))).toBe(true);
    });
});
