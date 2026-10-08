/**
 * MISSIONS — gun ammunition set per mission (#77, IRGC campaign 5/10).
 *
 * The IRGC missions are built around the gun, and the loadout's 180 rounds (the real F-35A load)
 * are not enough there, so MissionDef.gunAmmo overrides the loadout's rounds at launch (there is no
 * rearming, #63). Missions without it keep the loadout's 180. The HUD rounds counter and the
 * cockpit stores page read the jet's real count.
 */
import { PerspectiveCamera } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { FrameContext, MissionDef } from '../src/core/contracts';
import { DEFAULT_SETTINGS, LOADOUTS, QUALITY_PRESETS } from '../src/core/data';
import { TRAINING, missionGunAmmo, validateMission } from '../src/missions';
import { gunAmmoOverride } from '../src/missions/runtime/gunAmmo';
import { drawSmsPage } from '../src/hud/cockpit/pages';
import { createHud } from '../src/hud/Hud';
import { Pen } from '../src/hud/hmd/pen';
import { buildMock } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { harness } from './missions-helpers';

// each test builds a real-sim mission harness: give a loaded box room
vi.setConfig({ testTimeout: 60_000 });
installPath2D();

const byId = (id: string) => TRAINING.find((m) => m.id === id)!;
/** t02 (the air-to-air lesson, no gunAmmo of its own) with its own gun rounds. */
const withGun = (gunAmmo: MissionDef['gunAmmo']): MissionDef => ({ ...byId('t02'), gunAmmo });

describe('MissionDef.gunAmmo: resolving the rounds', () => {
  it('a number applies on every difficulty; no override → null (keep the loadout)', () => {
    for (const d of ['recruit', 'pilot', 'veteran'] as const) {
      expect(gunAmmoOverride({ gunAmmo: 400 }, d)).toBe(400);
      expect(gunAmmoOverride({}, d)).toBeNull();
    }
  });

  it('per difficulty: a level left out takes the nearest easier level listed, else the easiest listed', () => {
    const g = { gunAmmo: { recruit: 400, veteran: 300 } };
    expect(gunAmmoOverride(g, 'recruit')).toBe(400);
    expect(gunAmmoOverride(g, 'pilot')).toBe(400);
    expect(gunAmmoOverride(g, 'pilot')).toBe(400);
    expect(gunAmmoOverride(g, 'veteran')).toBe(300);
    const hard = { gunAmmo: { veteran: 260 } };
    expect(gunAmmoOverride(hard, 'recruit')).toBe(260);
    expect(gunAmmoOverride(hard, 'veteran')).toBe(260);
  });

  it("missionGunAmmo falls back to the loadout's rounds (the briefing's hangar cards)", () => {
    expect(LOADOUTS.a2a_stealth.gunAmmo).toBe(180);
    expect(missionGunAmmo(byId('t02'), 'pilot', 'a2a_stealth')).toBe(180);
    expect(missionGunAmmo(withGun(400), 'pilot', 'a2a_stealth')).toBe(400);
    expect(missionGunAmmo(withGun({ recruit: 400, veteran: 300 }), 'veteran', 'a2a_beast')).toBe(300);
  });

  it('the validator accepts whole rounds and flags bad values', () => {
    expect(validateMission(withGun(400))).toEqual([]);
    expect(validateMission(withGun({ recruit: 400, veteran: 300 }))).toEqual([]);
    expect(validateMission(withGun(-1)).some((e) => /gunAmmo must be a whole number/.test(e))).toBe(true);
    expect(validateMission(withGun(250.5)).some((e) => /gunAmmo must be a whole number/.test(e))).toBe(true);
    expect(validateMission(withGun({})).some((e) => /gunAmmo per difficulty is empty/.test(e))).toBe(true);
    expect(validateMission(withGun({ rookie: 300 } as MissionDef['gunAmmo'])).some((e) => /unknown difficulty "rookie"/.test(e))).toBe(true);
  });
});

describe('MissionDef.gunAmmo: launch', () => {
  it('a mission without it starts with the loadout\'s 180 rounds (unchanged)', () => {
    for (const [def, loadout] of [
      [byId('t02'), undefined],
      [byId('t05'), undefined],
      [byId('t02'), 'a2a_beast'],
    ] as const) {
      const h = harness(def, 'pilot', loadout);
      const p = h.world.player!;
      expect(def.gunAmmo).toBeUndefined();
      expect(p.gunAmmo).toBe(180);
      expect(p.gunMaxAmmo).toBe(180);
    }
  });

  it('a mission with gunAmmo: 400 starts with 400 rounds, whatever the loadout', () => {
    for (const loadout of byId('t02').allowedLoadouts) {
      const h = harness(withGun(400), 'pilot', loadout);
      expect(h.world.player!.gunAmmo, loadout).toBe(400);
      expect(h.world.player!.gunMaxAmmo, loadout).toBe(400);
    }
  });

  it('per difficulty: { recruit: 400, veteran: 300 } arms 400 on Recruit and 300 on Veteran', () => {
    const def = withGun({ recruit: 400, veteran: 300 });
    expect(harness(def, 'recruit').world.player!.gunAmmo).toBe(400);
    expect(harness(def, 'veteran').world.player!.gunAmmo).toBe(300);
  });
});

describe('MissionDef.gunAmmo: the stores page and the HUD rounds counter show the real number', () => {
  it('cockpit SMS page: RDS 400 with the gun selected (no second GUN line), GUN 400 under a missile, for a gunAmmo: 400 mission', () => {
    const h = harness(withGun(400));
    const p = h.world.player!;
    const sms = () => {
      const { ctx } = makeFakeCanvas(512, 512);
      drawSmsPage(new Pen(ctx as unknown as CanvasRenderingContext2D), 0, 0, 480, 480, { ctx: {} as FrameContext, p, flash: false });
      return ctx.texts.map((t) => t.text);
    };
    h.world.combat.selectWeapon(p, 'gun', h.world);
    expect(sms()).toContain('RDS 400');
    expect(sms()).not.toContain('GUN 400');
    const missile = p.stores.find((s) => s.count > 0)?.weapon;
    expect(missile).toBeTruthy();
    h.world.combat.selectWeapon(p, missile!, h.world);
    expect(sms()).toContain('GUN 400');
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
