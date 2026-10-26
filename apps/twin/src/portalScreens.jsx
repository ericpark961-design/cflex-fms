// The portal's screens (D-01): 3D twin, NOC wall, alarm map, power chain and
// Copilot — everything App.jsx needs for them, imported in this one place.
//
// The internal (HAEA Local Console) build resolves this module to
// portalScreens.internal.js instead (vite.console.config.js), so these
// modules — and three.js, maplibre-gl and its CSS, which have side effects a
// tree-shaker must keep — never enter that bundle. DECISIONS Q-2026-10-25-09 (B).
export { default as MapScreen } from './MapScreen';
export { default as TwinScreen } from './TwinScreen';
export { default as WallScreen } from './WallScreen';
export { mountCopilot } from './copilot';
export { default as powerTpl } from './screens/PowerChain.tpl.html?raw';
