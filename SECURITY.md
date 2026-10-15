# Security

## Reporting a vulnerability

Email security@qodalis.com with a description and reproduction steps. Please do
not open a public issue for undisclosed vulnerabilities. We aim to acknowledge
reports within three working days.

## Design notes

- The proxy holds the token or password in memory only; it reads them from the
  environment, sends them only to `QCLI_URL` (`Authorization: Bearer`, or the
  sign-in request), and never writes them to logs or tool results.
- Authorization is enforced by the Qodalis CLI server: every tool call runs with
  the permissions of the configured account (and the token's scope). The
  proxy's read-only mode and allow/deny lists can only narrow what the server
  allows, never widen it. Use an account or token scoped to what the AI
  assistant should be able to do.
- A password session opened by the proxy is ended when it shuts down.
- TLS certificates are verified unless `QCLI_TRUST_CERT=true`.
- Nothing is written to stdout except the MCP protocol stream.
