import { readFileSync } from 'node:fs';

/**
 * A small `.env` parser (no dependency): `KEY=value`, optional `export`,
 * `#` comments, single/double quotes with `\n`/`\t`/`\\`/`\"` escapes inside
 * double quotes, and inline comments after unquoted values.
 */
export const parseEnvFile = (content: string): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        const isSkippable = line.length === 0 || line.startsWith('#');
        if (isSkippable) {
            continue;
        }
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) {
            continue;
        }
        const key = match[1] ?? '';
        result[key] = parseValue(match[2] ?? '');
    }
    return result;
};

const parseValue = (raw: string): string => {
    const value = raw.trim();
    if (value.startsWith('"')) {
        const end = value.indexOf('"', 1);
        const body = end === -1 ? value.slice(1) : value.slice(1, end);
        return body.replace(/\\(n|t|r|\\|")/g, (_m, ch: string) =>
            ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch,
        );
    }
    if (value.startsWith("'")) {
        const end = value.indexOf("'", 1);
        return end === -1 ? value.slice(1) : value.slice(1, end);
    }
    const commentStart = value.search(/\s#/);
    return (commentStart === -1 ? value : value.slice(0, commentStart)).trim();
};

/** Loads a .env file into `env` without overriding keys that are already set. */
export const applyEnvFile = (path: string, env: Record<string, string | undefined>): void => {
    let content: string;
    try {
        content = readFileSync(path, 'utf8');
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read env file "${path}": ${reason}`);
    }
    for (const [key, value] of Object.entries(parseEnvFile(content))) {
        if (env[key] === undefined) {
            env[key] = value;
        }
    }
};
