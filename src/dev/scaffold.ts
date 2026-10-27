import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * `qcli_scaffold_plugin`: runs `@qodalis/create-cli-plugin` non-interactively. Inside a
 * web-cli checkout it creates `packages/plugins/<name>`; anywhere else a standalone
 * `qodalis-cli-<name>` project (and installs its dependencies).
 */
export const SCAFFOLD_PACKAGE = '@qodalis/create-cli-plugin@latest';
export const SCAFFOLD_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_LIMIT = 6000;

export type ScaffoldArgs = {
    description?: string | undefined;
    directory?: string | undefined;
    name: string;
    processorName?: string | undefined;
};

export type ScaffoldPlan = {
    /** Arguments after `npx` */
    args: string[];
    cwd: string;
    monorepo: string | undefined;
    name: string;
    processorName: string;
    /** Where create-cli-plugin will put the plugin */
    target: string;
};

export class ScaffoldError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ScaffoldError';
    }
}

const toPascalCase = (name: string): string =>
    name
        .split(/[-_\s]+/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join('');

/** The web-cli monorepo root above `dir` (same rule as create-cli-plugin), if any. */
export const detectMonorepo = (dir: string): string | undefined => {
    let current = path.resolve(dir);
    for (;;) {
        const workspace = path.join(current, 'pnpm-workspace.yaml');
        if (
            existsSync(workspace) &&
            existsSync(path.join(current, 'packages', 'plugins')) &&
            readFileSync(workspace, 'utf8').includes('packages/plugins')
        ) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
};

/** Validates the arguments and works out where the plugin goes; throws {@link ScaffoldError}. */
export const planScaffold = (input: ScaffoldArgs, cwd = process.cwd()): ScaffoldPlan => {
    const name = (input.name ?? '').trim();
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name.endsWith('-') || name.includes('--')) {
        throw new ScaffoldError(
            `Invalid plugin name "${name}": use lowercase letters, digits and single hyphens, starting with a letter (e.g. "weather" or "json-tools").`,
        );
    }
    if (name.startsWith('cli-')) {
        throw new ScaffoldError(
            `Invalid plugin name "${name}": leave out the "cli-" prefix, it is added to the package name (@qodalis/cli-${name.slice(4)}).`,
        );
    }
    if (name.length > 50) {
        throw new ScaffoldError('Invalid plugin name: at most 50 characters.');
    }
    const processorName = input.processorName?.trim() || toPascalCase(name);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(processorName)) {
        throw new ScaffoldError(
            `Invalid processorName "${processorName}": PascalCase letters and digits (e.g. "Weather"; the class becomes Cli${processorName}CommandProcessor).`,
        );
    }
    const description = input.description?.trim();
    if (
        description !== undefined &&
        (description.length > 200 || /[\0-\x1f"`$\\]/.test(description))
    ) {
        throw new ScaffoldError(
            'Invalid description: one line of at most 200 characters, without quotes, backticks, $ or backslashes.',
        );
    }
    const dir = path.resolve(cwd, input.directory?.trim() || '.');
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new ScaffoldError(`Directory ${dir} does not exist.`);
    }
    const monorepo = detectMonorepo(dir);
    const target = monorepo
        ? path.join(monorepo, 'packages', 'plugins', name)
        : path.join(dir, `qodalis-cli-${name}`);
    if (existsSync(target)) {
        throw new ScaffoldError(`${target} already exists; pick another name or directory.`);
    }
    const args = ['-y', SCAFFOLD_PACKAGE, '--name', name, '--processor-name', processorName];
    if (description) {
        args.push('--description', description);
    }
    return { args, cwd: dir, monorepo, name, processorName, target };
};

export type RunResult = { code: number | null; output: string; timedOut: boolean };
export type Runner = (
    command: string,
    args: string[],
    options: { cwd: string; signal?: AbortSignal | undefined; timeoutMs: number },
) => Promise<RunResult>;

/** Runs a command without a TTY, stdin closed, capturing stdout and stderr together. */
export const runCommand: Runner = (command, args, options) =>
    new Promise((resolve, reject) => {
        const windows = process.platform === 'win32';
        // npx is a .cmd on Windows, which needs a shell; the arguments are validated
        // (no quotes or shell metacharacters) and quoted.
        const viaShell = windows && command === 'npx';
        const child = spawn(
            viaShell ? 'npx.cmd' : command,
            viaShell ? args.map((a) => `"${a}"`) : args,
            {
                cwd: options.cwd,
                // Own process group on POSIX, so a timeout also stops npm install below npx.
                detached: !windows,
                env: { ...process.env, CI: 'true', npm_config_yes: 'true' },
                shell: viaShell,
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        let output = '';
        let timedOut = false;
        const append = (chunk: Buffer): void => {
            output += chunk.toString();
            if (output.length > OUTPUT_LIMIT * 4) {
                output = output.slice(-OUTPUT_LIMIT * 2);
            }
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const signalTree = (signal: NodeJS.Signals): void => {
            try {
                if (!windows && child.pid) {
                    process.kill(-child.pid, signal);
                } else {
                    child.kill(signal);
                }
            } catch {
                // already gone
            }
        };
        const kill = (): void => {
            signalTree('SIGTERM');
            setTimeout(() => signalTree('SIGKILL'), 3000).unref();
        };
        const timer = setTimeout(() => {
            timedOut = true;
            kill();
        }, options.timeoutMs);
        options.signal?.addEventListener('abort', kill, { once: true });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', kill);
            resolve({ code, output, timedOut });
        });
    });

/** Files under `dir`, relative, without node_modules / dist / .git. */
export const listFiles = (dir: string, limit = 200): string[] => {
    const files: string[] = [];
    const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (files.length >= limit) {
                return;
            }
            if (['node_modules', 'dist', '.git'].includes(entry.name)) {
                continue;
            }
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                files.push(path.relative(dir, full).split(path.sep).join('/'));
            }
        }
    };
    if (existsSync(dir)) {
        walk(dir);
    }
    return files.sort();
};

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const tail = (text: string): string => {
    const clean = stripAnsi(text).trim();
    return clean.length > OUTPUT_LIMIT ? `…${clean.slice(-OUTPUT_LIMIT)}` : clean;
};

