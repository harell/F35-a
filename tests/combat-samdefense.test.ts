/**
 * Regression tests for defending against SAMs (i1 critiques):
 *  - "chaff while beaming defeats every SAM and difficulty barely matters": chaff now rolls once
 *    per salvo per fire-control radar with timing / geometry and diminishing returns, scaled by
 *    difficulty — beam + chaff hit rates spread across recruit … ace, chaff alone is weak, a beam
 *    alone at medium altitude does nothing (no clutter to hide in)
 *  - "the notch switches on and off at exactly 1,000 m AGL": one continuous clutter function, so
 *    950 m and 1,050 m behave alike, and low flying is a real tactic
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FakeWorld, FlatTerrain, steerToward, v3 } from './combat-helpers';
import type { Difficulty, SamType } from '../src/core/types';

type Mode = 'none' | 'chaff' | 'beam' | 'beamchaff';

/** Missiles fired and hits on a scripted F-35 that runs at a SAM site and defends when warned. */
function engagement(sam: SamType, diff: Difficulty, mode: Mode, alt: number, trials: number, d0 = 16_000): { launches: number; hits: number } {
  let launches = 0;
  let hits = 0;
  for (let t = 0; t < trials; t++) {
    const w = new FakeWorld({ difficulty: diff, seed: 1000 + t * 17, terrain: new FlatTerrain(0) });
    const site = w.spawnSam({ type: sam, team: 'red', position: v3(0, 0, 0) });
    const brg = (t / trials) * Math.PI * 2;
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(Math.sin(brg) * d0, alt, -Math.cos(brg) * d0), heading: brg + Math.PI, speed: 260, loadout: 'a2a_beast' });
    p.chaff = 80;
    const ids = new Set<number>();
    w.events.on('munition:launch', (e) => {
      if (e.targetId === p.id) {
        launches++;
        ids.add(e.missile.id);
      }
    });
    const apply = w.applyDamage.bind(w);
    w.applyDamage = (target, amount, attackerId, weapon) => {
      if (target === p) hits++; // count the hit, keep the jet flying
      else apply(target, amount, attackerId, weapon);
    };
    const dir = new Vector3();
    let cmT = 0;
    let side = 0;
    let defending = false;
    let lastInc = -99;
    w.controllers.set(p.id, (ac, dt) => {
      const inc = ac.incoming[0];
      if (inc) {
        defending = true;
        lastInc = w.time;
      } else if (w.time - lastInc > 6) defending = false;
      ac.input.chaff = false;
      if (defending && (mode === 'beam' || mode === 'beamchaff')) {
        dir.subVectors(ac.position, site.position);
        dir.y = 0;
        dir.normalize();
        if (side === 0) side = -dir.z * ac.velocity.x + dir.x * ac.velocity.z >= 0 ? 1 : -1;
        dir.set(-dir.z * side, 0, dir.x * side);
        steerToward(ac, dir, 6, dt, 260);
      } else if (!defending) {
        dir.subVectors(site.position, ac.position);
        dir.y = 0;
        steerToward(ac, dir, 4, dt, 260);
      }
      if ((mode === 'chaff' || mode === 'beamchaff') && inc && inc.distance < 9000) {
        cmT -= dt;
        if (cmT <= 0) {
          cmT = 0.7;
          ac.input.chaff = true;
        }
      }
    });
    w.run(260, () => (site.missilesReady === 0 || site.state === 'reload') && !w.missiles.some((m) => m.alive && ids.has(m.id)));
  }
  return { launches, hits };
}

const rate = (r: { launches: number; hits: number }) => r.hits / Math.max(1, r.launches);

describe('combat: defending against SAMs', () => {
  it('SA-6 at 3,000 m: beam + chaff is a skill that difficulty scales; chaff alone or a beam alone is not enough', { timeout: 60_000 }, () => {
    const rec = rate(engagement('sa6', 'recruit', 'beamchaff', 3000, 6));
    const vet = rate(engagement('sa6', 'veteran', 'beamchaff', 3000, 6));
    const ace = rate(engagement('sa6', 'ace', 'beamchaff', 3000, 6));
    expect(rec).toBeLessThan(0.2);
    expect(vet).toBeGreaterThan(rec);
    expect(ace).toBeGreaterThan(vet);
    expect(ace).toBeGreaterThan(0.3);
    expect(ace).toBeLessThan(0.8);
    // one trick alone at medium altitude
    expect(rate(engagement('sa6', 'veteran', 'chaff', 3000, 4))).toBeGreaterThan(0.7);
    expect(rate(engagement('sa6', 'veteran', 'beam', 3000, 4))).toBeGreaterThan(0.8);
    expect(rate(engagement('sa6', 'veteran', 'none', 3000, 3))).toBeGreaterThan(0.9);
  });

  it('the Doppler notch has no altitude cliff (950 m ≈ 1,050 m) and flying low is a real tactic', { timeout: 60_000 }, () => {
    const r950 = rate(engagement('sa6', 'veteran', 'beam', 950, 6));
    const r1050 = rate(engagement('sa6', 'veteran', 'beam', 1050, 6));
    const low = rate(engagement('sa6', 'veteran', 'beam', 300, 6));
    const high = rate(engagement('sa6', 'veteran', 'beam', 3000, 6));
    expect(Math.abs(r950 - r1050)).toBeLessThan(0.25);
    expect(low).toBeLessThan(high - 0.3);
    expect(low).toBeGreaterThan(0.1); // not immunity either
  });

  it('no single trick defeats every SAM: the SA-10 still hits most beam + chaff defences at altitude', { timeout: 60_000 }, () => {
    const sa10 = rate(engagement('sa10', 'veteran', 'beamchaff', 6000, 4, 30_000));
    const sa6 = rate(engagement('sa6', 'veteran', 'beamchaff', 6000, 4));
    expect(sa10).toBeGreaterThan(0.5);
    expect(sa10).toBeGreaterThan(sa6);
  });
});
