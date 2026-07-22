# Security Policy

## The main-process proxy

To make cross-origin requests work (the browser renderer blocks them via CORS), the plugin's
`menu.js` runs in the modeler's **main process** and starts a small HTTP proxy. Its trust model:

- **Loopback only.** The server binds to `127.0.0.1` (never `0.0.0.0`), so it is not reachable from
  other machines.
- **Lifecycle-bound.** It exists only while the FluxNova/Camunda Modeler is running.
- **Purpose.** It forwards HTTP/HTTPS requests that you build in the REST Client UI — it is a
  design-time developer tool, equivalent to running `curl`/Postman on your own machine.
- **Scope limits.** Only `http:`/`https:` targets are allowed, request bodies are capped, and each
  outbound request times out after 60s.

Any local process on your machine can reach a loopback port, so treat this like any other local dev
server: it is intended for use on a trusted workstation while you are actively modeling. If you do
not want the proxy, install the plugin without its `menu` entry — Send will fall back to a direct
(CORS-limited) renderer fetch.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via a
[GitHub Security Advisory](https://github.com/gowthamrajum/fluxnova-rest-client-plugin/security/advisories/new)
rather than a public issue. We'll acknowledge and work on a fix as quickly as we can.
