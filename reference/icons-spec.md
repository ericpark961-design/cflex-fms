# C-Flex UPS Device Icons

Photorealistic SVG icons for the APC/Schneider UPS fleet monitored by C-Flex FMS,
traced from real product photos. Built for the floor-layout / device views
(EcoStruxure IT–style "single pane of glass").

## Contents

```
cflex-ups-icons/
├── README.md            ← this spec
├── CLAUDE.md            ← brief for the coding agent (read first)
├── fleet.json           ← every real device (HMA/KUS/HAEA) mapped to an icon
├── icons/               ← the deliverable SVG assets (6)
│   ├── srt3000.svg
│   ├── srt5000.svg      (UPS + SRT192RMBP battery pack, stacked)
│   ├── srt8000.svg
│   ├── modular20k.svg
│   ├── modular15k.svg
│   └── symmetra_lx.svg
├── reference/           ← source-of-truth product photos (DO NOT ship to prod)
│   └── *_real.png       (one per icon — match the SVG to these)
├── src/                 ← React integration scaffold (TypeScript)
│   ├── UpsIcon.tsx
│   ├── ups-models.ts
│   └── status.ts
└── scripts/
    └── gen_icons.py     ← regenerates all SVGs (Python + cairosvg for preview)
```

## Icon ↔ model ↔ fleet

| Icon            | Model (spreadsheet)            | Model number   | Form / U  | Fleet count |
|-----------------|--------------------------------|----------------|-----------|-------------|
| `srt3000`       | Smart-UPS SRT 3000             | SRT3000RMXLA   | 2U rack   | 3  (HMA PG) |
| `srt5000`       | Smart-UPS SRT 5000             | SRT5KRMXLT     | 3U + batt | 19 (KUS/HAEA/HMA) |
| `srt8000`       | Smart-UPS SRT 8000             | SRT8KRMXLT     | 6U rack   | 18 (HMA TC/IDF) |
| `modular20k`    | Smart-UPS Modular Ultra 20kW   | SRYLF20KRMT    | modular   | 2  (HAEA MDF) |
| `modular15k`    | Smart-UPS Modular Ultra 15kW   | SRYLF15KRMT    | modular   | 1  (HMA) |
| `symmetra_lx`   | Symmetra LX 16000 RM           | SYA16K         | tower     | 1  (HMA MPOE) |

Total: 44 devices across 3 sites. See `fleet.json` for per-device label/IP/serial/location.

## Theming hooks (in every SVG)

- `id="apc-logo"` — wraps the APC wordmark. The current logo is a close typographic
  approximation. For pixel-exact branding, replace the whole `<g id="apc-logo">` group
  with the official APC logo SVG from the APC partner brand kit (RingOn is an authorized
  APC partner). One group per logo instance.
- `id="lcd-screen"` — the unit display rectangle. Tint it per status to mimic the real
  SRT behavior (normal backlit / amber = message / red = alert). Note: modular & symmetra
  also expose `id="lcd-screen"` on their main display.

## Status color convention (`src/status.ts`)

| Status   | Ring/badge | Screen tint | Meaning           |
|----------|------------|-------------|-------------------|
| normal   | `#3ad17a`  | `#cdd6d2`   | Online            |
| warning  | `#f0a93a`  | `#f3d79a`   | Message / warning |
| critical | `#e24b4a`  | `#f3b3b3`   | Alert / on battery|
| offline  | `#8a9099`  | `#3a3f47`   | Unreachable       |

These match the EcoStruxure IT severity palette so C-Flex and ESX read the same.

## Using the React component

```tsx
import { UpsIcon } from "@/components/ups/UpsIcon";

// floor map: fast, crisp, status ring + badge
<UpsIcon model="srt5000" status="critical" width={200} label="HAEA-IDF2" />

// detail view: also tints the LCD screen
<UpsIcon model="modular20k" status="warning" mode="inline" width={360} />
```

Copy `icons/*.svg` to a served path (Next.js `public/assets/ups/`) and pass `basePath`
to match (default `/assets/ups`). To drive from the fleet:

```ts
import fleet from "./fleet.json";
fleet.devices.map(d => <UpsIcon key={d.serial} model={d.icon} label={d.label} ... />)
```

## Regenerating / editing

```bash
pip install cairosvg pillow --break-system-packages
python3 scripts/gen_icons.py     # rewrites icons/*.svg and renders preview PNGs
```

