/**
 * Playtest tooling (#118): the test-hook logic that runs without a browser. The hooks themselves
 * (`window.__f35.*`) are exercised in the dev server; see .claude/skills/play-f35/SKILL.md.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import type { FrameContext, HudApi } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS, TEST_HOOKS } from '../src/core/data';
import { missionById } from '../src/missions';
import { hudShown, testConditions } from '../src/game/testParams';
import { createHud, type HudTestHooks } from '../src/hud/Hud';
import { buildMock, type Scenario } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { parseProbe, probeLabel, type ProbeSpec } from './missions-probes';
import { runPlaythrough } from './missions-bot';
import { flat } from './ai-helpers';

installPath2D();

describe('bot-sweep --park / --gunonly (tests/missions-probes.ts)', () => {
  it('parses the flags; rows and logs name the probe', () => {
    expect(parseProbe({})).toBeNull();
    expect(parseProbe({ park: '' })).toEqual({ kind: 'park', at: 'start' });
    expect(parseProbe({ park: 'start' })).toEqual({ kind: 'park', at: 'start' });
    expect(parseProbe({ park: 'far' })).toEqual({ kind: 'park', at: 'far' });
    expect(parseProbe({ gunonly: '' })).toEqual({ kind: 'gunonly' });
    expect(() => parseProbe({ park: 'home' })).toThrow(/start or far/);
    expect(() => parseProbe({ park: '', gunonly: '' })).toThrow(/pick one/);
    expect(() => parseProbe({ gunonly: '1' })).toThrow();
    expect([null, { kind: 'park', at: 'start' }, { kind: 'park', at: 'far' }, { kind: 'gunonly' }].map((p) => probeLabel(p as ProbeSpec | null))).toEqual(['bot', 'park:start', 'park:far', 'gunonly']);
  });

  it('park: the parked jet never flies, shoots or dies; the row and log say which park', { timeout: 60_000 }, () => {
    const r = runPlaythrough('c01', 'recruit', 1, flat(0), { maxT: 60, log: true, probe: { kind: 'park', at: 'far' } });
    expect(r.probe?.label).toBe('park:far');
    expect(r.events[0]).toMatch(/PROBE park:far/);
    expect(r.launches).toEqual([]);
    expect(r.probe?.gunRounds).toBe(0);
    expect(Object.keys(r.modes)).toEqual(['PARKED']);
    expect(r.alive).toBe(true);
  });

  it('gun-only: no missile or bomb ever leaves the jet', { timeout: 60_000 }, () => {
    const r = runPlaythrough('c01', 'recruit', 0, flat(0), { maxT: 90, probe: { kind: 'gunonly' } });
    expect(r.probe?.label).toBe('gunonly');
    expect(r.launches).toEqual([]);
    expect(Object.keys(r.modes)).toEqual(['GUNONLY']);
  });

  it('no probe: the plain bot, no probe field', { timeout: 60_000 }, () => {
    const r = runPlaythrough('c01', 'recruit', 0, flat(0), { maxT: 5 });
    expect(r.probe).toBeUndefined();
  });
});

describe('Instant Action time of day and weather (?tod= / ?weather=, missionById conditions)', () => {
  it('missionById builds an ia_* id at the asked time of day and weather, on the same seeded layout', () => {
    const day = missionById('ia_stroll_auckland')!;
    const night = missionById('ia_stroll_auckland', { timeOfDay: 'night', weather: 'clear' })!;
    expect(day.timeOfDay).toBe('day');
    expect(day.weather).toBe('scattered');
    expect(night.timeOfDay).toBe('night');
    expect(night.weather).toBe('clear');
    expect(night.id).toBe(day.id);
    expect(night.seed).toBe(day.seed);
    expect(JSON.stringify(night.script)).toBe(JSON.stringify(day.script));
    // one condition alone keeps the other's default
    expect(missionById('ia_dogfight_auckland', { weather: 'overcast' })!.timeOfDay).toBe('day');
  });

  it("conditions don't change campaign or training missions", () => {
    const c10 = missionById('c10')!;
    expect(missionById('c10', { timeOfDay: 'day', weather: 'clear' })).toBe(c10);
  });

  it('parses and validates the URL values (case-insensitive); unknown values are listed, not applied', () => {
    const q = (s: string) => testConditions(new URLSearchParams(s), true);
    expect(q('?mission=ia_stroll_auckland&tod=night&weather=clear')).toEqual({ conditions: { timeOfDay: 'night', weather: 'clear' }, invalid: [] });
    expect(q('?tod=Dusk')).toEqual({ conditions: { timeOfDay: 'dusk' }, invalid: [] });
    expect(q('?weather=overcast')).toEqual({ conditions: { weather: 'overcast' }, invalid: [] });
    const bad = q('?tod=midnight&weather=rain');
    expect(bad.conditions).toEqual({});
    expect(bad.invalid).toHaveLength(2);
    expect(bad.invalid[0]).toContain('tod=midnight');
    expect(bad.invalid[1]).toContain('weather=rain');
    expect(q('')).toEqual({ conditions: {}, invalid: [] });
  });

  it('nothing without the test hooks (the deployed game)', () => {
    expect(testConditions(new URLSearchParams('?tod=night&weather=clear'), false)).toEqual({ conditions: {}, invalid: [] });
  });
});

describe('sticky hud(false)', () => {
  it('a view change keeps the HUD hidden by the hook; hud(true) brings it back; the tactical map never shows it', () => {
    for (const mode of ['cockpit', 'hud', 'chase', 'orbit', 'flyby', 'target', 'missile'] as const) {
      expect(hudShown(mode, true), mode).toBe(false);
      expect(hudShown(mode, false), mode).toBe(true);
    }
    expect(hudShown('tactical', false)).toBe(false);
  });
});

/** The HUD on the dev mock world (as the hud-* tests), in the HUD view. */
function hudRig(scene: Scenario, W = 844, H = 390) {
  const mock = buildMock(scene);
  const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
  const hud = createHud(canvas, mock.events) as HudApi & HudTestHooks;
  hud.resize(W, H, 1);
  hud.setVisible(true);
  const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
  const p = mock.player;
  camera.position.copy(p.position);
  camera.quaternion.copy(p.quaternion);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const ctx: FrameContext = {
    dt: 1 / 30,
    time: 0,
    world: mock.world,
    player: p,
    camera,
    viewMode: 'hud',
    focusId: p.id,
    mission: mock.mission,
    settings: { ...DEFAULT_SETTINGS, targetCam: false },
    quality: { ...QUALITY_PRESETS.medium },
    paused: false,
    screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  };
  return {
    mock,
    hud,
    ctx,
    camera,
    /** Draw frames for `seconds`; returns the strings drawn in the last one. */
    draw(seconds = 0.1, dt = 1 / 30): string[] {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i++) {
        fake.reset();
        ctx.time += dt;
        ctx.dt = dt;
        mock.tick(dt);
        hud.update(ctx);
      }
      return fake.texts.map((t) => t.text);
    },
  };
}

