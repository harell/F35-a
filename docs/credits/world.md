# Credits — WORLD module (terrain, sky, water, clouds, scenery)

Almost everything in the world is generated procedurally at load time. Terrain, colour maps,
detail and cloud textures, runway markings, buildings, trees and night lights are all made in
code. A few ready-made textures from the three.js repository are used as optional
enhancements, and each has a procedural fallback or is only used where noted.

| File (public/textures/) | Source | Licence | Used for |
|---|---|---|---|
| `waternormals.jpg` | three.js examples — https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/waternormals.jpg | MIT (© 2010–2026 three.js authors) | Ocean / harbour normal map (procedural fallback: `createWaterNormalFallback`) |
| `lensflare0.png`, `lensflare3.png` | three.js examples — https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/lensflare/ | MIT (© three.js authors) | Sun lens flare (high quality, daytime only) |
| `moon_1024.jpg` | three.js examples — https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/moon_1024.jpg | MIT (© three.js authors) | Night-sky moon disc (loaded only for night missions; grey fallback) |

Code dependencies: `three` (MIT) including `three/examples/jsm/objects/Lensflare.js`.

Techniques and references (reimplemented, no code copied):
* CDLOD terrain: F. Strugar, *Continuous Distance-Dependent Level of Detail for Rendering
  Heightmaps* (2010).
* Exact Euclidean distance transform: P. Felzenszwalb & D. Huttenlocher, *Distance Transforms of
  Sampled Functions* (2012).
* "Eroded" fBm with analytic noise derivatives: Iñigo Quilez (iquilezles.org articles).
* `hash12` shader hash: Dave Hoskins, *Hash without Sine* (MIT).
* Ridged multifractal: F. K. Musgrave, *Texturing & Modeling: A Procedural Approach*.

Geography: the Auckland (Tāmaki Makaurau) coastline, islands, volcanic cones and landmarks are a
stylised reconstruction hand-traced from public geographic knowledge, using the landmark
coordinates in `src/core/auckland.ts`. No map data files were imported.

Iteration 1 additions (all procedural, no new assets or dependencies):
* Coastline: exact vector distance to the hand-traced coast polygons (segment splatting,
  `src/world/terrain/coastline.ts`) instead of a raster distance transform; a 15 m signed-distance
  coast mask (R8, 2048² over the central 32 km) drives the water shoreline, beach band and surf.
* City: CBD skyline with a dozen named towers placed at their approximate real positions (PwC Tower,
  Vero Centre, Pacifica, Metropolis, ANZ Centre, …; heights from public knowledge), suburban town
  centres, the port with ships at berth, and the motorway network (SH1, SH16, SH18, SH20)
  hand-traced from memory at ~100–200 m accuracy (`src/world/scenery/motorways.ts`). No map data
  files were imported.
* Motorway surface texture, window / street-light LODs, harbour light reflections and the city
  light carpet are generated in code.
* Volcanic cone crater bowls and pā terraces are shaded in the terrain shader from the cone list
  in `src/world/terrain/theaters/aucklandMap.ts` (crater sizes from public knowledge).
