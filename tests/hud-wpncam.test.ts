/**
 * Weapon window (hud/hmd/wpnCam.ts): the rules for the player's missile / bomb in the target camera's
 * slot. Planner and tracker unit tests, the chase-shot framing, and the real HUD in node (the HUD lab's
 * mock world) for the slot ownership: strip under the target camera, the video taking the slot for the
 * last seconds, the target camera not rendered meanwhile.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import type { Settings } from '../src/core/types';
import { createHud, type HudTestHooks } from '../src/hud/Hud';
import { buildMock, type Scenario } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { PIP_DESTROYED_HOLD, PIP_SHIP_HOLD, pipView } from '../src/hud/hmd/pip';
import {
  WPN_DWELL,
  WPN_GROW,
  WPN_RESULT_HOLD,
  WPN_SPLASH_HOLD,
  WpnTracker,
  planWpn,
  phaseText,
  rangeText,
  resetWpn,
  secText,
  wpnView,
  type WpnPlanInput,
  type WpnTrack,
} from '../src/hud/hmd/wpnCam';
import { makePose, weaponCamPose } from '../src/render/targetCam/pose';
import type { AnyEntity, MissileEntity } from '../src/sim/entities';

installPath2D();

let nextId = 100;
function track(o: Partial<WpnTrack> = {}): WpnTrack {
  return {
    id: nextId++,
    name: 'AMRAAM',
    guidance: 'active_radar',
    bomb: false,
    len: 3.65,
    targetId: 7,
    label: 'MIG-29',
    launchAt: 0,
    outcome: 'flight',
    endAt: -1,
    hold: 0,
    range: 5000,
    minRange: 5000,
    tti: 8,
    active: false,
    wasVideo: false,
    pos: new Vector3(),
    vel: new Vector3(),
    tgt: new Vector3(),
    seen: 0,
    ...o,
  };
}
const inp = (o: Partial<WpnPlanInput> = {}): WpnPlanInput => ({ now: 5, setting: 'dynamic', suppressed: false, pinned: null, prevFocus: null, prevSince: 0, prevVideo: false, ...o });

describe('weapon window planner', () => {
  it('a strip while the weapon cruises, the video from 3 s before impact, closed with nothing in the air', () => {
    expect(planWpn([], inp()).look).toBe('closed');
    const t = track({ tti: 8 });
    expect(planWpn([t], inp()).look).toBe('strip');
    t.tti = 2.9;
    const p = planWpn([t], inp());
    expect(p.look).toBe('video');
    expect(p.focus).toBe(t);
    expect(p.scale).toBe(WPN_GROW);
  });

  it('an open video stays open until the time to impact climbs past 5 s (the target turned away)', () => {
    const t = track({ tti: 4.2 });
    expect(planWpn([t], inp({ prevFocus: t.id, prevVideo: true })).look).toBe('video');
    t.tti = 5.5;
    expect(planWpn([t], inp({ prevFocus: t.id, prevVideo: true })).look).toBe('strip');
    // never opened: 4.2 s is still the strip
    t.tti = 4.2;
    expect(planWpn([t], inp()).look).toBe('strip');
  });

  it('settings: compact keeps the slot size, off shows nothing', () => {
    const t = track({ tti: 1 });
    expect(planWpn([t], inp({ setting: 'compact' })).scale).toBe(1);
    expect(planWpn([t], inp({ setting: 'off' })).look).toBe('closed');
  });

  it('a red cue (or the Sky Tower cut) keeps it a strip, the outcome included', () => {
    const t = track({ tti: 1 });
    expect(planWpn([t], inp({ suppressed: true })).look).toBe('strip');
    const k = track({ outcome: 'kill', endAt: 5, hold: WPN_SPLASH_HOLD, tti: 0 });
    expect(planWpn([k], inp({ suppressed: true })).look).toBe('strip');
  });

  it('a hit holds SPLASH for its hold, then the window closes', () => {
    const k = track({ outcome: 'hit', endAt: 10, hold: WPN_SPLASH_HOLD, tti: 0, wasVideo: true });
    expect(planWpn([k], inp({ now: 10 + WPN_SPLASH_HOLD - 0.05 })).look).toBe('video');
    expect(planWpn([k], inp({ now: 10 + WPN_SPLASH_HOLD + 0.05 })).look).toBe('closed');
  });

  it('a kill of the target camera’s own target holds its DESTROYED hold (the tracker sets it)', () => {
    const k = track({ outcome: 'kill', endAt: 10, hold: PIP_DESTROYED_HOLD, tti: 0 });
    expect(planWpn([k], inp({ now: 12.5 })).look).toBe('video');
    expect(planWpn([k], inp({ now: 13.1 })).look).toBe('closed');
  });

  it('hits less than 1.6 s apart count up (SPLASH ×N) and are not cut short by a weapon in its last seconds', () => {
    const a = track({ outcome: 'kill', endAt: 10, hold: WPN_SPLASH_HOLD, tti: 0 });
    const b = track({ outcome: 'kill', endAt: 11, hold: WPN_SPLASH_HOLD, tti: 0 });
    const c = track({ tti: 1 });
    const p = planWpn([a, b, c], inp({ now: 11.2 }));
    expect(p.focus).toBe(b);
    expect(p.splashN).toBe(2);
    expect(p.look).toBe('video');
  });

  it('a miss holds MISSED 2 s (video if it had the video), and gives way at once to a weapon in its last 3 s', () => {
    const m = track({ outcome: 'miss', endAt: 10, hold: WPN_RESULT_HOLD, tti: 0, wasVideo: true });
    let p = planWpn([m], inp({ now: 11 }));
    expect(p.focus).toBe(m);
    expect(p.look).toBe('video');
    expect(planWpn([m], inp({ now: 10 + WPN_RESULT_HOLD + 0.05 })).look).toBe('closed');
    // decoyed while still a strip: no video
    const d = track({ outcome: 'decoyed', endAt: 10, hold: WPN_RESULT_HOLD, tti: 0, wasVideo: false });
    expect(planWpn([d], inp({ now: 11 })).look).toBe('strip');
    // another weapon reaches its last 3 s: it takes the window, MISSED stays as an amber chip
    const next = track({ tti: 2 });
    p = planWpn([m, next], inp({ now: 11 }));
    expect(p.focus).toBe(next);
    expect(p.chips.some((c) => c.outcome === 'miss')).toBe(true);
  });

  it('several weapons: the next to hit, held at least 2 s; a pinned one wins', () => {
    const a = track({ tti: 9 });
    const b = track({ tti: 6 });
    expect(planWpn([a, b], inp()).focus).toBe(b);
    // a was shown 1 s ago: it stays until the dwell is up
    expect(planWpn([a, b], inp({ prevFocus: a.id, prevSince: 4 })).focus).toBe(a);
    expect(planWpn([a, b], inp({ prevFocus: a.id, prevSince: 5 - WPN_DWELL - 0.1 })).focus).toBe(b);
    expect(planWpn([a, b], inp({ pinned: a.id })).focus).toBe(a);
    // the other one is a chip
    expect(planWpn([a, b], inp()).chips.map((c) => c.label)).toEqual(['MIG-29']);
  });

  it('eight weapons: one window, the others grouped by target, at most 3 rows (+N)', () => {
    const labels = ['SUICIDE BOAT', 'SUICIDE BOAT', 'SUICIDE BOAT', 'MSL BOAT', 'MSL BOAT', 'MSL BOAT', 'AD BOAT', 'AD BOAT'];
    const ts = labels.map((label, i) => track({ label, tti: 20 + i, bomb: true, guidance: 'tri_mode', name: 'GBU-53' }));
    const p = planWpn(ts, inp());
    expect(p.flying).toBe(8);
    expect(p.focus).toBe(ts[0]);
    expect(p.look).toBe('strip');
    expect(p.chips.length).toBeLessThanOrEqual(3);
    expect(p.chips[0]).toMatchObject({ label: 'SUICIDE BOAT', count: 2 });
    expect(p.chips[1]).toMatchObject({ label: 'MSL BOAT', count: 3 });
    expect(p.chips[2]).toMatchObject({ label: 'AD BOAT', count: 2 });
    // a fourth group: the last row becomes "+N"
    ts.push(track({ label: 'MOTHER SHIP', tti: 40 }));
    const q = planWpn(ts, inp());
    expect(q.chips.length).toBe(3);
    expect(q.chips[2]).toMatchObject({ label: '', count: 3 }); // AD BOAT ×2 + MOTHER SHIP
  });
});

describe('weapon window texts', () => {
  it('range in NM, metres inside 1 NM; seconds with one decimal under 10', () => {
    expect(rangeText(5926)).toBe('3.2 NM');
    expect(rangeText(844)).toBe('840 M');
    expect(secText(6.06, 'T-')).toBe('T-6.1');
    expect(secText(12.2)).toBe('13');
    expect(secText(Infinity, 'T-')).toBe('T---');
  });
  it('guidance phase: DL until pitbull, then ACTIVE', () => {
    expect(phaseText(track({ active: false }))).toBe('DL');
    expect(phaseText(track({ active: true }))).toBe('ACTIVE');
    expect(phaseText(track({ guidance: 'tri_mode', active: false }))).toBe('GPS');
  });
});

/* ───────────── tracker ───────────── */

