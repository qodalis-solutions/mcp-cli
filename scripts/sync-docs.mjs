#!/usr/bin/env node
// Refreshes the bundled docs snapshot (docs/llms-full.txt) that qcli_docs_* fall back to
// offline. Source, first match wins:
//   npm run sync-docs -- <file-or-url>
//   a web-cli checkout next to this repository (../web-cli/apps/docs/...)
//   QCLI_DOCS_URL, else https://cli.qodalis.com/llms-full.txt
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TITLE = '# Qodalis CLI plugin development';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'docs', 'llms-full.txt');
const siblings = [
    'apps/docs/src/llms-full.txt',
    'apps/docs/src/static/llms-full.txt',
    'apps/docs/public/llms-full.txt',
    'apps/docs/src/assets/llms-full.txt',
].map((p) => path.join(root, '..', 'web-cli', p));

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
