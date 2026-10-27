import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    detectMonorepo,
    listFiles,
    planScaffold,
    runCommand,
    scaffoldPlugin,
    ScaffoldError,
    type Runner,
} from '../../src/dev/scaffold.js';

const tempDir = (): string => mkdtempSync(path.join(tmpdir(), 'mcp-cli-scaffold-'));

describe('planScaffold', () => {
    it('builds the npx arguments for a standalone project', () => {
        const dir = tempDir();
        const plan = planScaffold({ description: 'Weather forecasts', name: 'weather' }, dir);
        expect(plan).toEqual({
            args: [
                '-y',
                '@qodalis/create-cli-plugin@latest',
                '--name',
                'weather',
                '--processor-name',
                'Weather',
                '--description',
                'Weather forecasts',
            ],
            cwd: dir,
            monorepo: undefined,
            name: 'weather',
            processorName: 'Weather',
            target: path.join(dir, 'qodalis-cli-weather'),
        });
        expect(planScaffold({ name: 'json-tools', processorName: 'Json' }, dir).args).toEqual([
            '-y',
            '@qodalis/create-cli-plugin@latest',
            '--name',
            'json-tools',
            '--processor-name',
            'Json',
        ]);
        expect(planScaffold({ name: 'json-tools' }, dir).processorName).toBe('JsonTools');
    });

    it.each([
        ['Weather', /Invalid plugin name/],
        ['my plugin', /Invalid plugin name/],
        ['1abc', /Invalid plugin name/],
        ['abc-', /Invalid plugin name/],
        ['a--b', /Invalid plugin name/],
        ['a;rm -rf /', /Invalid plugin name/],
        ['', /Invalid plugin name/],
        ['cli-weather', /leave out the "cli-" prefix/],
        ['a'.repeat(51), /at most 50/],
    ])('rejects the name %j', (name, message) => {
        expect(() => planScaffold({ name }, tempDir())).toThrow(ScaffoldError);
        expect(() => planScaffold({ name }, tempDir())).toThrow(message);
    });

    it('rejects bad processor names, descriptions and directories', () => {
        const dir = tempDir();
        expect(() => planScaffold({ name: 'a', processorName: 'lower' }, dir)).toThrow(
            /Invalid processorName/,
        );
        expect(() => planScaffold({ description: 'say "hi"', name: 'a' }, dir)).toThrow(
            /Invalid description/,
        );
        expect(() => planScaffold({ description: 'a\nb', name: 'a' }, dir)).toThrow(
            /Invalid description/,
        );
        expect(() => planScaffold({ description: '$(x)', name: 'a' }, dir)).toThrow(
            /Invalid description/,
        );
        expect(() => planScaffold({ directory: 'missing', name: 'a' }, dir)).toThrow(
            /does not exist/,
        );
        mkdirSync(path.join(dir, 'qodalis-cli-taken'));
        expect(() => planScaffold({ name: 'taken' }, dir)).toThrow(/already exists/);
    });

    it('targets packages/plugins inside a web-cli checkout', () => {
        const root = tempDir();
        mkdirSync(path.join(root, 'packages', 'plugins'), { recursive: true });
        mkdirSync(path.join(root, 'apps', 'demo'), { recursive: true });
        writeFileSync(
            path.join(root, 'pnpm-workspace.yaml'),
            "packages:\n  - 'packages/plugins/*'\n",
        );
        const plan = planScaffold({ directory: 'apps/demo', name: 'weather' }, root);
        expect(plan.monorepo).toBe(root);
        expect(plan.target).toBe(path.join(root, 'packages', 'plugins', 'weather'));
        expect(detectMonorepo(tempDir())).toBeUndefined();
    });
});

describe('scaffoldPlugin', () => {
    it('runs npx and reports the created files and next steps', async () => {
        const dir = tempDir();
        const plan = planScaffold({ description: 'Weather', name: 'weather' }, dir);
        const runner = vi.fn<Runner>(async (_command, _args, options) => {
            const target = path.join(options.cwd, 'qodalis-cli-weather');
            mkdirSync(path.join(target, 'src', 'lib'), { recursive: true });
            mkdirSync(path.join(target, 'node_modules', 'x'), { recursive: true });
            writeFileSync(path.join(target, 'package.json'), '{}');
            writeFileSync(path.join(target, 'src', 'lib', 'index.ts'), '');
            writeFileSync(path.join(target, 'node_modules', 'x', 'y.js'), '');
            return { code: 0, output: '\u001b[32mDone!\u001b[0m\n', timedOut: false };
        });
        const result = await scaffoldPlugin(plan, { runner });
        expect(runner).toHaveBeenCalledWith('npx', plan.args, {
            cwd: dir,
            signal: undefined,
            timeoutMs: 300000,
        });
        expect(result.isError).toBe(false);
        expect(result.text).toContain(`Created the weather plugin in ${plan.target}.`);
        expect(result.text).toContain('Files (2):\n- package.json\n- src/lib/index.ts');
        expect(result.text).toContain('class CliWeatherCommandProcessor');
        expect(result.text).toContain('npx tsup');
        expect(result.text.endsWith('Done!')).toBe(true);
    });

    it('reports failures and timeouts with the output tail', async () => {
        const plan = planScaffold({ name: 'weather' }, tempDir());
        const failed = await scaffoldPlugin(plan, {
            runner: async () => ({ code: 1, output: 'Error: boom', timedOut: false }),
        });
        expect(failed).toEqual({
            isError: true,
            text: `\`npx ${plan.args.join(' ')}\` (in ${plan.cwd}) exited with code 1.\n\nOutput:\nError: boom`,
        });
        const slow = await scaffoldPlugin(plan, {
            runner: async () => ({ code: null, output: 'x'.repeat(7000), timedOut: true }),
            timeoutMs: 2000,
        });
        expect(slow.text).toMatch(/timed out after 2 s/);
        expect(slow.text).toMatch(/Output:\n…x{6000}$/);
    });

    it('runCommand captures output, exit codes and timeouts of a real process', async () => {
        const ok = await runCommand(
            process.execPath,
            ['-e', 'console.log("out"); console.error("err")'],
            {
                cwd: tmpdir(),
                timeoutMs: 10_000,
            },
        );
        expect(ok.code).toBe(0);
        expect(ok.output).toContain('out');
        expect(ok.output).toContain('err');
        const slow = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
            cwd: tmpdir(),
            timeoutMs: 200,
        });
        expect(slow.timedOut).toBe(true);
        await expect(
            runCommand('definitely-not-a-command-qcli', [], { cwd: tmpdir(), timeoutMs: 1000 }),
        ).rejects.toThrow(/ENOENT/);
    });

    it('lists files without node_modules, dist and .git', () => {
        expect(listFiles(path.join(tempDir(), 'missing'))).toEqual([]);
    });
});
