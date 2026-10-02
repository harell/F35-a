/**
 * HUD end-to-end layout regression tests: the real createHud() runs in node on a recording canvas with
 * the HUD lab's mock world, and the tests assert where text lands — reproducing the i1 reviewers'
 * failing cases (centre-screen pile-ups over the FPM / target box, radio over the PCD / touch controls,
 * truncated radio and objectives, no MISSILE DEFEATED feedback, no lock cone / LOCKING cue, the
 * MAP view with no tactical picture).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import type { CameraMode, Settings } from '../src/core/types';
import { createHud } from '../src/hud/Hud';
import { buildMock, type Scenario } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas, overlaps, textBox, type Box, type TextRec } from '../src/hud/dev/fakeCanvas';
import { pcdZoom } from '../src/hud/cockpit/zoom';
import { pcdScreenRect } from '../src/hud/cockpit/geometry';
import { computeLayout, makeLayout } from '../src/hud/hmd/layout';
import { pipView } from '../src/hud/hmd/pip';
import { Projector } from '../src/hud/hmd/projector';
import { computeTouchLayout } from '../src/input/touch/layout';
import { GroundTargetEntity, MissileEntity } from '../src/sim/entities';
import { paletteFor } from '../src/hud/hmd/palette';
import { PLAYER_LOCK_CONE } from '../src/sim/sensors/Sensors';
import { gunOvershoot } from '../src/hud/hmd/weapons';

installPath2D();

interface Rig {
  hud: ReturnType<typeof createHud>;
  fake: ReturnType<typeof makeFakeCanvas>['ctx'];
  mock: ReturnType<typeof buildMock>;
  ctx: FrameContext;
  camera: PerspectiveCamera;
  W: number;
  H: number;
  /** Run the HUD for `seconds` (frames of dt); returns the texts of the LAST frame. */
  run(seconds?: number, dt?: number): TextRec[];
}

function rig(scene: Scenario, view: CameraMode, W = 844, H = 390, settings: Partial<Settings> = {}): Rig {
  const mock = buildMock(scene);
  const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
  const hud = createHud(canvas, mock.events);
  hud.resize(W, H, 1);
  hud.setVisible(view !== 'tactical');
  const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
  const p = mock.player;
  if (view === 'cockpit' || view === 'hud') {
    camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
    camera.quaternion.copy(p.quaternion);
  } else if (view === 'tactical') {
    camera.position.set(p.position.x, p.position.y + 9000, p.position.z);
    camera.up.set(0, 0, -1);
    camera.lookAt(p.position);
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
    settings: { ...DEFAULT_SETTINGS, ...settings },
    quality: { ...QUALITY_PRESETS.medium },
    paused: false,
    screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  };
  const r: Rig = {
    hud,
    fake,
    mock,
    ctx,
    camera,
    W,
    H,
    run(seconds = 0.1, dt = 1 / 30) {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i++) {
        fake.reset();
        ctx.dt = dt;
        ctx.time += dt;
        mock.tick(dt);
        hud.update(ctx);
      }
      return fake.texts.slice();
    },
  };
  return r;
}

const find = (texts: TextRec[], s: string | RegExp) => texts.filter((t) => (typeof s === 'string' ? t.text === s : s.test(t.text)));
const one = (texts: TextRec[], s: string | RegExp) => {
  const f = find(texts, s);
  expect(f.length, `text ${String(s)} drawn`).toBeGreaterThan(0);
  return f[0];
};

/** FPM screen box (velocity vector through the camera). */
function fpmBox(r: Rig): Box {
  const proj = new Projector();
  proj.update(r.camera, r.W, r.H);
  const sp = { x: 0, y: 0, depth: 0, front: false, onScreen: false, dirX: 0, dirY: 0, offAxis: 0 };
  proj.dir(r.mock.player.velocity.clone().normalize(), sp);
  return { x0: sp.x - 17, y0: sp.y - 14, x1: sp.x + 17, y1: sp.y + 12 };
}

/** Target designator box (with its labels) of the designated / locked target. */
function tdBox(r: Rig): Box {
  const p = r.mock.player;
  const t = r.mock.world.getEntity(p.radar.lockedId ?? p.radar.designatedId)!;
  const proj = new Projector();
  proj.update(r.camera, r.W, r.H);
  const sp = { x: 0, y: 0, depth: 0, front: false, onScreen: false, dirX: 0, dirY: 0, offAxis: 0 };
  proj.point(t.position, sp);
  return { x0: sp.x - 20, y0: sp.y - 28, x1: sp.x + 20, y1: sp.y + 30 };
}

beforeEach(() => {
  pcdZoom.close();
});

