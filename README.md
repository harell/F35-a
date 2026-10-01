# F35-A Ratites

<p align="center"><img src="docs/cover.jpg" width="420" alt="F-35-a Ratites game cover: an F-35A over Auckland's Sky Tower and skyline, with a kiwi in the flames"></p>

**A combat flight simulator for your phone's browser.** Fly the F-35A Lightning II over Auckland, New Zealand.
Defend the city against a hostile force dug in on the Hauraki Gulf islands: dogfight MiGs and Flankers over the Waitematā,
dodge SA-10s behind Rangitoto, and thread the Harbour Bridge at 40 m.

Inspired by NovaLogic's *F-22 Raptor* (1997). Built with three.js (WebGL 2), TypeScript and Web Audio, and installable as a PWA.

<p align="center"><em>Landscape · two thumbs · headphones recommended</em></p>

<p align="center">
  <img src="docs/screenshots/bridge-cockpit.png" width="49%" alt="Cockpit view: lining up at 40 m to fly under the Auckland Harbour Bridge">
  <img src="docs/screenshots/skytower-chase.png" width="49%" alt="Chase view: the F-35A over the Waitematā Harbour heading for the Sky Tower and the CBD">
</p>
<p align="center"><em>Left: cockpit view, lining up to fly under the Harbour Bridge. Right: chase view, inbound to the Sky Tower over the Waitematā.</em></p>

## Play

* **Play now:** https://harell.github.io/F35-a/ (GitHub Pages; redeployed automatically on every push to `master`).
  The PWA install and offline mode work from there.
* **Install (GitHub Pages build):** open it on your phone, then use *Share → Add to Home Screen* (iOS) or *Install app* (Android).
  It then runs full-screen in landscape and works offline.
* Runs in iOS Safari 15+, Android Chrome and desktop Chrome, Edge, Firefox and Safari.

## Features

| | |
|---|---|
| **Flight model** | Force-based 6-DOF with an F-35-style fly-by-wire g/AoA command law, engine spool, afterburner fuel burn, energy bleed, transonic drag, and Auto-GCAS ground-collision avoidance |
| **Air-to-air** | Designation, then a nose-pointing ±30° radar lock (or a silent TWS shot). AIM-120D with loft, datalink and pitbull; AIM-9X with a ±90° HMD seeker and growl; GAU-22 25 mm with LCOS/funnel; a Pk-calibrated SHOOT cue on the DLZ |
| **Threats** | SA-6, SA-8, SA-10, SA-15, SA-18 MANPADS and ZSU-23-4 with search → track → launch → guide. RWR, DAS missile warning, flares and chaff, beam-notching, terrain masking, EMCON pop-up ambushes, point defence, SEAD with AARGM and SDB |
| **Enemies** | MiG-29, Su-27, Su-35, Su-57, Tu-22M3 and A-50 flown by AI that uses its own sensors, flies BVR/BFM, defends against missiles and bugs out |
| **Cockpit** | F-35 HMD symbology plus a 3D cockpit with a panoramic display (TSD, SMS, FUEL, ENG, RWR, ICAWS, radar pages; tap to zoom) |
| **Views** | Cockpit, HMD-only, chase, orbit, padlock/target, missile cam, flyby and tactical map, plus a picture-in-picture target camera: a live head-on shot of the bandit or a slow orbit of the SAM site (radars spinning) with name, range and radar state / aspect |
| **Sound** | Synthesized F135 roar and afterburner, gun, missile launches, explosions delayed by distance, RWR search/lock/launch tones, AIM-9 growl, "Bitching Betty" voice warnings, radio chatter, adaptive music |
| **Auckland** | Map-driven terrain from LINZ open data: Waitematā and Manukau harbours, Hauraki Gulf islands, volcanic cones, the real CBD (LINZ streets, and every building extruded from its outline to its 2024 LiDAR height) with the Sky Tower (built from its OpenStreetMap 3D model), the Harbour Bridge, the port, Whenuapai and the airport |
| **Civil traffic** | A320neos of *AeroFlop*, a fictional airline in Air NZ-style black-and-white colours, land on and depart from Auckland Airport's 05R/23L. They're a neutral side: enemy AI and SAMs ignore them, and they never get auto-locked or picked before a bandit. You *can* box and shoot one down, but AWACS calls check fire, it costs 500 points, and it shows in the debrief |
| **Sky Tower** | A protected landmark. One stray bomb or missile from you brings it down: AWACS calls check fire, the mission fails on the spot, the tower topples onto the CBD, and the stump stays in your save for every later Auckland sortie. The gun can't hurt it, and flying into it is fatal |
| **Campaign** | *Operation Southern Cross*: 12 missions (CAP, raid intercepts, SEAD, strike, ship strike, AWACS hunt, escort, night defence, Su-57 finale), 3 training missions, Instant Action (dogfight, SAM gauntlet, strike, survival) in 5 theatres, medals and debrief tips |
| **Difficulty** | Recruit, Pilot, Veteran and Ace, scaling AI skill, SAM reaction, missile lethality, countermeasure effectiveness, lock time, damage and G-LOC |
| **Mobile** | Floating side-stick, throttle with an afterburner detent, thumb buttons, optional tilt steering, haptics, safe-area aware, dynamic resolution, PWA/offline, wake lock |

## Controls

**Touch (default):** throttle lever on the left (drag past the detent for afterburner; double-tap toggles MIL/AB), floating side-stick on the right.
**FIRE** releases the selected weapon, **GUN** fires the gun, **CMS** drops flares and chaff, **WPN** cycles weapons, **TGT** designates/locks,
**CAM** changes view (long-press for padlock), **RADAR** toggles emission. Drag the empty centre of the screen to look around; tap a target box to designate it.

**Keyboard:** arrows/WASD pitch & roll · Q/E yaw · Shift/Ctrl throttle · Tab afterburner · Space gun · Enter fire · R weapon · T target ·
X countermeasures · C camera · V radar · P/Esc pause · mouse-drag look. **Gamepad:** standard mapping.

## Development

```bash
npm install
npm run dev          # http://localhost:5173 (use --host to test on a phone on the same Wi-Fi)
npm run typecheck    # tsc --noEmit
npm test             # vitest unit tests (flight model, missiles, radar, SAMs, AI, missions, terrain, HUD...)
npm run build        # production build to dist/
npm run e2e          # mission smoke test (headless Chromium)
npm run voices       # regenerate voice clips (needs a local TTS + ffmpeg, see tools/)
```

Handy URL parameters: `?mission=c01&autostart=1&view=chase&difficulty=veteran&quality=high&fps=1`.
Missions: `c01`–`c12`, `t01`–`t03`, and Instant Action ids like `ia_dogfight_auckland`.

Architecture, conventions and module ownership are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Developer labs for models,
effects, HUD, audio, UI and world live in [`labs/`](labs/).

## Credits

Everything is procedural (models, textures, sounds, terrain) except the items listed in [docs/CREDITS.md](docs/CREDITS.md):
three.js (MIT) plus a few MIT-licensed textures from its repository, the B612 Mono font (OFL 1.1), and TTS-generated voice clips.

F35-A is a fan-made game. It is not affiliated with or endorsed by Lockheed Martin, the RNZAF, the USAF or NovaLogic.
Auckland geography is a stylised reconstruction, and the scenario is fictional.
