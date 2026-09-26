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
import { Projector } from '../src/hud/hmd/projector';
import { computeTouchLayout } from '../src/input/touch/layout';
import { MissileEntity } from '../src/sim/entities';
import { PLAYER_LOCK_CONE } from '../src/sim/sensors/Sensors';

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
    expect(splash[0].y).toBeLessThan(80);
    expect(splash[0].x).toBeGreaterThan(r.W * 0.6);
    for (let i = 0; i < 4; i++) r.mock.events.emit('hud:message', { text: `HAMMER ${i}: SPLASH SU-27`, tone: 'info', duration: 2.5 });
    texts = r.run(1);
    const feed = find(texts, /SPLASH/).filter((t) => t.align === 'right');
    expect(feed.length).toBe(3);
    // none of them in the centre of the screen
    for (const t of find(texts, /SPLASH|DESTROYED/)) expect(Math.abs(t.y - r.H / 2) > 60 || t.x < r.W * 0.35).toBe(true);
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

