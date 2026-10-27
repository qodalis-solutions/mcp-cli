/**
 * Environment-driven configuration. Primary names use `QCLI_`; `QODALIS_CLI_`
 * is accepted as an alias for every key.
 */
export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

/** How the proxy authenticates to the Qodalis CLI server. */
export type AuthConfig =
    | { kind: 'none' }
    | { kind: 'token'; token: string }
    | { kind: 'password'; password: string; user: string };

export type Config = {
    auth: AuthConfig;
    connectionTimeoutMs: number;
    /** Expose the local plugin-development tools and prompts (`qcli_*`) */
    devTools: boolean;
    /** Where the plugin-development docs (`llms-full.txt`) are fetched from */
    docsUrl: string;
    /** Client-side deny-list (trailing `*` allowed), applied after `tools` */
    exclude: string[];
    /** Expose and allow only tools annotated `readOnlyHint: true` */
    readOnly: boolean;
    requestTimeoutMs: number;
    /** Client-side allow-list (trailing `*` allowed); empty = every tool */
    tools: string[];
    /** Accept self-signed TLS certificates */
    trustCert: boolean;
    /**
     * Server base URL, e.g. `https://cli.example.com` (no trailing slash). Without it
     * the process runs in developer mode: only the local plugin-development tools.
     */
    url: string | undefined;
};

export const DEFAULT_DOCS_URL = 'https://cli.qodalis.com/llms-full.txt';

export const PREFIXES = ['QCLI', 'QODALIS_CLI'];

/** `QCLI_<suffix>` plus the `QODALIS_CLI_<suffix>` alias. */
export const names = (suffix: string): string[] => PREFIXES.map((prefix) => `${prefix}_${suffix}`);

export const ENV_FILE_VARIABLES = names('ENV_FILE');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export type EnvReader = {
    boolean: (names: string[], fallback: boolean) => boolean;
    list: (names: string[]) => string[];
    optional: (names: string[]) => string | undefined;
    positiveInteger: (names: string[], fallback: number) => number;
    required: (names: string[]) => string;
};

/** Typed readers over an environment map; the first non-empty name wins. */
export const createEnvReader = (env: Env): EnvReader => {
    const optional = (names: string[]): string | undefined => {
        for (const name of names) {
            const value = env[name]?.trim();
            if (value) {
                return value;
            }
        }
        return undefined;
    };
    const describe = (names: string[]): string =>
        names.length > 1
            ? `${names[0]} (or its alias ${names.slice(1).join(' / ')})`
            : (names[0] ?? '');
    const required = (names: string[]): string => {
        const value = optional(names);
        if (!value) {
            throw new ConfigError(`${describe(names)} is required.`);
        }
        return value;
    };
    const boolean = (names: string[], fallback: boolean): boolean => {
        const value = optional(names);
        if (value === undefined) {
            return fallback;
        }
        const normalized = value.toLowerCase();
        if (TRUE_VALUES.has(normalized)) {
            return true;
        }
        if (FALSE_VALUES.has(normalized)) {
            return false;
        }
        throw new ConfigError(`${names[0]} must be a boolean (true/false), got "${value}".`);
    };
    const positiveInteger = (names: string[], fallback: number): number => {
        const value = optional(names);
        if (value === undefined) {
            return fallback;
        }
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new ConfigError(`${names[0]} must be a positive integer, got "${value}".`);
        }
        return parsed;
    };
    const list = (names: string[]): string[] =>
        (optional(names) ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
    return { boolean, list, optional, positiveInteger, required };
};

/**
 * Canonical server URL: scheme and host, optional base path, no trailing slash.
 * A pasted endpoint URL (`…/api/qcli/mcp`) is accepted and reduced to the base.
 */
const parseHttpUrl = (input: string, variable: string): URL => {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw new ConfigError(`${variable} must be an http(s) URL, got "${input}".`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ConfigError(`${variable} must be an http(s) URL, got "${input}".`);
    }
    return url;
};

export const normalizeUrl = (input: string): string => {
    const url = parseHttpUrl(input, 'QCLI_URL');
    const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/qcli\/mcp$/i, '');
    return `${url.protocol}//${url.host}${path}`;
};

const loadAuth = (read: EnvReader): AuthConfig => {
    const token = read.optional(names('TOKEN'));
    const user = read.optional(names('USER'));
    const password = read.optional(names('PASSWORD'));
    if (token && (user || password)) {
        throw new ConfigError('Set either QCLI_TOKEN or QCLI_USER + QCLI_PASSWORD, not both.');
    }
    if (token) {
        return { kind: 'token', token };
    }
    if (user || password) {
        if (!user || !password) {
            throw new ConfigError('QCLI_USER and QCLI_PASSWORD must be set together.');
        }
        return { kind: 'password', password, user };
    }
    return { kind: 'none' };
};

export const loadConfig = (env: Env = process.env): Config => {
    const read = createEnvReader(env);
    const url = read.optional(names('URL'));
    const devTools = read.boolean(names('DEV_TOOLS'), true);
    if (!url && !devTools) {
        throw new ConfigError(
            'Nothing to serve: set QCLI_URL to proxy a Qodalis CLI server, or leave QCLI_DEV_TOOLS on for the plugin-development tools.',
        );
    }
    const auth = loadAuth(read);
    const docsUrl = read.optional(names('DOCS_URL')) ?? DEFAULT_DOCS_URL;
    parseHttpUrl(docsUrl, 'QCLI_DOCS_URL');
    return {
        auth,
        connectionTimeoutMs: read.positiveInteger(names('CONNECTION_TIMEOUT'), 8000),
        devTools,
        docsUrl,
        exclude: read.list(names('EXCLUDE')),
        readOnly: read.boolean(names('READ_ONLY'), false),
        requestTimeoutMs: read.positiveInteger(names('REQUEST_TIMEOUT'), 60000),
        tools: read.list(names('TOOLS')),
        trustCert: read.boolean(names('TRUST_CERT'), false),
        url: url ? normalizeUrl(url) : undefined,
    };
};

/** One-line summary for the startup log (never contains secrets). */
export const describeConfig = (config: Config): string => {
    const auth =
        config.auth.kind === 'token'
            ? 'token auth'
            : config.auth.kind === 'password'
              ? `signs in as ${config.auth.user}`
              : 'no auth';
    const filters = [
        config.readOnly ? 'read-only tools' : 'all tools',
        config.tools.length ? `allow ${config.tools.join(',')}` : '',
        config.exclude.length ? `exclude ${config.exclude.join(',')}` : '',
    ]
        .filter(Boolean)
        .join(', ');
    const dev = config.devTools ? ' + plugin-development tools' : '';
    if (!config.url) {
        return `developer mode (plugin-development tools only; ${filters})`;
    }
    return `${config.url} (${auth}; ${filters})${dev}`;
};
