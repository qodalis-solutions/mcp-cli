import type { AuthConfig } from './config.js';

export type FailureKind =
    'auth' | 'forbidden' | 'http' | 'login' | 'not-enabled' | 'timeout' | 'unreachable';

/** A remote failure turned into one sentence that tells the user what to do. */
export class RemoteError extends Error {
    constructor(
        readonly kind: FailureKind,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'RemoteError';
    }
}

/** Connection-level error codes: the request never reached (or never left) the server. */
const RETRYABLE_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'UND_ERR_SOCKET',
    'UND_ERR_CLOSED',
]);
/** Not retried: the host did not answer within QCLI_CONNECTION_TIMEOUT, retrying doubles the wait. */
const CONNECT_TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT']);

/** The first `code` found on the error, its `cause` chain or an AggregateError's members. */
export const networkCode = (error: unknown, depth = 0): string | undefined => {
    if (!error || typeof error !== 'object' || depth > 5) {
        return undefined;
    }
    const code = (error as { code?: unknown }).code;
    if (
        typeof code === 'string' &&
        (RETRYABLE_CODES.has(code) || CONNECT_TIMEOUT_CODES.has(code))
    ) {
        return code;
    }
    const nested = (error as { errors?: unknown[] }).errors;
    for (const inner of Array.isArray(nested) ? nested : []) {
        const found = networkCode(inner, depth + 1);
        if (found) {
            return found;
        }
    }
    return networkCode((error as { cause?: unknown }).cause, depth + 1);
};

/** Connection refused/reset, DNS failure, socket closed: safe to retry once on a fresh connection. */
export const isRetryableNetworkError = (error: unknown): boolean => {
    const code = networkCode(error);
    return code !== undefined && RETRYABLE_CODES.has(code);
};

const isNetworkError = (error: unknown): boolean =>
    networkCode(error) !== undefined ||
    (error instanceof TypeError && /fetch failed|network/i.test(error.message));

const isTimeout = (error: unknown): boolean => {
    const name = (error as { name?: unknown })?.name;
    const code = (error as { code?: unknown })?.code;
    return (
        name === 'TimeoutError' ||
        code === 'REQUEST_TIMEOUT' ||
        /timed? ?out/i.test(String((error as Error)?.message))
    );
};

/** HTTP status of an SDK HTTP error (`SdkHttpError.status`) or a plain `{ status }`. */
export const httpStatus = (error: unknown): number | undefined => {
    const status = (error as { status?: unknown })?.status;
    return typeof status === 'number' && status >= 400 ? status : undefined;
};

/** `{"error":"…"}` (or detail/message) from the HTTP body the SDK attached. */
const serverDetail = (error: unknown): string | undefined => {
    const data = (error as { data?: { text?: unknown } })?.data;
    const text = typeof data?.text === 'string' ? data.text : (error as Error)?.message;
    const json = typeof text === 'string' ? text.slice(Math.max(0, text.indexOf('{'))) : '';
    try {
        const body = JSON.parse(json) as Record<string, unknown>;
        const detail = body['error'] ?? body['detail'] ?? body['message'];
        return typeof detail === 'string' ? detail.slice(0, 300) : undefined;
    } catch {
        return undefined;
    }
};

export type ClassifyContext = {
    auth: AuthConfig['kind'];
    requestTimeoutMs: number;
    connectionTimeoutMs: number;
    url: string;
};

/** Map a transport / HTTP failure to a {@link RemoteError} with an actionable message. */
export const classify = (error: unknown, ctx: ClassifyContext): RemoteError => {
    if (error instanceof RemoteError) {
        return error;
    }
    const status = httpStatus(error);
    const detail = serverDetail(error);
    const options = { cause: error };
    if (status === 401) {
        const advice =
            ctx.auth === 'token'
                ? 'QCLI_TOKEN is wrong, expired or revoked. Create a new token (`token create claude` in the web CLI) and update QCLI_TOKEN.'
                : ctx.auth === 'password'
                  ? 'the session was rejected even after signing in again. Check that the account is enabled.'
                  : 'the server requires authentication. Set QCLI_TOKEN, or QCLI_USER and QCLI_PASSWORD.';
        return new RemoteError(
            'auth',
            `${ctx.url} answered 401 (not authenticated): ${advice}`,
            options,
        );
    }
    if (status === 403) {
        return new RemoteError(
            'forbidden',
            `${ctx.url} answered 403${detail ? ` (${detail})` : ''}: the account needs the commands:execute permission, or the server rejected the request origin.`,
            options,
        );
    }
    if (status === 404 || status === 405) {
        return new RemoteError(
            'not-enabled',
            `MCP is not enabled on this server (enable the mcp option): ${status} from ${ctx.url}/api/qcli/mcp.`,
            options,
        );
    }
    if (status !== undefined) {
        return new RemoteError(
            'http',
            `${ctx.url} answered ${status}${detail ? `: ${detail}` : ''}.`,
            options,
        );
    }
    const code = networkCode(error);
    if (code && CONNECT_TIMEOUT_CODES.has(code)) {
        return new RemoteError(
            'unreachable',
            `Cannot reach ${ctx.url} (no answer within ${ctx.connectionTimeoutMs} ms). Check QCLI_URL / VPN.`,
            options,
        );
    }
    if (isNetworkError(error)) {
        const reason = code ?? (error as Error).message;
        return new RemoteError(
            'unreachable',
            `Cannot reach ${ctx.url} (${reason}). Check QCLI_URL / VPN.`,
            options,
        );
    }
    if (isTimeout(error)) {
        return new RemoteError(
            'timeout',
            `${ctx.url} did not answer within ${ctx.requestTimeoutMs} ms (QCLI_REQUEST_TIMEOUT).`,
            options,
        );
    }
    return new RemoteError(
        'http',
        `${ctx.url}: ${(error as Error)?.message ?? String(error)}`,
        options,
    );
};
