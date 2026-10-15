import { describe, expect, it } from 'vitest';
import { classify, isToolAllowed, matchesPattern, RemoteError } from '../../src/index.js';
import type { RemoteTool } from '../../src/index.js';

const tool = (name: string, readOnly?: boolean): RemoteTool => ({
    inputSchema: { type: 'object' },
    name,
    ...(readOnly === undefined ? {} : { annotations: { readOnlyHint: readOnly } }),
});
const none = { exclude: [], readOnly: false, tools: [] };

describe('filters', () => {
    it('matches exact names and trailing wildcards', () => {
        expect(matchesPattern('fs_list', 'fs_*')).toBe(true);
        expect(matchesPattern('fs_list', 'fs_list')).toBe(true);
        expect(matchesPattern('fs_list', 'fs')).toBe(false);
        expect(matchesPattern('data_query', 'fs_*')).toBe(false);
        expect(matchesPattern('anything', '*')).toBe(true);
    });

    it('read-only mode keeps only readOnlyHint: true', () => {
        const config = { ...none, readOnly: true };
        expect(isToolAllowed(tool('fs_list', true), config)).toBe(true);
        expect(isToolAllowed(tool('fs_delete', false), config)).toBe(false);
        expect(isToolAllowed(tool('echo'), config)).toBe(false);
        expect(isToolAllowed(tool('echo'), none)).toBe(true);
    });

    it('applies the allow-list, then the deny-list', () => {
        const config = { ...none, exclude: ['fs_delete'], tools: ['fs_*', 'server_info'] };
        expect(isToolAllowed(tool('fs_list'), config)).toBe(true);
        expect(isToolAllowed(tool('server_info'), config)).toBe(true);
        expect(isToolAllowed(tool('fs_delete'), config)).toBe(false);
        expect(isToolAllowed(tool('echo'), config)).toBe(false);
        expect(isToolAllowed(tool('jobs_cancel'), { ...none, exclude: ['jobs_*'] })).toBe(false);
    });
});

describe('classify', () => {
    const ctx = {
        auth: 'token' as const,
        connectionTimeoutMs: 8000,
        requestTimeoutMs: 60000,
        url: 'http://s',
    };
    const http = (status: number, text = '') =>
        Object.assign(new Error(text), { data: { text }, status });

    it('maps HTTP statuses to actionable messages', () => {
        expect(classify(http(401), ctx).message).toMatch(
            /401.*QCLI_TOKEN is wrong, expired or revoked/,
        );
        expect(classify(http(401), { ...ctx, auth: 'none' }).message).toMatch(
            /Set QCLI_TOKEN, or QCLI_USER and QCLI_PASSWORD/,
        );
        expect(
            classify(http(403, '{"error":"forbidden: requires commands:execute"}'), ctx).message,
        ).toBe(
            'http://s answered 403 (forbidden: requires commands:execute): the account needs the commands:execute permission, or the server rejected the request origin.',
        );
        expect(classify(http(404), ctx).message).toBe(
            'MCP is not enabled on this server (enable the mcp option): 404 from http://s/api/qcli/mcp.',
        );
        expect(classify(http(405), ctx).kind).toBe('not-enabled');
        expect(classify(http(500, '{"detail":"boom"}'), ctx).message).toBe(
            'http://s answered 500: boom.',
        );
    });

    it('maps network errors and timeouts', () => {
        const refused = new TypeError('fetch failed', {
            cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
        });
        expect(classify(refused, ctx).message).toBe(
            'Cannot reach http://s (ECONNREFUSED). Check QCLI_URL / VPN.',
        );
        const aggregate = new TypeError('fetch failed', {
            cause: Object.assign(
                new AggregateError([Object.assign(new Error('y'), { code: 'EHOSTUNREACH' })]),
                {},
            ),
        });
        expect(classify(aggregate, ctx).message).toMatch(/EHOSTUNREACH/);
        const connectTimeout = new TypeError('fetch failed', {
            cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
        });
        expect(classify(connectTimeout, ctx).message).toBe(
            'Cannot reach http://s (no answer within 8000 ms). Check QCLI_URL / VPN.',
        );
        expect(
            classify(
                Object.assign(new Error('Request timed out'), { code: 'REQUEST_TIMEOUT' }),
                ctx,
            ).message,
        ).toBe('http://s did not answer within 60000 ms (QCLI_REQUEST_TIMEOUT).');
        expect(classify(new TypeError('fetch failed'), ctx).kind).toBe('unreachable');
        const existing = new RemoteError('login', 'kept');
        expect(classify(existing, ctx)).toBe(existing);
        expect(classify(new Error('odd'), ctx).message).toBe('http://s: odd');
    });
});