export type ScaffoldResult = { isError: boolean; text: string };

/** Runs create-cli-plugin for a validated plan and describes what it created. */
export const scaffoldPlugin = async (
    plan: ScaffoldPlan,
    options: { runner?: Runner; signal?: AbortSignal | undefined; timeoutMs?: number } = {},
): Promise<ScaffoldResult> => {
    const timeoutMs = options.timeoutMs ?? SCAFFOLD_TIMEOUT_MS;
    const result = await (options.runner ?? runCommand)('npx', plan.args, {
        cwd: plan.cwd,
        signal: options.signal,
        timeoutMs,
    });
    const command = `npx ${plan.args.join(' ')}`;
    if (result.timedOut || result.code !== 0) {
        const why = result.timedOut
            ? `timed out after ${Math.round(timeoutMs / 1000)} s`
            : `exited with code ${result.code}`;
        return {
            isError: true,
            text: `\`${command}\` (in ${plan.cwd}) ${why}.\n\nOutput:\n${tail(result.output)}`,
        };
    }
    const files = listFiles(plan.target);
    const className = `Cli${plan.processorName}CommandProcessor`;
    const steps = plan.monorepo
        ? [
              `Implement the command in ${plan.target}/src/lib/processors/ (class ${className}).`,
              `Build: \`pnpm nx build ${plan.name}\`; test: \`pnpm nx test ${plan.name}\`.`,
              'Register the module in a demo app (e.g. apps/demo-angular) to try it.',
          ]
        : [
              `Implement the command in ${plan.target}/src/lib/processors/ (class ${className}).`,
              `Build with \`npx tsup\` in ${plan.target}.`,
              'Register the exported module in your host app (`modules` input/prop, or engine.registerModule()).',
              'Publish with `npm publish --access public` when ready.',
          ];
    return {
        isError: false,
        text: [
            `Created the ${plan.name} plugin in ${plan.target}${plan.monorepo ? ` (web-cli monorepo at ${plan.monorepo})` : ''}.`,
            '',
            `Files (${files.length}):`,
            ...files.map((f) => `- ${f}`),
            '',
            'Next steps:',
            ...steps.map((s, i) => `${i + 1}. ${s}`),
            '',
            'Look up the APIs with qcli_api (ICliCommandProcessor, ICliExecutionContext, ICliModule) and the guide with qcli_docs_search.',
            '',
            `Output of \`${command}\`:`,
            tail(result.output),
        ].join('\n'),
    };
};
