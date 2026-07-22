/* SPDX-License-Identifier: Apache-2.0 */
import React from 'camunda-modeler-plugin-helpers/react';
import Modal from 'camunda-modeler-plugin-helpers/components/Modal';

import './style.css';

import { METHODS, BODY_METHODS } from './lib/constants';
import { navigate } from './lib/paths';
import { detectExpressions } from './lib/expressions';
import { activeRows, buildRequest } from './lib/request';
import { proxyBase, sendViaProxy } from './lib/proxyClient';
import { readConnector, writeConnector } from './lib/connectorIo';
import {
  TECH_ACTIONS, BIZ_ACTIONS, BIZ_FORMATS,
  defaultTechExceptions, techCustomRow, bizRow
} from './lib/exceptions';

// Left-column tabs, grouped: request definition | response handling. All share `state.tab`.
const REQ_TABS = [['params', 'Params'], ['authorization', 'Authorization'], ['headers', 'Headers'], ['body', 'Body']];
const RESP_TABS = [['outputs', 'Outputs'], ['technical', 'Technical'], ['business', 'Business']];

const kvRow = () => ({ key: '', value: '', desc: '', enabled: true });
const outRow = () => ({ name: '', path: '' });

/**
 * Postman-style REST client popup with a right-hand Inputs/Outputs sidebar.
 *
 *  - Left  : the request builder (method/url, Params, Authorization, Headers, Body) + response.
 *  - Right : Inputs (top) — every ${expression} used anywhere in the request is auto-detected
 *            and gets a fill field; those values are substituted so the request can actually run.
 *            Outputs (bottom) — map response values (dot/bracket JSON paths) to process variables;
 *            resolved values preview live against the last response.
 *
 * Opened from the "Build request…" button the properties provider adds to a Connector Service
 * Task's Implementation group, via the window.__fluxnovaRestClient handoff registered on mount.
 * Send prefers the main-process proxy (lib/proxyClient) to escape the renderer CORS wall, falling
 * back to a direct fetch. On open it prefills from the task's connector config, and "Save to Task"
 * writes the request back (lib/connectorIo) — an undoable BPMN edit.
 */
export default class RestClientPlugin extends React.PureComponent {
  constructor(props) {
    super(props);
    this.state = this.freshState();
  }

  freshState() {
    return {
      open: false,
      element: null,
      services: null,       // { modeling, bpmnFactory, commandStack } for BPMN round-trip
      saved: false,         // "Saved ✓" flash on the Save to Task button

      // request
      tab: 'params',
      method: 'GET',
      url: '',
      params: [kvRow()],
      headers: [{ key: 'Accept', value: 'application/json', desc: '', enabled: true }, kvRow()],

      // auth
      authType: 'none',
      bearerToken: '',
      basicUser: '',
      basicPass: '',
      apiKeyName: '',
      apiKeyValue: '',
      apiKeyIn: 'header',

      // body
      bodyType: 'none',
      rawType: 'json',
      body: '',
      form: [kvRow()],

      // inputs / outputs
      inputs: {},            // token '${x}' -> test value
      outputs: [outRow()],   // { name, path }

      // exception handling (engine-agnostic design-time metadata; persisted in snapshot)
      techExceptions: defaultTechExceptions(),   // { classes:[…], custom:[…] }
      bizExceptions: [bizRow()],                 // [{ name, script, action, bpmnError }]
      bizFormat: 'groovy',                       // language for the business-check scripts

      // response
      sending: false,
      response: null,
      error: null,
      respTab: 'body',
      respView: 'pretty'
    };
  }

  componentDidMount() {
    window.__fluxnovaRestClient = {
      open: (element, services) => {
        // Prefill from the task's saved connector config (JSON snapshot or inputOutput),
        // and normalize row arrays so each editable table keeps a trailing blank row.
        let prefill = null;
        try { prefill = readConnector(element); } catch (e) { console.error('[fluxnova-rest-client] prefill error', e); }
        const merged = { ...this.freshState(), ...(prefill || {}), open: true, element, services: services || null };
        this.setState(this.normalizeRows(merged));
      }
    };
  }

  componentWillUnmount() {
    if (window.__fluxnovaRestClient) delete window.__fluxnovaRestClient;
  }

