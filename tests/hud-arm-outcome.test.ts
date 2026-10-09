/**
 * Playtest r2 F2: an AARGM-ER at an air-defence boat gave no feedback. The boat went quiet 3 s before
 * impact (ARM discipline), the missile ended in a spark 150 m off and the HUD said nothing. Now the
 * player's anti-radiation missile that doesn't kill its site says what happened, in plain words: the
 * site went quiet and the missile lost it, or the site was hit and damaged.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { FakeWorld, v3 } from './combat-helpers';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import type { CombatMissile } from '../src/sim/weapons/missile';
import { MUNITIONS } from '../src/sim/weapons/defs';
import { MissileEntity, type SamSiteEntity } from '../src/sim/entities';
import { armOutcomeText } from '../src/hud/hmd/format';
import { createHud } from '../src/hud/Hud';
import { buildMock } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { siteBurn } from '../src/render/effects/Effects';

/** One player AARGM at an air-defence boat 20 km out; how it ended and what the HUD would say. */
function armRun(seed: number) {
  const w = new FakeWorld({ seed, difficulty: 'veteran' });
  const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 9000, 0), heading: 0, speed: 280, loadout: 'sead_stealth', callsign: 'Viper 1' });
  const boat = w.spawnSam({ type: 'ad_boat', team: 'red', position: v3(0, 0, -20_000), known: true });
  f35.selectedWeapon = 'aargm';
  f35.radar.mode = 'ground';
  w.run(1);
  const mine: CombatMissile[] = [];
  w.events.on('munition:launch', (e) => {
    if (e.shooter === f35) mine.push(e.missile as CombatMissile);
  });
  let said: ReturnType<typeof armOutcomeText> = null;
  let wentQuiet = false;
  // the HUD's own rule, evaluated when the sim reports the end (the boat's state at that moment)
  w.events.on('munition:end', (e) => {
    if (mine.includes(e.missile as CombatMissile)) said = armOutcomeText(w.getEntity(e.targetId), e.reason === 'hit' || e.reason === 'proximity');
  });
  w.combat.fire(f35, w, 'aargm', boat.id);
  w.run(150, () => {
    if (mine.some((m) => m.alive) && !boat.radarOn) wentQuiet = true;
    return mine.length > 0 && mine.every((m) => !m.alive);
  });
  return { fired: mine.length, killed: !boat.alive, wentQuiet, said: said as ReturnType<typeof armOutcomeText> };
}

describe('HUD: what the player\'s AARGM did (r2 F2)', () => {
  it('a boat that went quiet and survived: "AD BOAT WENT QUIET — AARGM LOST IT"; a kill: left to the kill feed', { timeout: 60_000 }, () => {
    let quietMisses = 0;
    let kills = 0;
    for (let s = 1; s <= 12; s++) {
      const r = armRun(s);
      expect(r.fired).toBe(1);
      if (r.killed) {
        kills++;
        expect(r.said).toBeNull();
      } else {
        // every AARGM that didn't sink its boat gets a line
        expect(r.said).not.toBeNull();
        if (r.wentQuiet && r.said!.text === 'AD BOAT WENT QUIET — AARGM LOST IT') quietMisses++;
      }
    }
    expect(quietMisses).toBeGreaterThan(0);
    expect(kills).toBeGreaterThan(0);
  });

  it('a hit that leaves the site alive reads HIT — DAMAGED', () => {
    const mock = buildMock('aa');
    const sa6 = mock.world.sams[0];
    expect(armOutcomeText(sa6, true)).toEqual({ text: 'SA-6 HIT — DAMAGED', tone: 'good' });
    sa6.alive = false;
    expect(armOutcomeText(sa6, true)).toBeNull();
  });

  it('a damaged site still fighting burns (fire on deck, smoke); an intact or dead one does not', () => {
    const boat = { alive: true, health: 50, maxHealth: 50 };
    expect(siteBurn(boat)).toBe(0);
    boat.health = 30;
    expect(siteBurn(boat)).toBeGreaterThanOrEqual(0.4);
    const worse = siteBurn({ ...boat, health: 5 });
    expect(worse).toBeGreaterThan(siteBurn(boat));
    expect(worse).toBeLessThanOrEqual(1);
    expect(siteBurn({ ...boat, alive: false })).toBe(0);
  });

  it('the HUD draws the line when the sim reports the player\'s AARGM ended at a quiet site', () => {
    installPath2D();
    const mock = buildMock('aa');
    const p = mock.player;
    const W = 844;
    const H = 390;
    const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
    const hud = createHud(canvas, mock.events);
    hud.resize(W, H, 1);
    hud.setVisible(true);
    const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
    camera.position.copy(p.position).add(new Vector3(0, 4.5, 20));
    camera.updateMatrixWorld();
    const ctx: FrameContext = {
      dt: 1 / 30,
      time: 0,
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
    const frame = (): string => {
      fake.reset();
      ctx.time += 1 / 30;
      hud.update(ctx);
      return fake.texts.map((t) => t.text).join(' ').toUpperCase();
    };
    frame();
    const sa6 = mock.world.sams[0] as SamSiteEntity;
    sa6.radarOn = false;
    sa6.state = 'emcon';
    const arm = new MissileEntity(mock.world.nextId(), MUNITIONS.aargm, 'blue', p.id, sa6.id);
    mock.events.emit('munition:end', { missile: arm, position: sa6.position.clone().add(v3(150, 0, 0)), reason: 'ground', targetId: sa6.id });
    let drawn = '';
    for (let i = 0; i < 4; i++) drawn += frame();
    expect(drawn).toContain('SA-6 WENT QUIET');
  });
});