describe('HUD text zones: nothing piles up over the FPM / target box (i1-pres-lab-threat)', () => {
  it('threat scene: MISSILE above the FPM, SPIKE chip, the centre message dodges the FPM and TD box', () => {
    const r = rig('threat', 'hud');
    r.run(0.2);
    r.mock.events.emit('hud:message', { text: 'FIGHTS ON', tone: 'info', duration: 10 });
    const texts = r.run(0.3);
    const fpm = fpmBox(r);
    const td = tdBox(r);
    // MISSILE banner (3 inbound) sits above the flight path marker
    const missile = find(texts, /^MISSILE/);
    const L = computeLayout(makeLayout(), r.W, r.H, r.ctx.screen.safe, Math.tan(Math.PI / 6), false);
    // (it blinks: check the TTI readout next to it, drawn every frame)
    const tti = find(texts, /^\d+s$/).filter((t) => Math.abs(t.y - L.warnY) < 4);
    expect(tti.length).toBe(1);
    for (const m of missile) expect(m.y).toBeLessThan(fpm.y0);
    // the SAM tracking us in launch state → a distinct MUD SPIKE chip with the emitter symbol
    const spike = one(texts, /^MUD SPIKE 6$|^SPIKE /);
    expect(Math.abs(spike.y - L.row2Y)).toBeLessThan(2);
    // while MISSILE owns the band, low-priority centre messages wait (the pilot's eyes stay on the threat)
    expect(find(texts, 'FIGHTS ON').length).toBe(0);
    // an important one still shows — in its slot, off the FPM, the target box and the warning rows
    r.mock.events.emit('hud:message', { text: 'PRIMARY OBJECTIVE FAILED', tone: 'bad', duration: 4 });
    const t2 = r.run(0.2);
    const msg = one(t2, 'PRIMARY OBJECTIVE FAILED');
    const mb = textBox(msg);
    expect(overlaps(mb, fpm)).toBe(false);
    expect(overlaps(mb, td)).toBe(false);
    expect(mb.y0).toBeGreaterThan(L.row2Y + 8);
    // FLARES LOW is a chip in row 2, never stacked into the middle of the screen
    const flares = one(texts, 'FLARES LOW');
    expect(Math.abs(flares.y - L.row2Y)).toBeLessThan(2);
  });

  it('lock scene: the centre message dodges the FPM and the target box (never covers them)', () => {
    for (const scene of ['lock', 'aa', 'gun'] as const) {
      const r = rig(scene, 'hud');
      r.run(0.1);
      r.mock.events.emit('hud:message', { text: 'FIGHTS ON', tone: 'info', duration: 10 });
      const texts = r.run(0.3);
      const mb = textBox(one(texts, 'FIGHTS ON'));
      expect(overlaps(mb, fpmBox(r)), scene).toBe(false);
      expect(overlaps(mb, tdBox(r)), scene).toBe(false);
      // SHOOT (lock scene) and the message never overlap each other
      for (const s2 of find(texts, 'SHOOT')) expect(overlaps(textBox(s2), mb)).toBe(false);
    }
  });

  it('never stacks several centre messages: one slot, highest priority wins, the rest wait', () => {
    const r = rig('aa', 'hud');
    r.run(0.1);
    r.mock.events.emit('hud:message', { text: 'RADAR ON', tone: 'info', duration: 3 });
    r.mock.events.emit('hud:message', { text: 'OBJECTIVE COMPLETE', tone: 'good', duration: 3 });
    r.mock.events.emit('hud:message', { text: 'RETURN TO AO — 20 s', tone: 'warn', duration: 3 });
    const texts = r.run(0.2);
    expect(find(texts, 'RETURN TO AO — 20 s').length).toBe(1);
    expect(find(texts, 'OBJECTIVE COMPLETE').length).toBe(0);
    expect(find(texts, 'RADAR ON').length).toBe(0);
    // after it expires the next one shows (still one at a time)
    const later = r.run(3.2);
    expect(find(later, 'RETURN TO AO — 20 s').length).toBe(0);
    expect(find(later, 'OBJECTIVE COMPLETE').length + find(later, 'RADAR ON').length).toBe(1);
  });

  it('kill reports go to the kill feed (top-right, max 3), not the centre; mission + HUD kill lines merge', () => {
    const r = rig('aa', 'hud');
    r.run(0.1);
    const p = r.mock.player;
    const mig = r.mock.world.aircraft.find((a) => a.type === 'mig29')!;
    r.mock.events.emit('destroyed', { entity: mig, attackerId: p.id, weapon: 'aim120' });
    r.mock.events.emit('hud:message', { text: 'SPLASH MIG-29', tone: 'good', duration: 2.5 });
    let texts = r.run(0.1);
    const splash = find(texts, 'SPLASH MIG-29');
    expect(splash.length).toBe(1);
    expect(splash[0].align).toBe('right');
    // a target is designated: the target camera window owns the top-right corner, the feed sits right
    // under it (left of the DLZ scale)
    expect(pipView.vh).toBeGreaterThan(0);
    expect(splash[0].y).toBeGreaterThan(pipView.y + pipView.h);
    expect(splash[0].y).toBeLessThan(pipView.y + pipView.h + 40);
    expect(splash[0].x).toBeGreaterThan(r.W * 0.6);
    for (let i = 0; i < 4; i++) r.mock.events.emit('hud:message', { text: `HAMMER ${i}: SPLASH SU-27`, tone: 'info', duration: 2.5 });
    texts = r.run(1);
    const feed = find(texts, /SPLASH/).filter((t) => t.align === 'right');
    expect(feed.length).toBe(3);
    // none of them in the centre of the screen
    for (const t of find(texts, /SPLASH|DESTROYED/)) expect(Math.abs(t.y - r.H / 2) > 60 || t.x < r.W * 0.35).toBe(true);
  });

  it('kill feed stays in the top-right corner with the target camera off', () => {
    const r = rig('aa', 'hud', 844, 390, { targetCam: false });
    r.run(0.1);
    r.mock.events.emit('hud:message', { text: 'SPLASH MIG-29', tone: 'good', duration: 2.5 });
    const splash = find(r.run(0.1), 'SPLASH MIG-29');
    expect(splash.length).toBe(1);
    expect(pipView.vh).toBe(0);
    expect(splash[0].y).toBeLessThan(80);
    expect(splash[0].x).toBeGreaterThan(r.W * 0.6);
  });

  it('the mission title is a short top-band banner, never over the target box (i1-pres-c01-hud-t12 "DAWN PATROL")', () => {
    const r = rig('aa', 'hud');
    (r.mock.mission.def as { title?: string }).title = 'Dawn Patrol';
    r.mock.events.emit('hud:message', { text: 'DAWN PATROL', tone: 'info', duration: 4 });
    const texts = r.run(0.5);
    const L = computeLayout(makeLayout(), r.W, r.H, r.ctx.screen.safe, Math.tan(Math.PI / 6), false);
    const title = one(texts, 'DAWN PATROL');
    expect(title.y).toBeCloseTo(L.warnY, 0);
    expect(overlaps(textBox(title), tdBox(r))).toBe(false);
    // gone after ~3.5 s
    expect(find(r.run(4), 'DAWN PATROL').length).toBe(0);
  });

  it('the tutorial hint lives in the top-left column, outside the pitch-ladder window (i1-pres-dusk-chase-cbd)', () => {
    const r = rig('aa', 'hud');
    const texts = r.run(0.3);
    const hint = find(texts, /target box|TGT/i);
    expect(hint.length).toBeGreaterThan(0);
    for (const h of hint) {
      const b = textBox(h);
      expect(b.x1).toBeLessThan(r.W * 0.34);
      expect(b.y1).toBeLessThan(r.H / 2);
    }
  });
});

describe('warning band priorities', () => {
  it('PULL UP owns row 1 and holds low-priority centre messages back', () => {
    const r = rig('pullup', 'hud');
    r.run(0.1);
    r.mock.events.emit('hud:message', { text: 'RADAR ON', tone: 'info', duration: 3 });
    const L = computeLayout(makeLayout(), r.W, r.H, r.ctx.screen.safe, Math.tan(Math.PI / 6), false);
    let pull = 0;
    let radar = 0;
    for (let i = 0; i < 20; i++) {
      const t = r.run(1 / 20, 1 / 20);
      for (const x of find(t, 'PULL UP')) {
        pull++;
        expect(Math.abs(x.y - L.warnY)).toBeLessThan(2);
      }
      radar += find(t, 'RADAR ON').length;
    }
    expect(pull).toBeGreaterThan(5);
    expect(radar).toBe(0);
  });

  it('a hud:message repeating a warning (ENGINE FIRE) is not shown twice', () => {
    const r = rig('damage', 'hud');
    r.run(0.1);
    r.mock.events.emit('hud:message', { text: 'ENGINE FIRE', tone: 'bad', duration: 5 });
    for (let i = 0; i < 20; i++) expect(find(r.run(1 / 20, 1 / 20), 'ENGINE FIRE').length).toBeLessThanOrEqual(1);
  });

  it('gun: SHOOT sits in the cue slot, never on the target box the pipper tracks (i1-pres-lab-gun)', () => {
    const r = rig('gun', 'hud');
    r.mock.player.radar.lockedId = r.mock.player.radar.designatedId;
    const combat = r.mock.world.combat as unknown as { launchZone: (...a: unknown[]) => { shoot: boolean } | null };
    const orig = combat.launchZone;
    combat.launchZone = (...a: unknown[]) => {
      const z = orig(...a);
      return z ? { ...z, shoot: true } : z;
    };
    let seen = 0;
    for (let i = 0; i < 20; i++) {
      const t = r.run(1 / 20, 1 / 20);
      for (const s2 of find(t, 'SHOOT')) {
        seen++;
        expect(overlaps(textBox(s2), tdBox(r))).toBe(false);
      }
    }
    expect(seen).toBeGreaterThan(3);
  });
});

