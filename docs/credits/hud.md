# Credits — HUD / HMD / cockpit module (`src/hud/**`)

## Font

| Asset | Source | Licence |
|---|---|---|
| `src/hud/assets/B612Mono-Bold.ttf` — **B612 Mono Bold** | Downloaded at build time from the Google Fonts repository: `https://raw.githubusercontent.com/google/fonts/main/ofl/b612mono/B612Mono-Bold.ttf` (upstream project: https://github.com/polarsys/b612) | SIL Open Font License 1.1 — full text in `src/hud/assets/OFL-B612.txt`. Copyright 2012 The B612 Project Authors. |

B612 is the typeface Airbus and ENAC designed for cockpit displays. The HMD overlay, the panoramic cockpit display (PCD) and the
up-front display (UFD) use it. The font is loaded with the FontFace API under the family name "B612 HMD". It is bundled unmodified.
If it fails to load, the system monospace fonts are used instead.

## Everything else

All other HUD and cockpit visuals are generated procedurally in code by the HUD module. There are no third-party assets:

- the HMD symbology is drawn with Canvas2D (`src/hud/hmd/*`)
- the cockpit geometry is built in code (`src/hud/cockpit/geometry.ts`)
- the PCD and UFD pages are drawn with Canvas2D into CanvasTextures (`src/hud/cockpit/pages.ts`, `pcd.ts`)
