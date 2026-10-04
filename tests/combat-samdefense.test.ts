/**
 * Regression tests for defending against SAMs (i1 critiques):
 *  - "chaff while beaming defeats every SAM and difficulty barely matters": chaff now rolls once
 *    per salvo per fire-control radar with timing / geometry and diminishing returns, scaled by
 *    difficulty — beam + chaff hit rates spread across recruit … ace, chaff alone is weak, a beam
 *    alone at medium altitude does nothing (no clutter to hide in)
 *  - "the notch switches on and off at exactly 1,000 m AGL": one continuous clutter function, so
 *    950 m and 1,050 m behave alike, and low flying is a real tactic
 * and i2 critiques (src/sim/sam/endgame.ts):
 *  - "SAM hits are all-or-nothing: 100 % of missiles hit a non-defending jet (SA-6 36/36, SA-15
 *    48/48, SA-10 19/19 at Pilot; the SA-10 has since been removed) and one chaff roll decides the whole salvo": every round now
 *    rolls its own end-game miss distance (target g, aspect, notch, chaff in the gate, correlated
 *    salvo term) against the fuze reach; a per-difficulty target table, monotonic Recruit → Ace
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FakeWorld, FlatTerrain, steerToward, v3 } from './combat-helpers';
import type { Difficulty, SamType } from '../src/core/types';
import type { CombatMissile } from '../src/sim/weapons/missile';
import { ENDGAME_PK, SALVO_RHO, endgameState, registerRound } from '../src/sim/sam/endgame';
import type { CombatCtx } from '../src/sim/weapons/context';
import { quickRelockChance } from '../src/sim/sam/SamSystem';

/**
 * none: fly at the site; chaff: chaff only; beam: beam the site when warned; beamchaff: beam +
 * late chaff; break: a last-ditch 7 g break turn inside 3.5 km; beambreak: beam + chaff + break.
 */
type Mode = 'none' | 'chaff' | 'beam' | 'beamchaff' | 'break' | 'beambreak';

interface Result {
  launches: number;
  hits: number;
  /** Raw warhead damage of each hit (before the player's difficulty scale). */
  dmg: number[];
  /** Every round fired at the jet (end-game state readable via endgameState). */
  rounds: CombatMissile[];
  /** Round id → fuzed on the jet (proximity / hit). */
  fuzed: Map<number, boolean>;
  /** Round id → launch time (s). */
  launchT: Map<number, number>;
}

/** Missiles fired and hits on a scripted F-35 that runs at a SAM site and defends when warned. */
function engagement(sam: SamType, diff: Difficulty, mode: Mode, alt: number, trials: number, d0 = 16_000): Result {
  let launches = 0;
  let hits = 0;
  const dmg: number[] = [];
  const rounds: CombatMissile[] = [];
  const fuzed = new Map<number, boolean>();
  const launchT = new Map<number, number>();
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
        rounds.push(e.missile as CombatMissile);
        launchT.set(e.missile.id, t * 10_000 + w.time);
      }
    });
    w.events.on('munition:end', (e) => {
      if (ids.has(e.missile.id)) fuzed.set(e.missile.id, e.reason === 'proximity' || e.reason === 'hit');
    });
    const apply = w.applyDamage.bind(w);
    w.applyDamage = (target, amount, attackerId, weapon) => {
      if (target === p) {
        hits++; // count the hit, keep the jet flying
        dmg.push(amount);
      }
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
      if ((mode === 'break' || mode === 'beambreak') && inc && inc.distance < 3500) {
        // last-ditch break turn: 7 g, horizontal, perpendicular to the current velocity
        if (side === 0) side = 1;
        dir.set(-ac.velocity.z * side, 0, ac.velocity.x * side);
        steerToward(ac, dir, 7, dt, 260);
      } else if (defending && (mode === 'beam' || mode === 'beamchaff' || mode === 'beambreak')) {
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
      if ((mode === 'chaff' || mode === 'beamchaff' || mode === 'beambreak') && inc && inc.distance < 9000) {
        cmT -= dt;
        if (cmT <= 0) {
          cmT = 0.7;
          ac.input.chaff = true;
        }
      }
    });
    w.run(260, () => (site.missilesReady === 0 || site.state === 'reload') && !w.missiles.some((m) => m.alive && ids.has(m.id)));
  }
  return { launches, hits, dmg, rounds, fuzed, launchT };
}

