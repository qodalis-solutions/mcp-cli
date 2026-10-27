import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The plugin-development guide (`llms-full.txt`): plain markdown with a
 * `# Qodalis CLI plugin development` title, `## ` sections and `### ` topics,
 * each topic self-contained and starting with a one-line summary.
 */
export const DOCS_TITLE = '# Qodalis CLI plugin development';
/** How long fetched docs are reused before they are fetched again. */
export const DOCS_TTL_MS = 60 * 60_000;
/** After a failed download the URL is tried again after this long. */
export const DOCS_RETRY_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export type DocTopic = {
    /** Full markdown, heading included */
    content: string;
    section: string;
    /** First prose line after the heading */
    summary: string;
    title: string;
    /** `<section-slug>/<topic-slug>`, unique within the document */
    uri: string;
};

export type DocSection = {
    /** Full markdown of the section, topics included */
    content: string;
    slug: string;
    title: string;
    topics: DocTopic[];
};

export type Docs = {
    sections: DocSection[];
    /** Where the text came from, e.g. the URL or `bundled snapshot` */
    source: string;
    topics: DocTopic[];
};

export const slugify = (text: string): string =>
    text
        .toLowerCase()
        .replace(/[`'"]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'untitled';

const FENCE = /^\s*(```|~~~)/;

/** First prose line of a block: skips blank lines, code fences, tables and nested headings. */
const firstProseLine = (lines: string[]): string => {
    let inFence = false;
    for (const line of lines) {
        if (FENCE.test(line)) {
            inFence = !inFence;
            continue;
        }
        const trimmed = line.trim();
        if (inFence || !trimmed || trimmed.startsWith('#') || trimmed.startsWith('|')) {
            continue;
        }
        return trimmed.replace(/^[-*>]\s+/, '');
    }
    return '';
};

/** Splits the guide into `## ` sections and `### ` topics; headings inside code fences are ignored. */
export const parseDocs = (markdown: string, source = 'inline'): Docs => {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const sections: DocSection[] = [];
    type Open = { lines: string[]; title: string };
    let section: (Open & { topics: Array<Open & { section: string }> }) | undefined;
    let topic: (Open & { section: string }) | undefined;
    const closed: Array<typeof section & object> = [];
    let inFence = false;
    for (const line of lines) {
        if (FENCE.test(line)) {
            inFence = !inFence;
        }
        const h2 = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
        const h3 = !inFence && !h2 && /^###\s+(.+?)\s*#*\s*$/.exec(line);
        if (h2 && !line.startsWith('###')) {
            if (section) {
                closed.push(section);
            }
            section = { lines: [line], title: h2[1]!, topics: [] };
            topic = undefined;
            continue;
        }
        if (h3 && section) {
            topic = { lines: [line], section: section.title, title: h3[1]! };
            section.topics.push(topic);
            section.lines.push(line);
            continue;
        }
        section?.lines.push(line);
        topic?.lines.push(line);
    }
    if (section) {
        closed.push(section);
    }
    const sectionSlugs = new Set<string>();
    for (const open of closed) {
        let slug = slugify(open.title);
        for (let n = 2; sectionSlugs.has(slug); n++) {
            slug = `${slugify(open.title)}-${n}`;
        }
        sectionSlugs.add(slug);
        const topicSlugs = new Set<string>();
        const topics = open.topics.map((t): DocTopic => {
            let topicSlug = slugify(t.title);
            for (let n = 2; topicSlugs.has(topicSlug); n++) {
                topicSlug = `${slugify(t.title)}-${n}`;
            }
            topicSlugs.add(topicSlug);
            return {
                content: t.lines.join('\n').trim(),
                section: open.title,
                summary: firstProseLine(t.lines.slice(1)),
                title: t.title,
                uri: `${slug}/${topicSlug}`,
            };
        });
        sections.push({ content: open.lines.join('\n').trim(), slug, title: open.title, topics });
    }
    return { sections, source, topics: sections.flatMap((s) => s.topics) };
};

const STOP_WORDS = new Set(
    'a an and are as at be by can do does for from how i in is it my of on or the to use using what when with'.split(
        ' ',
    ),
);

/** Lower-case search terms; `ICliModule`, `read-line` and `readLine` all stay searchable. */
export const searchTerms = (query: string): string[] => [
    ...new Set(
        query
            .toLowerCase()
            .split(/[^a-z0-9_.@/-]+/)
            .map((term) => term.replace(/^[-./]+|[-./]+$/g, ''))
            .filter((term) => term.length > 1 && !STOP_WORDS.has(term)),
    ),
];

const countOccurrences = (haystack: string, needle: string): number => {
    let count = 0;
    for (
        let i = haystack.indexOf(needle);
        i !== -1;
        i = haystack.indexOf(needle, i + needle.length)
    ) {
        count++;
    }
    return count;
};

export type SearchHit = { excerpt: string; score: number; topic: DocTopic };

/** A ~200-character line around the first body match. */
const excerptFor = (topic: DocTopic, terms: string[]): string => {
    const lines = topic.content.split('\n').slice(1);
    const line =
        lines.find((l) => terms.some((t) => l.toLowerCase().includes(t)) && l.trim()) ?? '';
    const trimmed = line.trim();
    if (trimmed.length <= 200) {
        return trimmed;
    }
    const at = Math.max(
        0,
        Math.min(...terms.map((t) => trimmed.toLowerCase().indexOf(t)).filter((i) => i >= 0)) - 60,
    );
    return `${at > 0 ? '…' : ''}${trimmed.slice(at, at + 200)}…`;
};

/**
 * Keyword ranking over topics: a term in the title weighs most, then the summary and
 * the section name, then occurrences in the body (capped); every matched term and an
 * exact phrase match add a bonus, so topics covering the whole query come first.
 */
export const searchDocs = (docs: Docs, query: string, limit = 5): SearchHit[] => {
    const terms = searchTerms(query);
    if (terms.length === 0) {
        return [];
    }
    const phrase = query.trim().toLowerCase();
    const hits: SearchHit[] = [];
    for (const topic of docs.topics) {
        const title = topic.title.toLowerCase();
        const summary = topic.summary.toLowerCase();
        const section = topic.section.toLowerCase();
        const body = topic.content.toLowerCase();
        let score = 0;
        let matched = 0;
        for (const term of terms) {
            const inBody = countOccurrences(body, term);
            if (inBody === 0) {
                continue;
            }
            matched++;
            score += title.includes(term) ? 10 : 0;
            score += summary.includes(term) ? 4 : 0;
            score += section.includes(term) ? 2 : 0;
            score += Math.min(inBody, 6);
        }
        if (matched === 0) {
            continue;
        }
        score += (matched - 1) * 5;
        score += phrase.length > 3 && body.includes(phrase) ? 8 : 0;
        hits.push({ excerpt: excerptFor(topic, terms), score, topic });
    }
    return hits
        .sort((a, b) => b.score - a.score || a.topic.uri.localeCompare(b.topic.uri))
        .slice(0, Math.max(1, limit));
};

const normalize = (text: string): string =>
    text.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

export type ReadResult =
    | { kind: 'section'; section: DocSection }
    | { kind: 'topics'; topics: DocTopic[] }
    | { kind: 'not-found' };

/**
 * A topic by heading (case-insensitive), `Section › Topic`, `Section/Topic` or its
 * resource path; a whole `## ` section by its heading; else a unique partial match.
 */
export const readDocs = (docs: Docs, query: string): ReadResult => {
    const wanted = normalize(query.replace(/^qcli-docs:\/\//, ''));
    if (!wanted) {
        return { kind: 'not-found' };
    }
    const byUri = docs.topics.find((t) => t.uri === wanted);
    if (byUri) {
        return { kind: 'topics', topics: [byUri] };
    }
    const qualified = /^(.+?)\s*(?:›|>|\/|::)\s*(.+)$/.exec(wanted);
    if (qualified) {
        const [, sectionName, topicName] = qualified;
        const found = docs.topics.filter(
            (t) =>
                (normalize(t.section) === sectionName || slugify(t.section) === sectionName) &&
                (normalize(t.title) === topicName || slugify(t.title) === topicName),
        );
        if (found.length > 0) {
            return { kind: 'topics', topics: found };
        }
    }
    const exact = docs.topics.filter((t) => normalize(t.title) === wanted);
    if (exact.length > 0) {
        return { kind: 'topics', topics: exact };
    }
    const section = docs.sections.find((s) => normalize(s.title) === wanted || s.slug === wanted);
    if (section) {
        return { kind: 'section', section };
    }
    const partial = docs.topics.filter((t) => normalize(t.title).includes(wanted));
    if (partial.length === 1) {
        return { kind: 'topics', topics: partial };
    }
    return { kind: 'not-found' };
};

/** `Section › Topic` lines, grouped by section, for "not found" answers. */
export const listTopics = (docs: Docs): string =>
    docs.sections
        .map(
            (s) =>
                `## ${s.title}\n${s.topics.map((t) => `- ${t.title}${t.summary ? `: ${t.summary}` : ''}`).join('\n')}`,
        )
        .join('\n\n');

/** The `docs/llms-full.txt` bundled with the package (one or two levels above this file). */
export const readBundledDocs = (): string => {
    for (const candidate of ['../../docs/llms-full.txt', '../../../docs/llms-full.txt']) {
        try {
            return readFileSync(fileURLToPath(new URL(candidate, import.meta.url)), 'utf8');
        } catch {
            // try the next location
        }
    }
    throw new Error('The bundled docs snapshot (docs/llms-full.txt) is missing.');
};

export type DocsSourceOptions = {
    /** Overrides the HTTP client (tests) */
    fetch?: typeof fetch;
    log?: (message: string) => void;
    now?: () => number;
    /** Overrides the bundled snapshot (tests) */
    snapshot?: () => string;
    ttlMs?: number;
    url: string;
};

/**
 * The guide from `url` (cached for {@link DOCS_TTL_MS}), falling back to the last good
 * download and then to the bundled snapshot, so the tools work offline and before the
 * site publishes the file. A response that is not the guide (an HTML page) is ignored.
 */
export class DocsSource {
    private cached: { docs: Docs; expires: number } | undefined;
    private downloaded: Docs | undefined;
    private loading: Promise<Docs> | undefined;
    private snapshotDocs: Docs | undefined;

    constructor(private readonly options: DocsSourceOptions) {}

    async get(): Promise<Docs> {
        const now = (this.options.now ?? Date.now)();
        if (this.cached && now < this.cached.expires) {
            return this.cached.docs;
        }
        this.loading ??= this.load(now).finally(() => (this.loading = undefined));
        return this.loading;
    }

    private async load(now: number): Promise<Docs> {
        const { url } = this.options;
        try {
            const response = await (this.options.fetch ?? fetch)(url, {
                headers: { accept: 'text/plain, text/markdown;q=0.9, */*;q=0.1' },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const text = await response.text();
            if (!text.trimStart().startsWith(DOCS_TITLE)) {
                throw new Error(`not the plugin-development guide (expected "${DOCS_TITLE}")`);
            }
            this.downloaded = parseDocs(text, url);
            this.cached = {
                docs: this.downloaded,
                expires: now + (this.options.ttlMs ?? DOCS_TTL_MS),
            };
            return this.downloaded;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            let docs = this.downloaded;
            if (docs) {
                this.options.log?.(`docs: ${url} failed (${reason}); reusing the last download`);
            } else {
                this.options.log?.(`docs: ${url} failed (${reason}); using the bundled snapshot`);
                docs = this.snapshotDocs ??= parseDocs(
                    (this.options.snapshot ?? readBundledDocs)(),
                    'bundled snapshot',
                );
            }
            this.cached = { docs, expires: now + DOCS_RETRY_MS };
            return docs;
        }
    }
}