interface FakeEnt {
  id: number;
  kind: 'aircraft' | 'ground';
  type: string;
  name: string;
  team: string;
  alive: boolean;
  position: Vector3;
  velocity: Vector3;
}
function fakeWorld() {
  const ents = new Map<number, FakeEnt>();
  const mig: FakeEnt = { id: 7, kind: 'aircraft', type: 'mig29', name: 'MiG-29', team: 'red', alive: true, position: new Vector3(0, 5000, -6000), velocity: new Vector3() };
  ents.set(7, mig);
  const missiles: MissileEntity[] = [];
  const fire = (o: Partial<MissileEntity> & Record<string, unknown> = {}) => {
    const m = {
      id: nextId++,
      kind: 'missile',
      alive: true,
      shooterId: 1,
      targetId: 7,
      originalTargetId: 7,
      def: { name: 'AIM-120D AMRAAM', short: 'AMRAAM', guidance: 'active_radar', category: 'aam', length: 3.65 },
      position: new Vector3(0, 5000, 0),
      velocity: new Vector3(0, 0, -1000),
      targetPoint: new Vector3(),
      age: 0,
      seekerLocked: false,
      decoyed: false,
      trackBroken: false,
      ...o,
    } as unknown as MissileEntity;
    missiles.push(m);
    return m;
  };
  return { ents, mig, missiles, fire, lookup: (id: number) => (ents.get(id) as unknown as AnyEntity) ?? null };
}