const rate = (r: { launches: number; hits: number }) => r.hits / Math.max(1, r.launches);
/** Hit rate over several engagements pooled. */
const pooled = (...rs: Result[]) => rate({ launches: rs.reduce((a, r) => a + r.launches, 0), hits: rs.reduce((a, r) => a + r.hits, 0) });

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
    // one trick alone at medium altitude (i2: the end-game Pk means even no defence is < 100 %)
    const chaffOnly = rate(engagement('sa6', 'veteran', 'chaff', 3000, 6));
    expect(chaffOnly).toBeGreaterThan(0.5);
    expect(chaffOnly).toBeGreaterThan(vet + 0.25);
    expect(rate(engagement('sa6', 'veteran', 'beam', 3000, 4))).toBeGreaterThan(0.7);
    expect(rate(engagement('sa6', 'veteran', 'none', 3000, 4))).toBeGreaterThan(0.7);
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

  it('i2: an undefended jet is no longer hit by 100 % of SAM rounds; Pk follows the difficulty table, monotonic', { timeout: 60_000 }, () => {
    const pilot = pooled(engagement('sa6', 'pilot', 'none', 3000, 6), engagement('sa15', 'pilot', 'none', 3000, 6), engagement('sa6', 'pilot', 'none', 6000, 6, 30_000));
    const vet = pooled(engagement('sa6', 'veteran', 'none', 3000, 6), engagement('sa15', 'veteran', 'none', 3000, 6), engagement('sa6', 'veteran', 'none', 6000, 6, 30_000));
    const ace = pooled(engagement('sa6', 'ace', 'none', 3000, 6), engagement('sa15', 'ace', 'none', 3000, 6), engagement('sa6', 'ace', 'none', 6000, 6, 30_000));
    // reviewer: Pilot 36/36, 48/48, 19/19 — target ≈ 0.75 at Pilot, ≈ 0.9 at Ace
    expect(pilot).toBeGreaterThan(0.55);
    expect(pilot).toBeLessThan(0.85);
    expect(vet).toBeGreaterThan(pilot);
    expect(ace).toBeGreaterThan(vet);
    expect(ace).toBeGreaterThan(0.8);
    expect(ace).toBeLessThan(0.97);
    expect(ENDGAME_PK.recruit).toBeLessThan(ENDGAME_PK.pilot);
    expect(ENDGAME_PK.pilot).toBeLessThan(ENDGAME_PK.veteran);
    expect(ENDGAME_PK.veteran).toBeLessThan(ENDGAME_PK.ace);
  });

  it('i2: defence ladder at Pilot — none > chaff only > beam + chaff (≈ 20 %); a break turn lowers the Pk', { timeout: 60_000 }, () => {
    const none = pooled(engagement('sa6', 'pilot', 'none', 3000, 6), engagement('sa6', 'pilot', 'none', 6000, 6, 30_000));
    const chaff = pooled(engagement('sa6', 'pilot', 'chaff', 3000, 6), engagement('sa6', 'pilot', 'chaff', 6000, 6, 30_000));
    const good = pooled(engagement('sa6', 'pilot', 'beamchaff', 3000, 6), engagement('sa6', 'pilot', 'beamchaff', 6000, 6, 30_000));
    const brk = pooled(engagement('sa6', 'pilot', 'break', 3000, 6), engagement('sa6', 'pilot', 'break', 6000, 6, 30_000));
    expect(chaff).toBeLessThan(none - 0.05);
    expect(good).toBeLessThan(chaff - 0.2);
    expect(good).toBeGreaterThan(0.03);
    expect(good).toBeLessThan(0.35);
    // the end-game manoeuvre term: a hard break at the right moment is a skill in itself
    expect(brk).toBeLessThan(none - 0.08);
  });

  it('i2: every round rolls its own end game — mixed outcomes within salvos, a spread of miss distances and damage', { timeout: 60_000 }, () => {
    const r = engagement('sa15', 'pilot', 'none', 3000, 8);
    const applied = r.rounds.map((m) => endgameState(m)?.applied ?? -1).filter((x) => x >= 0);
    expect(applied.length).toBeGreaterThan(20);
    // miss distances are a spread, not ~0 m every time
    const sorted = [...applied].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length * 0.2)]).toBeGreaterThan(2);
    expect(sorted[Math.floor(sorted.length * 0.8)] - sorted[Math.floor(sorted.length * 0.2)]).toBeGreaterThan(5);
    // not every round hits an undefended jet any more (reviewer: 48/48), but most still do
    expect(r.hits).toBeLessThan(r.launches);
    expect(r.hits).toBeGreaterThan(r.launches * 0.4);
    // salvos (rounds launched < 3 s apart) are no longer all-or-nothing: some end split
    let split = 0;
    for (let i = 1; i < r.rounds.length; i++) {
      const a = r.rounds[i - 1].id;
      const b = r.rounds[i].id;
      if (Math.abs(r.launchT.get(b)! - r.launchT.get(a)!) < 3 && r.fuzed.get(a) !== r.fuzed.get(b)) split++;
    }
    expect(split).toBeGreaterThan(0);
    // proximity bursts at different distances: damage per hit varies (not all full-warhead)
    const dmin = Math.min(...r.dmg);
    const dmax = Math.max(...r.dmg);
    expect(dmax - dmin).toBeGreaterThan(15);
  });

  it('i2: a chaff gate walk-off no longer always loses the whole salvo: skilled crews may re-lock (never in the notch)', () => {
    const c = [0.25, 0.5, 0.75, 0.95].map((k) => quickRelockChance(k, 0));
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThan(c[i - 1]);
    expect(c[0]).toBeLessThan(0.1); // recruit crews: chaff still breaks the salvo
    expect(c[3]).toBeGreaterThan(0.4);
    expect(c[3]).toBeLessThan(0.7); // ace: often, never always
    expect(quickRelockChance(0.95, 0.8)).toBe(0); // beam + clutter: the chaff break sticks
  });

  it('i2: rounds of one salvo share a correlated error term, but are not identical', () => {
    let seed = 7;
    const rng = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const ctx = { rng } as unknown as CombatCtx;
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng());
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < 4000; i++) {
      const salvoZ = gauss();
      const a = {} as CombatMissile;
      const b = {} as CombatMissile;
      registerRound(ctx, a, salvoZ);
      registerRound(ctx, b, salvoZ);
      const za = endgameState(a)!.z;
      const zb = endgameState(b)!.z;
      sxy += za * zb;
      sxx += za * za;
      syy += zb * zb;
    }
    const corr = sxy / Math.sqrt(sxx * syy);
    expect(corr).toBeGreaterThan(SALVO_RHO - 0.1);
    expect(corr).toBeLessThan(SALVO_RHO + 0.1);
    expect(corr).toBeLessThan(0.8);
  });
});
