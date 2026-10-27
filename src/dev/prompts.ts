import type { GetPromptResult, Prompt } from '@modelcontextprotocol/server';

/** MCP prompts that walk an assistant through plugin work with the `qcli_*` tools. */
export const PROMPTS: Prompt[] = [
    {
        arguments: [
            {
                description: 'Plugin name: lowercase letters, digits and hyphens (e.g. "weather")',
                name: 'name',
                required: true,
            },
            {
                description: 'One-line description of the plugin',
                name: 'description',
                required: true,
            },
        ],
        description:
            'Create a Qodalis web CLI plugin (a command for the browser terminal): scaffold, implement, test and register it.',
        name: 'create-web-plugin',
        title: 'Create a web CLI plugin',
    },
    {
        arguments: [
            {
                description: 'Server language: node, dotnet or python',
                name: 'language',
                required: true,
            },
            {
                description: 'Command name as typed in the terminal (e.g. "weather")',
                name: 'command',
                required: true,
            },
        ],
        description:
            'Add a command to a Qodalis CLI server (Node, .NET or Python) that the web terminal runs remotely.',
        name: 'create-server-command',
        title: 'Create a server command',
    },
];

export class PromptError extends Error {}

const SERVER_LANGUAGES = {
    dotnet: {
        base: 'CliCommandProcessor (Qodalis.Cli) implementing ICliCommandProcessor from Qodalis.Cli.Abstractions',
        handler: 'HandleAsync(CliProcessCommand command, CancellationToken cancellationToken)',
        label: '.NET',
        register:
            'register it in Program.cs: `builder.Services.AddCli(cli => cli.AddProcessor<YourProcessor>())` (or group several in a module with `cli.AddModule(...)`)',
        test: '`dotnet build` and `dotnet test`',
    },
    node: {
        base: 'CliCommandProcessor from @qodalis/cli-server-abstractions',
        handler: 'handleAsync(command: CliProcessCommand, signal?: AbortSignal): Promise<string>',
        label: 'Node.js',
        register:
            'register it with the builder returned by createCliServer(): `builder.addProcessor(new YourProcessor())` (or `builder.addModule(...)`)',
        test: '`npm run build` and `npm test` (vitest)',
    },
    python: {
        base: 'CliCommandProcessor from qodalis_cli_server_abstractions',
        handler:
            'async def handle_async(self, command: CliProcessCommand, cancellation_event: asyncio.Event | None = None) -> str',
        label: 'Python',
        register:
            'register it with the builder of create_cli_server(): `builder.add_processor(YourProcessor())` (or `builder.add_module(...)`)',
        test: '`pytest`',
    },
} as const;

type ServerLanguage = keyof typeof SERVER_LANGUAGES;

const required = (args: Record<string, string> | undefined, name: string): string => {
    const value = args?.[name]?.trim();
    if (!value) {
        throw new PromptError(`Missing required argument "${name}".`);
    }
    return value;
};

const message = (text: string): GetPromptResult => ({
    messages: [{ content: { text, type: 'text' }, role: 'user' }],
});

export type PromptContext = {
    /** qcli_scaffold_plugin is available (not read-only, not filtered out) */
    canScaffold: boolean;
};