describe('weapon window tracker', () => {
  it('time to impact from the closing speed; a hit that kills is a kill', () => {
    const w = fakeWorld();
    const tr = new WpnTracker();
    const m = w.fire();
    tr.update(w.missiles, 1, w.lookup, 1, null);
    const t = tr.find(m.id)!;
    expect(t.label).toBe('MIG-29');
    // the short name, as the FIRE button and the HMD's weapon column read (#282), not 'AIM-120D'
    expect(t.name).toBe('AMRAAM');
    expect(t.tti).toBeCloseTo(6, 3);
    // the warhead kills it: the sim reports 'munition:end' and the target is dead
    m.alive = false;
    w.mig.alive = false;
    tr.onEnd(m.id, 'proximity');
    tr.update(w.missiles, 1, w.lookup, 7, null);
    expect(t.outcome).toBe('kill');
    expect(t.hold).toBe(WPN_SPLASH_HOLD);
  });

  it('a kill of the target camera’s target holds its DESTROYED hold (6 s for a ship)', () => {
    const w = fakeWorld();
    const ship: FakeEnt = { id: 9, kind: 'ground', type: 'ship', name: 'SHIP', team: 'red', alive: true, position: new Vector3(0, 0, -9000), velocity: new Vector3() };
    w.ents.set(9, ship);
    const tr = new WpnTracker();
    const a = w.fire({ targetId: 9, originalTargetId: 9 });
    const b = w.fire();
    tr.update(w.missiles, 1, w.lookup, 1, 9);
    a.alive = false;
    ship.alive = false;
    tr.onEnd(a.id, 'hit');
    b.alive = false;
    w.mig.alive = false;
    tr.onEnd(b.id, 'hit');
    tr.update(w.missiles, 1, w.lookup, 2, 9);
    expect(tr.find(a.id)!.hold).toBe(PIP_SHIP_HOLD);
    expect(tr.find(b.id)!.hold).toBe(WPN_SPLASH_HOLD);
  });

  it('target dead before the weapon arrives: NO TGT, and the weapon is not picked up again', () => {
    const w = fakeWorld();
    const tr = new WpnTracker();
    const m = w.fire();
    tr.update(w.missiles, 1, w.lookup, 1, null);
    w.mig.alive = false; // the salvo partner / a wingman got it
    tr.update(w.missiles, 1, w.lookup, 2, null);
    expect(tr.find(m.id)!.outcome).toBe('notgt');
    tr.update(w.missiles, 1, w.lookup, 3, null);
    expect(tr.tracks.filter((t) => t.id === m.id).length).toBe(1);
  });

  it('decoyed: the box follows the target it was fired at and says DECOYED', () => {
    const w = fakeWorld();
    const tr = new WpnTracker();
    const m = w.fire();
    tr.update(w.missiles, 1, w.lookup, 1, null);
    (m as unknown as { decoyed: boolean; targetId: number }).decoyed = true;
    (m as unknown as { targetId: number }).targetId = 555;
    tr.update(w.missiles, 1, w.lookup, 2, null);
    const t = tr.find(m.id)!;
    expect(t.outcome).toBe('decoyed');
    expect(t.targetId).toBe(7);
  });

  it('a miss is the range opening again after the closest approach, not the expected impact time', () => {
    const w = fakeWorld();
    const tr = new WpnTracker();
    const m = w.fire();
    m.position.set(0, 5000, -5900); // 100 m short, closing
    tr.update(w.missiles, 1, w.lookup, 6, null);
    expect(tr.find(m.id)!.outcome).toBe('flight');
    m.position.set(30, 5000, -6080); // past it, 85 m away and opening
    tr.update(w.missiles, 1, w.lookup, 6.2, null);
    expect(tr.find(m.id)!.outcome).toBe('flight'); // not yet 40 m past the closest approach
    m.position.set(60, 5000, -6300);
    tr.update(w.missiles, 1, w.lookup, 6.4, null);
    expect(tr.find(m.id)!.outcome).toBe('miss');
  });

  it('only the player’s own weapons', () => {
    const w = fakeWorld();
    const tr = new WpnTracker();
    w.fire({ shooterId: 42 });
    tr.update(w.missiles, 1, w.lookup, 1, null);
    expect(tr.tracks.length).toBe(0);
  });
});