describe('cockpit look-down (i1-pres-lab-damage-pcd: warning tags over the ICAWS / TSD pages)', () => {
  function lookDown(r: Rig, deg: number) {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (-deg * Math.PI) / 180);
    r.camera.quaternion.copy(r.mock.player.quaternion).multiply(q);
    r.camera.updateMatrixWorld();
  }
  it('non-critical warnings and chips fade out while looking down at the PCD', () => {
    const r = rig('damage', 'cockpit');
    lookDown(r, 24);
    const texts = r.run(0.3);
    for (const label of ['OVER-G', 'HYDRAULICS', 'BINGO', 'DAMAGE', 'ENGINE FIRE']) {
      for (const t of find(texts, label)) expect(t.alpha, label).toBeLessThan(0.1);
    }
    // no conformal symbology on the panel either (clipped at the glare shield + faded)
    for (const t of texts) if (/^MIG-29$|^WP2 CAP$/.test(t.text)) expect(t.alpha).toBeLessThan(0.1);
  });
  it('life-critical MISSILE stays at full strength while looking down', () => {
    const r = rig('threat', 'cockpit');
    lookDown(r, 24);
    let seen = 0;
    for (let i = 0; i < 10; i++) for (const t of find(r.run(1 / 20, 1 / 20), /^MISSILE/)) {
      seen++;
      expect(t.alpha).toBeGreaterThan(0.9);
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('missile defeat feedback (samstats: warning on 40 s after every missile was defeated)', () => {
  function withIncoming() {
    const r = rig('aa', 'hud');
    const p = r.mock.player;
    const su = r.mock.world.aircraft.find((a) => a.type === 'su35')!;
    const def = { ...((r.mock.world.missiles[0] ?? { def: null }).def ?? {}), id: 'r77', name: 'R-77', short: 'R-77', category: 'aam', guidance: 'active_radar' } as MissileEntity['def'];
    const m = new MissileEntity(900, def, 'red', su.id, p.id);
    m.position.copy(p.position).add(new Vector3(3000, 0, 0));
    (r.mock.world.missiles as MissileEntity[]).push(m);
    const byId = r.mock.world.getEntity;
    (r.mock.world as { getEntity: (id: number | null | undefined) => unknown }).getEntity = (id) => (id === 900 ? m : byId(id));
    p.incoming = [{ missileId: 900, bearing: 1.2, elevation: 0, distance: 3000, timeToImpact: 6, guidance: 'radar' }];
    p.warnings.add('missile');
    return { r, m, p };
  }

  it('shows MISSILE DEFEATED at once when the inbound missile is decoyed (munition:end)', () => {
    const { r, m, p } = withIncoming();
    let texts = r.run(0.3);
    expect(find(texts, 'MISSILE DEFEATED').length).toBe(0);
    // decoyed: MAWS drops it, the missile self-destructs
    p.incoming = [];
    p.warnings.delete('missile');
    m.alive = false;
    r.mock.events.emit('munition:end', { missile: m, position: m.position, reason: 'decoyed', targetId: p.id });
    texts = r.run(1 / 30);
    expect(find(texts, 'MISSILE DEFEATED').length).toBe(1);
    expect(find(texts, /^MISSILE( ×\d)?$/).length).toBe(0);
    // gone after ~2 s
    expect(find(r.run(2.2), 'MISSILE DEFEATED').length).toBe(0);
  });

  it('shows MISSILE DEFEATED when a still-flying missile drops off the warning (guidance broken / notched)', () => {
    const { r, p } = withIncoming();
    r.run(0.3);
    p.incoming = [];
    p.warnings.delete('missile');
    let texts = r.run(0.1);
    expect(find(texts, 'MISSILE DEFEATED').length).toBe(0); // debounce (re-acquisition guard)
    texts = r.run(0.3);
    expect(find(texts, 'MISSILE DEFEATED').length).toBe(1);
  });

  it('a hit is never reported as defeated', () => {
    const { r, m, p } = withIncoming();
    r.run(0.3);
    p.incoming = [];
    m.alive = false;
    r.mock.events.emit('munition:end', { missile: m, position: m.position, reason: 'proximity', targetId: p.id });
    expect(find(r.run(1), 'MISSILE DEFEATED').length).toBe(0);
  });
});

describe('radar lock cue: ±30° cone + LOCKING', () => {
  it('draws the ±30° lock cone around the nose while designated-not-locked, and LOCKING while it builds', () => {
    const r = rig('aa', 'hud');
    let seen = false;
    for (let i = 0; i < 20 && !seen; i++) seen = find(r.run(0.1), 'LOCKING').length > 0;
    expect(seen).toBe(true);
    const proj = new Projector();
    proj.update(r.camera, r.W, r.H);
    const expectR = proj.pxPerRad * Math.tan(PLAYER_LOCK_CONE);
    const cone = r.fake.arcs.filter((a) => a.dashed && Math.abs(a.r - expectR) / expectR < 0.12);
    expect(cone.length).toBeGreaterThan(0);
    // no cone once locked
    r.mock.player.radar.lockedId = r.mock.player.radar.designatedId;
    r.run(0.1);
    expect(r.fake.arcs.filter((a) => a.dashed && Math.abs(a.r - expectR) / expectR < 0.12).length).toBe(0);
  });
});

describe('radio subtitles: paged (never truncated), 2 lines max, placed clear of controls / PCD', () => {
  const long =
    'Viper 1, Darkstar. Raid of three Backfires, bullseye zero four five for forty, angels thirty, hot, fast. If they get within seven kilometres of the city they will launch. Commit, commit, commit.';

  function collect(r: Rig, seconds: number): { lines: Set<string>; maxLines: number; boxes: Box[] } {
    const lines = new Set<string>();
    let maxLines = 0;
    const boxes: Box[] = [];
    const dt = 1 / 20;
    for (let t = 0; t < seconds; t += dt) {
      const texts = r.run(dt, dt);
      const radio = texts.filter((x) => x.size <= 12.5 && x.align === 'left' && /[a-z]/.test(x.text) && x.color.startsWith('rgba(240'));
      const withHead = texts.filter((x) => x.text === '[DARKSTAR]');
      const all = [...withHead, ...radio];
      maxLines = Math.max(maxLines, new Set(all.map((x) => Math.round(x.y))).size);
      for (const x of all) {
        lines.add(x.text);
        boxes.push(textBox(x));
      }
    }
    return { lines, maxLines, boxes };
  }

  it('shows the whole long raid call (c05 punchline) in pages of at most two lines', () => {
    const r = rig('nav', 'hud');
    r.mock.events.emit('radio', { from: 'DARKSTAR', text: long, priority: 1, team: 'blue' });
    const { lines, maxLines } = collect(r, 14);
    const joined = [...lines].join(' ');
    expect(joined).toContain('Commit, commit, commit.');
    expect(joined).toContain('they will launch.');
    expect(maxLines).toBeLessThanOrEqual(2);
  });

  it('bottom band sits between the throttle cluster and the stick (667x375 and left-handed too)', () => {
    for (const [W, H, lh] of [
      [844, 390, false],
      [667, 375, false],
      [844, 390, true],
    ] as const) {
      const r = rig('nav', 'hud', W, H, { leftHanded: lh });
      r.mock.events.emit('radio', { from: 'DARKSTAR', text: long, priority: 1, team: 'blue' });
      const { boxes } = collect(r, 2);
      const t = computeTouchLayout(W, H, { top: 0, left: 0, right: 0, bottom: 0 }, { leftHanded: lh });
      const b = t.buttons;
      const ctl = [t.throttle, b.fire, b.gun, b.cms].map((c) => ({ x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h }));
      ctl.push({ x0: t.stickHome.x - t.stickRadius, y0: t.stickHome.y - t.stickRadius, x1: t.stickHome.x + t.stickRadius, y1: t.stickHome.y + t.stickRadius });
      expect(boxes.length).toBeGreaterThan(0);
      for (const bx of boxes) {
        for (const c of ctl) expect(overlaps(bx, c), `${W}x${H} lh=${lh}`).toBe(false);
        expect(bx.y1).toBeLessThanOrEqual(H);
      }
    }
  });

  it('cockpit view: subtitles go above the glare shield, never over the PCD (i1-pres-c01-cockpit-t12)', () => {
    const r = rig('nav', 'cockpit');
    r.mock.events.emit('radio', { from: 'DARKSTAR', text: long, priority: 1, team: 'blue' });
    const { boxes } = collect(r, 3);
    const pcd = pcdScreenRect(60, r.W, r.H);
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) expect(b.y1).toBeLessThan(pcd.top - 60);
  });
});

describe('objectives: compact, shown after changes, never cut mid-word (i1-pres-c01-hud-t12 "NORT.")', () => {
  it('wraps "Keep the MiGs off the North Shore" at word boundaries', () => {
    const r = rig('aa', 'hud');
    r.run(0.1);
    r.mock.events.emit('objective', { id: 'o3', label: 'Keep the MiGs off the North Shore', state: 'complete' });
    const texts = r.run(0.2);
    const lines = texts.filter((t) => /^(\+|>|-|x| ) /.test(t.text)).map((t) => t.text.slice(2).trim());
    const joined = lines.join(' ');
    expect(joined).toContain('KEEP THE MIGS OFF THE NORTH SHORE');
    for (const l of lines) expect(l).not.toMatch(/\.$/);
    // and they go away again
    expect(r.run(7).filter((t) => t.text === 'OBJECTIVES').length).toBe(0);
  });
});

describe('tactical MAP view: a real north-up map with range rings, labels, SAM rings, legend and tap zoom', () => {
  it('draws the map furniture and labelled contacts, and a tap on empty map cycles 10/20/40 km', () => {
    const r = rig('aa', 'tactical');
    let texts = r.run(0.1);
    one(texts, /^TACTICAL MAP {2}\d+ KM$/);
    one(texts, 'N');
    one(texts, /^\d+ km$/);
    one(texts, 'SAM THREAT RING');
    one(texts, /^SA-6/);
    one(texts, /^MIG-29 A\d+$/); // hostile with type + angels
    one(texts, /^VIPER 2 A\d+$/); // datalinked friendly
    const t0 = one(texts, /^TACTICAL MAP/).text;
    // tap on an empty corner of the map → next range
    expect(r.hud.pick(r.W / 2 + 5, r.H - 30)).toBeNull();
    texts = r.run(0.1);
    const t1 = one(texts, /^TACTICAL MAP/).text;
    expect(t1).not.toBe(t0);
    // three taps come back round
    r.hud.pick(r.W / 2 + 5, r.H - 30);
    r.hud.pick(r.W / 2 + 5, r.H - 30);
    texts = r.run(0.1);
    expect(one(texts, /^TACTICAL MAP/).text).toBe(t0);
  });

  it('a tap on a contact designates it (returns its id) instead of zooming', () => {
    const r = rig('aa', 'tactical');
    const texts = r.run(0.1);
    const lbl = one(texts, /^MIG-29 A\d+$/);
    const mig = r.mock.world.aircraft.find((a) => a.type === 'mig29')!;
    // the label sits next to the symbol: tap at the symbol (label anchor minus the offset)
    const x = lbl.align === 'left' ? lbl.x - 10 : lbl.align === 'right' ? lbl.x + 10 : lbl.x;
    const y = lbl.align === 'center' ? lbl.y - 14 : lbl.y;
    expect(r.hud.pick(x, y)).toBe(mig.id);
  });
});

describe('cockpit PCD zoom overlay', () => {
  it('draws the zoomed page large with tabs, and lays out tab hit boxes', () => {
    const r = rig('aa', 'cockpit');
    r.run(0.1);
    pcdZoom.openPortal(1, ['TSD', 'RDR'], 0);
    const texts = r.run(0.1);
    // page content at a readable size (≥ 12 CSS px for the TSD readouts)
    const hdg = one(texts, /^HDG \d{3}$/);
    expect(hdg.size).toBeGreaterThanOrEqual(12);
    one(texts, 'TSD');
    one(texts, 'RDR');
    expect(pcdZoom.tabCount).toBe(2);
    const tab = pcdZoom.tabs[1];
    expect(pcdZoom.tabAt(tab.x + tab.w / 2, tab.y + tab.h / 2)).toBe(1);
    // the overlay stays inside the free band between the touch clusters
    const t = computeTouchLayout(r.W, r.H, { top: 0, left: 0, right: 0, bottom: 0 }, { leftHanded: false });
    expect(pcdZoom.rect.x).toBeGreaterThanOrEqual(t.buttons.cms.x + t.buttons.cms.w);
    expect(pcdZoom.rect.x + pcdZoom.rect.w).toBeLessThanOrEqual(t.stickHome.x - t.stickRadius);
    // HUD taps are swallowed while it is open
    expect(r.hud.pick(r.W / 2, r.H / 2)).toBeNull();
  });
});

describe('external views', () => {
  it('chase: centre messages stay off the jet', () => {
    const r = rig('aa', 'chase');
    r.run(0.1);
    r.mock.events.emit('hud:message', { text: 'NEW OBJECTIVE: KEEP THE MIGS OFF THE NORTH SHORE', tone: 'info', duration: 10 });
    const texts = r.run(0.2);
    const proj = new Projector();
    proj.update(r.camera, r.W, r.H);
    const sp = { x: 0, y: 0, depth: 0, front: false, onScreen: false, dirX: 0, dirY: 0, offAxis: 0 };
    proj.point(r.mock.player.position, sp);
    const jet: Box = { x0: sp.x - 60, y0: sp.y - 25, x1: sp.x + 60, y1: sp.y + 15 };
    const msg = find(texts, /NEW OBJECTIVE|NORTH SHORE/);
    expect(msg.length).toBeGreaterThan(0);
    for (const m of msg) expect(overlaps(textBox(m), jet)).toBe(false);
  });

  it('chase: the missile threat ring moves to the radar inset (not over the jet in the centre)', () => {
    const r = rig('threat', 'chase');
    r.run(0.3);
    const L = computeLayout(makeLayout(), r.W, r.H, r.ctx.screen.safe, Math.tan(Math.PI / 6), false, { external: true });
    const centreRings = r.fake.arcs.filter((a) => a.dashed && Math.hypot(a.x - r.W / 2, a.y - r.H / 2) < 30 && a.r > 40);
    expect(centreRings.length).toBe(0);
    // time-to-impact readouts sit around the inset
    const tti = r.fake.texts.filter((t) => /^\d+$/.test(t.text) && Math.hypot(t.x - L.insetCx, t.y - L.insetCy) < L.insetR + 10);
    expect(tti.length).toBeGreaterThan(0);
  });
});


/** Every text drawn over `seconds` (blinking cues are only on screen part of the time). */
function textsOver(r: Rig, seconds: number): TextRec[] {
  const all: TextRec[] = [];
  for (let i = 0; i < Math.round(seconds * 30); i++) all.push(...r.run(1 / 30));
  return all;
}

describe('bomb release cue in every view (playtest 1.3-a: none in the default chase view)', () => {
  const views: CameraMode[] = ['chase', 'orbit', 'flyby', 'hud', 'cockpit'];

  it('REL n counts down to the release in chase as in the HMD views', () => {
    for (const v of views) {
      const r = rig('ag', v);
      const rel = find(textsOver(r, 0.5), /^REL \d+$/);
      expect(rel.length, v).toBeGreaterThan(0);
      expect(rel[0].size, v).toBeGreaterThanOrEqual(15);
    }
  });

  it('IN RANGE (the briefings\' word) shows in chase, off the jet and clear of the info block and inset (844x390)', () => {
    for (const v of views) {
      const r = rig('ag', v);
      const ship = r.mock.world.ground.find((g) => g.type === 'ship')!;
      (r.mock.world.combat as { bombImpactPoint: unknown }).bombImpactPoint = () => ({ point: ship.position.clone(), inRange: true, timeToRelease: 0 });
      const texts = textsOver(r, 1);
      expect(find(texts, 'IN RNG').length, v).toBe(0);
      const cue = find(texts, 'IN RANGE');
      expect(cue.length, v).toBeGreaterThan(0);
      if (v !== 'chase') continue;
      const box = textBox(cue[0]);
      expect(box.x0).toBeGreaterThan(0);
      expect(box.x1).toBeLessThan(r.W);
      const proj = new Projector();
      proj.update(r.camera, r.W, r.H);
      const sp = { x: 0, y: 0, depth: 0, front: false, onScreen: false, dirX: 0, dirY: 0, offAxis: 0 };
      proj.point(r.mock.player.position, sp);
      expect(overlaps(box, { x0: sp.x - 60, y0: sp.y - 25, x1: sp.x + 60, y1: sp.y + 15 })).toBe(false);
      // the compact info block (speed / alt / weapon / target, the AMRAAM mini-DLZ row) and the inset
      const L = computeLayout(makeLayout(), r.W, r.H, r.ctx.screen.safe, Math.tan(Math.PI / 6), false, { external: true });
      for (const t of r.run(1 / 30)) {
        if (t.x > L.extX + 210 || t.text === 'IN RANGE') continue;
        expect(overlaps(box, textBox(t)), t.text).toBe(false);
      }
      expect(box.x1).toBeLessThan(L.insetCx - L.insetR);
    }
  });

  it('IN RANGE never prints over a contact box near the boresight (playtest 2.2-a: "IN□RANGE")', () => {
    const r = rig('ag', 'hud');
    const ship = r.mock.world.ground.find((g) => g.type === 'ship')!;
    (r.mock.world.combat as { bombImpactPoint: unknown }).bombImpactPoint = () => ({ point: ship.position.clone(), inRange: true, timeToRelease: 0 });
    const free = textBox(one(textsOver(r, 1), 'IN RANGE'));
    // a bandit right where the cue would go (the contact box is drawn after the cue is planned)
    const mig = r.mock.world.aircraft.find((a) => a.type === 'mig29')!;
    const at = new Vector3(((free.x0 + free.x1) / 2 / r.W) * 2 - 1, -((((free.y0 + free.y1) / 2) / r.H) * 2 - 1), 0.5).unproject(r.camera);
    const pos = r.camera.position.clone().add(at.sub(r.camera.position).normalize().multiplyScalar(8000));
    const c = r.mock.player.radar.contacts.find((k) => k.id === mig.id)!;
    const proj = new Projector();
    proj.update(r.camera, r.W, r.H);
    const sp = { x: 0, y: 0, depth: 0, front: false, onScreen: false, dirX: 0, dirY: 0, offAxis: 0 };
    let seen = 0;
    for (let i = 0; i < 30; i++) {
      mig.position.copy(pos);
      c.position.copy(pos);
      const cue = find(r.run(1 / 30), 'IN RANGE');
      proj.point(mig.position, sp);
      for (const t of cue) {
        seen++;
        expect(overlaps(textBox(t), { x0: sp.x - 8, y0: sp.y - 8, x1: sp.x + 8, y1: sp.y + 8 })).toBe(false);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(Math.abs(sp.x - (free.x0 + free.x1) / 2)).toBeLessThan(4);
  });

  it('a bomb in flight shows TTI n at its target, on screen and from the off-screen cue (playtest 2.2-e)', () => {
    for (const v of ['hud', 'chase'] as const) {
      for (const behind of [false, true]) {
        const r = rig('ag', v);
        const p = r.mock.player;
        const ship = r.mock.world.ground.find((g) => g.type === 'ship')!;
        // (a StormBreaker gliding in from 14 km: 9 km to go at ~190 m/s)
        if (behind) ship.position.copy(p.position).add(new Vector3(0, 0, 9000).applyQuaternion(p.quaternion)).setY(0);
        const def = { ...((r.mock.world.missiles[0] ?? { def: null }).def ?? {}), id: 'gbu53', name: 'GBU-53/B', short: 'GBU-53', category: 'bomb', guidance: 'tri_mode' } as MissileEntity['def'];
        const m = new MissileEntity(901, def, 'blue', p.id, ship.id);
        m.position.copy(ship.position).add(new Vector3(0, 3000, 0)).addScaledVector(new Vector3().subVectors(p.position, ship.position).setY(0).normalize(), 8500);
        m.velocity.subVectors(ship.position, m.position).setLength(190);
        (r.mock.world.missiles as MissileEntity[]).push(m);
        const tti = find(r.run(0.1), /^TTI \d+$/);
        expect(tti.length, `${v} ${behind ? 'off-screen' : 'on screen'}`).toBe(1);
        const s = Number(tti[0].text.slice(4));
        expect(s).toBeGreaterThan(40);
        expect(s).toBeLessThan(55);
        // a missile keeps its M n
        expect(find(r.run(0.1), /^M \d+$/).length).toBe(0);
      }
    }
  });

  it('the AMRAAM SHOOT cue and its mini DLZ still work in chase', () => {
    const r = rig('lock', 'chase');
    expect(find(textsOver(r, 0.5), 'SHOOT').length).toBeGreaterThan(0);
  });
});

describe('the radio pill is reserved before the target box labels and the centre message (playtest 3.3-a / 3.3-b)', () => {
  const call = 'Viper 1, Darkstar, single group, bullseye zero four five, 13 miles, hot, closing on the ship.';

  /** The radio pill's text rows (head + body lines), as one box; null without a call up. */
  function pillBox(texts: TextRec[]): Box | null {
    const rows = texts.filter((x) => x.text === '[DARKSTAR]' || (x.size <= 12.5 && x.align === 'left' && /[a-z]/.test(x.text) && x.color.startsWith('rgba(240')));
    if (!rows.length) return null;
    const b = rows.map(textBox);
    return { x0: Math.min(...b.map((k) => k.x0)), y0: Math.min(...b.map((k) => k.y0)), x1: Math.max(...b.map((k) => k.x1)), y1: Math.max(...b.map((k) => k.y1)) };
  }

  it('hud: a target box low on screen moves its range / TTI labels off the radio pill (3.3-a)', () => {
    const r = rig('ag', 'hud');
    r.mock.events.emit('radio', { from: 'DARKSTAR', text: call, priority: 1, team: 'blue' });
    const pill0 = pillBox(r.run(0.1));
    expect(pill0).not.toBeNull();
    // the ship just above the pill (a bomb run-in): its labels below the box would print into the call
    const p = r.mock.player;
    const ship = r.mock.world.ground.find((g) => g.type === 'ship')!;
    const ty = pill0!.y0 - 22;
    const at = new Vector3(0, -((ty / r.H) * 2 - 1), 0.5).unproject(r.camera);
    const pos = r.camera.position.clone().add(at.sub(r.camera.position).normalize().multiplyScalar(9000));
    const def = { ...((r.mock.world.missiles[0] ?? { def: null }).def ?? {}), id: 'gbu53', name: 'GBU-53/B', short: 'GBU-53', category: 'bomb', guidance: 'tri_mode' } as MissileEntity['def'];
    const m = new MissileEntity(901, def, 'blue', p.id, ship.id);
    (r.mock.world.missiles as MissileEntity[]).push(m);
    const proj = new Projector();
    proj.update(r.camera, r.W, r.H);
    const sp = { x: 0, y: 0, depth: 0, front: false, onScreen: false, dirX: 0, dirY: 0, offAxis: 0 };
    let seen = 0;
    for (let i = 0; i < 10; i++) {
      ship.position.copy(pos);
      m.position.copy(pos).add(new Vector3(0, 3000, 0)).addScaledVector(new Vector3().subVectors(p.position, pos).setY(0).normalize(), 8500);
      m.velocity.subVectors(pos, m.position).setLength(190);
      const texts = r.run(1 / 30);
      const pill = pillBox(texts);
      expect(pill).not.toBeNull();
      proj.point(ship.position, sp);
      expect(Math.abs(sp.y - ty)).toBeLessThan(2);
      const labels = [...find(texts, /^TTI \d+$/), ...texts.filter((t) => /^\d+(\.\d)?$/.test(t.text) && t.size === 12.5 && Math.abs(t.x - sp.x) < 1)];
      expect(labels.length).toBe(2);
      for (const t of labels) {
        seen++;
        expect(overlaps(textBox(t), pill!), t.text).toBe(false);
      }
    }
    expect(seen).toBe(20);
  });

  it('chase: OBJECTIVE COMPLETE never prints on the rows of the radio pill (3.3-b)', () => {
    for (const scene of ['aa', 'ag', 'nav'] as const) {
      const r = rig(scene, 'chase');
      r.run(0.1);
      r.mock.events.emit('radio', { from: 'DARKSTAR', text: call, priority: 1, team: 'blue' });
      r.mock.events.emit('hud:message', { text: 'OBJECTIVE COMPLETE', tone: 'good', duration: 4 });
      let seen = 0;
      for (let i = 0; i < 15; i++) {
        const texts = r.run(1 / 30);
        const pill = pillBox(texts);
        expect(pill, scene).not.toBeNull();
        for (const t of find(texts, /OBJECTIVE|COMPLETE/)) {
          seen++;
          expect(overlaps(textBox(t), pill!), `${scene}: ${t.text}`).toBe(false);
        }
      }
      expect(seen, scene).toBeGreaterThan(0);
    }
  });
});

/** Defend-style mission on the mock: friendly fuel tanks ahead and a protect objective on them. */
function addDefendSite(r: Rig, ahead = 20_000, right = 0, n = 9): GroundTargetEntity[] {
  const p = r.mock.player;
  const fwd = new Vector3(0, 0, -1).applyQuaternion(p.quaternion).setY(0).normalize();
  const rt = new Vector3(-fwd.z, 0, fwd.x);
  const c = p.position.clone().addScaledVector(fwd, ahead).addScaledVector(rt, right).setY(0);
  const tanks: GroundTargetEntity[] = [];
  for (let i = 0; i < n; i++) {
    const t = new GroundTargetEntity(9000 + i, 'fuel', 'blue', { name: 'Fuel Tank', radius: 20 });
    t.groupId = 'wiri';
    t.position.set(c.x + ((i % 3) - 1) * 90, 0, c.z + (Math.floor(i / 3) - 1) * 90);
    r.mock.world.ground.push(t);
    tanks.push(t);
  }
  const def = r.mock.mission.def as unknown as { script: unknown };
  def.script = {
    objectives: [
      { id: 'o_tanks', kind: 'protect', group: 'wiri', minSurvivors: 6, label: 'Keep at least 6 of the 9 fuel tanks standing', primary: true },
      { id: 'o_all', kind: 'protect', group: 'wiri', minSurvivors: 9, label: 'Save all 9 tanks', primary: false },
    ],
  };
  r.mock.mission.objectives.push(
    { id: 'o_tanks', label: 'Keep at least 6 of the 9 fuel tanks standing', state: 'active', primary: true, progress: { done: n, total: n } },
    { id: 'o_all', label: 'Save all 9 tanks', state: 'active', primary: false, progress: { done: n, total: n } },
  );
  return tanks;
}

describe('the defended site is marked (playtest 1.3-b / 1.2-b: Defend never showed the Wiri tanks)', () => {
  const friend = paletteFor('green').friend;

  it('tactical map: a friendly DEFEND n/m symbol, counting the survivors, that a tap never designates', () => {
    const r = rig('nav', 'tactical');
    const tanks = addDefendSite(r);
    const lbl = one(r.run(0.1), 'DEFEND 9/9');
    expect(lbl.color).toBe(friend);
    // the label sits next to the symbol: a tap there zooms the map, it never returns a tank
    const ids = new Set(tanks.map((t) => t.id));
    for (const [dx, dy] of [[-10, 0], [10, 0], [0, -14], [0, 16]]) expect(ids.has(r.hud.pick(lbl.x + dx, lbl.y + dy) ?? -1)).toBe(false);
    // a tank lost: the count follows (dead entities leave world.ground on the next cleanup)
    tanks[0].alive = false;
    r.mock.world.ground.splice(r.mock.world.ground.indexOf(tanks[0]), 1);
    one(r.run(0.1), 'DEFEND 8/9');
  });

  it('HMD and chase: the site is marked in the friendly colour', () => {
    for (const v of ['hud', 'chase'] as const) {
      const r = rig('nav', v);
      // (off to the side: in chase a label never lands on the jet itself)
      addDefendSite(r, 20_000, 6_000);
      const lbl = find(r.run(0.1), 'DEFEND 9/9');
      expect(lbl.length, v).toBe(1);
      expect(lbl[0].color, v).toBe(friend);
    }
  });

  it('TSD: labelled on the zoomed PCD page, a symbol on the chase radar inset', () => {
    const r = rig('nav', 'cockpit');
    addDefendSite(r, 12_000);
    r.run(0.1);
    pcdZoom.openPortal(1, ['TSD'], 0);
    one(r.run(0.1), 'DEFEND 9/9');
    pcdZoom.close();
    // the inset has no labels: compare its circles with and without the protect objective
    const inInset = (q: Rig) => {
      const L = computeLayout(makeLayout(), q.W, q.H, q.ctx.screen.safe, Math.tan(Math.PI / 6), false, { external: true });
      q.run(0.1);
      return q.fake.arcs.filter((a) => Math.hypot(a.x - L.insetCx, a.y - L.insetCy) < L.insetR && a.r > 3 && a.r < 6).length;
    };
    const without = rig('nav', 'chase');
    const withSite = rig('nav', 'chase');
    addDefendSite(withSite);
    expect(inInset(withSite)).toBe(inInset(without) + 1);
  });

  it('chase: a site behind the jet slides off it and keeps its DEFEND n/m label (playtest 2.2-b)', () => {
    const r = rig('nav', 'chase');
    const p = r.mock.player;
    const proj = new Projector();
    proj.update(r.camera, r.W, r.H);
    const sp = { x: 0, y: 0, depth: 0, front: false, onScreen: false, dirX: 0, dirY: 0, offAxis: 0 };
    proj.point(p.position, sp);
    const jet = { x0: sp.x - 60, y0: sp.y - 25, x1: sp.x + 60, y1: sp.y + 15 };
    // the ground point seen just right of the jet's centre (its right wing)
    const ray = new Vector3(((sp.x + 14) / r.W) * 2 - 1, -((sp.y / r.H) * 2 - 1), 0.5).unproject(r.camera).sub(r.camera.position).normalize();
    const g = r.camera.position.clone().addScaledVector(ray, -r.camera.position.y / ray.y);
    const fwd = new Vector3(0, 0, -1).applyQuaternion(p.quaternion).setY(0).normalize();
    const rt = new Vector3(-fwd.z, 0, fwd.x);
    const rel = g.clone().sub(p.position).setY(0);
    addDefendSite(r, rel.dot(fwd), rel.dot(rt));
    const texts = r.run(0.1);
    const lbl = one(texts, 'DEFEND 9/9');
    expect(overlaps(textBox(lbl), jet)).toBe(false);
    // the symbol (r 7 circle) is drawn, off the jet
    const sym = r.fake.arcs.filter((a) => Math.abs(a.r - 7) < 0.6 && Math.hypot(a.x - sp.x, a.y - sp.y) < 200);
    expect(sym.length).toBe(1);
    expect(overlaps({ x0: sym[0].x - 7, y0: sym[0].y - 7, x1: sym[0].x + 7, y1: sym[0].y + 7 }, jet)).toBe(false);
    // and the radar inset carries the count when the site is on it
    const near = rig('nav', 'chase');
    addDefendSite(near, 14_000, 5_000);
    const L = computeLayout(makeLayout(), near.W, near.H, near.ctx.screen.safe, Math.tan(Math.PI / 6), false, { external: true });
    const inset = one(near.run(0.1), '9/9');
    expect(Math.hypot(inset.x - L.insetCx, inset.y - L.insetCy)).toBeLessThan(L.insetR);
  });

  it('tactical map legend: a DEFEND row only when there is a site, and the panel grows to fit it (playtest 2.2-i)', () => {
    const entry = /^DEFEND n\/m/;
    expect(find(rig('nav', 'tactical').run(0.1), entry).length).toBe(0);
    const r = rig('nav', 'tactical');
    addDefendSite(r);
    const texts = r.run(0.1);
    const row = one(texts, entry);
    expect(row.color).toBe(friend);
    // below FRIENDLY, above the scale bar and the tap hint, which stay inside the panel above OBJECTIVES
    expect(row.y).toBeGreaterThan(one(texts, 'FRIENDLY (DATALINK)').y);
    const hint = one(texts, /^TAP MAP/);
    expect(hint.y).toBeGreaterThan(row.y);
    expect(one(texts, 'OBJECTIVES').y).toBeGreaterThan(hint.y + 10);
  });

  it('only our own team\'s protected ground groups are sites', () => {
    const r = rig('nav', 'tactical');
    for (const t of addDefendSite(r)) t.team = 'red';
    expect(find(r.run(0.1), /^DEFEND/).length).toBe(0);
  });
});

describe('objectives list: primaries first, bonus objectives under BONUS (playtest 1.3-c / 1.3-d)', () => {
  const pal = paletteFor('green');
  /** Objective lines of the compact list, in draw order (state mark + text). */
  const objLines = (texts: TextRec[]) => texts.filter((t) => t.text === 'BONUS' || /^(\+|>|-|x| ) /.test(t.text)).sort((a, b) => a.y - b.y);

  it('a secondary that just changed waits below the primaries', () => {
    const r = rig('nav', 'chase');
    r.mock.mission.objectives.push({ id: 'o4', label: 'Splash the escort', state: 'active', primary: false, progress: { done: 0, total: 2 } });
    r.run(0.1);
    r.mock.events.emit('objective', { id: 'o4', label: 'Splash the escort', state: 'active' });
    const lines = objLines(r.run(0.2));
    expect(lines[0].text).toMatch(/^> SPLASH THE MIG-29 SWEEP/);
    const bonus = lines.findIndex((l) => l.text === 'BONUS');
    const escort = lines.findIndex((l) => /SPLASH THE ESCORT/.test(l.text));
    const primary = lines.findIndex((l) => /RANGITOTO/.test(l.text));
    expect(bonus).toBeGreaterThan(primary);
    expect(escort).toBe(bonus + 1);
  });

  it('a failed bonus never tops the list and is not drawn in the alarm red', () => {
    const r = rig('nav', 'hud');
    addDefendSite(r);
    r.run(0.1);
    const all = r.mock.mission.objectives.find((o) => o.id === 'o_all')!;
    all.state = 'failed';
    r.mock.events.emit('objective', { id: 'o_all', label: all.label, state: 'failed' });
    const lines = objLines(r.run(0.2));
    expect(lines[0].text).toMatch(/^> /);
    expect(lines[0].text).not.toMatch(/SAVE ALL/);
    const failed = one(lines, /^x SAVE ALL 9 TANKS/);
    expect(failed.color).not.toBe(pal.danger);
    expect(failed.y).toBeGreaterThan(one(lines, 'BONUS').y);
  });

  it('at mission end the settled primaries still lead the list (playtest 2.2-c: BONUS came first)', () => {
    for (const end of ['failed', 'complete'] as const) {
      const r = rig('nav', 'chase');
      const objs = r.mock.mission.objectives;
      objs.push({ id: 'o4', label: 'Splash the escort', state: 'active', primary: false, progress: { done: 1, total: 2 } });
      r.run(0.1);
      for (const o of objs) if (o.primary) o.state = end;
      objs.find((o) => o.id === 'o4')!.state = end === 'failed' ? 'failed' : 'active';
      r.mock.events.emit('objective', { id: 'o4', label: 'Splash the escort', state: 'failed' });
      const lines = objLines(r.run(0.2));
      expect(lines[0].text, end).toMatch(end === 'failed' ? /^x SPLASH THE MIG-29 SWEEP/ : /^\+ SPLASH THE MIG-29 SWEEP/);
      expect(lines[0].color, end).toBe(end === 'failed' ? pal.danger : pal.good);
      const bonus = lines.findIndex((l) => l.text === 'BONUS');
      expect(bonus, end).toBeGreaterThan(lines.findIndex((l) => /RANGITOTO/.test(l.text)));
      expect(lines[bonus + 1].text, end).toMatch(/SPLASH THE ESCORT 1\/2/);
    }
  });
});

describe('bomb release cue: STEER gives a direction, BOMB AWAY while our bomb guides (issue #65)', () => {
  /** Every text drawn over 1 s in the hud view with the release cue stubbed to `cue`. */
  const cueTexts = (cue: Record<string, unknown>, view: CameraMode = 'hud'): string[] => {
    const r = rig('ag', view);
    const ship = r.mock.world.ground.find((g) => g.type === 'ship')!;
    const bi = { point: ship.position.clone(), inRange: false, timeToRelease: -1, offAxis: false, steer: 0, bombAway: false, ...cue };
    (r.mock.world.combat as { bombImpactPoint: unknown }).bombImpactPoint = () => bi;
    return textsOver(r, 1).map((t) => t.text);
  };

  it('off the release cone the cue says which way to turn, in the HMD and chase views', () => {
    for (const v of ['hud', 'chase'] as const) {
      const left = cueTexts({ offAxis: true, steer: -1 }, v);
      expect(left, v).toContain('STEER LEFT');
      expect(left, v).not.toContain('STEER RIGHT');
      const right = cueTexts({ offAxis: true, steer: 1 }, v);
      expect(right, v).toContain('STEER RIGHT');
      expect(right, v).not.toContain('STEER LEFT');
      expect([...left, ...right], v).not.toContain('STEER');
    }
  });

  it('STEER RIGHT fits on the 844x390 screen, clear of the jet in chase', () => {
    for (const v of ['hud', 'chase'] as const) {
      const r = rig('ag', v);
      const ship = r.mock.world.ground.find((g) => g.type === 'ship')!;
      const bi = { point: ship.position.clone(), inRange: false, timeToRelease: -1, offAxis: true, steer: 1, bombAway: false };
      (r.mock.world.combat as { bombImpactPoint: unknown }).bombImpactPoint = () => bi;
      const box = textBox(find(textsOver(r, 0.5), 'STEER RIGHT')[0]);
      expect(box.x0, v).toBeGreaterThan(0);
      expect(box.x1, v).toBeLessThan(r.W);
      if (v !== 'chase') continue;
      const proj = new Projector();
      proj.update(r.camera, r.W, r.H);
      const sp = { x: 0, y: 0, depth: 0, front: false, onScreen: false, dirX: 0, dirY: 0, offAxis: 0 };
      proj.point(r.mock.player.position, sp);
      expect(overlaps(box, { x0: sp.x - 60, y0: sp.y - 25, x1: sp.x + 60, y1: sp.y + 15 })).toBe(false);
    }
  });

  it('while our own bomb is still guiding onto the target it reads BOMB AWAY, not STEER or OUT OF RANGE', () => {
    const off = cueTexts({ offAxis: true, steer: -1, bombAway: true });
    expect(off).toContain('BOMB AWAY');
    expect(off.some((t) => /STEER/.test(t))).toBe(false);
    const oor = cueTexts({ bombAway: true });
    expect(oor).toContain('BOMB AWAY');
    expect(oor).not.toContain('OUT OF RANGE');
    // a second bomb is still cued (a corvette takes two StormBreakers)
    const again = cueTexts({ inRange: true, timeToRelease: 0, bombAway: true });
    expect(again).toContain('IN RANGE');
    expect(again).not.toContain('BOMB AWAY');
    expect(cueTexts({ timeToRelease: 12, bombAway: true })).toContain('REL 12');
  });
});

describe('engaged marker: own missile in flight at a contact', () => {
  it('marks a non-designated contact our missile is guiding on with M n beside its box, clear of other text', () => {
    const r = rig('aa', 'hud');
    const p = r.mock.player;
    const su = r.mock.world.aircraft.find((a) => a.type === 'su35')!;
    expect(p.radar.designatedId).not.toBe(su.id);
    expect(find(r.run(0.1), /^M \d+$/).length).toBe(0);
    const def = { id: 'aim120', name: 'AIM-120D', short: 'AMRAAM', category: 'aam', guidance: 'active_radar' } as MissileEntity['def'];
    const m = new MissileEntity(950, def, 'blue', p.id, su.id);
    // 12 km out, closing at ~1,200 m/s: about 10 s to go
    m.position.copy(su.position).addScaledVector(new Vector3().subVectors(p.position, su.position).normalize(), 12_000);
    m.velocity.subVectors(su.position, m.position).setLength(1000);
    (r.mock.world.missiles as MissileEntity[]).push(m);
    const texts = r.run(0.1);
    const ms = find(texts, /^M \d+$/);
    expect(ms.length).toBe(1);
    const s = Number(ms[0].text.slice(2));
    expect(s).toBeGreaterThanOrEqual(8);
    expect(s).toBeLessThanOrEqual(12);
    // beside the su-35's box
    const proj = new Projector();
    proj.update(r.camera, r.W, r.H);
    const sp = { x: 0, y: 0, depth: 0, front: false, onScreen: false, dirX: 0, dirY: 0, offAxis: 0 };
    proj.point(p.radar.contacts.find((c) => c.id === su.id)!.position, sp);
    expect(Math.abs(ms[0].y - sp.y)).toBeLessThan(30);
    expect(Math.abs(ms[0].x - sp.x)).toBeLessThan(60);
    // never printed over other text
    const mb = textBox(ms[0]);
    for (const t of texts) if (t !== ms[0]) expect(overlaps(mb, textBox(t)), `M n over "${t.text}"`).toBe(false);
    // a dead missile: the mark goes
    m.alive = false;
    expect(find(r.run(0.1), /^M \d+$/).length).toBe(0);
  });
});

describe('gun closure cue', () => {
  const kt = 0.514444;
  /** The gun cue's Vc texts: those the gun adds (the altitude column / info block has its own). */
  const gunVcs = (r: Rig) => {
    const p = r.mock.player;
    p.selectedWeapon = 'aim120';
    const base = find(r.run(0.1), /^Vc \d+$/).map((t) => `${Math.round(t.x)},${Math.round(t.y)}`);
    p.selectedWeapon = 'gun';
    const texts = r.run(0.1);
    return { texts, vc: find(texts, /^Vc \d+$/).filter((t) => !base.includes(`${Math.round(t.x)},${Math.round(t.y)}`)) };
  };
  /** Put the target `range` m dead ahead, a little high, closing at `closureKt`. */
  const place = (r: Rig, range: number, closureKt: number) => {
    const p = r.mock.player;
    const mig = r.mock.world.getEntity(p.radar.lockedId)!;
    const fwd = p.velocity.clone().normalize();
    mig.position.copy(p.position).addScaledVector(fwd, range).add(new Vector3(0, range * 0.06, 0));
    mig.velocity.copy(p.velocity).addScaledVector(fwd, -closureKt * kt);
    const c = p.radar.contacts.find((k) => k.id === mig.id);
    if (c) c.position.copy(mig.position);
    return mig;
  };
  const clear = (texts: TextRec[], t: TextRec) => {
    for (const o of texts) if (o !== t) expect(overlaps(textBox(t), textBox(o)), `"${t.text}" over "${o.text}"`).toBe(false);
  };

  it('OVERSHOOT is a time-to-close cue: under 4 s to the 150 m break-off at the present closure', () => {
    expect(gunOvershoot(600, 100 * kt)).toBe(false); // 8.8 s
    expect(gunOvershoot(580, 154 * kt)).toBe(false); // 5.4 s (lit too early before: playtest 2.1-b)
    expect(gunOvershoot(300, 154 * kt)).toBe(true); // 1.9 s
    expect(gunOvershoot(300, -20)).toBe(false); // opening
  });

  for (const view of ['hud', 'chase'] as const) {
    it(`${view}: Vc (knots) by the gun cue inside 3 km of an air target, OVERSHOOT only when about to overshoot, clear of every text`, () => {
      const r = rig('gun', view);
      place(r, 600, 100);
      let { texts, vc } = gunVcs(r);
      expect(vc.length, 'gun Vc drawn').toBe(1);
      expect(Math.abs(Number(vc[0].text.slice(3)) - 100)).toBeLessThanOrEqual(15);
      expect(find(texts, 'OVERSHOOT').length).toBe(0);
      clear(texts, vc[0]);
      // 580 m at Vc 154: still time to pull the pipper on (no cue)
      place(r, 580, 154);
      ({ texts, vc } = gunVcs(r));
      expect(vc.length).toBe(1);
      expect(find(texts, 'OVERSHOOT').length).toBe(0);
      // 300 m at Vc 154: OVERSHOOT, clear of the target's labels and every other text
      place(r, 300, 154);
      ({ texts, vc } = gunVcs(r));
      clear(texts, one(texts, 'OVERSHOOT'));
      clear(texts, vc[0]);
      // beyond 3 km: no closure cue
      place(r, 4000, 154);
      ({ texts, vc } = gunVcs(r));
      expect(vc.length).toBe(0);
      expect(find(texts, 'OVERSHOOT').length).toBe(0);
    });
  }
});

describe('target waypoint labels with the bandits in reach', () => {
  it('drops the target waypoint\'s name / distance once a hostile aircraft is within 5 km (the boxes take over)', () => {
    const r = rig('gun', 'hud');
    const p = r.mock.player;
    const fwd = p.velocity.clone().normalize();
    const wp = { id: 'wp_swarm', label: 'Swarm', position: p.position.clone().addScaledVector(fwd, 4000).add(new Vector3(0, -900, 0)).addScaledVector(new Vector3(-fwd.z, 0, fwd.x).normalize(), 1200), radius: 2000, kind: 'target' as const };
    (r.mock.mission as { currentWaypoint: unknown }).currentWaypoint = wp;
    // the MiG at 700 m (a contact): no labels
    expect(find(r.run(0.1), 'Swarm').length).toBe(0);
    // nothing within 5 km: the labels come back
    const mig = r.mock.world.getEntity(p.radar.lockedId)!;
    mig.position.copy(p.position).addScaledVector(fwd, 9000).add(new Vector3(2000, 0, 0));
    r.mock.player.radar.contacts.find((c) => c.id === mig.id)!.position.copy(mig.position);
    expect(find(r.run(0.1), 'Swarm').length).toBe(1);
  });
});

describe('own missiles in flight: a count that always reads', () => {
  for (const view of ['hud', 'chase'] as const) {
    it(`${view}: "3 IN FLT" in the weapon block with three of our missiles in the air, clear of other text`, () => {
      const r = rig('aa', view);
      const p = r.mock.player;
      expect(find(r.run(0.1), /IN FLT$/).length).toBe(0);
      const def = { id: 'aim120', name: 'AIM-120D', short: 'AMRAAM', category: 'aam', guidance: 'active_radar' } as MissileEntity['def'];
      const targets = r.mock.world.aircraft.filter((a) => a.team === 'red');
      for (let i = 0; i < 3; i++) {
        const m = new MissileEntity(960 + i, def, 'blue', p.id, targets[i % targets.length].id);
        m.position.copy(p.position).add(new Vector3(0, 0, -200 * (i + 1)).applyQuaternion(p.quaternion));
        m.velocity.copy(p.velocity).multiplyScalar(4);
        (r.mock.world.missiles as MissileEntity[]).push(m);
      }
      const texts = r.run(0.1);
      const t = one(texts, '3 IN FLT');
      for (const o of texts) if (o !== t) expect(overlaps(textBox(t), textBox(o)), `"${t.text}" over "${o.text}"`).toBe(false);
    });
  }
});
