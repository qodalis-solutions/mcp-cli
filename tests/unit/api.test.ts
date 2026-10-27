import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    ApiSource,
    blankNonCode,
    collectTypeFiles,
    extractDeclarations,
    formatLookup,
    lookupSymbol,
    normalizePackageName,
    typesEntry,
    type TypeFiles,
} from '../../src/dev/api.js';

const fixture = (name: string): string =>
    readFileSync(path.resolve(import.meta.dirname, '../fixtures', name), 'utf8');
const SAMPLE = fixture('sample.d.ts.txt');
const EXTRA = fixture('extra.d.ts.txt');

const types = (files: Record<string, string> = { 'index.d.ts': SAMPLE }): TypeFiles => ({
    files: new Map(Object.entries(files)),
    package: '@qodalis/cli-core',
    source: 'test',
    version: '9.9.9',
});

describe('extractDeclarations', () => {
    it('extracts an interface with its JSDoc, ignoring braces in comments and strings', () => {
        const [decl] = extractDeclarations(SAMPLE, 'ICliCommandProcessor');
        expect(decl!.startsWith('/**\n * Processes a command.')).toBe(true);
        expect(decl!.endsWith('format?: \'}\' | "{";\n}')).toBe(true);
        expect(decl).toContain('processCommand(command: CliProcessCommand');
    });

    it('extracts type aliases, enums, consts, overloads and merged interfaces', () => {
        expect(extractDeclarations(SAMPLE, 'CliProcessCommand')[0]).toMatch(
            /^\/\*\*\n \* A parsed command\.\n \*\/\ntype CliProcessCommand = \{[\s\S]*\};$/,
        );
        expect(extractDeclarations(SAMPLE, 'CliColor')[0]).toMatch(
            /^declare enum CliColor \{[\s\S]*Blue = "blue"\n\}$/,
        );
        expect(extractDeclarations(SAMPLE, 'DefaultAuthor')).toEqual([
            'declare const DefaultAuthor: {\n    name: string;\n};',
        ]);
        expect(extractDeclarations(SAMPLE, 'parse')).toEqual([
            '/** Overloaded. */\ndeclare function parse(value: string): CliProcessCommand;',
            'declare function parse(value: string, strict: boolean): CliProcessCommand;',
        ]);
        expect(extractDeclarations(SAMPLE, 'Merged')).toHaveLength(2);
        expect(extractDeclarations(SAMPLE, 'Callback')).toEqual([
            'type Callback = (value: string) => void',
        ]);
    });

    it('handles generics with defaults, arrow types and abstract classes', () => {
        const [decl] = extractDeclarations(SAMPLE, 'CliBase');
        expect(
            decl!.startsWith(
                '/** A class. */\ndeclare abstract class CliBase<T extends object = {}>',
            ),
        ).toBe(true);
        expect(decl!.endsWith('Promise<void>;\n}')).toBe(true);
    });

    it('does not match members or names inside comments', () => {
        expect(extractDeclarations(SAMPLE, 'command')).toEqual([]);
        expect(extractDeclarations(SAMPLE, 'processCommand')).toEqual([]);
        expect(blankNonCode('a /* b */ "c" // d\ne')).toBe('a         " "     \ne');
    });
});

describe('lookupSymbol', () => {
    it('lists related declarations', () => {
        const lookup = lookupSymbol(types(), 'ICliCommandProcessor');
        expect(lookup.declarations).toHaveLength(1);
        expect(lookup.related).toEqual(['CliProcessCommand', 'ICliExecutionContext']);
        const text = formatLookup('ICliCommandProcessor', lookup);
        expect(text).toContain('@qodalis/cli-core@9.9.9 from test');
        expect(text).toContain('```ts\n// index.d.ts\n/**');
        expect(text).toContain(
            'Related declarations (look up with qcli_api): CliProcessCommand, ICliExecutionContext',
        );
    });

    it('resolves `export { local as Public }` aliases', () => {
        expect(lookupSymbol(types(), 'publicModule').declarations[0]!.text).toBe(
            'declare const internalModule: { name: string };',
        );
    });

    it('suggests similar names when nothing matches', () => {
        const lookup = lookupSymbol(types(), 'CommandProcessor');
        expect(lookup.declarations).toEqual([]);
        expect(lookup.suggestions).toEqual(['ICliCommandProcessor']);
        expect(formatLookup('CommandProcessor', lookup)).toBe(
            'No declaration named "CommandProcessor" in @qodalis/cli-core@9.9.9 from test. Similar names: ICliCommandProcessor.',
        );
        expect(formatLookup('Zzz', lookupSymbol(types(), 'Zzz'))).toMatch(/qcli_docs_search/);
    });
});

describe('package names and entries', () => {
    it('normalizes @qodalis package names and refuses others', () => {
        expect(normalizePackageName(undefined)).toBe('@qodalis/cli-core');
        expect(normalizePackageName(' ')).toBe('@qodalis/cli-core');
        expect(normalizePackageName('cli')).toBe('@qodalis/cli');
        expect(normalizePackageName('@qodalis/angular-cli')).toBe('@qodalis/angular-cli');
        expect(() => normalizePackageName('@evil/pkg')).toThrow(/not a @qodalis package/);
        expect(() => normalizePackageName('../../etc')).toThrow(/not a @qodalis package/);
    });

    it('reads the declaration entry from package.json', () => {
        expect(typesEntry({ types: './public-api.d.ts' })).toBe('public-api.d.ts');
        expect(typesEntry({ typings: 'lib/index.d.ts' })).toBe('lib/index.d.ts');
        expect(typesEntry({ exports: { '.': { types: './x.d.ts' } } })).toBe('x.d.ts');
        expect(typesEntry({})).toBe('index.d.ts');
    });

    it('follows relative re-exports across files', async () => {
        const read = vi.fn(
            async (file: string) => ({ 'index.d.ts': SAMPLE, 'extra.d.ts': EXTRA })[file],
        );
        const files = await collectTypeFiles('index.d.ts', read);
        expect([...files.keys()]).toEqual(['index.d.ts', 'extra.d.ts']);
        expect(lookupSymbol(types(Object.fromEntries(files)), 'ICliExtra').declarations[0]).toEqual(
            {
                file: 'extra.d.ts',
                text: '/** From a second file. */\nexport interface ICliExtra {\n    extra: boolean;\n}',
            },
        );
    });
});

