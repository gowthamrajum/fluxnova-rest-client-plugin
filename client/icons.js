/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Small inline SVG icons (Lucide-style, 24px stroke geometry) used on the action
 * buttons. Stroke uses currentColor so each icon inherits its button's text color.
 * Inline SVG — no font, no emoji, no external assets (CSP-safe).
 */
import React from 'camunda-modeler-plugin-helpers/react';

function Svg({ size = 15, children }) {
  return (
    <svg
      className="rc-ic"
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// paper-plane "send"
export const IconSend = () => (
  <Svg><path d="M22 2 11 13" /><path d="M22 2 15 22 11 13 2 9z" /></Svg>
);

// floppy "save"
export const IconSave = () => (
  <Svg><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></Svg>
);

// check
export const IconCheck = () => (
  <Svg><path d="M20 6 9 17l-5-5" /></Svg>
);

// x / close
export const IconClose = () => (
  <Svg><path d="M18 6 6 18M6 6l12 12" /></Svg>
);

// plus
export const IconPlus = () => (
  <Svg size={14}><path d="M12 5v14M5 12h14" /></Svg>
);
