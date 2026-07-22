/* SPDX-License-Identifier: Apache-2.0 */
/**
 * FluxNova Modeler plugin entry (loaded in the app).
 *
 *  - `script` : the client-side bundle (renderer) that renders the Postman-style
 *               REST client popup and the "Build request…" properties-panel button.
 *  - `menu`   : the main-process half — starts a loopback HTTP proxy so the popup can
 *               call cross-origin APIs without hitting the renderer's CORS wall.
 */
module.exports = {
  name: 'Fluxnova REST Client',
  script: './dist/client.js',
  menu: './menu.js'
};