describe('weapon window chase shot', () => {
  it('behind and above the weapon, looking down its flight path towards the target', () => {
    const pose = makePose();
    weaponCamPose(new Vector3(0, 5000, 0), new Vector3(0, 0, -800), new Vector3(500, 5000, -4000), 3.65, pose);
    expect(pose.position.z).toBeGreaterThan(5); // behind (the weapon flies to −Z)
    expect(pose.position.y).toBeGreaterThan(5000);
    expect(pose.look.z).toBeLessThan(-50); // ahead
    expect(pose.look.x).toBeGreaterThan(0); // turned part of the way to the target
  });
});

/* ───────────── the real HUD ───────────── */

function rig(scene: Scenario, settings: Partial<Settings> = {}, W = 844, H = 390) {
  const mock = buildMock(scene);
  const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
  const hud = createHud(canvas, mock.events);
  hud.resize(W, H, 1);
  const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
  const p = mock.player;
  camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
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
    settings: { ...DEFAULT_SETTINGS, ...settings },
    quality: { ...QUALITY_PRESETS.medium },
    paused: false,
    screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  };
  const run = (seconds = 0.3, dt = 1 / 30) => {
    const n = Math.max(1, Math.round(seconds / dt));
    for (let i = 0; i < n; i++) {
      fake.reset();
      ctx.dt = dt;
      ctx.time += dt;
      mock.tick(dt);
      hud.update(ctx);
    }
    return fake.texts.slice();
  };
  const read = () => (hud as typeof hud & HudTestHooks).layoutRead().wpn;
  return { mock, hud, run, read, ctx };
}

afterEach(() => resetWpn());

