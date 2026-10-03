/**
 * Issue #116, playtest 1.2-j: a bomb's TTI after release is its predicted time of flight (the bomb's
 * own glide law flown to the target: glideTimeToGo), not range ÷ closing speed, which read 99 s on a
 * StormBreaker from 12 NM that took ~120 s. Flies real GBU-53 / GBU-39 / GBU-31 releases in the sim and
 * compares the estimate along the way with the time the bomb actually took.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import type { LoadoutId } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { MUNITIONS } from '../src/sim/weapons/defs';
import { glideTimeToGo } from '../src/sim/weapons/dlz';
import type { SimWorld } from '../src/sim/api';
import type { MissileEntity } from '../src/sim/entities';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;
const NM = 1852;

function makeWorld(): SimWorld {
  return createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(1) });
}

/** The estimate from the bomb's present state (what the HUD shows). */
function estimate(m: MissileEntity, target: Vector3): number {
  const dx = target.x - m.position.x;
  const dz = target.z - m.position.z;
  const horiz = Math.hypot(dx, dz);
  const vh = horiz > 1 ? (m.velocity.x * dx + m.velocity.z * dz) / horiz : Math.hypot(m.velocity.x, m.velocity.z);
  return glideTimeToGo(MUNITIONS[m.def.id as keyof typeof MUNITIONS], horiz, m.position.y - target.y, vh, m.velocity.y, target.y, m.def.maxFlightTime - m.age);
}

/** Range ÷ closing speed (the old TTI). */
function naive(m: MissileEntity, target: Vector3): number {
  const r = new Vector3().subVectors(target, m.position);
  const d = r.length();
  return d / Math.max(80, m.velocity.dot(r) / d);
}

function fly(weapon: 'gbu53' | 'gbu39' | 'gbu31', loadout: LoadoutId, range: number, alt: number) {
  const w = makeWorld();
  const tgt = w.spawnGround({ type: 'fuel', team: 'red', position: new Vector3(0, 0, 0), heading: 0, name: 'Fuel Depot' });
  const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, alt, range), heading: 0, speed: 250, loadout });
  p.radar.designatedId = tgt.id;
  const launches: MissileEntity[] = [];
  w.events.on('munition:launch', (e) => launches.push(e.missile));
  w.combat.fire(p, w, weapon, tgt.id);
  for (let i = 0; i < 3 * 60 && !launches.length; i++) w.step(DT);
  expect(launches.length, `${weapon} released`).toBe(1);
  const m = launches[0];
  const samples: { t: number; est: number; naive: number }[] = [];
  let t = 0;
  let last = -99;
  while (m.alive && t < 400) {
    if (t - last >= 5) {
      samples.push({ t, est: estimate(m, tgt.position), naive: naive(m, tgt.position) });
      last = t;
    }
    w.step(DT);
    t += DT;
  }
  return { tof: t, samples, hit: m.position.distanceTo(tgt.position) < 60 };
}

describe('bomb TTI is the predicted time of flight (#116 1.2-j)', () => {
  it('GBU-53 from 12 NM: ~113 s (range ÷ closing read 99), and the estimate tracks the real flight within 10 % all the way', () => {
    const r = fly('gbu53', 'strike_sdb2', 12 * NM, 8_000);
    expect(r.tof).toBeGreaterThan(100);
    expect(r.tof).toBeLessThan(150);
    const first = r.samples[0];
    // at release: the old range ÷ closing read well short (13 s here; ~20 s in the playtest)
    expect(r.tof - first.naive).toBeGreaterThan(8);
    for (const s of r.samples) {
      const left = r.tof - s.t;
      if (left < 8) continue;
      expect(Math.abs(s.est - left) / left, `t ${s.t | 0}: est ${s.est.toFixed(1)} vs ${left.toFixed(1)}`).toBeLessThan(0.1);
    }
  });

  it('GBU-39 and GBU-31: the estimate at release is close to the real flight (90 s / 53 s here)', () => {
    for (const [weapon, loadout, range, tol] of [
      ['gbu39', 'sead_stealth', 10 * NM, 0.05],
      // (the JDAM's short, steep fall: 59 s predicted for 53 s, where range ÷ closing read 64 s)
      ['gbu31', 'strike_stealth', 5 * NM, 0.15],
    ] as const) {
      const r = fly(weapon, loadout, range, 8_000);
      const s = r.samples[0];
      expect(Math.abs(s.est - r.tof) / r.tof, `${weapon}: est ${s.est.toFixed(1)} vs ${r.tof.toFixed(1)}`).toBeLessThan(tol);
      expect(Math.abs(s.est - r.tof), weapon).toBeLessThanOrEqual(Math.abs(s.naive - r.tof) + 1);
    }
  });
});
