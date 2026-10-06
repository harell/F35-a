/**
 * Playtest 1.2-h: the cockpit and HMD showed no fuel quantity (only the BINGO chip), the PCD FUEL page
 * was a tap away, and the PCD (18 %) and the mission runner (15 %) called bingo at different fuel.
 *  - one bingo fraction (core/data.ts) for the sim warning, the mission runner and the HUD;
 *  - "FUEL n.n" (klb) under the HMD speed column in the cockpit and hud views, amber at joker, red at bingo;
 *  - the PCD's RWR portal jumps to FUEL when BINGO comes on.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { restHead } from '../src/render/camera/cameraMath';
import type { FrameContext } from '../src/core/contracts';
import { BINGO_FRACTION, DEFAULT_SETTINGS, JOKER_FRACTION, QUALITY_PRESETS } from '../src/core/data';
import type { CameraMode } from '../src/core/types';
import { createHud } from '../src/hud/Hud';
import { buildMock, type Scenario } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas, type TextRec } from '../src/hud/dev/fakeCanvas';
import { paletteFor } from '../src/hud/hmd/palette';
import { PCD_W, PcdDisplay } from '../src/hud/cockpit/pcd';
import { BINGO_FRACTION as RUNNER_BINGO } from '../src/missions/runtime/winchester';
import { WARNING_THRESHOLDS } from '../src/sim/Warnings';
import { AIRCRAFT_PERF } from '../src/sim/flight/aircraftData';

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
    camera.quaternion.copy(p.quaternion).multiply(restHead(view, new Quaternion()));
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

const CAP = AIRCRAFT_PERF.f35a.internalFuel;

describe('fuel cues (1.2-h)', () => {
  it('one bingo fraction: sim warning, mission runner and HUD agree', () => {
    expect(RUNNER_BINGO).toBe(BINGO_FRACTION);
    expect(WARNING_THRESHOLDS.bingoFraction).toBe(BINGO_FRACTION);
    expect(WARNING_THRESHOLDS.fuelLowFraction).toBe(JOKER_FRACTION);
  });

  for (const view of ['cockpit', 'hud'] as CameraMode[]) {
    it(`${view}: FUEL readout in klb from joker only (owner, 2026-10-06), amber at joker, red at bingo`, { timeout: 20_000 }, () => {
      const pal = paletteFor(DEFAULT_SETTINGS.hudColor);
      const r = rig('aa', view);
      const fuel = (frac: number): TextRec | undefined => {
        r.mock.player.flight.fuel = frac * CAP;
        return r.run(0.1).find((t) => /^FUEL \d+\.\d$/.test(t.text));
      };
      expect(fuel(0.6)).toBeUndefined();
      const joker = fuel(JOKER_FRACTION - 0.02);
      expect(joker?.text).toBe('FUEL ' + (((JOKER_FRACTION - 0.02) * CAP * 2.20462) / 1000).toFixed(1));
      expect(joker?.color).toBe(pal.warn);
      expect(fuel(BINGO_FRACTION - 0.02)?.color).toBe(pal.danger);
    });
  }

  it('PCD: the RWR portal jumps to FUEL when BINGO comes on', () => {
    const doc = globalThis as unknown as { document?: unknown };
    const prev = doc.document;
    doc.document = { createElement: () => makeFakeCanvas(PCD_W, 256).canvas };
    try {
      for (const leftHanded of [false, true]) {
        const pcd = new PcdDisplay({ ...QUALITY_PRESETS.medium });
        const mock = buildMock('aa');
        const p = mock.player;
        p.warnings.delete('bingo');
        const ctx = { player: p, world: mock.world, settings: { ...DEFAULT_SETTINGS, leftHanded }, dt: 0.1 } as unknown as FrameContext;
        pcd.update(ctx, 0.1);
        const rwr = pcd.pages().indexOf('RWR');
        expect(rwr).toBe(leftHanded ? 0 : 2);
        p.warnings.add('bingo');
        pcd.update(ctx, 0.1);
        expect(pcd.pages()[rwr]).toBe('FUEL');
      }
    } finally {
      doc.document = prev;
    }
  });
});
