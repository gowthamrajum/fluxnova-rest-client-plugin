/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Main-process half of the plugin. Camunda/FluxNova Modeler runs this file in the
 * Electron MAIN process (Node.js), where the browser same-origin / CORS policy does
 * NOT apply. We use that to host a tiny loopback HTTP proxy so the renderer popup can
 * actually call cross-origin APIs — the outbound request is made here, in Node.
 *
 * Trust model (see SECURITY.md): the server binds to 127.0.0.1 only, exists solely
 * while the modeler is open, and is an intentional local request forwarder for a
 * design-time developer tool. It is not exposed off-host.
 *
 * This is plain CommonJS — it is loaded directly by Electron, NOT bundled by webpack.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

// Loopback port range the renderer scans (keep in sync with client/lib/constants.js).
const PORT_BASE = 34517;
const PORT_SPAN = 10;
const VERSION = '0.2.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(payload);
}

// Outbound request via Node's http/https — no CORS, always available in the main process.
function forward({ url, method, headers, body }) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (_) { return reject(new Error('Invalid URL: ' + url)); }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return reject(new Error('Only http/https URLs are allowed'));
    }
    const lib = target.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = lib.request(
      target,
      { method: method || 'GET', headers: headers || {} },
      (up) => {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: up.statusCode,
            statusText: up.statusMessage || '',
            headers: up.headers,
            body: buf.toString('utf8'),
            bytes: buf.length,
            timeMs: Date.now() - started,
            ok: up.statusCode >= 200 && up.statusCode < 300
          });
        });
      }
    );
    req.on('error', reject);
    // Guard against hung connections — a design-time tool shouldn't block forever.
    req.setTimeout(60000, () => req.destroy(new Error('Request timed out after 60s')));
    if (body != null && body !== '') req.write(body);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) { req.destroy(); reject(new Error('Request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

    const path = (req.url || '').split('?')[0];

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true, plugin: 'fluxnova-rest-client', version: VERSION });
      return;
    }

    if (req.method === 'POST' && path === '/proxy') {
      try {
        const raw = await readBody(req);
        const spec = raw ? JSON.parse(raw) : {};
        if (!spec.url) { sendJson(res, 400, { error: 'Missing "url"' }); return; }
        const result = await forward(spec);
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 502, { error: (e && e.message) ? e.message : String(e) });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });
}

// Try ports in the range until one binds; leaves the renderer a small set to scan.
function listenInRange(server, i) {
  if (i >= PORT_SPAN) {
    console.error('[fluxnova-rest-client] no free port in ' + PORT_BASE + '..' + (PORT_BASE + PORT_SPAN - 1) + '; proxy disabled');
    return;
  }
  const port = PORT_BASE + i;
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE') { listenInRange(createServer(), i + 1); }
    else console.error('[fluxnova-rest-client] proxy error', err);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('[fluxnova-rest-client] proxy listening on http://127.0.0.1:' + port);
  });
}

// Start the proxy as a load side-effect (guarded so a double-load can't double-bind).
if (!global.__fluxnovaRestClientProxy) {
  global.__fluxnovaRestClientProxy = true;
  try { listenInRange(createServer(), 0); }
  catch (e) { console.error('[fluxnova-rest-client] failed to start proxy', e); }
}

// Camunda Modeler menu-plugin contract: export a function returning menu entries.
// We add one informational item; the proxy itself runs regardless of the menu.
module.exports = function (electronApp, menuState) {
  return [
    {
      label: 'REST Client proxy active (127.0.0.1)',
      enabled: () => false
    }
  ];
};