  // Ensure editable tables end in a blank row so the "type in the last row to add
  // another" affordance works after a prefill.
  normalizeRows(state) {
    const pad = (rows, make) => {
      const arr = Array.isArray(rows) && rows.length ? rows.slice() : [make()];
      const last = arr[arr.length - 1];
      const empty = make();
      const isBlank = Object.keys(empty).every((k) => k === 'enabled' || !last[k]);
      if (!isBlank) arr.push(empty);
      return arr;
    };
    const tech = state.techExceptions && Array.isArray(state.techExceptions.classes)
      ? state.techExceptions
      : defaultTechExceptions();
    return {
      ...state,
      params: pad(state.params, kvRow),
      headers: pad(state.headers, kvRow),
      form: pad(state.form, kvRow),
      outputs: pad(state.outputs, outRow),
      techExceptions: { classes: tech.classes, custom: pad(tech.custom, techCustomRow) },
      bizExceptions: pad(state.bizExceptions, bizRow)
    };
  }

  saveToTask = () => {
    const { services, element } = this.state;
    if (!services || !element) return;
    try {
      writeConnector(services, element, this.state);
      this.setState({ saved: true });
      setTimeout(() => { if (this.state.open) this.setState({ saved: false }); }, 1800);
    } catch (e) {
      console.error('[fluxnova-rest-client] save error', e);
      this.setState({ error: 'Could not save to task: ' + ((e && e.message) || e) });
    }
  };

  close = () => this.setState({ open: false });
  setField = (field) => (e) => this.setState({ [field]: e.target.value });

  updateRow = (field, i, prop) => (e) => {
    const val = prop === 'enabled' ? e.target.checked : e.target.value;
    const rows = this.state[field].slice();
    rows[i] = { ...rows[i], [prop]: val };
    if (i === rows.length - 1 && (rows[i].key || rows[i].value)) rows.push(kvRow());
    this.setState({ [field]: rows });
  };

  removeRow = (field, i) => () => {
    const rows = this.state[field].slice();
    rows.splice(i, 1);
    if (!rows.length) rows.push(kvRow());
    this.setState({ [field]: rows });
  };

  activeRows(field) {
    return activeRows(this.state[field]);
  }

  countFor(tab) {
    if (tab === 'params') return this.activeRows('params').length;
    if (tab === 'headers') return this.activeRows('headers').length + (this.state.authType !== 'none' ? 1 : 0);
    if (tab === 'authorization') return this.state.authType !== 'none' ? 1 : 0;
    if (tab === 'body') return this.state.bodyType !== 'none' ? 1 : 0;
    return 0;
  }

  // Badge counts for the response-handling tabs.
  respCount(tab) {
    const s = this.state;
    if (tab === 'outputs') return s.outputs.filter((o) => o.name && o.path).length;
    if (tab === 'technical') {
      const t = s.techExceptions;
      return t.classes.filter((c) => c.action !== 'ignore').length + t.custom.filter((r) => r.code).length;
    }
    if (tab === 'business') return s.bizExceptions.filter((r) => r.name || r.script).length;
    return 0;
  }

  renderTab(t, label, n) {
    return (
      <button
        key={t}
        className={'rc-tab' + (this.state.tab === t ? ' active' : '')}
        onClick={() => this.setState({ tab: t })}
      >
        {label}
        {n > 0 && <span className="rc-badge">{n}</span>}
      </button>
    );
  }

  /* ---- expression inputs (detection + substitution live in lib/expressions.js) ---- */

  setInput = (tok) => (e) => this.setState({ inputs: { ...this.state.inputs, [tok]: e.target.value } });

  /* ---- output mapping ---- */

  updateOut = (i, prop) => (e) => {
    const rows = this.state.outputs.slice();
    rows[i] = { ...rows[i], [prop]: e.target.value };
    if (i === rows.length - 1 && (rows[i].name || rows[i].path)) rows.push(outRow());
    this.setState({ outputs: rows });
  };

  removeOut = (i) => () => {
    const rows = this.state.outputs.slice();
    rows.splice(i, 1);
    if (!rows.length) rows.push(outRow());
    this.setState({ outputs: rows });
  };

  /* ---- request send (build + path engine + codegen live in lib/) ---- */

