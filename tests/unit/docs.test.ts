import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    DOCS_RETRY_MS,
    DOCS_TTL_MS,
    DocsSource,
    listTopics,
    parseDocs,
    readBundledDocs,
    readDocs,
    searchDocs,
    searchTerms,
    slugify,
} from '../../src/dev/docs.js';

const FIXTURE = readFileSync(
    path.resolve(import.meta.dirname, '../fixtures/llms-full.txt'),
    'utf8',
);
const docs = parseDocs(FIXTURE, 'fixture');

describe('parseDocs', () => {
    it('splits sections and topics, ignoring headings inside code fences', () => {
        expect(docs.sections.map((s) => s.title)).toEqual([
            'Overview',
            'Web plugins',
            'Server plugins',
            'Recipes',
        ]);
        expect(docs.topics.map((t) => `${t.section} › ${t.title}`)).toEqual([
            'Overview › Architecture',
            'Web plugins › Command processors',
            'Web plugins › Reading input',
            'Web plugins › Testing',
            'Server plugins › Node.js processor',
            'Server plugins › Testing',
            'Recipes › Ask before a destructive action',
        ]);
        const processors = docs.topics[1]!;
        expect(processors.content).toContain('### also not a heading');
        expect(processors.content).toContain('Use `context.writer` to print output.');
        expect(processors.content).not.toContain('### Reading input');
    });

    it('takes the first prose line as the summary and builds unique resource paths', () => {
        expect(docs.topics[0]!.summary).toBe('Commands are processors registered through modules.');
        expect(docs.topics.map((t) => t.uri)).toContain('server-plugins/node-js-processor');
        expect(docs.topics.map((t) => t.uri)).toContain('web-plugins/testing');
        expect(docs.topics.map((t) => t.uri)).toContain('server-plugins/testing');
        expect(docs.sections[1]!.content).toContain('### Reading input');
    });

    it('makes duplicate slugs unique and handles CRLF', () => {
        const dup = parseDocs(
            '# T\r\n\r\n## A\r\n\r\n### X\r\n\r\none\r\n\r\n### X\r\n\r\ntwo\r\n',
        );
        expect(dup.topics.map((t) => t.uri)).toEqual(['a/x', 'a/x-2']);
        expect(dup.topics[1]!.summary).toBe('two');
        expect(slugify('`ICliModule` & friends!')).toBe('iclimodule-friends');
        expect(slugify('!!!')).toBe('untitled');
    });
});

describe('searchDocs', () => {
    it('ranks title matches first and returns an excerpt', () => {
        const hits = searchDocs(docs, 'reading input');
        expect(hits[0]!.topic.title).toBe('Reading input');
        expect(hits[0]!.excerpt).toBeTruthy();
    });

    it('finds symbols in code samples and honours the limit', () => {
        const hits = searchDocs(docs, 'ICliCommandProcessor', 1);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.topic.title).toBe('Command processors');
        expect(searchDocs(docs, 'testing', 10).map((h) => h.topic.uri)).toEqual([
            'server-plugins/testing',
            'web-plugins/testing',
        ]);
    });

    it('returns nothing for stop words or unknown terms', () => {
        expect(searchDocs(docs, 'the of and')).toEqual([]);
        expect(searchDocs(docs, 'kubernetes')).toEqual([]);
        expect(searchTerms('How do I use readLine, ICliModule?')).toEqual([
            'readline',
            'iclimodule',
        ]);
    });

    it('shortens long excerpts around the match', () => {
        const long = parseDocs(
            `# T\n\n## S\n\n### Long\n\nSummary.\n\n${'word '.repeat(80)}needle ${'tail '.repeat(80)}\n`,
        );
        const [hit] = searchDocs(long, 'needle');
        expect(hit!.excerpt.startsWith('…')).toBe(true);
        expect(hit!.excerpt).toContain('needle');
        expect(hit!.excerpt.length).toBeLessThanOrEqual(202);
    });
});

