import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * `qcli_api`: TypeScript declarations of the published `@qodalis/*` packages, read from
 * the project's node_modules when installed there, otherwise from the npm registry
 * (`latest`) through a CDN, cached in memory and in a temp directory.
 */
export const DEFAULT_API_PACKAGE = '@qodalis/cli-core';
const FETCH_TIMEOUT_MS = 15_000;
/** Most `.d.ts` files followed through relative re-exports of one package. */
const MAX_FILES = 400;

/** `cli-core`, `@qodalis/cli-core` → `@qodalis/cli-core`; anything outside @qodalis is refused. */
export const normalizePackageName = (input: string | undefined): string => {
    const name = (input ?? '').trim() || DEFAULT_API_PACKAGE;
    const full = name.startsWith('@') ? name : `@qodalis/${name}`;
    if (!/^@qodalis\/[a-z0-9][a-z0-9._-]*$/.test(full)) {
        throw new Error(
            `"${input}" is not a @qodalis package name (e.g. @qodalis/cli-core, @qodalis/cli).`,
        );
    }
    return full;
};

// ---------------------------------------------------------------- extraction

export type Declaration = {
    /** The declaration with its JSDoc, as written in the .d.ts */
    text: string;
    /** File it came from, relative to the package root */
    file: string;
};

const KEYWORDS = 'interface|type|class|function|enum|const|let|var|namespace|module';
const DECLARATION = new RegExp(
    `^(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:const\\s+(?=enum))?(${KEYWORDS})\\s+([A-Za-z_$][\\w$]*)`,
);
const BLOCK_KINDS = new Set(['interface', 'class', 'enum', 'namespace', 'module']);

/**
 * `source` with comments, strings and template literals replaced by spaces (newlines
 * kept), so offsets match the original and braces in JSDoc or string types do not count.
 */
export const blankNonCode = (source: string): string => {
    const out = source.split('');
    const blank = (from: number, to: number): void => {
        for (let k = from; k < to && k < out.length; k++) {
            if (out[k] !== '\n') {
                out[k] = ' ';
            }
        }
    };
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        const next = source[i + 1];
        if (ch === '/' && next === '/') {
            const eol = source.indexOf('\n', i);
            const end = eol === -1 ? source.length : eol;
            blank(i, end);
            i = end - 1;
        } else if (ch === '/' && next === '*') {
            const close = source.indexOf('*/', i + 2);
            const end = close === -1 ? source.length : close + 2;
            blank(i, end);
            i = end - 1;
        } else if (ch === '"' || ch === "'" || ch === '`') {
            let j = i + 1;
            for (; j < source.length && source[j] !== ch; j++) {
                if (source[j] === '\\') {
                    j++;
                }
            }
            blank(i + 1, j);
            i = j;
        }
    }
    return out.join('');
};

/**
 * End offset of the declaration starting at `start` in comment-free `code`: a block
 * declaration ends at the `}` that closes its body, anything else at the first `;`
 * outside brackets (or at the end of a balanced line followed by a new statement).
 */
const declarationEnd = (code: string, start: number, block: boolean): number => {
    let depth = 0;
    let opened = false;
    for (let i = start; i < code.length; i++) {
        const ch = code[i];
        const arrow = code[i - 1] === '=';
        if (ch === '{' || ch === '(' || ch === '[' || (ch === '<' && !arrow)) {
            depth++;
            opened ||= ch === '{';
        } else if (ch === '}' || ch === ')' || ch === ']' || (ch === '>' && !arrow)) {
            depth = Math.max(0, depth - 1);
            if (block && opened && depth === 0 && ch === '}') {
                return i + 1;
            }
        } else if (depth === 0 && ch === ';') {
            return i + 1;
        } else if (depth === 0 && !block && ch === '\n') {
            const rest = code.slice(i + 1, i + 200).trimStart();
            if (rest === '' || /^(export|declare|interface|type|import|abstract)\b/.test(rest)) {
                return i;
            }
        }
    }
    return code.length;
};

/** Start of the JSDoc block directly above `start` (at most one line break between), else `start`. */
const leadingDoc = (source: string, start: number): number => {
    const before = source.slice(0, start).trimEnd();
    if (!before.endsWith('*/')) {
        return start;
    }
    const open = before.lastIndexOf('/**');
    if (open === -1 || before.slice(open + 3, -2).includes('*/')) {
        return start;
    }
    const gap = source.slice(before.length, start);
    return gap.split('\n').length <= 2 ? open : start;
};

