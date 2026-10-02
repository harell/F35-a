/**
 * MISSIONS — gun ammunition set per mission (#77, IRGC campaign 5/10).
 *
 * The IRGC missions are built around the gun, and the loadout's 180 rounds (the real F-35A load)
 * are not enough there, so MissionDef.gunAmmo overrides the loadout's rounds at launch and at every
 * rearm. Missions without it keep the loadout's 180. The HUD rounds counter and the cockpit stores
 * page read the jet's real count.
 */
import { PerspectiveCamera } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AKL } from '../src/core/auckland';
import type { FrameContext, MissionDef } from '../src/core/contracts';
import { DEFAULT_SETTINGS, LOADOUTS, QUALITY_PRESETS } from '../src/core/data';
import { CAMPAIGN, TRAINING, buildInstantMissionSeeded, missionGunAmmo, validateMission } from '../src/missions';
import { REARM_HOLD } from '../src/missions/runtime/rearm';
import { gunAmmoOverride } from '../src/missions/runtime/gunAmmo';
import { drawSmsPage } from '../src/hud/cockpit/pages';
import { createHud } from '../src/hud/Hud';
import { Pen } from '../src/hud/hmd/pen';
import { buildMock } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { harness, killGroup, shieldPlayer, type Harness } from './missions-helpers';

// real-sim runs of a few seconds each: give a loaded box room
vi.setConfig({ testTimeout: 60_000 });
installPath2D();

const byId = (id: string) => [...CAMPAIGN, ...TRAINING].find((m) => m.id === id)!;
const WH = AKL.whenuapai;
/** c01 (CAP over the Waitematā) with its own gun rounds. */
const withGun = (gunAmmo: MissionDef['gunAmmo']): MissionDef => ({ ...byId('c01'), gunAmmo });

/** Hold the player over Whenuapai at 600 m (stub world: teleport every step). */
function holdOverField(h: Harness, seconds: number): void {
  const p = h.world.player!;
  h.run(seconds, () => {
    p.position.set(WH.x + 300, 600, WH.z);
    shieldPlayer(h);
  });
}

const rearmed = (h: Harness) => h.of('hud:message').filter((m) => m.text === 'REARMED').length;

describe('MissionDef.gunAmmo: resolving the rounds', () => {
  it('a number applies on every difficulty; no override → null (keep the loadout)', () => {
    for (const d of ['recruit', 'pilot', 'veteran', 'ace'] as const) {
      expect(gunAmmoOverride({ gunAmmo: 400 }, d)).toBe(400);
      expect(gunAmmoOverride({}, d)).toBeNull();
    }
  });

  it('per difficulty: a level left out takes the nearest easier level listed, else the easiest listed', () => {
    const g = { gunAmmo: { recruit: 400, ace: 300 } };
    expect(gunAmmoOverride(g, 'recruit')).toBe(400);
    expect(gunAmmoOverride(g, 'pilot')).toBe(400);
    expect(gunAmmoOverride(g, 'veteran')).toBe(400);
    expect(gunAmmoOverride(g, 'ace')).toBe(300);
    const hard = { gunAmmo: { veteran: 260 } };
    expect(gunAmmoOverride(hard, 'recruit')).toBe(260);
    expect(gunAmmoOverride(hard, 'ace')).toBe(260);
  });

  it("missionGunAmmo falls back to the loadout's rounds (the briefing's hangar cards)", () => {
    expect(LOADOUTS.a2a_stealth.gunAmmo).toBe(180);
    expect(missionGunAmmo(byId('c01'), 'pilot', 'a2a_stealth')).toBe(180);
    expect(missionGunAmmo(withGun(400), 'pilot', 'a2a_stealth')).toBe(400);
    expect(missionGunAmmo(withGun({ recruit: 400, ace: 300 }), 'ace', 'a2a_beast')).toBe(300);
  });

  it('the validator accepts whole rounds and flags bad values', () => {
    expect(validateMission(withGun(400))).toEqual([]);
    expect(validateMission(withGun({ recruit: 400, ace: 300 }))).toEqual([]);
    expect(validateMission(withGun(-1)).some((e) => /gunAmmo must be a whole number/.test(e))).toBe(true);
    expect(validateMission(withGun(250.5)).some((e) => /gunAmmo must be a whole number/.test(e))).toBe(true);
    expect(validateMission(withGun({})).some((e) => /gunAmmo per difficulty is empty/.test(e))).toBe(true);
    expect(validateMission(withGun({ rookie: 300 } as MissionDef['gunAmmo'])).some((e) => /unknown difficulty "rookie"/.test(e))).toBe(true);
  });
});

