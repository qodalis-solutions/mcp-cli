#!/usr/bin/env node
// Refreshes the bundled docs snapshot (docs/llms-full.txt) that qcli_docs_* fall back to
// offline. Source, first match wins:
//   npm run sync-docs -- <file-or-url>
//   a web-cli checkout (QCLI_WEB_CLI_DIR, default ../web-cli): generated with its
//   tools/build-llms.js (the file is git-ignored there), or a previous build
//   in apps/docs/src/static
//   QCLI_DOCS_URL, else https://cli.qodalis.com/llms-full.txt
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TITLE = '# Qodalis CLI plugin development';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'docs', 'llms-full.txt');
const webCli = path.resolve(process.env.QCLI_WEB_CLI_DIR ?? path.join(root, '..', 'web-cli'));
const siblings = ['apps/docs/src/static/llms-full.txt'].map((p) => path.join(webCli, p));

/** Runs web-cli's generator into a temp dir; undefined when the checkout has none. */
const generate = () => {
    const generator = path.join(webCli, 'tools', 'build-llms.js');
    if (!existsSync(generator)) {
        return undefined;
    }
    const out = mkdtempSync(path.join(tmpdir(), 'qcli-llms-'));
    process.on('exit', () => rmSync(out, { force: true, recursive: true }));
    execFileSync(process.execPath, [generator, out], { cwd: webCli, stdio: 'inherit' });
    return path.join(out, 'llms-full.txt');
};

const read = async (source) => {
    if (/^https?:\/\//.test(source)) {
        const response = await fetch(source, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} from ${source}`);
        }
        return response.text();
    }
    return readFileSync(path.resolve(source), 'utf8');
};

const source =
    process.argv[2] ??
    generate() ??
    siblings.find((p) => existsSync(p)) ??
    process.env.QCLI_DOCS_URL ??
    'https://cli.qodalis.com/llms-full.txt';

try {
    const text = (await read(source)).replace(/\r\n/g, '\n');
    if (!text.trimStart().startsWith(TITLE)) {
        throw new Error(`${source} does not start with "${TITLE}"`);
    }
    writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`);
    const topics = text.split('\n').filter((line) => line.startsWith('### ')).length;
    console.log(`docs/llms-full.txt <- ${source} (${topics} topics, ${text.length} bytes)`);
} catch (error) {
    console.error(`sync-docs: ${error.message}`);
    process.exit(1);
}
