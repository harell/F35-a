/**
 * First-time flow polish (issue #70, playtest 2026-10-02 round 4: 4.2-b, 4.2-c, 4.2-f):
 *  - tilt chosen but no orientation data: Input flies the touch stick, so the hints and {controls} texts
 *    describe the stick and a toast says tilt is unavailable;
 *  - T01's first hint stays on screen for its whole duration in the default cockpit view at 844x390
 *    (it was drawn ~2.4 s of its 7 s while the radio pill and the opening objectives filled the column);
 *  - the cockpit stores (SMS) page isn't covered by the touch controls in either handed layout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { restHead } from '../src/render/camera/cameraMath';
import type { FrameContext } from '../src/core/contracts';
import { EventBus } from '../src/core/events';
import { DEFAULT_SETTINGS, DIFFICULTIES, QUALITY_PRESETS } from '../src/core/data';
import type { Settings } from '../src/core/types';
import { createMissionRunner, missionById } from '../src/missions';
import { mission } from '../src/missions/content/common';
import { TILT_UNAVAILABLE_TOAST, currentControlPrefs, followActiveScheme } from '../src/missions/runtime/controlsText';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createHud } from '../src/hud/Hud';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { pcdRowSpan } from '../src/hud/cockpit/geometry';
import { PCD_PORTALS, PCD_W, PORTAL_INSET, PcdDisplay } from '../src/hud/cockpit/pcd';
import { computeTouchLayout, type Rect } from '../src/input/touch/layout';
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
  it('T01 re-words its STICK hint and a {controls} hint reads the stick once Input falls back; a toast says so', () => {
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

    // a mission whose hint uses the {controls} token (no shipped mission has one since c01 was removed)
    const fixture = mission({
      id: 'fx_controls',
      kind: 'campaign',
      index: 1,
      title: 'Controls fixture',
      subtitle: 'Test fixture',
      timeOfDay: 'day',
      weather: 'clear',
      briefing: ['Test fixture.'],
      recommendedLoadout: 'a2a_stealth',
      allowedLoadouts: ['a2a_stealth'],
      player: { x: -9000, z: -6000, altitude: 1200, heading: 100, speed: 220 },
      script: { hints: [{ id: 'h_controls', text: '{controls}. Climb toward the CAP', when: { kind: 'time', t: 2 }, duration: 6 }] },
    });
    const fx = harness(fixture);
    let seen = '';
    fx.run(12, () => {
      if (fx.runner.hint?.includes('Climb toward the CAP')) seen = fx.runner.hint;
    });
    expect(seen).toMatch(/^Right thumb THROTTLE, left thumb STICK\. Climb/);

    // the sensor wakes up after all: back to the tilt wording, no toast
    expect(followActiveScheme('tilt', 'tilt')).toBeNull();
    expect(currentControlPrefs()).toEqual({ controlScheme: 'tilt', leftHanded: true });
  });
});

interface HudFrameRec {
  t: number;
  hint: string | null;
  /** The OBJECTIVES summary was drawn. */
  obj: boolean;
  /** The current hint was drawn (any of its lines). */
  hintDrawn: boolean;
}

/** Fly a lesson with the real runner, sim world and HUD (one event bus), cockpit view at 844x390, 30 HUD fps. */
function flyLesson(id: string, seconds: number, prep?: (world: ReturnType<typeof createSimWorld>) => void): HudFrameRec[] {
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
  const def = missionById(id)!;
  const diff = DIFFICULTIES.pilot;
  const world = createSimWorld({ terrain: flatLand(), difficulty: diff, events, combat: createCombatSystemSeeded(7) });
  const runner = createMissionRunner(def, { createAi: stubAi({ created: [], retasked: [] }), difficulty: diff, events });
  runner.setup(world, def.recommendedLoadout);
  prep?.(world);
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
  const out: HudFrameRec[] = [];
  for (let i = 0; i < 60 * seconds; i++) {
    world.step(1 / 60);
    runner.update(world, 1 / 60);
    if (i % 2) continue;
    camera.position.copy(eye.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position));
    camera.quaternion.copy(p.quaternion).multiply(restHead('cockpit', new Quaternion()));
    camera.updateMatrixWorld();
    ctx.time = world.time;
    fake.reset();
    hud.update(ctx);
    const texts = fake.texts.map((t) => t.text.toUpperCase().trim());
    const hint = runner.hint ?? null;
    const up = hint?.toUpperCase() ?? '';
    // (a short last line of a page — "NOSE" — only counts at the hint's end)
    const hintDrawn = !!hint && texts.some((t) => (t.length > 8 ? up.includes(t) : t.length >= 3 && up.endsWith(t)));
    out.push({ t: world.time, hint, obj: texts.includes('OBJECTIVES'), hintDrawn });
  }
  return out;
}

/** Runs of consecutive frames with the objectives summary drawn: [start, end) times. */
function objectiveRuns(frames: HudFrameRec[]): [number, number][] {
  const runs: [number, number][] = [];
  let from = -1;
  for (let i = 0; i <= frames.length; i++) {
    const on = i < frames.length && frames[i].obj;
    if (on && from < 0) from = i;
    if (!on && from >= 0) {
      runs.push([frames[from].t, i < frames.length ? frames[i].t : frames[i - 1].t]);
      from = -1;
    }
  }
  return runs;
}

