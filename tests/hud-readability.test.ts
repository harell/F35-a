/**
 * HUD and menu readability at 844×390 (issue #62, polish 4/5 of epic #84):
 *  - Defend: the strikers carry a STRK tag on every display (contacts, target box, TSD, tactical map),
 *    the escort doesn't, and the primary objective counts the strikers left ("STRIKERS n");
 *  - the cockpit PCD's TSD and RWR corner readouts ("10 NM", "BULL 005/6", "2 EMIT") are at least
 *    12 px tall on the 844×390 screen (they were 9–10 px, and look smaller on the tilted panel).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import { createCockpit } from '../src/hud/Cockpit';
import { buildMock } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { pcdScreenRect } from '../src/hud/cockpit/geometry';
import { PCD_W } from '../src/hud/cockpit/pcd';
import type { MissionDef } from '../src/core/contracts';
import { buildInstantMissionSeeded } from '../src/missions';
import { entityLabel, trackLabel, trackShort } from '../src/hud/hmd/format';
import { objectiveLines } from '../src/hud/hmd/overlays';
import { harness, killGroup } from './missions-helpers';

const defend = (enemyCount = 6): MissionDef =>
  buildInstantMissionSeeded({ mode: 'defend', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'su27', enemyCount }, 62);

describe('Defend: the strikers can be told from the escort', () => {
  it('tags the strikers STRK and leaves the escort untagged, even when both fly the Su-27', () => {
    const h = harness(defend());
    const strikers = h.world.aircraft.filter((a) => a.groupId === 'strikers');
    const escort = h.world.aircraft.filter((a) => a.groupId === 'escort');
    expect(strikers.length).toBeGreaterThanOrEqual(2);
    expect(escort.length).toBeGreaterThanOrEqual(1);
    for (const s of strikers) {
      expect(s.hudTag).toBe('STRK');
      expect(trackLabel(s)).toBe(entityLabel(s) + ' STRK');
      expect(trackShort(s)).toBe('STRK');
    }
    for (const e of escort) {
      expect(e.hudTag).toBeUndefined();
      expect(trackLabel(e)).toBe(entityLabel(e));
      expect(trackShort(e)).not.toBe('STRK');
    }
    // the same label string every frame (no per-frame allocation)
    expect(trackLabel(strikers[0])).toBe(trackLabel(strikers[1]));
  });

  it('counts the strikers left on the primary objective line', () => {
    const h = harness(defend());
    h.runner.update(h.world, 0.1);
    const o = h.runner.objectives.find((x) => x.id === 'o_tanks')!;
    const strikers = h.world.aircraft.filter((a) => a.groupId === 'strikers');
    expect(o.primary).toBe(true);
    expect(o.threat).toEqual({ label: 'Strikers', left: strikers.length });
    const before = objectiveLines(o, 30);
    expect(before.join(' ')).toContain('STRIKERS ' + strikers.length);
    // one striker splashed: the count drops
    h.world.applyDamage(strikers[0], 1e6, h.world.player!.id, 'aim120');
    h.runner.update(h.world, 0.1);
    expect(o.threat?.left).toBe(strikers.length - 1);
    expect(objectiveLines(o, 30).join(' ')).toContain('STRIKERS ' + (strikers.length - 1));
    // the escort doesn't count
    killGroup(h, 'escort');
    h.runner.update(h.world, 0.1);
    expect(o.threat?.left).toBe(strikers.length - 1);
  });

  it('shows the count only while the objective is active', () => {
    const lines = objectiveLines({ label: 'Keep the tanks standing', state: 'complete', progress: { done: 9, total: 9 }, threat: { label: 'Strikers', left: 0 } }, 30);
    expect(lines.join(' ')).not.toContain('STRIKERS');
  });
});

describe('cockpit PCD corner readouts at 844×390', () => {
  installPath2D();
  const g = globalThis as unknown as { document?: unknown };
  const prevDoc = g.document;
  const created: ReturnType<typeof makeFakeCanvas>['ctx'][] = [];
  beforeAll(() => {
    g.document = {
      createElement: () => {
        const c = makeFakeCanvas(1024, 512);
        created.push(c.ctx);
        return c.canvas;
      },
    };
  });
  afterAll(() => {
    g.document = prevDoc;
  });

  it('draws the TSD range, the bullseye call and the RWR emitter count at least 12 px tall', () => {
    const W = 844;
    const H = 390;
    const mock = buildMock('threat');
    const cockpit = createCockpit(mock.events, { ...QUALITY_PRESETS.medium });
    cockpit.resize(W, H);
    cockpit.visible = true;
    const p = mock.player;
    const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
    camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
    camera.quaternion.copy(p.quaternion);
    camera.updateMatrixWorld();
    const ctx: FrameContext = {
      dt: 1 / 30,
      time: 1,
      world: mock.world,
      player: p,
      camera,
      viewMode: 'cockpit',
      focusId: p.id,
      mission: mock.mission,
      settings: { ...DEFAULT_SETTINGS },
      quality: { ...QUALITY_PRESETS.medium },
      paused: false,
      screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    };
    for (let i = 0; i < 3; i++) cockpit.update(ctx, new Quaternion());
    const rect = pcdScreenRect(60, W, H);
    // the PCD texture is PCD_W texels across the panel's on-screen width
    const pxPerTexel = (rect.right - rect.left) / PCD_W;
    const texts = created.flatMap((c) => c.texts);
    for (const re of [/^\d+ NM$/, /^BULL \d{3}\/\d+$/, /^\d+ EMIT$/]) {
      const t = texts.find((x) => re.test(x.text));
      expect(t, String(re)).toBeTruthy();
      expect(t!.size * pxPerTexel, `${t!.text}: ${(t!.size * pxPerTexel).toFixed(1)} px`).toBeGreaterThanOrEqual(12);
    }
  });
});
