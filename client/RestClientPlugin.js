/* SPDX-License-Identifier: Apache-2.0 */
import React from 'camunda-modeler-plugin-helpers/react';
import Modal from 'camunda-modeler-plugin-helpers/components/Modal';

import './style.css';

import { METHODS, BODY_METHODS } from './lib/constants';
import { navigate } from './lib/paths';
import { detectExpressions } from './lib/expressions';
import { activeRows, buildRequest } from './lib/request';
import { JSON_TYPES, jsonNode, jsonRoot, isContainer, compileJson, jsonError, formatJson, mapNodeAt, payloadCode } from './lib/payload';
import { proxyBase, sendViaProxy } from './lib/proxyClient';
import { readConnector, writeConnector } from './lib/connectorIo';
import { compileHandler } from './lib/connectorCompile';
import { IconSend, IconSave, IconCheck, IconClose, IconPlus, IconChevronLeft, IconChevronRight } from './icons';
import {
  TECH_ACTION_DEFS, BIZ_ACTION_DEFS, BIZ_FORMATS, STATUS_PRESETS,
  defaultTechExceptions, techRule, bizRow, anyActionOn, statusShort
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
      inputsOpen: false,    // Inputs sidebar drawer — starts collapsed
      respOpen: false,      // Response panel — collapsed until a Send expands it

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
      jsonRoot: jsonRoot(),           // structured JSON payload tree (nested objects/arrays)
      payloadSave: 'json',            // how the payload is written to the connector: json | groovy | js

      // inputs / outputs
      inputs: {},            // token '${x}' -> test value
      outputs: [outRow()],   // { name, path }

      // exception handling (engine-agnostic design-time metadata; persisted in snapshot)
      techExceptions: defaultTechExceptions(),   // { rules: [{ status, code, actions }] }
      bizExceptions: [],                         // [{ name, script, actions }]
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
    // Append a trailing blank row so the "type in the last row to add another" affordance
    // keeps working after a prefill. `blank` decides when the last row still counts as empty.
    const pad = (rows, make, blank) => {
      const arr = Array.isArray(rows) && rows.length ? rows.slice() : [make()];
      const last = arr[arr.length - 1];
      const isBlank = blank
        ? blank(last)
        : Object.keys(make()).every((k) => k === 'enabled' || !last[k]);
      if (!isBlank) arr.push(make());
      return arr;
    };
    // Exception rules are add-driven ("+"), so no trailing-blank padding — just keep
    // whatever the snapshot restored (or an empty list).
    const tech = state.techExceptions && Array.isArray(state.techExceptions.rules)
      ? state.techExceptions
      : defaultTechExceptions();
    return {
      ...state,
      params: pad(state.params, kvRow),
      headers: pad(state.headers, kvRow),
      form: pad(state.form, kvRow),
      outputs: pad(state.outputs, outRow),
      jsonRoot: (state.jsonRoot && state.jsonRoot.type) ? state.jsonRoot : jsonRoot(),
      techExceptions: tech,
      bizExceptions: Array.isArray(state.bizExceptions) ? state.bizExceptions : []
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
  clearResponse = () => this.setState({ response: null, error: null, respOpen: false });
  setField = (field) => (e) => this.setState({ [field]: e.target.value });

  /* ---- workspace: resizable modal that remembers its size ---- */

  // Ref on the resize grip. Fires when the modal opens; applies the saved (or a
  // near-full-screen default) size to the host modal element inline.
  applyWorkspaceSize = (el) => {
    this.resizeGrip = el || null;
    if (!el) return;
    const modal = el.closest('.rc-modal');
    if (!modal) return;
    let w = 0, h = 0;
    try { w = parseInt(localStorage.getItem('fnrc.ws.w'), 10) || 0; h = parseInt(localStorage.getItem('fnrc.ws.h'), 10) || 0; } catch (_) { /* no storage */ }
    if (!w) w = Math.min(1400, Math.round(window.innerWidth * 0.94));
    if (!h) h = Math.round(window.innerHeight * 0.88);
    modal.style.width = w + 'px';
    modal.style.height = h + 'px';
  };

  startResize = (e) => {
    const modal = this.resizeGrip && this.resizeGrip.closest('.rc-modal');
    if (!modal) return;
    e.preventDefault();
    const rect = modal.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY, startW = rect.width, startH = rect.height;
    const MINW = 760, MINH = 460;
    const maxW = window.innerWidth * 0.98, maxH = window.innerHeight * 0.96;
    // The modal is center-anchored, so each edge moves half the delta — scale by 2 to track the pointer.
    const onMove = (ev) => {
      modal.style.width = Math.min(maxW, Math.max(MINW, startW + (ev.clientX - startX) * 2)) + 'px';
      modal.style.height = Math.min(maxH, Math.max(MINH, startH + (ev.clientY - startY) * 2)) + 'px';
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        const r = modal.getBoundingClientRect();
        localStorage.setItem('fnrc.ws.w', String(Math.round(r.width)));
        localStorage.setItem('fnrc.ws.h', String(Math.round(r.height)));
      } catch (_) { /* no storage */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

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
    if (tab === 'technical') return s.techExceptions.rules.length;
    if (tab === 'business') return s.bizExceptions.length;
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
    // Clicking Send expands the response panel.
    this.setState({ sending: true, response: null, error: null, respTab: 'body', respOpen: true });
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
    const { method, url, tab, sending, respOpen } = this.state;
    const label = this.taskLabel();
    // A collapsible Response panel lives under the request tabs (not the config tabs).
    const showResponse = tab !== 'technical' && tab !== 'business';
    // When the response is collapsed (or absent), the request editor fills the height.
    const tallBody = tab === 'technical' || tab === 'business' || !respOpen;

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
                    <IconSend />{sending ? 'Sending…' : 'Send'}
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

                <div className={'rc-tabbody' + (tallBody ? ' tall' : '')}>
                  {tab === 'params' && this.renderKvTable('params', 'Query Params')}
                  {tab === 'authorization' && this.renderAuth()}
                  {tab === 'headers' && this.renderKvTable('headers', 'Headers')}
                  {tab === 'body' && this.renderBody()}
                  {tab === 'outputs' && this.renderOutputs()}
                  {tab === 'technical' && this.renderTechExceptions()}
                  {tab === 'business' && this.renderBizExceptions()}
                </div>

                {showResponse && this.renderResponse()}
            </div>
            <div className={'rc-side' + (this.state.inputsOpen ? '' : ' collapsed')}>
              {this.state.inputsOpen ? this.renderInputsSection() : (
                <button className="rc-side-reveal" onClick={() => this.setState({ inputsOpen: true })} title="Show Inputs">
                  <IconChevronLeft />
                  <span className="rc-side-vlabel">Inputs</span>
                </button>
              )}
            </div>
            <div className="rc-resize" ref={this.applyWorkspaceSize} onPointerDown={this.startResize} title="Drag to resize" />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <button type="button" className="rc-secondary rc-close" onClick={this.close}><IconClose />Close</button>
          {this.state.services && (
            <button
              type="button"
              className={'rc-save' + (this.state.saved ? ' saved' : '')}
              onClick={this.saveToTask}
              disabled={!url.trim()}
              title="Write this request into the Service Task's connector config (undoable)"
            >
              {this.state.saved ? <IconCheck /> : <IconSave />}{this.state.saved ? 'Saved' : 'Save to Task'}
            </button>
          )}
        </Modal.Footer>
      </Modal>
    );
  }

  /* ---- right sidebar: Inputs (Name/Value) + Outputs ---- */

  // The `${x}` token stripped of its wrapper, for a cleaner field label.
  tokenName(tok) {
    const m = /^\$\{([^}]*)\}$/.exec(tok);
    return m ? m[1] : tok;
  }

  renderInputsSection() {
    const exprs = detectExpressions(this.state);
    const unfilled = exprs.filter((t) => !this.state.inputs[t]).length;
    return (
      <div className="rc-side-sec rc-side-inputs">
        <div className="rc-side-title">
          <span>Inputs</span>
          {exprs.length > 0 && <span className="rc-badge">{exprs.length}</span>}
          {unfilled > 0 && <span className="rc-side-note">{unfilled} to fill</span>}
          <button className="rc-side-collapse" onClick={() => this.setState({ inputsOpen: false })} title="Collapse">
            <IconChevronRight />
          </button>
        </div>
        <div className="rc-side-scroll">
          {exprs.length === 0 ? (
            <div className="rc-in-empty">
              Add <code>{'${var}'}</code> anywhere in the request and it shows up here for a test value.
            </div>
          ) : (
            <div className="rc-in-list">
              {exprs.map((tok) => {
                const filled = !!this.state.inputs[tok];
                return (
                  <label className="rc-in-field" key={tok}>
                    <span className="rc-in-tok" title={tok}>
                      {this.tokenName(tok)}
                      {!filled && <span className="rc-in-dot" title="not filled" />}
                    </span>
                    <input
                      className="rc-in-input"
                      placeholder="test value"
                      value={this.state.inputs[tok] || ''}
                      onChange={this.setInput(tok)}
                    />
                  </label>
                );
              })}
            </div>
          )}
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

  /* ---- Technical Exceptions: HTTP class / custom code -> multiple toggleable actions ---- */

  // Shared renderer for a set of toggleable actions on one exception (class/custom/business).
  renderActions(defs, actions, onToggle, onValue) {
    return (
      <div className="rc-acts">
        <div className="rc-act-toggles">
          {defs.map((d) => (
            <button
              key={d.key}
              type="button"
              className={'rc-tgl' + (actions[d.key] && actions[d.key].on ? ' on' : '')}
              onClick={() => onToggle(d.key)}
            >
              {actions[d.key] && actions[d.key].on ? '✓ ' : ''}{d.label}
            </button>
          ))}
        </div>
        {defs.some((d) => d.field && actions[d.key] && actions[d.key].on) && (
          <div className="rc-act-fields">
            {defs.filter((d) => d.field && actions[d.key] && actions[d.key].on).map((d) => (
              <label className="rc-act-field" key={d.key}>
                <span>{d.field}</span>
                <input
                  className="rc-io-input"
                  placeholder={d.placeholder}
                  value={actions[d.key].value}
                  onChange={(e) => onValue(d.key, e.target.value)}
                />
              </label>
            ))}
          </div>
        )}
      </div>
    );
  }

  renderTechExceptions() {
    const rules = this.state.techExceptions.rules;
    return (
      <div className="rc-exc">
        <p className="rc-exc-hint">Add a rule for each failure you want to handle: pick a status, then toggle any actions. <b>Log</b> and <b>Throw incident</b> take a message; <b>Throw BPMN error</b> takes a code an error boundary event can catch.</p>
        {rules.length === 0 && (
          <div className="rc-exc-blank">No error handling yet. Add a rule to react to HTTP failures.</div>
        )}
        <div className="rc-exc-list">
          {rules.map((r, i) => (
            <div className="rc-exc-card" key={i}>
              <div className="rc-exc-card-head">
                <span className="rc-exc-when">When</span>
                <select className="rc-select rc-exc-status" value={r.status} onChange={this.setTechStatus(i)}>
                  {STATUS_PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {r.status === 'custom' && (
                  <input className="rc-io-input rc-exc-codein" placeholder="e.g. 404, 409, 5xx" value={r.code} onChange={this.setTechCode(i)} />
                )}
                {r.status !== 'custom' && statusShort(r.status) && <span className="rc-exc-match">{statusShort(r.status)}</span>}
                <button className="rc-del" onClick={this.removeTechRule(i)} title="remove rule">×</button>
              </div>
              {this.renderActions(TECH_ACTION_DEFS, r.actions, this.toggleTech(i), this.valueTech(i))}
            </div>
          ))}
        </div>
        <button type="button" className="rc-add" onClick={this.addTechRule}><IconPlus />Add error rule</button>
        {this.renderCodePreview()}
      </div>
    );
  }

  // Live preview of the native connector script that Save writes (technical + business
  // combined), with the Groovy/JavaScript choice that determines its language.
  renderCodePreview() {
    const { bizFormat } = this.state;
    const handler = compileHandler(this.state);
    return (
      <div className="rc-code">
        <div className="rc-code-head">
          <span className="rc-code-title">Generated connector script</span>
          <div className="rc-seg small">
            {BIZ_FORMATS.map(([v, l]) => (
              <button key={v} className={bizFormat === v ? 'on' : ''} onClick={() => this.setState({ bizFormat: v })}>{l}</button>
            ))}
          </div>
        </div>
        <pre className="rc-code-body">{handler ? handler.script : '// Add an error rule or a business check to generate the handler script.'}</pre>
        <p className="rc-code-note">Saved into the Service Task as a native <code>{bizFormat === 'js' ? 'javascript' : 'groovy'}</code> connector output parameter — the engine runs it, no custom backend.</p>
      </div>
    );
  }

  addTechRule = () => this.setState({ techExceptions: { rules: [...this.state.techExceptions.rules, techRule()] } });
  removeTechRule = (i) => () => {
    const rules = this.state.techExceptions.rules.slice();
    rules.splice(i, 1);
    this.setState({ techExceptions: { rules } });
  };
  setTechRule(i, patch) {
    const rules = this.state.techExceptions.rules.slice();
    rules[i] = { ...rules[i], ...patch };
    this.setState({ techExceptions: { rules } });
  }
  setTechStatus = (i) => (e) => this.setTechRule(i, { status: e.target.value });
  setTechCode = (i) => (e) => this.setTechRule(i, { code: e.target.value });
  toggleTech = (i) => (key) => {
    const cur = this.state.techExceptions.rules[i].actions[key];
    this.setTechRule(i, { actions: { ...this.state.techExceptions.rules[i].actions, [key]: { ...cur, on: !cur.on } } });
  };
  valueTech = (i) => (key, value) => {
    const cur = this.state.techExceptions.rules[i].actions[key];
    this.setTechRule(i, { actions: { ...this.state.techExceptions.rules[i].actions, [key]: { ...cur, value } } });
  };

  /* ---- Business Exceptions: custom script (throws = exception) -> toggleable actions ---- */

  renderBizExceptions() {
    const { bizExceptions, bizFormat } = this.state;
    return (
      <div className="rc-exc rc-biz">
        <p className="rc-exc-hint">Add a check: a script (in the language chosen below) over the response. If it <b>throws</b>, that's a business exception — run whichever actions are toggled on. In scope: <code>body</code> (parsed JSON), <code>response</code> (raw), <code>statusCode</code>, <code>headers</code>.</p>
        {bizExceptions.length === 0 && (
          <div className="rc-exc-blank">No business checks yet. Add one to validate the response.</div>
        )}
        <div className="rc-exc-list">
          {bizExceptions.map((r, i) => (
            <div className="rc-biz-row" key={i}>
              <div className="rc-biz-row-head">
                <input className="rc-io-input rc-biz-name" placeholder="check name" value={r.name} onChange={this.setBizField(i, 'name')} />
                <button className="rc-del" onClick={this.removeBiz(i)} title="remove">×</button>
              </div>
              <textarea
                className="rc-biz-script"
                spellCheck={false}
                placeholder={bizFormat === 'groovy' ? "if (body?.status != 'ok') throw new RuntimeException('bad status')" : "if (body?.status !== 'ok') throw new Error('bad status')"}
                value={r.script}
                onChange={this.setBizField(i, 'script')}
              />
              {this.renderActions(BIZ_ACTION_DEFS, r.actions, this.toggleBiz(i), this.valueBiz(i))}
            </div>
          ))}
        </div>
        <button type="button" className="rc-add" onClick={this.addBizRule}><IconPlus />Add check</button>
        {this.renderCodePreview()}
      </div>
    );
  }

  addBizRule = () => this.setState({ bizExceptions: [...this.state.bizExceptions, bizRow()] });
  setBizRow(i, patch) {
    const rows = this.state.bizExceptions.slice();
    rows[i] = { ...rows[i], ...patch };
    this.setState({ bizExceptions: rows });
  }
  setBizField = (i, prop) => (e) => this.setBizRow(i, { [prop]: e.target.value });
  toggleBiz = (i) => (key) => {
    const cur = this.state.bizExceptions[i].actions[key];
    this.setBizRow(i, { actions: { ...this.state.bizExceptions[i].actions, [key]: { ...cur, on: !cur.on } } });
  };
  valueBiz = (i) => (key, value) => {
    const cur = this.state.bizExceptions[i].actions[key];
    this.setBizRow(i, { actions: { ...this.state.bizExceptions[i].actions, [key]: { ...cur, value } } });
  };
  removeBiz = (i) => () => {
    const rows = this.state.bizExceptions.slice();
    rows.splice(i, 1);
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
          {[['none', 'none'], ['json', 'JSON'], ['raw', 'raw'], ['urlencoded', 'x-www-form-urlencoded'], ['form', 'form-data']].map(([val, lbl]) => (
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
        {bodyType === 'json' && this.renderJsonBuilder()}
        {bodyType === 'raw' && this.renderRawBody()}
        {(bodyType === 'urlencoded' || bodyType === 'form') && this.renderKvTable('form', bodyType === 'form' ? 'Form Data' : 'URL-encoded Fields')}
        {(bodyType === 'json' || bodyType === 'raw') && this.renderPayloadPersist()}
      </div>
    );
  }

  // The connector's payload setting: choose whether the payload is written as a JSON
  // string, a Groovy script, or a JavaScript script — with a live preview of the exact
  // thing that gets saved. Scripts return the payload (the form a camunda:script input uses).
  renderPayloadPersist() {
    const { payloadSave, bodyType } = this.state;
    const asJson = payloadSave === 'json';
    const lang = payloadSave === 'js' ? 'js' : 'groovy';
    const jsonStr = bodyType === 'json' ? compileJson(this.state.jsonRoot) : (this.state.body || '');
    const preview = asJson ? jsonStr : payloadCode(this.state, lang);
    const showFlag = asJson && bodyType === 'json';
    const err = showFlag ? jsonError(jsonStr) : null;
    return (
      <div className="rc-code">
        <div className="rc-code-head">
          <span className="rc-code-lead">
            <span className="rc-code-title">Save payload as</span>
            {showFlag && <span className={'rc-json-flag ' + (err ? 'bad' : 'ok')}>{err ? 'invalid JSON' : 'valid JSON'}</span>}
          </span>
          <div className="rc-seg small">
            {[['json', 'JSON'], ['groovy', 'Groovy'], ['js', 'JavaScript']].map(([v, l]) => (
              <button key={v} className={payloadSave === v ? 'on' : ''} onClick={() => this.setState({ payloadSave: v })}>{l}</button>
            ))}
          </div>
        </div>
        <pre className="rc-code-body">{preview}</pre>
        <p className="rc-code-note">{asJson
          ? <>Written to the connector as a JSON string payload — <code>{'${var}'}</code> resolves at runtime.</>
          : <>Written as a native <code>{lang === 'js' ? 'javascript' : 'groovy'}</code> script input parameter that returns the payload — <code>{'${var}'}</code> becomes a process-variable reference.</>}
        </p>
      </div>
    );
  }

  // Structured JSON builder — a tree, so any shape works (nested objects, arrays,
  // arrays of objects, object values that are arrays, …). The preview + save form
  // live in renderPayloadPersist below.
  renderJsonBuilder() {
    const root = this.state.jsonRoot;
    return (
      <div className="rc-json">
        <div className="rc-json-rootbar">
          <span className="rc-json-rootlabel">Body is</span>
          <select className="rc-select rc-json-roottype" value={root.type} onChange={this.setJson([], 'type')}>
            <option value="object">an Object &#123; &#125;</option>
            <option value="array">an Array [ ]</option>
          </select>
          <button type="button" className="rc-add-sm" onClick={this.addJson([])}><IconPlus />{root.type === 'array' ? 'item' : 'field'}</button>
        </div>
        <div className="rc-json-tree">
          {root.children.map((c, i) => this.renderJsonNode(c, [i], root.type))}
        </div>
      </div>
    );
  }

  // Render one node (and its subtree) at `path`. parentType decides whether a key is shown.
  renderJsonNode(node, path, parentType) {
    const container = isContainer(node.type);
    return (
      <div className="rc-jn" key={path.join('.')}>
        <div className={'rc-jn-row' + (node.enabled ? '' : ' off')}>
          <input type="checkbox" className="c-en" checked={node.enabled} onChange={this.setJson(path, 'enabled')} title="Enable/disable" />
          {parentType === 'object'
            ? <input className="rc-jn-key" placeholder="key" value={node.key} onChange={this.setJson(path, 'key')} />
            : <span className="rc-jn-index">–</span>}
          <select className="rc-select rc-jn-type" value={node.type} onChange={this.setJson(path, 'type')}>
            {JSON_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {!container && node.type !== 'null' && (
            <input
              className="rc-jn-val"
              placeholder={node.type === 'expression' ? 'variable (e.g. orderId)' : 'value'}
              value={node.value}
              onChange={this.setJson(path, 'value')}
            />
          )}
          {container && <button type="button" className="rc-add-sm" onClick={this.addJson(path)}><IconPlus />{node.type === 'array' ? 'item' : 'field'}</button>}
          <button className="rc-del" onClick={this.removeJson(path)} title="remove">×</button>
        </div>
        {container && node.children.length > 0 && (
          <div className="rc-jn-children">
            {node.children.map((c, i) => this.renderJsonNode(c, [...path, i], node.type))}
          </div>
        )}
      </div>
    );
  }

  setJson = (path, prop) => (e) => {
    const val = prop === 'enabled' ? e.target.checked : e.target.value;
    this.setState({ jsonRoot: mapNodeAt(this.state.jsonRoot, path, (n) => ({ ...n, [prop]: val })) });
  };

  addJson = (path) => () => {
    this.setState({
      jsonRoot: mapNodeAt(this.state.jsonRoot, path, (n) => {
        // In an array, a new item copies the previous item's type, so once you've made
        // one object you can keep adding objects with a single click.
        const type = (n.type === 'array' && n.children.length) ? n.children[n.children.length - 1].type : 'string';
        return { ...n, children: [...n.children, jsonNode(type)] };
      })
    });
  };

  removeJson = (path) => () => {
    const parent = path.slice(0, -1);
    const idx = path[path.length - 1];
    this.setState({
      jsonRoot: mapNodeAt(this.state.jsonRoot, parent, (n) => {
        const children = n.children.slice();
        children.splice(idx, 1);
        return { ...n, children };
      })
    });
  };

  // Raw body editor + (for JSON) a Format button and a live validity + preview.
  renderRawBody() {
    const { body, rawType } = this.state;
    const err = rawType === 'json' ? jsonError(body) : null;
    return (
      <div className="rc-raw">
        {rawType === 'json' && (
          <div className="rc-raw-bar">
            <button type="button" className="rc-mini" onClick={() => this.setState({ body: formatJson(this.state.body) })}>Format</button>
            {body.trim() && <span className={'rc-json-flag ' + (err ? 'bad' : 'ok')}>{err ? 'invalid JSON' : 'valid JSON'}</span>}
          </div>
        )}
        <textarea
          className="rc-bodyarea"
          spellCheck={false}
          placeholder={rawType === 'json' ? '{\n  "id": "${orderId}"\n}' : ''}
          value={body}
          onChange={this.setField('body')}
        />
      </div>
    );
  }

  /* ---- response ---- */

  renderResponse() {
    const { response, error, respTab, respView, respOpen, sending } = this.state;
    const ok = response && response.status >= 200 && response.status < 300;
    const hdrCount = response && response.headers ? Object.keys(response.headers).length : 0;
    const hasResult = !!(response || error);

    return (
      <div className={'rc-response' + (respOpen ? ' open' : '')}>
        <div className="rc-resp-bar">
          <button className="rc-resp-toggle" onClick={() => this.setState({ respOpen: !respOpen })} title={respOpen ? 'Collapse' : 'Expand'}>
            <IconChevronRight />
            <span>Response</span>
            {sending && <span className="rc-resp-hint">sending…</span>}
            {!sending && !hasResult && <span className="rc-resp-hint">hit Send</span>}
          </button>
          {respOpen && hasResult && !error && (
            <div className="rc-resp-tabs">
              <button className={'rc-rtab' + (respTab === 'body' ? ' active' : '')} onClick={() => this.setState({ respTab: 'body' })}>Body</button>
              <button className={'rc-rtab' + (respTab === 'headers' ? ' active' : '')} onClick={() => this.setState({ respTab: 'headers' })}>
                Headers{hdrCount ? <span className="rc-badge">{hdrCount}</span> : null}
              </button>
            </div>
          )}
          <div className="rc-resp-meta">
            {response && response.status != null && (
              <span className={'rc-status ' + (ok ? 'ok' : 'bad')}>{response.status} {response.statusText}</span>
            )}
            {response && response.timeMs != null && <span className="rc-time">{response.timeMs} ms</span>}
            {response && response.bytes != null && <span className="rc-time">{this.humanSize(response.bytes)}</span>}
            {response && response.shape && <span className={'rc-shape s-' + response.shape}>{response.shape}</span>}
            {response && response.via && <span className={'rc-via v-' + response.via} title={response.via === 'proxy' ? 'Sent through the main-process proxy (no CORS)' : 'Sent directly from the renderer (subject to CORS)'}>via {response.via}</span>}
            {hasResult && <button className="rc-resp-close" onClick={this.clearResponse} title="Close response"><IconClose /></button>}
          </div>
        </div>

        {respOpen && !hasResult && (
          <div className="rc-resp-empty"><p>Enter a URL and hit <b>Send</b> to see the response here.</p></div>
        )}

        {respOpen && error && (
          <pre className="rc-body rc-err">Error: {error}{'\n\n'}This request went directly from the renderer, so a cross-origin call may have been blocked by CORS. The main-process proxy (menu.js) handles cross-origin calls — make sure the plugin is installed with its menu half and restart the modeler.</pre>
        )}

        {respOpen && !error && respTab === 'body' && response && response.body !== undefined && (
          <>
            <div className="rc-view-toggle">
              <button className={respView === 'pretty' ? 'on' : ''} onClick={() => this.setState({ respView: 'pretty' })}>Pretty</button>
              <button className={respView === 'raw' ? 'on' : ''} onClick={() => this.setState({ respView: 'raw' })}>Raw</button>
            </div>
            <pre className="rc-body">{respView === 'raw' ? (response.raw || '') : this.pretty(response.body)}</pre>
          </>
        )}

        {respOpen && !error && respTab === 'headers' && response && (
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
