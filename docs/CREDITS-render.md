# Credits — models, effects & cameras (`src/render/**`)

All 3D models, textures and effects in the render module are **generated procedurally at runtime**;
no external model, texture or sound files are used or downloaded.

| Asset | How it is made |
|---|---|
| F-35A, MiG-29, Su-27, Su-35, Su-57, Tu-22M3, A-50 | Lofted cross-sections, lifting-surface builders and lathes (`src/render/models/geom/*`, `src/render/models/aircraft/*`) built from public dimensions/planforms |
| Liveries (RAM panel lines, camouflage, insignia, tail codes, bort numbers) | Painted on a canvas in model space (`src/render/models/aircraft/liveries.ts`) |
| Missiles, bombs, SAM vehicles, ships, buildings | Procedural geometry (`munitions.ts`, `vehicles.ts`, `sams.ts`, `ground.ts`) |
| Reflection environment | Procedural sky cube (`materials.ts`), auto-PMREM'd by three.js |
| Smoke / fire / glow particle textures | Procedural value-noise on a canvas (`src/render/effects/textures.ts`) |
| Afterburner / rocket flames, vapour cones, shockwaves | Custom GLSL shaders |

Library: [three.js](https://github.com/mrdoob/three.js) (MIT) — including `BufferGeometryUtils` from `three/examples/jsm`.
