import type { Tool } from '@modelcontextprotocol/server';
import type { Config } from './config.js';

/** A tool exactly as the remote server lists it. */
export type RemoteTool = Tool;

/** `fs_*` matches every name starting with `fs_`; anything else must match exactly. */
export const matchesPattern = (name: string, pattern: string): boolean =>
    pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;

export type FilterConfig = Pick<Config, 'exclude' | 'readOnly' | 'tools'>;

/**
 * Whether the proxy exposes (and forwards calls to) a tool: read-only mode keeps only
 * tools annotated `readOnlyHint: true`, then the allow-list and deny-list apply.
 */
export const isToolAllowed = (tool: RemoteTool, config: FilterConfig): boolean => {
    if (config.readOnly && tool.annotations?.readOnlyHint !== true) {
        return false;
    }
    if (config.tools.length > 0 && !config.tools.some((p) => matchesPattern(tool.name, p))) {
        return false;
    }
    return !config.exclude.some((p) => matchesPattern(tool.name, p));
};
