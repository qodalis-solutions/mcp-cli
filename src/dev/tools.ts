import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { isToolAllowed } from '../filters.js';
import {
    ApiSource,
    formatLookup,
    lookupSymbol,
    normalizePackageName,
    type ApiSourceOptions,
} from './api.js';
import {
    DocsSource,
    listTopics,
    readDocs,
    searchDocs,
    type Docs,
    type DocsSourceOptions,
} from './docs.js';
import { getPrompt, PROMPTS, type PromptContext } from './prompts.js';
import { planScaffold, scaffoldPlugin, type Runner } from './scaffold.js';

export const DOCS_RESOURCE_SCHEME = 'qcli-docs://';

/** The local plugin-development tools, served without a Qodalis CLI server. */
export const DEV_TOOLS: Tool[] = [
    {
        annotations: { openWorldHint: true, readOnlyHint: true, title: 'Search the plugin docs' },
        description:
            'Search the Qodalis CLI plugin-development guide (web plugins, server plugins, recipes). Returns the best matching topics as "Section › Topic" with their summary and an excerpt; read one in full with qcli_docs_read.',
        inputSchema: {
            properties: {
                limit: {
                    description: 'Maximum number of topics (default 5, at most 20)',
                    maximum: 20,
                    minimum: 1,
                    type: 'integer',
                },
                query: {
                    description:
                        'Keywords, e.g. "read user input", "register module", "ICliExecutionContext"',
                    type: 'string',
                },
            },
            required: ['query'],
            type: 'object',
        },
        name: 'qcli_docs_search',
    },
    {
        annotations: { openWorldHint: true, readOnlyHint: true, title: 'Read a plugin docs topic' },
        description:
            'Read a topic of the Qodalis CLI plugin-development guide in full (markdown with code samples). Pass a topic heading (case-insensitive), "Section › Topic" when a heading exists in several sections, or a section name ("Web plugins") for the whole section. Lists the topics when nothing matches.',
        inputSchema: {
            properties: {
                topic: {
                    description: 'Topic heading, "Section › Topic", or a section name',
                    type: 'string',
                },
            },
            required: ['topic'],
            type: 'object',
        },
        name: 'qcli_docs_read',
    },
    {
        annotations: { openWorldHint: true, readOnlyHint: true, title: 'Look up a Qodalis API' },
        description:
            "TypeScript declaration (with JSDoc) of an interface, type, class, function, enum or constant from the published @qodalis packages: the project's node_modules when installed, else the latest version on npm. Use it for exact member names and signatures, e.g. ICliCommandProcessor, ICliExecutionContext, ICliModule, ICliInputReader, CliProcessCommand.",
        inputSchema: {
            properties: {
                package: {
                    description:
                        'Package to read (default @qodalis/cli-core; also @qodalis/cli, @qodalis/angular-cli, ...). "cli-core" is short for @qodalis/cli-core.',
                    type: 'string',
                },
                symbol: { description: 'Exported name, case-sensitive', type: 'string' },
            },
            required: ['symbol'],
            type: 'object',
        },
        name: 'qcli_api',
    },
    {
        annotations: {
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true,
            readOnlyHint: false,
            title: 'Scaffold a Qodalis CLI plugin',
        },
        description:
            'Create a new web CLI plugin with @qodalis/create-cli-plugin (npx): processor, module, build config and tests. Inside a web-cli checkout it goes to packages/plugins/<name>; elsewhere to a standalone qodalis-cli-<name> project with its dependencies installed. Returns the created files and next steps.',
        inputSchema: {
            properties: {
                description: { description: 'One-line description of the plugin', type: 'string' },
                directory: {
                    description:
                        'Directory to run in (default: the current working directory of the MCP server)',
                    type: 'string',
                },
                name: {
                    description:
                        'Plugin name: lowercase letters, digits and hyphens, without a "cli-" prefix (package @qodalis/cli-<name>)',
                    type: 'string',
                },
                processorName: {
                    description:
                        'PascalCase processor name (class Cli<processorName>CommandProcessor); default derived from name',
                    type: 'string',
                },
            },
            required: ['name'],
            type: 'object',
        },
        name: 'qcli_scaffold_plugin',
    },
];

export const DEV_TOOL_NAMES = new Set(DEV_TOOLS.map((t) => t.name));

export type DevToolsOptions = {
    api?: ApiSourceOptions;
    docs?: Partial<DocsSourceOptions>;
    log?: (message: string) => void;
    /** Runs npx (tests) */
    runner?: Runner;
    scaffoldTimeoutMs?: number;
};

const text = (value: string, isError = false): CallToolResult => ({
    content: [{ text: value, type: 'text' }],
    ...(isError ? { isError: true } : {}),
});

const stringArg = (
    args: Record<string, unknown>,
    name: string,
    required = false,
): string | undefined => {
    const value = args[name];
    if (value === undefined || value === null || value === '') {
        if (required) {
            throw new Error(`Missing required argument "${name}".`);
        }
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(`Argument "${name}" must be a string.`);
    }
    return value;
};

/** Docs, API and scaffold tools plus the prompts and docs resources, filtered by the config. */
export class DevTools {
    readonly docs: DocsSource;
    readonly api: ApiSource;

    constructor(
        private readonly config: Config,
        private readonly options: DevToolsOptions = {},
    ) {
        this.docs = new DocsSource({
            url: config.docsUrl,
            ...(options.log ? { log: options.log } : {}),
            ...options.docs,
        });
        this.api = new ApiSource({ ...(options.log ? { log: options.log } : {}), ...options.api });
    }

    /** The dev tools that pass QCLI_READ_ONLY / QCLI_TOOLS / QCLI_EXCLUDE. */
    tools(): Tool[] {
        return DEV_TOOLS.filter((tool) => isToolAllowed(tool, this.config));
    }