/** Top-level declarations in `source`: kind, name and start offset. */
const topLevel = (source: string): Array<{ kind: string; name: string; start: number }> => {
    const code = blankNonCode(source);
    const found: Array<{ kind: string; name: string; start: number }> = [];
    let depth = 0;
    let offset = 0;
    for (const line of code.split('\n')) {
        if (depth === 0) {
            const trimmed = line.trimStart();
            const match = DECLARATION.exec(trimmed);
            if (match) {
                found.push({
                    kind: match[1]!,
                    name: match[2]!,
                    start: offset + line.length - trimmed.length,
                });
            }
        }
        for (const ch of line) {
            depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
        }
        depth = Math.max(0, depth);
        offset += line.length + 1;
    }
    return found;
};

/** Every top-level declaration of `symbol` in `source` (overloads and merged interfaces included). */
export const extractDeclarations = (source: string, symbol: string): string[] => {
    const code = blankNonCode(source);
    return topLevel(source)
        .filter((d) => d.name === symbol)
        .map((d) =>
            source
                .slice(
                    leadingDoc(source, d.start),
                    declarationEnd(code, d.start, BLOCK_KINDS.has(d.kind)),
                )
                .trim(),
        );
};

/** Names of every top-level declaration in the files. */
export const declaredNames = (sources: string[]): Set<string> =>
    new Set(sources.flatMap((source) => topLevel(source).map((d) => d.name)));

/** `export { Local as Symbol }` aliases: the local name a public symbol is declared under. */
export const aliasOf = (sources: string[], symbol: string): string | undefined => {
    for (const source of sources) {
        for (const list of source.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
            for (const entry of list[1]!.split(',')) {
                const m = /^\s*(?:type\s+)?([\w$]+)\s+as\s+([\w$]+)\s*$/.exec(entry);
                if (m && m[2] === symbol && m[1] !== symbol) {
                    return m[1];
                }
            }
        }
    }
    return undefined;
};

/** Relative module specifiers a .d.ts imports or re-exports from. */
const relativeSpecifiers = (source: string): string[] =>
    [...source.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]!);

export type TypeFiles = {
    /** Relative path → content */
    files: Map<string, string>;
    package: string;
    /** `node_modules (<path>)`, `cache`, `https://…` */
    source: string;
    version: string;
};

export type ApiLookup = {
    declarations: Declaration[];
    /** Declared names referenced by the declarations, to look up next */
    related: string[];
    /** Close names when nothing matched */
    suggestions: string[];
    types: TypeFiles;
};

/** Finds `symbol` in the package's declaration files. */
export const lookupSymbol = (types: TypeFiles, symbol: string): ApiLookup => {
    const sources = [...types.files.values()];
    const find = (name: string): Declaration[] =>
        [...types.files].flatMap(([file, content]) =>
            extractDeclarations(content, name).map((text) => ({ file, text })),
        );
    let declarations = find(symbol);
    if (declarations.length === 0) {
        const local = aliasOf(sources, symbol);
        if (local) {
            declarations = find(local);
        }
    }
    const names = declaredNames(sources);
    const related = new Set<string>();
    for (const { text } of declarations) {
        for (const word of text.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []) {
            if (word !== symbol && names.has(word)) {
                related.add(word);
            }
        }
    }
    const lower = symbol.toLowerCase();
    const suggestions =
        declarations.length > 0
            ? []
            : [...names]
                  .filter((n) => {
                      const candidate = n.toLowerCase();
                      return (
                          candidate.includes(lower) ||
                          (candidate.length > 3 && lower.includes(candidate))
                      );
                  })
                  .sort((a, b) => a.length - b.length || a.localeCompare(b))
                  .slice(0, 15);
    return { declarations, related: [...related].sort(), suggestions, types };
};

// ---------------------------------------------------------------- resolution

type PackageJson = {
    exports?: unknown;
    name?: string;
    types?: string;
    typings?: string;
    version?: string;
};