/** CSS px of a world point projected by `camera` on an 844x390 screen (only to check the recorded values). */
function screenOf(v: { clone(): { project(c: PerspectiveCamera): { x: number; y: number } } }, camera: PerspectiveCamera, W = 844, H = 390) {
  const n = v.clone().project(camera);
  return { x: ((n.x + 1) / 2) * W, y: ((1 - n.y) / 2) * H };
}

describe('HUD layout read (state().hud)', () => {
  it('exists with the test hooks (vitest runs with them on, like the dev server)', () => {
    expect(TEST_HOOKS).toBe(true);
    const r = hudRig('aa');
    expect(typeof r.hud.layoutRead).toBe('function');
    expect(typeof r.hud.stepClock).toBe('function');
  });

  it('gun: the pipper where drawGun put it, and the designated box as drawn (also among the boxes)', () => {
    const r = hudRig('gun');
    r.draw(0.2);
    const read = r.hud.layoutRead();
    expect(read.mode).toBe('hmd');
    expect(read.visible).toBe(true);
    expect(read.pipper).not.toBeNull();
    const lead = screenOf(r.mock.world.combat.gunLeadPoint(r.mock.player, r.mock.world)!, r.camera);
    expect(Math.abs(read.pipper!.x - lead.x)).toBeLessThan(1);
    expect(Math.abs(read.pipper!.y - lead.y)).toBeLessThan(1);
    expect(read.pipper!.r).toBeGreaterThan(10);
    const tid = r.mock.player.radar.lockedId ?? r.mock.player.radar.designatedId;
    expect(read.designated?.id).toBe(tid);
    const [x, y, w, h] = read.designated!.rect!;
    expect(w).toBeGreaterThan(0);
    expect(w).toBe(h);
    const t = screenOf(r.mock.world.getEntity(tid)!.position, r.camera);
    expect(Math.abs(x + w / 2 - t.x)).toBeLessThan(1);
    expect(Math.abs(y + h / 2 - t.y)).toBeLessThan(1);
    expect(read.boxes.some((b) => b.id === tid && b.kind === 'aircraft')).toBe(true);
    // stepping the HUD clock (simulate with { hud: true }) draws nothing: the read stays the last drawn frame's
    for (let i = 0; i < 10; i++) r.hud.stepClock({ ...r.ctx, dt: 1 / 60 });
    const after = r.hud.layoutRead();
    expect({ ...after, clock: 0 }).toEqual({ ...read, clock: 0 });
    expect(after.clock - read.clock).toBeCloseTo(10 / 60, 6);
  });

  it('every target box drawn is listed with its rect; no pipper without the gun', () => {
    const r = hudRig('aa');
    r.draw(0.2);
    const read = r.hud.layoutRead();
    expect(read.pipper).toBeNull();
    expect(read.boxes.length).toBeGreaterThan(1);
    for (const b of read.boxes) {
      expect(b.rect[2]).toBeGreaterThan(0);
      expect(b.rect[0] + b.rect[2]).toBeGreaterThan(0);
      expect(b.rect[0]).toBeLessThan(844);
    }
  });

  it('the steering waypoint: its label, and its diamond and name where drawn', () => {
    const r = hudRig('nav');
    // the waypoint 9 km ahead, right of and a little below the nose (clear of the FPM, the tape band
    // and the text blocks)
    const p = r.mock.player;
    r.mock.mission.currentWaypoint!.position.set(2500, 0, -9000).applyQuaternion(p.quaternion).add(p.position).add(new Vector3(0, -600, 0));
    const texts = r.draw(0.2);
    const read = r.hud.layoutRead();
    expect(read.steer?.label).toBe('WP1 NAV');
    expect(read.steer?.diamond).not.toBeNull();
    const wp = screenOf(r.mock.mission.currentWaypoint!.position, r.camera);
    expect(Math.abs(read.steer!.diamond![0] - wp.x)).toBeLessThan(1);
    expect(Math.abs(read.steer!.diamond![1] - wp.y)).toBeLessThan(1);
    // its name: printed by the diamond, or (no room there: here the mock's labels are in the way) by the
    // fixed NEXT line; drawn either way
    expect(texts).toContain('WP1 NAV');
    expect(read.steer!.next).toBe(read.steer!.name === null);
    if (read.steer!.name) expect(Math.abs(read.steer!.name[0] - wp.x)).toBeLessThan(80);
    // in the open (no other symbols near it) the diamond prints its name itself
    r.mock.world.aircraft.length = 0;
    r.mock.world.sams.length = 0;
    r.mock.world.ground.length = 0;
    r.mock.player.radar.contacts.length = 0;
    r.draw(0.1);
    const open = r.hud.layoutRead().steer!;
    expect(open.name, JSON.stringify(open)).not.toBeNull();
    expect(open.next).toBe(false);
  });

  it('hidden: nothing reads as drawn', () => {
    const r = hudRig('gun');
    r.draw(0.1);
    r.hud.setVisible(false);
    r.draw(0.1);
    const read = r.hud.layoutRead();
    expect(read.visible).toBe(false);
    expect(read.pipper).toBeNull();
    expect(read.steer).toBeNull();
    expect(read.boxes).toEqual([]);
    expect(read.designated?.rect ?? null).toBeNull();
  });
});