const webPlugin = (
    args: Record<string, string> | undefined,
    ctx: PromptContext,
): GetPromptResult => {
    const name = required(args, 'name');
    const description = required(args, 'description');
    const scaffold = ctx.canScaffold
        ? `Call \`qcli_scaffold_plugin\` with { "name": "${name}", "description": "${description}" } (add "directory" if the plugin should not go in the current project). Inside a web-cli checkout it creates packages/plugins/${name}; elsewhere a standalone qodalis-cli-${name} project. Read the files it reports.`
        : `qcli_scaffold_plugin is not available in this session (read-only or filtered). Ask the user to run \`npx -y @qodalis/create-cli-plugin@latest --name ${name} --description "${description}"\` and continue once it has created the project.`;
    return {
        description: `Create the "${name}" web CLI plugin`,
        ...message(
            [
                `Create a Qodalis web CLI plugin named "${name}": ${description}.`,
                '',
                'Work through these steps, using the qcli_* tools rather than guessing APIs:',
                '',
                '1. Learn the plugin model: `qcli_docs_read` with "Web plugins" (the whole section), then `qcli_docs_search` for anything specific to this plugin (arguments, interactive input, output formatting, state, services).',
                '2. Look up the exact contracts with `qcli_api`: ICliCommandProcessor, CliProcessCommand, ICliExecutionContext, ICliModule, and ICliInputReader if the command asks the user anything. Use the "Related declarations" it lists to go deeper. Do not invent members that are not in the declarations.',
                `3. ${scaffold}`,
                `4. Implement the command in src/lib/processors/: set command, description and parameters; do the work in processCommand(command, context), writing output through context.writer; use sub-processors (\`processors\`) for sub-commands; honour context.signal for long work. Keep "${name}" as the command name unless the user says otherwise.`,
                '5. Export everything through the module (ICliModule) in the public API, with a version and translations if the docs recommend them.',
                '6. Write tests next to the scaffolded ones (src/tests/*.spec.ts) covering the main paths and invalid input.',
                '7. Build and run the tests (the scaffold result lists the commands), fix every failure, then show the user how to register the module in a host app (`modules` input/prop, or engine.registerModule()).',
                '',
                'Finish with a short summary: files changed, how to use the command, and anything left to decide.',
            ].join('\n'),
        ),
    };
};

const serverCommand = (args: Record<string, string> | undefined): GetPromptResult => {
    const language = required(args, 'language')
        .toLowerCase()
        .replace(/^\.?net$|^c#$|^csharp$/, 'dotnet');
    const command = required(args, 'command');
    if (!(language in SERVER_LANGUAGES)) {
        throw new PromptError(`Unknown language "${language}": use node, dotnet or python.`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(command)) {
        throw new PromptError(
            `Invalid command "${command}": lowercase letters, digits and hyphens, starting with a letter.`,
        );
    }
    const lang = SERVER_LANGUAGES[language as ServerLanguage];
    return {
        description: `Add the "${command}" command to a ${lang.label} Qodalis CLI server`,
        ...message(
            [
                `Add a "${command}" command to the ${lang.label} Qodalis CLI server in this project. The web terminal discovers server commands and runs them remotely.`,
                '',
                'Steps (use the qcli_* tools instead of guessing APIs):',
                '',
                `1. Read the guide: \`qcli_docs_read\` with "Server plugins", then \`qcli_docs_search\` with "${lang.label} processor" and "${lang.label} module" for the details of this server.`,
                '2. Find where the server is configured in this project (the createCliServer / AddCli / create_cli_server call) and how existing processors are organised; follow the same layout and naming.',
                `3. Create a processor class deriving from ${lang.base}: set command = "${command}", a description, parameters (name, type, required, description) and the version; implement ${lang.handler}. Use sub-processors for sub-commands.`,
                `4. ${lang.register.charAt(0).toUpperCase()}${lang.register.slice(1)}.`,
                `5. Add tests for the processor alongside the existing ones and run ${lang.test}; fix every failure.`,
                '6. If a server is running with MCP enabled and this session is connected to it (QCLI_URL), the new command appears as a tool after a restart: call it to verify. Otherwise tell the user how to start the server and run the command in the web terminal.',
                '',
                'Finish with a short summary: files changed and how to use the command.',
            ].join('\n'),
        ),
    };
};

export const getPrompt = (
    name: string,
    args: Record<string, string> | undefined,
    ctx: PromptContext,
): GetPromptResult => {
    switch (name) {
        case 'create-web-plugin':
            return webPlugin(args, ctx);
        case 'create-server-command':
            return serverCommand(args);
        default:
            throw new PromptError(`Unknown prompt: ${name}`);
    }
};
