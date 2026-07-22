/* SPDX-License-Identifier: Apache-2.0 */
import { registerClientPlugin, registerPlatformBpmnJSPlugin } from 'camunda-modeler-plugin-helpers';

import RestClientPlugin from './RestClientPlugin';
import restClientPropertiesModule from './propertiesProvider';

// The popup (app-level React modal) + the window handoff it registers.
registerClientPlugin(RestClientPlugin, 'client');

// The "Build request…" button inside the Service Task's Implementation group (Camunda 7 panel).
registerPlatformBpmnJSPlugin(restClientPropertiesModule);