describe('weapon window in the HUD (one slot, one owner)', () => {
  it('locked target + AMRAAM in flight: the strip docks flush under the target camera, ▲ SAME TGT', () => {
    const r = rig('lock');
    const texts = r.run(0.5);
    const w = r.read();
    expect(w.look).toBe('strip');
    expect(w.owns).toBe(false);
    expect(pipView.open).toBe(true);
    // flush under the target camera window
    expect(w.rect![1]).toBe(pipView.y + pipView.h);
    expect(texts.some((t) => t.text === 'AMRAAM ▲ SAME TGT')).toBe(true);
    expect(texts.some((t) => /^T-\d/.test(t.text))).toBe(true);
    r.hud.dispose();
  });

  it('last 3 s: the video takes the slot and grows; the target camera is neither rendered nor drawn', () => {
    const r = rig('lock');
    r.run(0.2);
    const p = r.mock.player;
    const m = r.mock.world.missiles.find((x) => x.shooterId === p.id)!;
    const mig = r.mock.world.getEntity(m.targetId)!;
    // 1.5 km short of the target, closing at 1100 m/s
    m.position.copy(mig.position).add(new Vector3(0, 0, 1500).applyQuaternion(p.quaternion));
    m.velocity.subVectors(mig.position, m.position).normalize().multiplyScalar(1100);
    const texts = r.run(0.5);
    const w = r.read();
    expect(w.look).toBe('video');
    expect(w.owns).toBe(true);
    expect(pipView.vh).toBe(0); // the 3D pass renders the weapon instead
    expect(wpnView.vh).toBeGreaterThan(pipView.h);
    expect(texts.some((t) => /^TTI \d/.test(t.text))).toBe(true);
    // compact: the slot's own size
    r.hud.dispose();
    const c = rig('lock', { missileCam: 'compact' });
    c.run(0.2);
    const m2 = c.mock.world.missiles.find((x) => x.shooterId === c.mock.player.id)!;
    const t2 = c.mock.world.getEntity(m2.targetId)!;
    m2.position.copy(t2.position).add(new Vector3(0, 0, 1500).applyQuaternion(c.mock.player.quaternion));
    m2.velocity.subVectors(t2.position, m2.position).normalize().multiplyScalar(1100);
    c.run(0.5);
    expect(wpnView.vh).toBe(pipView.h);
    c.hud.dispose();
  });

  it('a kill of the target camera’s target: SPLASH, then DESTROYED in the weapon window for the camera’s hold', () => {
    const r = rig('lock');
    r.run(0.2);
    const p = r.mock.player;
    const m = r.mock.world.missiles.find((x) => x.shooterId === p.id)!;
    const mig = r.mock.world.getEntity(m.targetId)!;
    m.position.copy(mig.position).add(new Vector3(0, 0, 900).applyQuaternion(p.quaternion));
    m.velocity.subVectors(mig.position, m.position).normalize().multiplyScalar(1100);
    r.run(0.3);
    m.alive = false;
    mig.alive = false;
    r.mock.events.emit('munition:end', { missile: m, position: m.position, reason: 'proximity', targetId: mig.id });
    let texts = r.run(0.5);
    expect(r.read().outcome).toBe('kill');
    expect(texts.some((t) => t.text === 'SPLASH')).toBe(true);
    texts = r.run(1.5);
    expect(texts.some((t) => t.text === 'DESTROYED')).toBe(true);
    expect(r.read().owns).toBe(true);
    r.run(1.5);
    expect(r.read().look).toBe('closed');
    r.hud.dispose();
  });

  it('missile camera off: nothing drawn, the target camera unchanged', () => {
    const r = rig('lock', { missileCam: 'off' });
    const texts = r.run(0.5);
    expect(r.read().look).toBe('closed');
    expect(texts.some((t) => /SAME TGT|▸/.test(t.text))).toBe(false);
    expect(pipView.open).toBe(true);
    r.hud.dispose();
  });
});

describe('a protected asset lost takes the slot over everything', () => {
  it('the mission fails right after a civil / friendly loss: that asset is shown, setting off and weapon window included', () => {
    const r = rig('lock', { targetCam: false });
    r.run(0.3);
    expect(r.read().look).toBe('strip'); // the AMRAAM's strip, no target camera
    expect(pipView.open).toBe(false);
    const ship = r.mock.world.ground.find((g) => g.type === 'ship')!;
    ship.team = 'neutral'; // the escorted tanker
    ship.alive = false;
    r.mock.events.emit('destroyed', { entity: ship, attackerId: null, weapon: null });
    r.ctx.time += 1;
    r.mock.events.emit('mission:end', { success: false, reason: 'The tanker was sunk.' });
    r.run(0.5);
    expect(pipView.open).toBe(true);
    expect(pipView.targetId).toBe(ship.id);
    expect(pipView.vh).toBeGreaterThan(0);
    expect(r.read().look).toBe('closed');
    r.hud.dispose();
  });

  it('a loss without a failed mission (or long before it) changes nothing', () => {
    const r = rig('lock', { targetCam: false });
    r.run(0.3);
    const ship = r.mock.world.ground.find((g) => g.type === 'ship')!;
    ship.team = 'neutral';
    ship.alive = false;
    r.mock.events.emit('destroyed', { entity: ship, attackerId: null, weapon: null });
    r.run(0.3);
    expect(pipView.open).toBe(false);
    r.hud.dispose();
  });
});
