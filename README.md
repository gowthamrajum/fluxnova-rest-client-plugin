# FluxNova REST Client Plugin

A **Postman-style REST client** built into the [FluxNova Modeler](https://github.com/finos/fluxnova-modeler)
(the FINOS fork of the Camunda 7 desktop Modeler — also works in the upstream Camunda 7 Modeler).

Design, run, and wire up HTTP calls for **Connector Service Tasks** without leaving the modeler:
build a request visually, send it (cross-origin calls work — see the proxy below), map the
response into process variables, generate ready-to-paste Groovy/JS, and **save it straight back
into the task's connector config**.

> Status: `v0.2.0` — request builder, inputs/outputs, CORS-free proxy, BPMN round-trip, and a
> deterministic code generator. Apache-2.0.

---

## Features

- **Request builder** — method + URL, query params, headers, and auth (Bearer / Basic / API-Key in
  header or query), with per-row enable/disable and descriptions.
- **Bodies** — raw (JSON / text / XML), `x-www-form-urlencoded`, and `multipart/form-data`.
- **Inputs sidebar** — every `${expression}` used anywhere in the request is auto-detected and gets
  a test-value field; values are substituted so the request actually runs.
- **Send that works cross-origin** — requests go through a tiny **main-process proxy** (Node.js, no
  browser CORS wall). Falls back to a direct renderer fetch when the proxy isn't available. The
  response panel shows which path was used (`via proxy` / `via direct`).
- **Outputs mapping** — map response values to process variables with dot/bracket JSON paths
  (`data[0].id`, `items[*].name`, `meta['content-type']`), previewed live against the last response.
- **Code generator** — deterministic Groovy / JavaScript for a full call or parse-only, driven by
  the same path engine as the live preview (they can never disagree). No LLM, no downloads.
- **Save to Task** — writes the request into the Service Task's `http-connector` config
  (`camunda:inputOutput`) plus a JSON snapshot, so reopening restores the builder exactly. One
  undoable edit.

---

## Install

Requires Node.js ≥ 18.

```bash
git clone https://github.com/gowthamrajum/fluxnova-rest-client-plugin.git
cd fluxnova-rest-client-plugin
npm install
npm run build          # produces dist/client.js
```

Then link the folder into the modeler's plugins directory and restart the modeler:

| OS      | Plugins directory |
| ------- | ----------------- |
| macOS   | `~/Library/Application Support/fluxnova-modeler/plugins/` |
| Linux   | `~/.config/fluxnova-modeler/plugins/` |
| Windows | `%APPDATA%\fluxnova-modeler\plugins\` |

```bash
# macOS example (symlink so `npm run build` updates propagate)
ln -s "$(pwd)" "$HOME/Library/Application Support/fluxnova-modeler/plugins/fluxnova-rest-client"
```

> For the upstream Camunda Modeler, use its `camunda-modeler/plugins/` directory instead.
> After a rebuild, fully **quit and reopen** the modeler to reload the plugin.

---

## Usage

1. Add a **Service Task**, set its Implementation to **Connector**.
2. In the properties panel's Implementation group, click **Build request…**.
3. Fill in the method, URL, headers/params/auth/body. Fill any `${…}` values in the **Inputs**
   sidebar and hit **Send**.
4. Add **Outputs** rows to map response fields → process variables (previewed live).
5. Click **Save to Task** to write it into the connector, or copy the generated **Groovy/JS**.

---

## The main-process proxy (trust model)

Browsers block cross-origin `fetch` from the renderer, so the plugin ships a `menu.js` half that
runs in the modeler's **main process** and hosts a small HTTP proxy on `127.0.0.1` (port range
`34517`–`34526`). The popup forwards request specs there; the actual outbound call is made in
Node, where CORS does not apply, and the result is returned to the popup.

It is a **design-time developer tool**: the proxy is bound to loopback only, exists only while the
modeler is open, and forwards requests you build in the UI. See [SECURITY.md](SECURITY.md). If the
plugin is installed client-only (no `menu` half), Send still works for CORS-permissive endpoints via
a direct fetch.

---

## Develop

```bash
npm run dev     # webpack watch build
npm test        # vitest — path engine, request builder, codegen, connector round-trip
```

Architecture:

- `index.js` — plugin descriptor (`script` = renderer bundle, `menu` = main-process proxy).
- `menu.js` — the loopback HTTP proxy (CommonJS, loaded directly by Electron).
- `client/RestClientPlugin.js` — the React popup (state + render only).
- `client/propertiesProvider.js` — injects the **Build request…** button and hands the popup the
  bpmn-js model services for the round-trip.
- `client/lib/` — framework-free, unit-tested logic: `paths` (JSON-path engine), `expressions`,
  `request` (builder), `codegen`, `proxyClient`, `connectorIo` (BPMN read/write).

---

## Roadmap

- Response history / save named requests.
- OpenAPI import to prefill a request.
- Richer output-parameter styles (FEEL, direct expression) on save.

---

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE). Contributions require a DCO sign-off — see
[CONTRIBUTING.md](CONTRIBUTING.md).
