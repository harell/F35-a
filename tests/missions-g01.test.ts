/**
 * IRGC campaign mission g01 "Buzz Kill" (issue #78): a swarm of 10 Shahed-136 drones in a triangle
 * flies at the Sky Tower over the suburbs. Shoot them all down → win; two reach the tower → it
 * collapses and the mission fails; one reaches it → the tower is damaged and the mission goes on,
 * still winnable; and missiles alone can't win (10 drones, at most 8 missiles), so the gun is
 * required and the mission carries more rounds than the real 180.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { AKL } from '../src/core/auckland';
import { LOADOUTS } from '../src/core/data';
import type { Difficulty } from '../src/core/types';
import { CAMPAIGNS, campaignOf, missionById, missionGunAmmo, validateMission } from '../src/missions';
import { G01, G01_SWARM } from '../src/missions/content/irgc';
import { REASONS } from '../src/missions/runtime/reasons';
import { MUNITIONS } from '../src/sim/weapons/defs';
import type { AircraftEntity } from '../src/sim/entities';
import { harness, type Harness } from './missions-helpers';

const DIFFS: Difficulty[] = ['recruit', 'pilot', 'veteran', 'ace'];
const AAMS = ['aim120', 'aim9x'] as const;

const drones = (h: Harness): AircraftEntity[] => h.world.aircraft.filter((a) => a.groupId === 'shaheds');
const tower = (h: Harness) => h.world.landmarks.find((l) => l.id === 'skytower')!;

/** Shoot a drone down (credited to the player's AIM-120, as a hit would be). */
function kill(h: Harness, d: AircraftEntity): void {
  h.world.applyDamage(d, 1_000, h.world.player!.id, 'aim120', d.position.clone());
}

/** Run with the player parked on its CAP (out of the drones' way, inside the AO). */
function runParked(h: Harness, seconds: number, until?: () => boolean): void {
  const p = h.world.player!;
  const park = p.position.clone();
  h.run(seconds, () => {
    p.position.copy(park);
    return until?.() ?? h.runner.state !== 'running';
  });
}

describe('g01 Buzz Kill: content', () => {
  it('is the IRGC campaign\'s first mission, reachable by id (?mission=g01&autostart=1) and valid', () => {
    const irgc = CAMPAIGNS.find((c) => c.id === 'irgc')!;
    expect(irgc.missions[0]).toBe(G01);
    expect(G01.id).toBe('g01');
    expect(G01.index).toBe(1);
    expect(missionById('g01')).toBe(G01);
    expect(campaignOf('g01')?.id).toBe('irgc');
    expect(validateMission(G01)).toEqual([]);
    expect(G01.theater).toBe('auckland');
  });

  it('10 dumb Shaheds in a triangle, 10–12 km from the Sky Tower over the suburbs; no SAMs, no fighters, no wingmen', () => {
    const sc = G01.script;
    expect(sc.sams).toEqual([]);
    expect(sc.ground).toEqual([]);
    expect(sc.groups).toHaveLength(1);
    const g = sc.groups[0];
    expect(g).toMatchObject({ type: 'shahed136', team: 'red', count: 10, fixedCount: true, formation: 'triangle' });
    expect(g.oneWay).toBeDefined();
    const d = Math.hypot(g.x - AKL.skytower.x, g.z - AKL.skytower.z);
    expect(d).toBeGreaterThanOrEqual(10_000);
    expect(d).toBeLessThanOrEqual(12_000);
    // 3.3–4 minutes to impact at the drone's speed
    expect(d / g.speed).toBeGreaterThan(195);
    expect(d / g.speed).toBeLessThan(240);
    // aimed at the tower, on a straight route (the triangle keeps its shape)
    const ow = g.oneWay!;
    expect(Math.hypot(ow.targetX - AKL.skytower.x, ow.targetZ - AKL.skytower.z)).toBeLessThan(1);
    for (const w of ow.route ?? []) {
      const cross = (w.x - AKL.skytower.x) * (g.z - AKL.skytower.z) - (w.z - AKL.skytower.z) * (g.x - AKL.skytower.x);
      expect(Math.abs(cross) / d).toBeLessThan(5);
    }
  });

  it('air-to-air loadouts only: beast recommended, beast and stealth allowed', () => {
    expect(G01.recommendedLoadout).toBe('a2a_beast');
    expect([...G01.allowedLoadouts].sort()).toEqual(['a2a_beast', 'a2a_stealth']);
  });

  it('carries more gun rounds than usual (360–400), on every difficulty and loadout', () => {
    for (const diff of DIFFS) {
      for (const lo of G01.allowedLoadouts) {
        const n = missionGunAmmo(G01, diff, lo);
        expect(n, `${diff} ${lo}`).toBeGreaterThanOrEqual(360);
        expect(n, `${diff} ${lo}`).toBeLessThanOrEqual(400);
        expect(n).toBeGreaterThan(LOADOUTS[lo].gunAmmo);
      }
    }
    // fewer on harder difficulties, never more
    const rounds = DIFFS.map((d) => missionGunAmmo(G01, d, 'a2a_beast'));
    for (let i = 1; i < rounds.length; i++) expect(rounds[i]).toBeLessThanOrEqual(rounds[i - 1]);
  });

  it('missiles alone can\'t win: more drones than missiles, and one missile can\'t take two drones in formation', () => {
    for (const lo of G01.allowedLoadouts) {
      const missiles = LOADOUTS[lo].stores.filter((s) => (AAMS as readonly string[]).includes(s.weapon)).reduce((n, s) => n + s.count, 0);
      expect(missiles, lo).toBeLessThanOrEqual(8);
      expect(missiles, lo).toBeLessThan(G01_SWARM.count);
    }
    // nearest neighbours in the triangle are `spacing` apart (same row): wider than any AAM blast
    const blast = Math.max(...AAMS.map((w) => MUNITIONS[w].blastRadius));
    expect(G01_SWARM.spacing).toBeGreaterThan(2 * blast);
  });
});

