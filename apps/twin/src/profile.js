// profile.js — which screens this build has (DECISIONS Q-2026-10-25-09 (B)).
//
// The portal build (`npm run build`, the default) has every screen. The HAEA
// Local Console build (`npm run build:console`, CONSOLE_PROFILE=internal) has
// only what spec 01 §2.2 keeps on site: login, site/device status, device
// detail and trends, alarms (list, detail, ACK, comments), settings. The
// portal's screens — 3D twin, NOC wall, power chain, alarm map, Copilot (D-01)
// — are not deleted: apps/twin moves to the portal in WO-PTL-007. They are
// compiled out of the internal build instead:
//   · App.jsx routes them only when !INTERNAL, so the bundler drops the
//     screens and what only they import (three, maplibre);
//   · vite.console.config.js strips links to them from the screen templates;
//   · nav lists in JSX leave them out.
// apps/console/test checks the built bundle for any route to them.
//
// __CFLEX_PROFILE__ is a build-time constant (Vite `define`); under plain node
// (the unit tests) it is undeclared and this is the portal build.
/* global __CFLEX_PROFILE__ */
export const PROFILE = typeof __CFLEX_PROFILE__ === 'string' ? __CFLEX_PROFILE__ : 'portal';
export const INTERNAL = PROFILE === 'internal';

/** The portal screens' hash routes (#/twin, #/wall, #/map, #/powerchain — Copilot lives under powerchain). */
export const PORTAL_ROUTES = ['twin', 'wall', 'map', 'powerchain'];
