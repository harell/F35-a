# F35-A — Credits & licences

F35-A is built almost entirely from procedural content: aircraft, SAM and ground models are generated from code,
textures are painted onto canvases at runtime, terrain comes from noise plus a hand-traced map of Auckland, and every
sound effect and the music are synthesized with Web Audio. The third-party assets below are the only exceptions.

| What | Source | Licence | Details |
|---|---|---|---|
| **three.js** (incl. `examples/jsm` addons: Lensflare, BufferGeometryUtils) | https://github.com/mrdoob/three.js | MIT | [render](credits/render.md), [world](credits/world.md) |
| Water normal map, lens-flare sprites, moon texture (`public/textures/*`) | three.js examples, via raw.githubusercontent.com | MIT | [world](credits/world.md) |
| **B612 Mono** HMD font | https://github.com/polarsys/b612 (via google/fonts) | SIL OFL 1.1 (`src/hud/assets/OFL-B612.txt`) | [hud](credits/hud.md) |
| "Betty" cockpit voice (`b_*` clips) | Piper TTS `en-us-kathleen-low` | CC0 | [audio](credits/audio.md) |
| Pilot, wingman and AWACS voices (`p_*`, `a_*`, `s_*`, `h_*` clips) | Piper TTS `en-us-libritts-high` (LibriTTS speakers) | CC BY 4.0: LibriTTS (openslr.org/60), derived from LibriVox public-domain recordings | [audio](credits/audio.md) |
| Piper TTS engine (build-time only) | https://github.com/rhasspy/piper | MIT | [audio](credits/audio.md) |
| Shader hash `hash12` | Dave Hoskins, *Hash without Sine* | MIT | [world](credits/world.md) |

**Geography.** The Auckland coastline, volcanic cones, motorways, arterial roads and landmark positions are hand-traced,
stylised reconstructions (roughly 100–400 m accuracy). No map data was imported.

**Inspiration.** NovaLogic's *F-22 Raptor* (1997).

**Disclaimer.** F35-A is a fan-made, non-commercial game. It is not affiliated with or endorsed by Lockheed Martin,
the Royal New Zealand Air Force, the United States Air Force, NovaLogic or THQ Nordic. The scenario is fictional.