describe('g01 Buzz Kill: the swarm in the mission runtime', () => {
  it('spawns all 10 drones on every difficulty, in rows of 1, 2, 3, 4 with the nose on the Sky Tower', () => {
    for (const diff of DIFFS) {
      const h = harness(G01, diff);
      const ds = drones(h);
      expect(ds, diff).toHaveLength(10);
      const lead = ds[0];
      const heading = Math.atan2(AKL.skytower.x - lead.position.x, -(AKL.skytower.z - lead.position.z));
      const fwd = new Vector3(Math.sin(heading), 0, -Math.cos(heading));
      const rows = new Map<number, number>();
      for (const d of ds) {
        expect(d.oneWay).not.toBeNull();
        expect(Math.abs(Math.atan2(Math.sin(d.flight.heading - heading), Math.cos(d.flight.heading - heading)))).toBeLessThan(0.01);
        const row = Math.round(-d.position.clone().sub(lead.position).dot(fwd) / G01_SWARM.spacing);
        rows.set(row, (rows.get(row) ?? 0) + 1);
      }
      expect([0, 1, 2, 3].map((r) => rows.get(r))).toEqual([1, 2, 3, 4]);
    }
  });

  it('all 10 destroyed → mission complete, tower untouched (bonus objective too)', () => {
    const h = harness(G01);
    h.run(5);
    for (const d of drones(h)) kill(h, d);
    h.run(2);
    expect(h.runner.state).toBe('success');
    expect(tower(h).alive).toBe(true);
    expect(tower(h).hits).toBe(0);
    expect(h.runner.objectives.find((o) => o.id === 'o_tower')?.state).toBe('complete');
  });

  it('two drones reach the tower → it collapses and the mission fails', { timeout: 60_000 }, () => {
    const h = harness(G01);
    const ds = drones(h);
    const impacts: unknown[] = [];
    h.events.on('drone:impact', (e) => {
      if (e.landmark === tower(h)) impacts.push(e);
    });
    h.run(1);
    for (const d of ds.slice(2)) kill(h, d); // the lead and one drone of the second row get through
    runParked(h, 300);
    expect(impacts).toHaveLength(2);
    expect(tower(h).hits).toBe(2);
    expect(tower(h).alive).toBe(false);
    expect(h.runner.state).toBe('failed');
    expect(h.of('mission:end')).toEqual([{ success: false, reason: REASONS.skytowerLost }]);
  });

  it('one drone reaches the tower → damaged and burning, the mission goes on and is still winnable', { timeout: 60_000 }, () => {
    const h = harness(G01);
    const ds = drones(h);
    h.run(1);
    const [first, ...rest] = ds;
    const last = rest.pop()!;
    for (const d of rest) kill(h, d); // 8 shot down, the lead and the back-row straggler left
    runParked(h, 300, () => tower(h).hits > 0 || h.runner.state !== 'running');
    expect(first.alive).toBe(false);
    expect(first.oneWay?.impacted).toBe(true);
    expect(tower(h).hits).toBe(1);
    expect(tower(h).alive).toBe(true);
    expect(h.runner.state).toBe('running');
    expect(h.of('hud:message').some((m) => m.text === 'SKY TOWER HIT')).toBe(true);
    expect(h.runner.objectives.find((o) => o.id === 'o_tower')?.state).toBe('failed');
    expect(last.alive).toBe(true);
    kill(h, last);
    h.run(2);
    expect(h.runner.state).toBe('success');
    expect(tower(h).alive).toBe(true);
  });
});