/** A fake registry + CDN serving one version of @qodalis/cli-core. */
const fakeNetwork = (version = '2.0.0') => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
        urls.push(url);
        if (url === `https://registry.test/@qodalis/cli-core/latest`) {
            return new Response(JSON.stringify({ types: './public-api.d.ts', version }));
        }
        if (url === `https://cdn.test/@qodalis/cli-core@${version}/public-api.d.ts`) {
            return new Response(SAMPLE);
        }
        return new Response('not found', { status: 404 });
    });
    return { fetch: fetchFn as unknown as typeof fetch, urls };
};

describe('ApiSource resolution order (no network)', () => {
    it('prefers the project node_modules, searching parent directories', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'mcp-cli-api-'));
        const pkg = path.join(root, 'node_modules', '@qodalis', 'cli-core');
        mkdirSync(pkg, { recursive: true });
        writeFileSync(
            path.join(pkg, 'package.json'),
            JSON.stringify({ types: './index.d.ts', version: '1.2.3' }),
        );
        writeFileSync(path.join(pkg, 'index.d.ts'), SAMPLE);
        writeFileSync(path.join(pkg, 'extra.d.ts'), EXTRA);
        const nested = path.join(root, 'src', 'app');
        mkdirSync(nested, { recursive: true });
        const net = fakeNetwork();
        const source = new ApiSource({ cacheDir: null, cwd: nested, fetch: net.fetch });
        const result = await source.get('@qodalis/cli-core');
        expect(result.version).toBe('1.2.3');
        expect(result.source).toBe(`node_modules (${pkg})`);
        expect([...result.files.keys()]).toEqual(['index.d.ts', 'extra.d.ts']);
        expect(net.urls).toEqual([]);
    });

    it('downloads latest through the CDN, then reuses memory and the temp-dir cache', async () => {
        const cacheDir = mkdtempSync(path.join(tmpdir(), 'mcp-cli-cache-'));
        const empty = mkdtempSync(path.join(tmpdir(), 'mcp-cli-empty-'));
        const net = fakeNetwork('2.0.0');
        const options = {
            cacheDir,
            cdns: ['https://cdn.test'],
            cwd: empty,
            fetch: net.fetch,
            registryUrl: 'https://registry.test',
        };
        const source = new ApiSource(options);
        const first = await source.get('@qodalis/cli-core');
        expect(first.source).toBe('https://cdn.test/@qodalis/cli-core@2.0.0');
        expect(await source.get('@qodalis/cli-core')).toBe(first);
        // The entry, then the probes for its `export * from './extra'` (404 here).
        expect(net.urls).toEqual([
            'https://registry.test/@qodalis/cli-core/latest',
            'https://cdn.test/@qodalis/cli-core@2.0.0/public-api.d.ts',
            'https://cdn.test/@qodalis/cli-core@2.0.0/extra.d.ts',
            'https://cdn.test/@qodalis/cli-core@2.0.0/extra.d.mts',
            'https://cdn.test/@qodalis/cli-core@2.0.0/extra/index.d.ts',
        ]);

        // A new process: the registry says 2.0.0, the files come from the temp-dir cache.
        const again = await new ApiSource(options).get('@qodalis/cli-core');
        expect(again.source).toMatch(/^cache \(/);
        expect(net.urls).toHaveLength(6);
        expect(net.urls.at(-1)).toBe('https://registry.test/@qodalis/cli-core/latest');

        // Offline: the newest cached version is used.
        const logs: string[] = [];
        const offline = new ApiSource({
            ...options,
            fetch: (async () => {
                throw new TypeError('fetch failed');
            }) as unknown as typeof fetch,
            log: (m) => logs.push(m),
        });
        expect((await offline.get('@qodalis/cli-core')).version).toBe('2.0.0');
        expect(logs[0]).toMatch(
            /registry unavailable \(fetch failed\); using cached @qodalis\/cli-core@2.0.0/,
        );
    });

    it('tries the next CDN and reports failures without caching them', async () => {
        const empty = mkdtempSync(path.join(tmpdir(), 'mcp-cli-empty-'));
        const net = fakeNetwork('3.0.0');
        const source = new ApiSource({
            cacheDir: null,
            cdns: ['https://down.test', 'https://cdn.test'],
            cwd: empty,
            fetch: net.fetch,
            registryUrl: 'https://registry.test',
        });
        expect((await source.get('@qodalis/cli-core')).source).toBe(
            'https://cdn.test/@qodalis/cli-core@3.0.0',
        );
        await expect(source.get('@qodalis/unknown')).rejects.toThrow(/not published on npm/);
        const offline = new ApiSource({
            cacheDir: null,
            cwd: empty,
            fetch: (async () => {
                throw new TypeError('fetch failed');
            }) as unknown as typeof fetch,
        });
        await expect(offline.get('@qodalis/cli-core')).rejects.toThrow('fetch failed');
    });
});