describe('simulate(n, { hud: true }): the HUD clock advances without drawing', () => {
  it('a kill-feed line expires over stepped time; without stepping it is still up', () => {
    for (const step of [true, false]) {
      const r = hudRig('aa');
      r.draw(0.1);
      r.mock.events.emit('hud:message', { text: 'SPLASH MIG-29', tone: 'good' });
      expect(r.draw(0.1)).toContain('SPLASH MIG-29');
      const clock = r.hud.layoutRead().clock;
      // 8 s of simulate() at 60 Hz (the kill feed keeps a line 5 s)
      if (step) for (let i = 0; i < 480; i++) r.hud.stepClock({ ...r.ctx, dt: 1 / 60 });
      const texts = r.draw(1 / 30);
      expect(texts.includes('SPLASH MIG-29'), `stepped ${step}`).toBe(!step);
      expect(r.hud.layoutRead().clock - clock).toBeCloseTo(step ? 8 + 1 / 30 : 1 / 30, 3);
    }
  });

  it('a message sent during the stepped time is routed and runs out in it too', () => {
    const r = hudRig('aa');
    r.draw(0.1);
    r.mock.events.emit('hud:message', { text: 'RADAR ON', duration: 1.5, tone: 'info' });
    for (let i = 0; i < 300; i++) r.hud.stepClock({ ...r.ctx, dt: 1 / 60 });
    expect(r.draw(1 / 30)).not.toContain('RADAR ON');
  });
});
