export {
    ConfigError,
    createEnvReader,
    DEFAULT_DOCS_URL,
    describeConfig,
    ENV_FILE_VARIABLES,
    loadConfig,
    names,
    normalizeUrl,
    type AuthConfig,
    type Config,
    type Env,
} from './config.js';
export {
    ApiSource,
    extractDeclarations,
    formatLookup,
    lookupSymbol,
    normalizePackageName,
    type ApiLookup,
    type ApiSourceOptions,
    type TypeFiles,
} from './dev/api.js';
export {
    DocsSource,
    parseDocs,
    readDocs,
    searchDocs,
    type Docs,
    type DocSection,
    type DocTopic,
    type SearchHit,
} from './dev/docs.js';
export { getPrompt, PROMPTS } from './dev/prompts.js';
export { planScaffold, scaffoldPlugin, ScaffoldError, type ScaffoldPlan } from './dev/scaffold.js';
export { DEV_TOOLS, DevTools, type DevToolsOptions } from './dev/tools.js';
export { applyEnvFile, parseEnvFile } from './env-file.js';
export { classify, RemoteError, type FailureKind } from './errors.js';
export { isToolAllowed, matchesPattern, type RemoteTool } from './filters.js';
export { createFetch, MCP_PATH, RemoteServer, TOOLS_TTL_MS, type RemoteOptions } from './remote.js';
export {
    buildInstructions,
    createProxyServer,
    SERVER_NAME,
    type ProxyServerOptions,
    SERVER_VERSION,
    WEBSITE_URL,
} from './server.js';