describe("T01's first hint is visible for its whole duration (4.2-c)", () => {
  it('cockpit view, 844x390: drawn in every frame from t=1.5 s to its expiry, with the radio and objectives up', { timeout: 30_000 }, () => {
    const frames = flyLesson('t01', 11);
    const first = frames.filter((r) => r.hint?.startsWith('STICK'));
    // the hint ran its 7 s (≈ 210 HUD frames at 30 fps)…
    expect(first.length).toBeGreaterThan(200);
    // …and was on screen in every one of them
    expect(first.filter((r) => r.hintDrawn).length).toBe(first.length);
    // the opening objectives summary still showed (before and after the hint)
    expect(frames.filter((r) => r.obj).length).toBeGreaterThan(10);
  });

  it('T01–T04, T06: the summary never flashes on and off with the hints or the radio, and every hint is drawn while it waits', { timeout: 120_000 }, () => {
    for (const id of ['t01', 't02', 't04', 't06']) {
      const frames = flyLesson(id, 30);
      // once it shows, it stays up for a while: no frame-long flash between two radio calls, no blink
      // at the start before the first hint arrives (review of #70: T02 at 12.52 s, T04 at 0.02 s)
      for (const [a, b] of objectiveRuns(frames)) expect(b - a, `${id}: OBJECTIVES drawn only ${a.toFixed(2)}–${b.toFixed(2)} s`).toBeGreaterThan(1.5);
      expect(objectiveRuns(frames).length, `${id}: the summary never showed`).toBeGreaterThan(0);
      const hidden = frames.filter((r) => r.hint && !r.hintDrawn);
      expect(hidden.length, `${id}: hint hidden at ${hidden[0]?.t.toFixed(2)} s: ${hidden[0]?.hint}`).toBe(0);
    }
  });

  it('a damaged jet: the damage block counts too, so the summary never keeps the hint off the screen', { timeout: 30_000 }, () => {
    // HP bar only: the summary yields and the first hint is drawn in every frame
    const frames = flyLesson('t01', 11, (world) => {
      const p = world.player!;
      p.health = 0.5 * p.maxHealth;
    });
    const first = frames.filter((r) => r.hint?.startsWith('STICK'));
    expect(first.length).toBeGreaterThan(200);
    expect(first.filter((r) => r.hintDrawn).length).toBe(first.length);
    // HP bar + a HYD tag: with the radio pill up the hint can't fit even alone, but the summary still
    // never takes its place
    const worse = flyLesson('t01', 11, (world) => {
      const p = world.player!;
      p.health = 0.5 * p.maxHealth;
      p.damage.hydraulics = 0.3;
    });
    expect(worse.filter((r) => r.obj && r.hint && !r.hintDrawn).length).toBe(0);
    expect(worse.filter((r) => r.obj).length).toBeGreaterThan(10);
  });
});

describe('the cockpit stores page clears the touch controls (4.2-f)', () => {
  const W = 844;
  const H = 390;
  const doc = globalThis as unknown as { document?: unknown };
  for (const leftHanded of [false, true]) {
    it(`844x390, ${leftHanded ? 'left' : 'right'}-handed: no control over the SMS portal on any visible row`, () => {
      // which outer portal shows the stores page in this layout (PcdDisplay swaps them)
      const prev = doc.document;
      doc.document = { createElement: () => makeFakeCanvas(PCD_W, 256).canvas };
      let portal: number;
      try {
        const pcd = new PcdDisplay({ ...QUALITY_PRESETS.medium });
        pcd.setLeftHanded(leftHanded);
        portal = pcd.pages().indexOf('SMS');
      } finally {
        doc.document = prev;
      }
      expect(portal).toBe(leftHanded ? 2 : 0);
      const span = PCD_PORTALS[portal];
      // the portal frame (3-texel stroke centred on the inset edge)
      const u0 = span.x + PORTAL_INSET - 2;
      const u1 = span.x + span.w - PORTAL_INSET + 2;
      const t = computeTouchLayout(W, H, { top: 0, right: 0, bottom: 0, left: 0 }, { leftHanded });
      const b = t.buttons;
      const stick: Rect = { x: t.stickHome.x - t.stickRadius, y: t.stickHome.y - t.stickRadius, w: 2 * t.stickRadius, h: 2 * t.stickRadius };
      const controls: [string, Rect][] = [
        ['throttle', t.throttle],
        ['fire', b.fire],
        ['gun', b.gun],
        ['cms', b.cms],
        ['recenter', b.recenter],
        ['stick', stick],
      ];
      let rows = 0;
      for (let y = 0; y <= H; y++) {
        const r = pcdRowSpan(60, W, H, y);
        if (!r) continue;
        rows++;
        const k = (r.right - r.left) / PCD_W;
        const x0 = r.left + u0 * k;
        const x1 = r.left + u1 * k;
        for (const [id, c] of controls) {
          if (y < c.y || y > c.y + c.h) continue;
          // 2 px clear of the control's box (its glow / shadow)
          expect(c.x + c.w <= x0 - 2 || c.x >= x1 + 2, `${id} over the stores page at y=${y}`).toBe(true);
        }
      }
      expect(rows).toBeGreaterThan(80); // ~60 % of the panel is in view
    });
  }
});
