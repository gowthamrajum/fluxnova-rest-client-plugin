/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Renderer-side client for the main-process proxy (menu.js). Discovers which
 * loopback port the proxy bound (it scans a small range), caches it, and forwards
 * request specs there. When no proxy is reachable — e.g. the plugin was installed
 * client-only, or the menu half failed to start — callers fall back to a direct
 * renderer fetch (CORS-limited), so the popup still works for permissive endpoints.
 */
import { PROXY_PORT_BASE, PROXY_PORT_SPAN } from './constants';

let cachedBase = null;      // e.g. 'http://127.0.0.1:34517' once discovered
let probing = null;         // in-flight probe promise (dedupes concurrent Sends)

async function ping(port) {
  const url = 'http://127.0.0.1:' + port + '/health';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 400);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    return (j && j.plugin === 'fluxnova-rest-client') ? port : null;
  } catch (_) {
    return null;
  }
}

// Resolve the proxy base URL, or null if none is listening. Cached after first hit.
export async function proxyBase() {
  if (cachedBase) return cachedBase;
  if (probing) return probing;
  probing = (async () => {
    for (let i = 0; i < PROXY_PORT_SPAN; i++) {
      const port = await ping(PROXY_PORT_BASE + i);
      if (port) { cachedBase = 'http://127.0.0.1:' + port; return cachedBase; }
    }
    return null;
  })();
  const base = await probing;
  probing = null;
  return base;
}

export function isProxyKnown() {
  return !!cachedBase;
}

/**
 * Send a request spec through the proxy. `headers` is a plain object; `body` a
 * string (or undefined). Returns the normalized response the proxy produced.
 * Throws if the proxy isn't reachable or the forward itself failed.
 */
export async function sendViaProxy({ url, method, headers, body }) {
  const base = await proxyBase();
  if (!base) throw new Error('no-proxy');
  const res = await fetch(base + '/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, method, headers, body })
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || ('proxy ' + res.status));
  return data;
}
