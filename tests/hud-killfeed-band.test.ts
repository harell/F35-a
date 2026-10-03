/**
 * Playtest 1.2-a: with the target camera window (PiP) open, the kill feed used to drop under the window
 * into the warning band and print over the SPIKE / FLARES LOW chips (and the MISSILE line) during a
 * missile defence. The kill feed keeps clear of the warning band in every view, PiP open or not.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import type { CameraMode } from '../src/core/types';
import { createHud } from '../src/hud/Hud';
import { buildMock, type Scenario } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas, overlaps, textBox, type TextRec } from '../src/hud/dev/fakeCanvas';

installPath2D();

function rig(scene: Scenario, view: CameraMode, W = 844, H = 390, targetCam = true) {
  const mock = buildMock(scene);
  const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
  const hud = createHud(canvas, mock.events);
  hud.resize(W, H, 1);
  hud.setVisible(true);
  const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
  const p = mock.player;
  if (view === 'cockpit' || view === 'hud') {
    camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
    // along the nose: in the cockpit view that is the head raised COCKPIT_REST_PITCH from rest, where the
    // 'threat' scene's target box clears the spot under the band (at rest it fills the column, and the
    // feed rightly holds back for the warnings)
    camera.quaternion.copy(p.quaternion);
  } else {
    camera.position.copy(p.position).add(new Vector3(0, 4.5, 20).applyQuaternion(p.quaternion));
    camera.up.set(0, 1, 0).applyQuaternion(p.quaternion);
    camera.lookAt(p.position.clone().add(new Vector3(0, 0, -40).applyQuaternion(p.quaternion)));
  }
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const ctx: FrameContext = {
    dt: 1 / 30,
    time: 0,
    world: mock.world,
    player: p,
    camera,
    viewMode: view,
    focusId: p.id,
    mission: mock.mission,
    settings: { ...DEFAULT_SETTINGS, targetCam },
    quality: { ...QUALITY_PRESETS.medium },
    paused: false,
    screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  };
  return {
    mock,
    run(seconds = 0.1, dt = 1 / 30): TextRec[] {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i++) {
        fake.reset();
        ctx.time += dt;
        ctx.dt = dt;
        mock.tick(dt);
        hud.update(ctx);
      }
      return fake.texts.slice();
    },
  };
}

const KILLS = ['SPLASH SU-27', 'VIPER 2: SPLASH SU-27', 'VIPER 3: SPLASH MIG-29'];
const BAND = /^(MISSILE|SPIKE|MUD SPIKE|FLARES LOW|CHAFF LOW|DEFEATED|\+\d+)/;

describe('kill feed vs the warning band (1.2-a)', () => {
  for (const view of ['cockpit', 'hud', 'chase'] as CameraMode[]) {
    for (const pip of [true, false]) {
      it(`${view}, target camera ${pip ? 'open' : 'off'}: no kill-feed line prints on the MISSILE line or a chip`, { timeout: 20_000 }, () => {
        const r = rig('threat', view, 844, 390, pip);
        r.run(0.3);
        for (const text of KILLS) r.mock.events.emit('hud:message', { text, tone: 'good' });
        const texts = r.run(0.3);
        const kills = texts.filter((t) => KILLS.includes(t.text) && t.alpha > 0.05);
        const band = texts.filter((t) => BAND.test(t.text));
        expect(band.some((t) => /SPIKE/.test(t.text)), 'SPIKE chip shown').toBe(true);
        const bad: string[] = [];
        for (const k of kills) for (const b of band) if (overlaps(textBox(k), textBox(b), 2)) bad.push(`"${k.text}"@${k.x | 0},${k.y | 0} x "${b.text}"@${b.x | 0},${b.y | 0}`);
        expect(bad, bad.join("\n")).toEqual([]);
        // it still reports the newest kill (moved, not dropped)
        expect(kills.some((k) => k.text === KILLS[KILLS.length - 1]), 'newest kill shown').toBe(true);
      });
    }
  }
});