Each model is a function in `gen_icons.py`. The honeycomb mesh, silver triangular mesh,
LCD readout, button cluster, and module bays are parameterized helpers — adjust there,
not by hand-editing SVG.

## Fidelity notes (what each icon reproduces from `reference/`)

- SRT family: hex honeycomb battery-cover mesh, white "APC / Smart-UPS" wordmark bottom-left,
  navy bezel, right-side LCD module (power pill + "Output 208.0 v / Online" + load dots /
  charge / battery icons + ESC/OK/▲/▼), slotted black rack ears. srt5000 = UPS (3U) with the
  SRT192RMBP battery pack (2U) stacked above. srt8000 = two mesh sections (display top).
- modular20k: silver triangular-perf mesh + "APC Smart-UPS", color touchscreen app grid +
  power-flow diagram + power button + "Schneider" wordmark, 2×3 Li-ion battery modules.
- modular15k: same top, green line-diagram screen, 2 power modules (fan/IEC/switch),
  8 Li-ion battery modules with blue handles.
- symmetra_lx: silver tower frame, top control panel (LCD + status LEDs + nav), horizontal
  louvers, red APC oval, leveling feet.

---

## SNMP integration (live status → icon)

Data flow:

```
APC NMC (PowerNet-MIB)  --SNMP v3 authPriv-->  ups-poller.ts (net-snmp)
   -> UpsReading -> derive-status.ts -> UpsStatusUpdate
   -> UpsMonitorService (interval poll, cache, EventEmitter)
   -> UpsMonitorGateway (socket.io  /ups)  -->  useUpsFleet() hook
   -> <UpsIcon status=...>  (ring + LCD tint change live)
```

Files (`src/snmp/`, `config/`, `src/hooks/`):

- `powernet-oids.ts` — APC enterprise 318 OIDs + enums (output status, battery, replace).
- `ups-poller.ts` — `pollUps(target, creds)` single SNMP GET → `UpsReading` (v3 + v2c).
- `derive-status.ts` — pure `deriveStatus(reading)` → `{status, reasons}` (testable).
- `ups-monitor.service.ts` — polls all `fleet.json` targets, caches, emits `ups.status`.
- `ups-monitor.gateway.ts` — socket.io namespace `/ups`: `ups:snapshot` + `ups:status`.
- `ups-monitor.module.ts` — NestJS module.
- `config/snmp.config.ts` — creds from env (secret store), targets from `fleet.json`.
- `src/hooks/useUpsStatus.ts` — `useUpsFleet()` / `useUpsStatus(id)` for the frontend.
- `src/FloorMap.example.tsx` — wires the live feed into the `UpsIcon` grid.

Key OIDs polled (PowerNet-MIB, base `1.3.6.1.4.1.318`):

| Metric | OID |
|--------|-----|
| Output status | `.1.1.1.4.1.1.0` |
| Battery status | `.1.1.1.2.1.1.0` |
| Battery capacity % | `.1.1.1.2.2.1.0` |
| Replace battery | `.1.1.1.2.2.4.0` |
| Runtime remaining | `.1.1.1.2.2.3.0` |
| Battery temp | `.1.1.1.2.2.2.0` |
| Output load % | `.1.1.1.4.2.3.0` |
| Output voltage | `.1.1.1.4.2.1.0` |
| Input voltage | `.1.1.1.3.2.1.0` |
| Model | `.1.1.1.1.1.1.0` |

Status rules (first match wins, see `derive-status.ts` `THRESHOLDS`):

| Status | Triggers |
|--------|----------|
| critical | output OFF / hardware-fault bypass / on battery / battery low / overload >100% / charge <30% |
| warning | replace battery / software-switched bypass / smart boost-trim / self-test / charge <50% / load >90% / temp >45°C / runtime <5 min |
| offline | SNMP unreachable (timeout) |
| normal | online / ECO mode, all metrics nominal |

Credentials: env only, hydrated in prod from `~/secure/cflex-v2-secrets/` — see `.env.example`.
Never commit keys. Dependencies to add: see `package.snippet.json`.

Sample values: `data/sample-readings.json` holds a realistic poll of all 44 devices
(37 normal, 4 warning, 2 critical, 1 offline) so the dashboard can be built/tested before
live SNMP is wired. `reference/status_preview.png` shows the icon in each state.
