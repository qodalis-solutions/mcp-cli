import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    applyEnvFile,
    ConfigError,
    describeConfig,
    loadConfig,
    normalizeUrl,
    parseEnvFile,
} from '../../src/index.js';

describe('loadConfig', () => {
    it('applies the defaults', () => {
        expect(loadConfig({ QCLI_URL: 'http://localhost:8047' })).toEqual({
            auth: { kind: 'none' },
            connectionTimeoutMs: 8000,
            exclude: [],
            readOnly: false,
            requestTimeoutMs: 60000,
            tools: [],
            trustCert: false,
            url: 'http://localhost:8047',
        });
    });

    it('reads every setting, with the QODALIS_CLI_ alias', () => {
        const config = loadConfig({
            QODALIS_CLI_URL: 'https://cli.example.com/base/',
            QODALIS_CLI_TOKEN: 'qcli_pat_x',
            QCLI_READ_ONLY: 'yes',
            QCLI_TOOLS: 'fs_*, server_info',
            QODALIS_CLI_EXCLUDE: 'fs_delete',
            QCLI_CONNECTION_TIMEOUT: '2000',
            QCLI_REQUEST_TIMEOUT: '5000',
            QCLI_TRUST_CERT: '1',
        });
        expect(config).toEqual({
            auth: { kind: 'token', token: 'qcli_pat_x' },
            connectionTimeoutMs: 2000,
            exclude: ['fs_delete'],
            readOnly: true,
            requestTimeoutMs: 5000,
            tools: ['fs_*', 'server_info'],
            trustCert: true,
            url: 'https://cli.example.com/base',
        });
    });

    it('prefers QCLI_ over the alias', () => {
        expect(loadConfig({ QCLI_URL: 'http://a', QODALIS_CLI_URL: 'http://b' }).url).toBe(
            'http://a',
        );
    });

    it('reads user and password', () => {
        expect(
            loadConfig({ QCLI_URL: 'http://a', QCLI_USER: 'root', QCLI_PASSWORD: 'pw' }).auth,
        ).toEqual({ kind: 'password', password: 'pw', user: 'root' });
    });

    it.each([
        [{}, /QCLI_URL \(or its alias QODALIS_CLI_URL\) is required/],
        [{ QCLI_URL: 'ftp://x' }, /http\(s\) URL/],
        [{ QCLI_URL: 'not a url' }, /http\(s\) URL/],
        [{ QCLI_URL: 'http://a', QCLI_TOKEN: 't', QCLI_USER: 'u' }, /not both/],
        [{ QCLI_URL: 'http://a', QCLI_USER: 'u' }, /must be set together/],
        [{ QCLI_URL: 'http://a', QCLI_PASSWORD: 'p' }, /must be set together/],
        [{ QCLI_URL: 'http://a', QCLI_READ_ONLY: 'maybe' }, /QCLI_READ_ONLY must be a boolean/],
        [{ QCLI_URL: 'http://a', QCLI_REQUEST_TIMEOUT: '0' }, /positive integer/],
        [{ QCLI_URL: 'http://a', QCLI_CONNECTION_TIMEOUT: '1.5' }, /positive integer/],
    ])('rejects invalid settings %#', (env, message) => {
        expect(() => loadConfig(env)).toThrow(ConfigError);
        expect(() => loadConfig(env)).toThrow(message);
    });

    it('normalizes pasted endpoint URLs', () => {
        expect(normalizeUrl('http://Host:8047/api/qcli/mcp/')).toBe('http://host:8047');
    });

    it('describes the config without secrets', () => {
        const token = describeConfig(loadConfig({ QCLI_URL: 'http://a', QCLI_TOKEN: 'SECRET' }));
        const password = describeConfig(
            loadConfig({
                QCLI_URL: 'http://a',
                QCLI_USER: 'root',
                QCLI_PASSWORD: 'SECRET',
                QCLI_READ_ONLY: 'true',
                QCLI_TOOLS: 'fs_*',
                QCLI_EXCLUDE: 'fs_delete',
            }),
        );
        expect(token).toBe('http://a (token auth; all tools)');
        expect(password).toBe(
            'http://a (signs in as root; read-only tools, allow fs_*, exclude fs_delete)',
        );
        expect(token + password).not.toContain('SECRET');
    });
});

describe('env file', () => {
    it('parses KEY=value lines, quotes, comments and export', () => {
        expect(
            parseEnvFile(
                '# comment\nexport QCLI_URL=http://a\nQCLI_TOKEN="qcli pat\\tx" \nQCLI_TOOLS=fs_* # inline\nQCLI_USER=\'root\'\nnot a line\n',
            ),
        ).toEqual({
            QCLI_TOKEN: 'qcli pat\tx',
            QCLI_TOOLS: 'fs_*',
            QCLI_URL: 'http://a',
            QCLI_USER: 'root',
        });
    });

    it('loads a file without overriding variables that are set', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'mcp-cli-'));
        const file = path.join(dir, '.env');
        writeFileSync(file, 'QCLI_URL=http://from-file\nQCLI_TOKEN=from-file\n');
        const env: Record<string, string | undefined> = { QCLI_TOKEN: 'from-env' };
        applyEnvFile(file, env);
        expect(env).toEqual({ QCLI_TOKEN: 'from-env', QCLI_URL: 'http://from-file' });
        expect(loadConfig(env).auth).toEqual({ kind: 'token', token: 'from-env' });
        expect(() => applyEnvFile(path.join(dir, 'missing'), env)).toThrow(
            /Could not read env file/,
        );
    });
});