describe('MissionDef.gunAmmo: launch and rearm', () => {
  it('a mission without it starts with the loadout\'s 180 rounds (unchanged)', () => {
    for (const [def, loadout] of [
      [byId('c01'), undefined],
      [byId('c03'), undefined],
      [byId('c01'), 'a2a_beast'],
    ] as const) {
      const h = harness(def, 'pilot', loadout);
      const p = h.world.player!;
      expect(def.gunAmmo).toBeUndefined();
      expect(p.gunAmmo).toBe(180);
      expect(p.gunMaxAmmo).toBe(180);
    }
  });

  it('a mission with gunAmmo: 400 starts with 400 rounds, whatever the loadout', () => {
    for (const loadout of byId('c01').allowedLoadouts) {
      const h = harness(withGun(400), 'pilot', loadout);
      expect(h.world.player!.gunAmmo, loadout).toBe(400);
      expect(h.world.player!.gunMaxAmmo, loadout).toBe(400);
    }
  });

  it('per difficulty: { recruit: 400, ace: 300 } arms 400 on Recruit and 300 on Ace', () => {
    const def = withGun({ recruit: 400, ace: 300 });
    expect(harness(def, 'recruit').world.player!.gunAmmo).toBe(400);
    expect(harness(def, 'ace').world.player!.gunAmmo).toBe(300);
  });

  it(`rearms with 400 rounds at Whenuapai (Winchester → ${REARM_HOLD} s hold over the field)`, () => {
    const h = harness(withGun(400));
    const p = h.world.player!;
    for (const st of p.stores) st.count = 0;
    p.gunAmmo = 37;
    h.run(1, () => shieldPlayer(h));
    holdOverField(h, REARM_HOLD + 1);
    expect(rearmed(h)).toBe(1);
    expect(h.world.combat.remaining(p, 'aim120')).toBeGreaterThan(0);
    expect(p.gunAmmo).toBe(400);
    expect(p.gunMaxAmmo).toBe(400);
  });

  it('the rearm gate measures "most of the gun spent" against the mission\'s rounds, not 180', () => {
    // 150 of 400 left: well over half of the loadout's 180, but under half of the mission's load
    const h = harness(withGun(400));
    const p = h.world.player!;
    p.gunAmmo = 150;
    h.run(1, () => shieldPlayer(h));
    holdOverField(h, REARM_HOLD + 1);
    expect(rearmed(h)).toBe(1);
    expect(p.gunAmmo).toBe(400);
    // a fresh 400-round jet circling the field does nothing
    holdOverField(h, REARM_HOLD * 2);
    expect(rearmed(h)).toBe(1);
  });

  it('a mission without it still rearms to 180', () => {
    const h = harness(byId('c01'));
    const p = h.world.player!;
    for (const st of p.stores) st.count = 0;
    p.gunAmmo = 20;
    h.run(1, () => shieldPlayer(h));
    holdOverField(h, REARM_HOLD + 1);
    expect(rearmed(h)).toBe(1);
    expect(p.gunAmmo).toBe(180);
  });

  it("survival's between-wave rearm reloads the mission's rounds too", () => {
    const base = buildInstantMissionSeeded({ mode: 'survival', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mig29', enemyCount: 1 }, 5);
    expect(base.script.survival?.rearm).toBe(true);
    const h = harness({ ...base, gunAmmo: 500 });
    const p = h.world.player!;
    expect(p.gunAmmo).toBe(500);
    // wait for the first wave, spend some rounds, then clear the wave
    let wave: string | undefined;
    h.run(30, () => {
      shieldPlayer(h);
      wave = h.world.aircraft.find((a) => a.team === 'red' && a.alive)?.groupId ?? undefined;
      return !!wave;
    });
    expect(wave).toBeTruthy();
    p.gunAmmo = 12;
    killGroup(h, wave!);
    h.run(1, () => shieldPlayer(h));
    expect(h.of('hud:message').some((m) => /^REARMED/.test(m.text))).toBe(true);
    expect(p.gunAmmo).toBe(500);
  });
});

describe('MissionDef.gunAmmo: the stores page and the HUD rounds counter show the real number', () => {
  it('cockpit SMS page: RDS 400 / GUN 400 for the jet of a gunAmmo: 400 mission', () => {
    const h = harness(withGun(400));
    const p = h.world.player!;
    h.world.combat.selectWeapon(p, 'gun', h.world);
    const { ctx } = makeFakeCanvas(512, 512);
    drawSmsPage(new Pen(ctx as unknown as CanvasRenderingContext2D), 0, 0, 480, 480, { ctx: {} as FrameContext, p, flash: false });
    const texts = ctx.texts.map((t) => t.text);
    expect(texts).toContain('RDS 400');
    expect(texts).toContain('GUN 400');
  });

  it('HMD weapon box: GUN 400 with the gun selected, and as the secondary line under a missile', () => {
    for (const scene of ['gun', 'aa'] as const) {
      const mock = buildMock(scene);
      mock.player.gunAmmo = mock.player.gunMaxAmmo = 400;
      const W = 844;
      const H = 390;
      const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
      const hud = createHud(canvas, mock.events);
      hud.resize(W, H, 1);
      const p = mock.player;
      const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
      camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
      camera.quaternion.copy(p.quaternion);
      camera.updateMatrixWorld();
      const frame: FrameContext = {
        dt: 1 / 30,
        time: 1,
        world: mock.world,
        player: p,
        camera,
        viewMode: 'hud',
        focusId: p.id,
        mission: mock.mission,
        settings: { ...DEFAULT_SETTINGS },
        quality: { ...QUALITY_PRESETS.medium },
        paused: false,
        screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
      };
      for (let i = 0; i < 3; i++) {
        fake.reset();
        mock.tick(1 / 30);
        hud.update(frame);
      }
      expect(fake.texts.some((t) => t.text === 'GUN 400'), scene).toBe(true);
    }
  });
});