/** The declaration entry of a package.json: `types`, `typings`, `exports["."].types`. */
export const typesEntry = (pkg: PackageJson): string => {
    const dot = (pkg.exports as Record<string, unknown> | undefined)?.['.'];
    const fromExports =
        dot && typeof dot === 'object'
            ? ((dot as Record<string, unknown>)['types'] as string | undefined)
            : undefined;
    return (pkg.types ?? pkg.typings ?? fromExports ?? 'index.d.ts').replace(/^\.\//, '');
};

/** `x.js` / `x` / `x/` → candidate declaration paths. */
const declarationCandidates = (specifier: string): string[] => {
    const base = specifier.replace(/\.(m|c)?js$/, '');
    return [`${base}.d.ts`, `${base}.d.mts`, `${base}/index.d.ts`, specifier];
};

/**
 * Loads the entry file and every .d.ts reachable through relative imports/re-exports
 * with `read` (returns undefined for a missing file).
 */
export const collectTypeFiles = async (
    entry: string,
    read: (relativePath: string) => Promise<string | undefined>,
): Promise<Map<string, string>> => {
    const files = new Map<string, string>();
    const tried = new Set<string>();
    const queue: string[][] = [[entry]];
    while (queue.length > 0 && files.size < MAX_FILES) {
        const candidates = queue.shift()!.filter((c) => !tried.has(c));
        candidates.forEach((c) => tried.add(c));
        for (const candidate of candidates) {
            const content = await read(candidate);
            if (content === undefined) {
                continue;
            }
            files.set(candidate, content);
            for (const specifier of relativeSpecifiers(content)) {
                queue.push(
                    declarationCandidates(
                        path.posix.normalize(
                            path.posix.join(path.posix.dirname(candidate), specifier),
                        ),
                    ),
                );
            }
            break;
        }
    }
    return files;
};

/** `<dir>/node_modules/<pkg>` for `dir` and each of its parents. */
export const findInstalledPackage = (cwd: string, name: string): string | undefined => {
    let dir = path.resolve(cwd);
    for (;;) {
        const candidate = path.join(dir, 'node_modules', ...name.split('/'));
        if (existsSync(path.join(candidate, 'package.json'))) {
            return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
};

const readLocal = (root: string) => async (relative: string) => {
    const full = path.join(root, relative);
    if (!full.startsWith(root) || !full.match(/\.d\.(m|c)?ts$/)) {
        return undefined;
    }
    try {
        return readFileSync(full, 'utf8');
    } catch {
        return undefined;
    }
};

export type ApiSourceOptions = {
    /** Project directory searched for node_modules (default: process.cwd()) */
    cwd?: string;
    /** Overrides the HTTP client (tests) */
    fetch?: typeof fetch;
    log?: (message: string) => void;
    /** Directory for downloaded declarations (default: `<os tmp>/qodalis-mcp-cli`); null disables it */
    cacheDir?: string | null;
    registryUrl?: string;
    /** CDN base URLs tried in order; `<base>/<name>@<version>/<file>` */
    cdns?: string[];
};

const DEFAULT_CDNS = ['https://cdn.jsdelivr.net/npm', 'https://unpkg.com'];

/**
 * Resolves a package's declaration files: (1) the project's node_modules, (2) an
 * in-memory copy, (3) the registry's `latest` version from the temp-dir cache or a CDN,
 * (4) without network, the newest version in the temp-dir cache.
 */
export class ApiSource {
    private readonly memory = new Map<string, Promise<TypeFiles>>();

    constructor(private readonly options: ApiSourceOptions = {}) {}

    get(name: string): Promise<TypeFiles> {
        const local = findInstalledPackage(this.options.cwd ?? process.cwd(), name);
        if (local) {
            return this.fromDirectory(name, local);
        }
        let pending = this.memory.get(name);
        if (!pending) {
            pending = this.download(name);
            this.memory.set(name, pending);
            pending.catch(() => this.memory.delete(name));
        }
        return pending;
    }

    private async fromDirectory(name: string, root: string): Promise<TypeFiles> {
        const pkg = JSON.parse(
            readFileSync(path.join(root, 'package.json'), 'utf8'),
        ) as PackageJson;
        const files = await collectTypeFiles(typesEntry(pkg), readLocal(root));
        if (files.size === 0) {
            throw new Error(`${name} in ${root} has no declaration files.`);
        }
        return {
            files,
            package: name,
            source: `node_modules (${root})`,
            version: pkg.version ?? '?',
        };
    }

    private get cacheDir(): string | undefined {
        return this.options.cacheDir === null
            ? undefined
            : (this.options.cacheDir ?? path.join(tmpdir(), 'qodalis-mcp-cli'));
    }

    private async fetchText(url: string): Promise<string | undefined> {
        const response = await (this.options.fetch ?? fetch)(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (response.status === 404) {
            return undefined;
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} from ${url}`);
        }
        return response.text();
    }

    private async download(name: string): Promise<TypeFiles> {
        const registry = this.options.registryUrl ?? 'https://registry.npmjs.org';
        let manifest: PackageJson;
        try {
            const text = await this.fetchText(`${registry}/${name}/latest`);
            if (text === undefined) {
                throw new Error(`${name} is not published on npm.`);
            }
            manifest = JSON.parse(text) as PackageJson;
        } catch (error) {
            const cached = this.newestCached(name);
            if (cached) {
                this.options.log?.(
                    `api: registry unavailable (${(error as Error).message}); using cached ${name}@${cached.version}`,
                );
                return cached;
            }
            throw error;
        }
        const version = manifest.version ?? 'latest';
        const fromCache = this.readCache(name, version);
        if (fromCache) {
            return fromCache;
        }
        const entry = typesEntry(manifest);
        let lastError: unknown;
        for (const cdn of this.options.cdns ?? DEFAULT_CDNS) {
            try {
                const base = `${cdn}/${name}@${version}`;
                const files = await collectTypeFiles(entry, async (file) =>
                    /\.d\.(m|c)?ts$/.test(file) ? this.fetchText(`${base}/${file}`) : undefined,
                );
                if (files.size === 0) {
                    throw new Error(`no declaration file at ${base}/${entry}`);
                }
                const types: TypeFiles = { files, package: name, source: base, version };
                this.writeCache(types);
                return types;
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private cacheFile(name: string, version: string): string | undefined {
        const dir = this.cacheDir;
        return dir ? path.join(dir, `${name.replace('/', '__')}@${version}.json`) : undefined;
    }

    private readCache(name: string, version: string): TypeFiles | undefined {
        const file = this.cacheFile(name, version);
        try {
            if (!file || !existsSync(file)) {
                return undefined;
            }
            const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
            return {
                files: new Map(Object.entries(data)),
                package: name,
                source: `cache (${file})`,
                version,
            };
        } catch {
            return undefined;
        }
    }

    private writeCache(types: TypeFiles): void {
        const file = this.cacheFile(types.package, types.version);
        if (!file) {
            return;
        }
        try {
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, JSON.stringify(Object.fromEntries(types.files)));
        } catch (error) {
            this.options.log?.(`api: could not cache declarations (${(error as Error).message})`);
        }
    }

    private newestCached(name: string): TypeFiles | undefined {
        const dir = this.cacheDir;
        if (!dir || !existsSync(dir)) {
            return undefined;
        }
        const prefix = `${name.replace('/', '__')}@`;
        const versions = readdirSync(dir)
            .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
            .map((f) => f.slice(prefix.length, -'.json'.length))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const newest = versions.at(-1);
        return newest ? this.readCache(name, newest) : undefined;
    }
}

/** Markdown answer for `qcli_api`. */
export const formatLookup = (symbol: string, lookup: ApiLookup): string => {
    const { types } = lookup;
    const origin = `${types.package}@${types.version} from ${types.source}`;
    if (lookup.declarations.length === 0) {
        const hint = lookup.suggestions.length
            ? `Similar names: ${lookup.suggestions.join(', ')}.`
            : 'Search the docs with qcli_docs_search, or try package "@qodalis/cli".';
        return `No declaration named "${symbol}" in ${origin}. ${hint}`;
    }
    const blocks = lookup.declarations.map((d) => `\`\`\`ts\n// ${d.file}\n${d.text}\n\`\`\``);
    const related = lookup.related.length
        ? `\n\nRelated declarations (look up with qcli_api): ${lookup.related.join(', ')}`
        : '';
    return `# ${symbol}\n\n${origin}\n\n${blocks.join('\n\n')}${related}`;
};
