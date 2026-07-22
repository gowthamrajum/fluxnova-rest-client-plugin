/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Shared, framework-free constants used by both the popup UI and the pure logic
 * modules (request building, code generation). Kept here so the lib layer never
 * has to import from the React component.
 */

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
export const RAW_TYPES = { json: 'application/json', text: 'text/plain', xml: 'application/xml' };

// Matches a ${expression} token; global so callers can iterate every occurrence.
// Callers that rely on .lastIndex (exec loops) MUST reset it first.
export const EXPR_RE = /\$\{([^}]+)\}/g;

// Loopback port range the main-process proxy (menu.js) binds and the renderer scans.
// Keep these in sync with the PORT_BASE / PORT_SPAN constants in menu.js.
export const PROXY_PORT_BASE = 34517;
export const PROXY_PORT_SPAN = 10;
