/**
 * First-time flow polish (issue #70, playtest 2026-10-02 round 4: 4.2-b, 4.2-c, 4.2-f):
 *  - tilt chosen but no orientation data: Input flies the touch stick, so the hints and c01's text
 *    describe the stick and a toast says tilt is unavailable;
 *  - T01's first hint stays on screen for its whole duration in the default cockpit view at 844x390
 *    (it was drawn ~2.4 s of its 7 s while the radio pill and the opening objectives filled the column);
 *  - the cockpit stores (SMS) page isn't covered by the touch controls in either handed layout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { DEFAULT_SETTINGS, DIFFICULTIES, QUALITY_PRESETS } from '../src/core/data';
import type { Settings } from '../src/core/types';
import { createMissionRunner, missionById } from '../src/missions';
import { TILT_UNAVAILABLE_TOAST, currentControlPrefs, followActiveScheme } from '../src/missions/runtime/controlsText';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createHud } from '../src/hud/Hud';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { flatLand, harness, stubAi } from './missions-helpers';

installPath2D();

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}
const g = globalThis as unknown as { localStorage?: MemStorage };
let savedStorage: MemStorage | undefined;
const useSettings = (s: Partial<Settings>) => {
  g.localStorage = new MemStorage();
  g.localStorage.setItem('f35a.settings.v1', JSON.stringify(s));
};
beforeAll(() => {
  savedStorage = g.localStorage;
});
afterAll(() => {
  g.localStorage = savedStorage;
  followActiveScheme('stick', 'stick');
});

describe('tilt chosen, no orientation data: the texts describe the stick (4.2-b)', () => {
  it('T01 re-words its STICK hint and c01 its controls hint once Input falls back; a toast says so', () => {
    useSettings({ controlScheme: 'tilt', leftHanded: true });
    expect(followActiveScheme('tilt', 'tilt')).toBeNull(); // tilt flying: no override, no toast
    const t01 = harness(missionById('t01')!);
    t01.run(2);
    expect(t01.runner.hint).toMatch(/tilting the phone/);
    // Input's grace period ran out without a deviceorientation event: it flies the touch stick
    expect(followActiveScheme('tilt', 'stick')).toBe(TILT_UNAVAILABLE_TOAST);
    expect(TILT_UNAVAILABLE_TOAST).toMatch(/tilt unavailable/i);
    t01.run(0.1);
    // the hint already on screen follows (left-handed: the stick is under the left thumb)
    expect(t01.runner.hint).toMatch(/^STICK \(left thumb\)/);
    expect(t01.runner.hint).not.toMatch(/tilt/i);
    // the toast fires once, not every frame
    expect(followActiveScheme('tilt', 'stick')).toBeNull();
    expect(currentControlPrefs()).toEqual({ controlScheme: 'stick', leftHanded: true });

    const c01 = harness(missionById('c01')!);
    let seen = '';
    c01.run(12, () => {
      if (c01.runner.hint?.includes('Climb toward the CAP')) seen = c01.runner.hint;
    });
    expect(seen).toMatch(/^Right thumb THROTTLE, left thumb STICK\. Climb/);

    // the sensor wakes up after all: back to the tilt wording, no toast
    expect(followActiveScheme('tilt', 'tilt')).toBeNull();
    expect(currentControlPrefs()).toEqual({ controlScheme: 'tilt', leftHanded: true });
  });
});

describe("T01's first hint is visible for its whole duration (4.2-c)", () => {
  it('cockpit view, 844x390: drawn in every frame from t=1.5 s to its expiry, with the radio and objectives up', { timeout: 30_000 }, () => {
    useSettings({});
    followActiveScheme('stick', 'stick');
    const W = 844;
    const H = 390;
    const events = new EventBus();
    const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
    // the HUD listens before the mission starts (the opening radio call goes out at setup)
    const hud = createHud(canvas, events);
    hud.resize(W, H, 1);
    hud.setVisible(true);
    const def = missionById('t01')!;
    const diff = DIFFICULTIES.pilot;
    const world = createSimWorld({ terrain: flatLand(), difficulty: diff, events, combat: createCombatSystemSeeded(7) });
    const runner = createMissionRunner(def, { createAi: stubAi({ created: [], retasked: [] }), difficulty: diff, events });
    runner.setup(world, def.recommendedLoadout);
    const p = world.player!;
    const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
    const ctx: FrameContext = {
      dt: 1 / 30,
      time: 0,
      world,
      player: p,
      camera,
      viewMode: 'cockpit',
      focusId: p.id,
      mission: runner,
      settings: { ...DEFAULT_SETTINGS },
      quality: { ...QUALITY_PRESETS.medium },
      paused: false,
      screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    };
    const eye = new Vector3();
    let shown = 0;
    let drawn = 0;
    let objectivesSeen = 0;
    for (let i = 0; i < 60 * 11; i++) {
      world.step(1 / 60);
      runner.update(world, 1 / 60);
      if (i % 2) continue;
      camera.position.copy(eye.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position));
      camera.quaternion.copy(p.quaternion);
      camera.updateMatrixWorld();
      ctx.time = world.time;
      fake.reset();
      hud.update(ctx);
      const texts = fake.texts.map((t) => t.text.toUpperCase());
      if (texts.includes('OBJECTIVES')) objectivesSeen++;
      if (!runner.hint?.startsWith('STICK')) continue;
      shown++;
      if (texts.some((t) => t.startsWith('STICK ('))) drawn++;
    }
    // the hint ran its 7 s (≈ 210 HUD frames at 30 fps)…
    expect(shown).toBeGreaterThan(200);
    // …and was on screen in every one of them
    expect(drawn).toBe(shown);
    // the opening objectives summary still showed (before and after the hint)
    expect(objectivesSeen).toBeGreaterThan(10);
  });
});