    has(name: string): boolean {
        return DEV_TOOL_NAMES.has(name);
    }

    /** Why a dev tool is hidden, or undefined when it is available. */
    hiddenReason(name: string): string | undefined {
        const tool = DEV_TOOLS.find((t) => t.name === name);
        if (!tool || isToolAllowed(tool, this.config)) {
            return undefined;
        }
        return this.config.readOnly && tool.annotations?.readOnlyHint !== true
            ? `Tool ${name} is not available: QCLI_READ_ONLY allows only read-only tools.`
            : `Tool ${name} is not available: excluded by QCLI_TOOLS / QCLI_EXCLUDE.`;
    }

    async call(
        name: string,
        args: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<CallToolResult> {
        try {
            switch (name) {
                case 'qcli_docs_search':
                    return await this.search(args);
                case 'qcli_docs_read':
                    return await this.read(args);
                case 'qcli_api':
                    return await this.lookup(args);
                case 'qcli_scaffold_plugin':
                    return await this.scaffold(args, signal);
                default:
                    return text(`Unknown tool: ${name}`, true);
            }
        } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
        }
    }

    private async search(args: Record<string, unknown>): Promise<CallToolResult> {
        const query = stringArg(args, 'query', true)!;
        const rawLimit = args['limit'];
        const limit =
            typeof rawLimit === 'number' && Number.isFinite(rawLimit)
                ? Math.min(20, Math.max(1, Math.floor(rawLimit)))
                : 5;
        const docs = await this.docs.get();
        const hits = searchDocs(docs, query, limit);
        if (hits.length === 0) {
            return text(
                `No topic matches "${query}". Topics in the guide (${docs.source}):\n\n${listTopics(docs)}`,
            );
        }
        const lines = hits.map(
            (hit, i) =>
                `${i + 1}. **${hit.topic.section} › ${hit.topic.title}** (score ${hit.score})\n   ${hit.topic.summary}${hit.excerpt && hit.excerpt !== hit.topic.summary ? `\n   > ${hit.excerpt}` : ''}`,
        );
        return text(
            `${hits.length} topic(s) for "${query}" (source: ${docs.source}). Read one with qcli_docs_read and its "Section › Topic".\n\n${lines.join('\n')}`,
        );
    }

    private async read(args: Record<string, unknown>): Promise<CallToolResult> {
        const topic = stringArg(args, 'topic', true)!;
        const docs = await this.docs.get();
        const result = readDocs(docs, topic);
        if (result.kind === 'section') {
            return text(result.section.content);
        }
        if (result.kind === 'topics') {
            return text(
                result.topics
                    .map((t) =>
                        result.topics.length > 1
                            ? `<!-- ${t.section} › ${t.title} -->\n${t.content}`
                            : t.content,
                    )
                    .join('\n\n---\n\n'),
            );
        }
        return text(
            `No topic or section "${topic}" in the guide (${docs.source}). Available topics:\n\n${listTopics(docs)}`,
            true,
        );
    }

    private async lookup(args: Record<string, unknown>): Promise<CallToolResult> {
        const symbol = stringArg(args, 'symbol', true)!.trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) {
            return text(`"${symbol}" is not an identifier (e.g. ICliCommandProcessor).`, true);
        }
        const pkg = normalizePackageName(stringArg(args, 'package'));
        let types;
        try {
            types = await this.api.get(pkg);
        } catch (error) {
            return text(
                `Could not load the declarations of ${pkg}: ${(error as Error).message}. Install the package in the project (npm install ${pkg}) to work offline.`,
                true,
            );
        }
        const lookup = lookupSymbol(types, symbol);
        return text(formatLookup(symbol, lookup), lookup.declarations.length === 0);
    }

    private async scaffold(
        args: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<CallToolResult> {
        const reason = this.hiddenReason('qcli_scaffold_plugin');
        if (reason) {
            return text(reason, true);
        }
        const plan = planScaffold({
            description: stringArg(args, 'description'),
            directory: stringArg(args, 'directory'),
            name: stringArg(args, 'name', true)!,
            processorName: stringArg(args, 'processorName'),
        });
        this.options.log?.(`scaffold: npx ${plan.args.join(' ')} in ${plan.cwd}`);
        const result = await scaffoldPlugin(plan, {
            ...(this.options.runner ? { runner: this.options.runner } : {}),
            ...(this.options.scaffoldTimeoutMs
                ? { timeoutMs: this.options.scaffoldTimeoutMs }
                : {}),
            signal,
        });
        return text(result.text, result.isError);
    }

    // ------------------------------------------------------------ prompts

    prompts() {
        return PROMPTS;
    }

    getPrompt(name: string, args: Record<string, string> | undefined) {
        const ctx: PromptContext = { canScaffold: !this.hiddenReason('qcli_scaffold_plugin') };
        return getPrompt(name, args, ctx);
    }

    // ------------------------------------------------------------ resources

    async resources() {
        const docs = await this.docs.get();
        return docs.topics.map((t) => ({
            description: t.summary,
            mimeType: 'text/markdown',
            name: `${t.section} › ${t.title}`,
            title: t.title,
            uri: `${DOCS_RESOURCE_SCHEME}${t.uri}`,
        }));
    }

    /** The markdown of a `qcli-docs://<section>/<topic>` resource, or undefined. */
    async readResource(uri: string): Promise<string | undefined> {
        if (!uri.startsWith(DOCS_RESOURCE_SCHEME)) {
            return undefined;
        }
        const docs: Docs = await this.docs.get();
        const path = uri.slice(DOCS_RESOURCE_SCHEME.length);
        return docs.topics.find((t) => t.uri === path)?.content;
    }
}