describe('readDocs', () => {
    it('matches a heading case-insensitively', () => {
        const result = readDocs(docs, 'reading INPUT');
        expect(result.kind === 'topics' && result.topics.map((t) => t.title)).toEqual([
            'Reading input',
        ]);
    });

    it('returns every topic with the same heading, or the qualified one', () => {
        const both = readDocs(docs, 'Testing');
        expect(both.kind === 'topics' && both.topics.length).toBe(2);
        for (const q of [
            'Server plugins › Testing',
            'server plugins/testing',
            'server-plugins/testing',
            'qcli-docs://server-plugins/testing',
        ]) {
            const one = readDocs(docs, q);
            expect(one.kind === 'topics' && one.topics.map((t) => t.section)).toEqual([
                'Server plugins',
            ]);
        }
    });

    it('returns a whole section, a unique partial match, or not-found', () => {
        const section = readDocs(docs, 'web plugins');
        expect(section.kind === 'section' && section.section.topics.length).toBe(3);
        const partial = readDocs(docs, 'destructive');
        expect(partial.kind === 'topics' && partial.topics[0]!.title).toBe(
            'Ask before a destructive action',
        );
        expect(readDocs(docs, 'processor').kind).toBe('not-found');
        expect(readDocs(docs, '  ').kind).toBe('not-found');
        expect(listTopics(docs)).toContain('## Recipes\n- Ask before a destructive action: ');
    });
});

const response = (body: string, status = 200): Response => new Response(body, { status });

describe('DocsSource', () => {
    it('fetches the URL, caches it for the TTL and refetches after', async () => {
        let now = 0;
        const fetchFn = vi.fn(async () => response(FIXTURE));
        const source = new DocsSource({
            fetch: fetchFn as unknown as typeof fetch,
            now: () => now,
            url: 'https://docs.test/llms-full.txt',
        });
        const [a, b] = await Promise.all([source.get(), source.get()]);
        expect(a).toBe(b);
        expect(a.source).toBe('https://docs.test/llms-full.txt');
        now = DOCS_TTL_MS - 1;
        await source.get();
        expect(fetchFn).toHaveBeenCalledTimes(1);
        now = DOCS_TTL_MS;
        await source.get();
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('falls back to the snapshot, ignores HTML pages and retries later', async () => {
        let now = 0;
        const logs: string[] = [];
        const fetchFn = vi
            .fn()
            .mockResolvedValueOnce(response('<!doctype html><html></html>'))
            .mockResolvedValueOnce(response(FIXTURE));
        const source = new DocsSource({
            fetch: fetchFn as unknown as typeof fetch,
            log: (m) => logs.push(m),
            now: () => now,
            snapshot: () => FIXTURE,
            url: 'https://docs.test/llms-full.txt',
        });
        expect((await source.get()).source).toBe('bundled snapshot');
        expect(logs[0]).toMatch(/not the plugin-development guide .*using the bundled snapshot$/);
        now = DOCS_RETRY_MS;
        expect((await source.get()).source).toBe('https://docs.test/llms-full.txt');
    });

    it('reuses the last download when the URL starts failing', async () => {
        let now = 0;
        const logs: string[] = [];
        const fetchFn = vi
            .fn()
            .mockResolvedValueOnce(response(FIXTURE))
            .mockResolvedValueOnce(response('gone', 500))
            .mockRejectedValueOnce(new TypeError('fetch failed'));
        const source = new DocsSource({
            fetch: fetchFn as unknown as typeof fetch,
            log: (m) => logs.push(m),
            now: () => now,
            snapshot: () => {
                throw new Error('snapshot must not be read');
            },
            ttlMs: 10,
            url: 'https://docs.test/x',
        });
        const first = await source.get();
        now = 10;
        expect(await source.get()).toBe(first);
        expect(logs).toEqual([
            'docs: https://docs.test/x failed (HTTP 500); reusing the last download',
        ]);
    });

    it('bundles a snapshot that follows the contract', () => {
        const bundled = parseDocs(readBundledDocs());
        expect(readBundledDocs().startsWith('# Qodalis CLI plugin development')).toBe(true);
        expect(bundled.sections.map((s) => s.title)).toEqual(
            expect.arrayContaining(['Overview', 'Web plugins', 'Server plugins', 'Recipes']),
        );
        expect(bundled.topics.every((t) => t.summary.length > 0)).toBe(true);
    });
});