  send = async () => {
    if (!this.state.url.trim()) return;
    this.setState({ sending: true, response: null, error: null, respTab: 'body' });
    const started = Date.now();
    try {
      const { url, opts } = buildRequest(this.state);

      // Multipart FormData can't be reconstructed over the JSON proxy — send those
      // directly. Everything else prefers the main-process proxy (no CORS wall) and
      // falls back to a direct renderer fetch when no proxy is listening.
      const proxyable = !(opts.body instanceof FormData);
      const base = proxyable ? await proxyBase() : null;

      const norm = base
        ? await this.sendProxy(url, opts)
        : await this.sendDirect(url, opts);

      this.setState({ sending: false, response: { ...norm, timeMs: norm.timeMs != null ? norm.timeMs : Date.now() - started } });
    } catch (e) {
      this.setState({
        sending: false,
        error: (e && e.message) ? e.message : String(e),
        response: { timeMs: Date.now() - started }
      });
    }
  };

  // Normalize a raw response body string into { raw, body, shape, bytes }.
  static shapeBody(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
    return {
      raw: text,
      body: parsed,
      bytes: new Blob([text]).size,
      shape: Array.isArray(parsed) ? 'list' : (parsed && typeof parsed === 'object' ? 'map' : 'text')
    };
  }

  async sendDirect(url, opts) {
    const started = Date.now();
    const res = await fetch(url, opts);
    const text = await res.text();
    const respHeaders = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });
    return {
      via: 'direct',
      status: res.status,
      statusText: res.statusText,
      timeMs: Date.now() - started,
      headers: respHeaders,
      ...RestClientPlugin.shapeBody(text)
    };
  }

  async sendProxy(url, opts) {
    const data = await sendViaProxy({
      url,
      method: opts.method,
      headers: opts.headers,
      body: typeof opts.body === 'string' ? opts.body : undefined
    });
    return {
      via: 'proxy',
      status: data.status,
      statusText: data.statusText,
      timeMs: data.timeMs,
      headers: data.headers || {},
      ...RestClientPlugin.shapeBody(data.body || '')
    };
  }

  taskLabel() {
    const el = this.state.element;
    const bo = el && (el.businessObject || el);
    return bo ? (bo.name || bo.id) : '';
  }

  render() {
    if (!this.state.open) return null;
    const { method, url, tab, sending } = this.state;
    const label = this.taskLabel();

    return (
      <Modal onClose={this.close} className="rc-modal">
        <Modal.Title>
          <span className="rc-modal-title">REST Client{label ? <span className="rc-modal-sub"> — {label}</span> : null}</span>
        </Modal.Title>
        <Modal.Body>
          <div className="rc-content rc-split">
            <div className="rc-exec-col">
                <div className="rc-urlbar">
                  <div className={'rc-method-wrap m-' + method.toLowerCase()}>
                    <select className="rc-method" value={method} onChange={this.setField('method')}>
                      {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <input
                    className="rc-url"
                    placeholder="https://api.example.com/${resourceId}"
                    value={url}
                    onChange={this.setField('url')}
                    onKeyDown={(e) => { if (e.key === 'Enter') this.send(); }}
                  />
                  <button className="rc-send" onClick={this.send} disabled={sending || !url.trim()}>
                    {sending ? 'Sending…' : 'Send'}
                  </button>
                </div>

                <div className="rc-tabs">
                  <div className="rc-tabgroup">
                    {REQ_TABS.map(([t, l]) => this.renderTab(t, l, this.countFor(t)))}
                  </div>
                  <span className="rc-tabsep" />
                  <div className="rc-tabgroup">
                    {RESP_TABS.map(([t, l]) => this.renderTab(t, l, this.respCount(t)))}
                  </div>
                </div>

                <div className={'rc-tabbody' + (tab === 'technical' || tab === 'business' ? ' tall' : '')}>
                  {tab === 'params' && this.renderKvTable('params', 'Query Params')}
                  {tab === 'authorization' && this.renderAuth()}
                  {tab === 'headers' && this.renderKvTable('headers', 'Headers')}
                  {tab === 'body' && this.renderBody()}
                  {tab === 'outputs' && this.renderOutputs()}
                  {tab === 'technical' && this.renderTechExceptions()}
                  {tab === 'business' && this.renderBizExceptions()}
                </div>

                {tab !== 'technical' && tab !== 'business' && this.renderResponse()}
            </div>
            <div className="rc-side">
              {this.renderInputsSection()}
            </div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <button type="button" className="rc-secondary" onClick={this.close}>Close</button>
          {this.state.services && (
            <button
              type="button"
              className={'rc-save' + (this.state.saved ? ' saved' : '')}
              onClick={this.saveToTask}
              disabled={!url.trim()}
              title="Write this request into the Service Task's connector config (undoable)"
            >
              {this.state.saved ? 'Saved ✓' : 'Save to Task'}
            </button>
          )}
          <button type="button" className="rc-send" onClick={this.send} disabled={sending || !url.trim()}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </Modal.Footer>
      </Modal>
    );
  }

  /* ---- right sidebar: Inputs (Name/Value) + Outputs ---- */

  renderInputsSection() {
    const exprs = detectExpressions(this.state);
    const unfilled = exprs.filter((t) => !this.state.inputs[t]).length;
    return (
      <div className="rc-side-sec rc-side-inputs">
        <div className="rc-side-title">
          <span>Inputs</span>
          {exprs.length > 0 && <span className="rc-badge">{exprs.length}</span>}
          {unfilled > 0 && <span className="rc-side-note">{unfilled} to fill</span>}
        </div>
        <div className="rc-side-scroll">
          <table className="rc-io-table">
            <thead>
              <tr><th>Name</th><th>Value</th></tr>
            </thead>
            <tbody>
              {exprs.length === 0 ? (
                <tr className="rc-io-empty">
                  <td colSpan={2}>Add <code>{'${var}'}</code> in the request to see it here.</td>
                </tr>
              ) : (
                exprs.map((tok) => (
                  <tr key={tok}>
                    <td className="rc-io-name" title={tok}>{tok}</td>
                    <td className="rc-io-inputcell">
                      <input
                        className="rc-io-input"
                        placeholder="value"
                        value={this.state.inputs[tok] || ''}
                        onChange={this.setInput(tok)}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  renderOutputs() {
    const { outputs, response } = this.state;
    const body = response && response.body;
    return (
      <div className="rc-exc">
        <p className="rc-exc-hint">Map response fields to process variables with a JSON path (<code>data[0].id</code>, <code>items[*].name</code>). Values preview live against the last response.</p>
      <table className="rc-io-table rc-io-card">
        <thead>
          <tr><th>Variable</th><th>JSON path</th><th className="rc-io-xcol" /></tr>
        </thead>
        <tbody>
          {outputs.map((o, i) => {
            const val = (o.path && body !== undefined) ? navigate(body, o.path) : undefined;
            const resolved = o.path ? (val !== undefined ? this.previewVal(val) : (response ? '—' : '')) : '';
            return (
              <tr key={i}>
                <td className="rc-io-inputcell">
                  <input className="rc-io-input" placeholder="variable" value={o.name} onChange={this.updateOut(i, 'name')} />
                </td>
                <td className="rc-io-inputcell">
                  <input className="rc-io-input" placeholder="json path" value={o.path} onChange={this.updateOut(i, 'path')} />
                  {resolved !== '' && <span className={'rc-io-resolved' + (val === undefined ? ' miss' : '')}>{resolved}</span>}
                </td>
                <td className="rc-io-xcol">
                  <button className="rc-del" onClick={this.removeOut(i)} title="remove">×</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    );
  }

  /* ---- Technical Exceptions: HTTP-failure class / custom code -> action ---- */

  renderTechExceptions() {
    const { techExceptions } = this.state;
    return (
      <div className="rc-exc">
        <p className="rc-exc-hint">Map each HTTP failure to an action. <b>Throw BPMN error</b> raises a catchable error (attach an error boundary event with the matching code).</p>
        <div className="rc-exc-list">
          {techExceptions.classes.map((c, i) => (
            <div className="rc-exc-row" key={c.key}>
              <span className="rc-exc-class"><b>{c.label}</b><span className="rc-exc-match">{c.match}</span></span>
              <select className="rc-select rc-exc-action" value={c.action} onChange={this.updateTechClass(i, 'action')}>
                {TECH_ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {c.action === 'error' && (
                <input className="rc-io-input rc-exc-err" placeholder="bpmn error code" value={c.bpmnError} onChange={this.updateTechClass(i, 'bpmnError')} />
              )}
            </div>
          ))}
        </div>
        <div className="rc-exc-subhead">Custom status codes</div>
        <div className="rc-exc-list">
          {techExceptions.custom.map((r, i) => (
            <div className="rc-exc-row" key={i}>
              <input className="rc-io-input rc-exc-codein" placeholder="404, 5xx…" value={r.code} onChange={this.updateTechCustom(i, 'code')} />
              <select className="rc-select rc-exc-action" value={r.action} onChange={this.updateTechCustom(i, 'action')}>
                {TECH_ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {r.action === 'error' && (
                <input className="rc-io-input rc-exc-err" placeholder="bpmn error code" value={r.bpmnError} onChange={this.updateTechCustom(i, 'bpmnError')} />
              )}
              <button className="rc-del" onClick={this.removeTechCustom(i)} title="remove">×</button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  updateTechClass = (i, prop) => (e) => {
    const classes = this.state.techExceptions.classes.slice();
    classes[i] = { ...classes[i], [prop]: e.target.value };
    this.setState({ techExceptions: { ...this.state.techExceptions, classes } });
  };

  updateTechCustom = (i, prop) => (e) => {
    const custom = this.state.techExceptions.custom.slice();
    custom[i] = { ...custom[i], [prop]: e.target.value };
    if (i === custom.length - 1 && (custom[i].code || custom[i].bpmnError)) custom.push(techCustomRow());
    this.setState({ techExceptions: { ...this.state.techExceptions, custom } });
  };

  removeTechCustom = (i) => () => {
    const custom = this.state.techExceptions.custom.slice();
    custom.splice(i, 1);
    if (!custom.length) custom.push(techCustomRow());
    this.setState({ techExceptions: { ...this.state.techExceptions, custom } });
  };

  /* ---- Business Exceptions: custom script (throws = exception) -> action ---- */

  renderBizExceptions() {
    const { bizExceptions, bizFormat } = this.state;
    return (
      <div className="rc-exc rc-biz">
        <div className="rc-biz-head">
          <p className="rc-exc-hint">Each check is a script over the response. If it <b>throws</b>, that's a business exception — run its action. The parsed <code>response</code> (and <code>statusCode</code>, <code>headers</code>) are in scope.</p>
          <div className="rc-seg small">
            {BIZ_FORMATS.map(([v, l]) => (
              <button key={v} className={bizFormat === v ? 'on' : ''} onClick={() => this.setState({ bizFormat: v })}>{l}</button>
            ))}
          </div>
        </div>
        <div className="rc-exc-list">
          {bizExceptions.map((r, i) => (
            <div className="rc-biz-row" key={i}>
              <div className="rc-biz-row-head">
                <input className="rc-io-input rc-biz-name" placeholder="check name" value={r.name} onChange={this.updateBiz(i, 'name')} />
                <select className="rc-select rc-exc-action" value={r.action} onChange={this.updateBiz(i, 'action')}>
                  {BIZ_ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <button className="rc-del" onClick={this.removeBiz(i)} title="remove">×</button>
              </div>
              <textarea
                className="rc-biz-script"
                spellCheck={false}
                placeholder={bizFormat === 'groovy' ? "if (response?.status != 'ok') throw new RuntimeException('bad status')" : "if (response?.status !== 'ok') throw new Error('bad status')"}
                value={r.script}
                onChange={this.updateBiz(i, 'script')}
              />
              {r.action === 'error' && (
                <input className="rc-io-input rc-exc-err wide" placeholder="bpmn error code (for the boundary event)" value={r.bpmnError} onChange={this.updateBiz(i, 'bpmnError')} />
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  updateBiz = (i, prop) => (e) => {
    const rows = this.state.bizExceptions.slice();
    rows[i] = { ...rows[i], [prop]: e.target.value };
    if (i === rows.length - 1 && (rows[i].name || rows[i].script)) rows.push(bizRow());
    this.setState({ bizExceptions: rows });
  };

  removeBiz = (i) => () => {
    const rows = this.state.bizExceptions.slice();
    rows.splice(i, 1);
    if (!rows.length) rows.push(bizRow());
    this.setState({ bizExceptions: rows });
  };

  previewVal(v) {
    if (v === null) return 'null';
    if (typeof v === 'object') {
      try { const s = JSON.stringify(v); return s.length > 60 ? s.slice(0, 57) + '…' : s; } catch (_) { return String(v); }
    }
    return String(v);
  }

  /* ---- request editors ---- */

  renderKvTable(field, title) {
    const rows = this.state[field];
    return (
      <div className="rc-kv">
        <div className="rc-kv-head">
          <span className="rc-kv-cap">{title}</span>
        </div>
        <div className="rc-kv-cols">
          <span className="c-en" />
          <span className="c-k">Key</span>
          <span className="c-v">Value</span>
          <span className="c-d">Description</span>
          <span className="c-x" />
        </div>
        {rows.map((row, i) => (
          <div className={'rc-kv-row' + (row.enabled ? '' : ' off')} key={i}>
            <input type="checkbox" className="c-en" checked={row.enabled} onChange={this.updateRow(field, i, 'enabled')} title="Enable/disable" />
            <input className="c-k" placeholder="key" value={row.key} onChange={this.updateRow(field, i, 'key')} />
            <input className="c-v" placeholder="value" value={row.value} onChange={this.updateRow(field, i, 'value')} />
            <input className="c-d" placeholder="description" value={row.desc} onChange={this.updateRow(field, i, 'desc')} />
            <button className="c-x rc-del" onClick={this.removeRow(field, i)} title="remove">×</button>
          </div>
        ))}
      </div>
    );
  }

  renderAuth() {
    const { authType, bearerToken, basicUser, basicPass, apiKeyName, apiKeyValue, apiKeyIn } = this.state;
    return (
      <div className="rc-auth">
        <label className="rc-field">
          <span className="rc-label">Type</span>
          <select className="rc-select" value={authType} onChange={this.setField('authType')}>
            <option value="none">No Auth</option>
            <option value="bearer">Bearer Token</option>
            <option value="basic">Basic Auth</option>
            <option value="apikey">API Key</option>
          </select>
        </label>

        {authType === 'none' && <p className="rc-hint">This request does not use any authorization.</p>}

        {authType === 'bearer' && (
          <label className="rc-field">
            <span className="rc-label">Token</span>
            <input className="rc-input" placeholder="token or ${expression}" value={bearerToken} onChange={this.setField('bearerToken')} />
          </label>
        )}

        {authType === 'basic' && (
          <>
            <label className="rc-field">
              <span className="rc-label">Username</span>
              <input className="rc-input" value={basicUser} onChange={this.setField('basicUser')} />
            </label>
            <label className="rc-field">
              <span className="rc-label">Password</span>
              <input className="rc-input" type="password" value={basicPass} onChange={this.setField('basicPass')} />
            </label>
          </>
        )}

        {authType === 'apikey' && (
          <>
            <label className="rc-field">
              <span className="rc-label">Key</span>
              <input className="rc-input" placeholder="X-API-Key" value={apiKeyName} onChange={this.setField('apiKeyName')} />
            </label>
            <label className="rc-field">
              <span className="rc-label">Value</span>
              <input className="rc-input" value={apiKeyValue} onChange={this.setField('apiKeyValue')} />
            </label>
            <label className="rc-field">
              <span className="rc-label">Add to</span>
              <select className="rc-select" value={apiKeyIn} onChange={this.setField('apiKeyIn')}>
                <option value="header">Header</option>
                <option value="query">Query Params</option>
              </select>
            </label>
          </>
        )}
      </div>
    );
  }

  renderBody() {
    const { bodyType, rawType, method } = this.state;
    const allowed = BODY_METHODS.includes(method);
    return (
      <div className="rc-body-editor">
        <div className="rc-body-modes">
          {[['none', 'none'], ['raw', 'raw'], ['urlencoded', 'x-www-form-urlencoded'], ['form', 'form-data']].map(([val, lbl]) => (
            <label key={val} className={'rc-radio' + (bodyType === val ? ' on' : '')}>
              <input type="radio" name="bodyType" value={val} checked={bodyType === val} onChange={this.setField('bodyType')} />
              {lbl}
            </label>
          ))}
          {bodyType === 'raw' && (
            <select className="rc-rawtype" value={rawType} onChange={this.setField('rawType')}>
              <option value="json">JSON</option>
              <option value="text">Text</option>
              <option value="xml">XML</option>
            </select>
          )}
        </div>

        {!allowed && bodyType !== 'none' && (
          <p className="rc-hint warn">Body is ignored for {method} requests.</p>
        )}

        {bodyType === 'none' && <p className="rc-hint">This request does not have a body.</p>}
        {bodyType === 'raw' && (
          <textarea
            className="rc-bodyarea"
            spellCheck={false}
            placeholder={rawType === 'json' ? '{\n  "key": "value"\n}' : ''}
            value={this.state.body}
            onChange={this.setField('body')}
          />
        )}
        {(bodyType === 'urlencoded' || bodyType === 'form') && this.renderKvTable('form', bodyType === 'form' ? 'Form Data' : 'URL-encoded Fields')}
      </div>
    );
  }

  /* ---- response ---- */

  renderResponse() {
    const { response, error, respTab, respView } = this.state;
    if (!response && !error) {
      return (
        <div className="rc-response">
          <div className="rc-resp-empty">
            <span>Response</span>
            <p>Fill inputs, enter a URL, and hit <b>Send</b> to see the response here.</p>
          </div>
        </div>
      );
    }
    const ok = response && response.status >= 200 && response.status < 300;
    const hdrCount = response && response.headers ? Object.keys(response.headers).length : 0;

    return (
      <div className="rc-response">
        <div className="rc-resp-bar">
          <div className="rc-resp-tabs">
            <button className={'rc-rtab' + (respTab === 'body' ? ' active' : '')} onClick={() => this.setState({ respTab: 'body' })}>Body</button>
            <button className={'rc-rtab' + (respTab === 'headers' ? ' active' : '')} onClick={() => this.setState({ respTab: 'headers' })}>
              Headers{hdrCount ? <span className="rc-badge">{hdrCount}</span> : null}
            </button>
          </div>
          <div className="rc-resp-meta">
            {response && response.status != null && (
              <span className={'rc-status ' + (ok ? 'ok' : 'bad')}>{response.status} {response.statusText}</span>
            )}
            {response && response.timeMs != null && <span className="rc-time">{response.timeMs} ms</span>}
            {response && response.bytes != null && <span className="rc-time">{this.humanSize(response.bytes)}</span>}
            {response && response.shape && <span className={'rc-shape s-' + response.shape}>{response.shape}</span>}
            {response && response.via && <span className={'rc-via v-' + response.via} title={response.via === 'proxy' ? 'Sent through the main-process proxy (no CORS)' : 'Sent directly from the renderer (subject to CORS)'}>via {response.via}</span>}
          </div>
        </div>

        {error && (
          <pre className="rc-body rc-err">Error: {error}{'\n\n'}This request went directly from the renderer, so a cross-origin call may have been blocked by CORS. The main-process proxy (menu.js) handles cross-origin calls — make sure the plugin is installed with its menu half and restart the modeler.</pre>
        )}

        {!error && respTab === 'body' && response && response.body !== undefined && (
          <>
            <div className="rc-view-toggle">
              <button className={respView === 'pretty' ? 'on' : ''} onClick={() => this.setState({ respView: 'pretty' })}>Pretty</button>
              <button className={respView === 'raw' ? 'on' : ''} onClick={() => this.setState({ respView: 'raw' })}>Raw</button>
            </div>
            <pre className="rc-body">{respView === 'raw' ? (response.raw || '') : this.pretty(response.body)}</pre>
          </>
        )}

        {!error && respTab === 'headers' && (
          <div className="rc-resp-headers">
            {response && response.headers && Object.keys(response.headers).length
              ? Object.keys(response.headers).map((k) => (
                <div className="rc-hrow" key={k}><span className="rc-hk">{k}</span><span className="rc-hv">{response.headers[k]}</span></div>
              ))
              : <p className="rc-hint">No headers.</p>}
          </div>
        )}
      </div>
    );
  }

  humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  pretty(body) {
    if (typeof body === 'string') return body;
    try { return JSON.stringify(body, null, 2); } catch (_) { return String(body); }
  }
}
