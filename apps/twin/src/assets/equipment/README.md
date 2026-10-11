# Equipment photography

273 crops of 94 models, taken from the FMS / DCIM equipment design sheets —
the same sheets `src/twin/{apc,vertiv,cisco}Catalog.js` were transcribed from,
so a device's picture and its specification come from one source.

Naming is `<photoId>_<view>.webp`, with view in
`front | side | rear | internal | top | hero`. `src/twin/equipmentLibrary.js`
globs them; `src/twin/equipmentPhoto.js` maps a catalogue id to a photoId.

Do not reference these files by name from application code. Go through
`photoFor(model)` so an unmapped model falls back to the generated faceplate
instead of landing on a near-miss photo of a different unit.

`vite.config.js` sets `assetsInlineLimit: 0` on their account: at the 4 KB
default, 170 of them were inlined into index.js as data URIs and the main
bundle went to 2.7 MB.
