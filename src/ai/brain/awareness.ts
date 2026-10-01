/**
 * F35-A — AI situational awareness: what a pilot knows about hostile aircraft and inbound
 * missiles. No cheating: knowledge comes only from
 *   - the aircraft's own sensor tracks (radar, IRST / EOTS, F-35 DAS) → weapons quality,
 *   - datalink tracks (team picture: other fighters, SAM radars, EWR/GCI, AWACS) → for red AI
 *     degraded by a slowly wandering GCI error (a "rough bogey dope"), good for blue (Link 16),
 *   - eyeballs: any hostile jet inside the pilot's visual range with terrain line of sight,
 *   - GCI vectors (interceptors only): a coarse, periodically refreshed position of a target.
 * Stealth therefore matters: a clean F-35 is seen late by radar and not at all by GCI unless
 * an EWR or SAM radar has it.
 *
 * Inbound missiles come from `ac.incoming` (DAS for the F-35, RWR + visual for others) and are
 * released to the brain only after the pilot's reaction time.
 */
import { Vector3 } from 'three';
import type { SimWorld } from '../../sim/api';
import type { AircraftEntity, IncomingMissile } from '../../sim/entities';
import type { PilotSkill } from '../skill';
import { isHostile } from '../../core/types';

export interface Bandit {
  id: number;
  ent: AircraftEntity;
  /** Estimated position / velocity (exact for own-sensor / visual tracks). */
  pos: Vector3;
  vel: Vector3;
  range: number;
  /** Weapons-quality track: own sensor or visual. */
  own: boolean;
  /** Seen with the pilot's eyes this tick. */
  visual: boolean;
  /** Held by our own fire-control/IR sensors (a missile can be launched at it). */
  sensor: boolean;
  /** 0 = none, 1 = designating us, 2 = locked on us / nose on at close range. */
  threat: number;
  /** Fighter (vs bomber / AWACS). */
  fighter: boolean;
}

const FIGHTERS = new Set(['f35a', 'mig29', 'su27', 'su35', 'su57']);

/** Per-target GCI error for red datalink tracks (random walk). */
interface ErrState {
  v: Vector3;
  t: number;
}

/** Last known state of a bandit (pilot's memory / "tally" after sensors lose it). */
interface Memory {
  id: number;
  pos: Vector3;
  vel: Vector3;
  t: number;
}

const _rel = new Vector3();
const _fwd = new Vector3();

export class Awareness {
  readonly bandits: Bandit[] = [];
  private readonly pool: Bandit[] = [];
  private readonly errors = new Map<number, ErrState>();
  /** missile id → sim time from which the pilot reacts to it. */
  private readonly reactAt = new Map<number, number>();
  private readonly losCache = new Map<number, { t: number; ok: boolean }>();
  /** Pooled memory entries (few bandits: linear scans, no per-tick allocation). */
  private readonly memory: Memory[] = [];
  private readonly memPool: Memory[] = [];
  /** Coarse GCI vector (interceptors / attack task). */
  readonly gciPos = new Vector3();
  readonly gciVel = new Vector3();
  gciId: number | null = null;
  private gciTime = -99;

  /** Rebuild the bandit list. */
  update(ac: AircraftEntity, world: SimWorld, skill: PilotSkill, rng: () => number): void {
    const list = this.bandits;
    for (let i = 0; i < list.length; i++) this.pool.push(list[i]);
    list.length = 0;
    const now = world.time;
    const red = ac.team === 'red';

    // 1. sensor / datalink contacts
    const contacts = ac.radar.contacts;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i] as (typeof contacts)[number] & { entityKind?: string; ownTime?: number };
      if (!isHostile(ac.team, c.team)) continue;
      if (c.entityKind !== undefined && c.entityKind !== 'aircraft') continue;
      const e = world.getEntity(c.id);
      if (!e || e.kind !== 'aircraft' || !e.alive) continue;
      // own-sensor track refreshed this sweep (a lost track lingers in memory for a few seconds:
      // then it is only a dead-reckoned estimate, like a datalink track)
      const age = Math.max(0, now - c.lastSeen);
      const own = c.source !== 'datalink' && age < 0.6;
      const b = this.alloc(e);
      if (own) {
        b.pos.copy(e.position);
        b.vel.copy(e.velocity);
        b.sensor = true;
        b.own = true;
      } else {
        // extrapolate the (possibly stale) datalink / memory track
        b.pos.copy(c.position).addScaledVector(c.velocity, age);
        b.vel.copy(c.velocity);
        if (red && c.source === 'datalink') b.pos.add(this.gciError(c.id, b.pos.distanceTo(ac.position), now, rng));
      }
      list.push(b);
    }

    // 2. eyeballs
    const vis = skill.visualRange;
    const all = world.aircraft;
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (!e.alive || !isHostile(ac.team, e.team)) continue;
      const d2 = e.position.distanceToSquared(ac.position);
      if (d2 > vis * vis) continue;
      if (!this.lineOfSight(ac, e, world, now)) continue;
      let b = this.find(e.id);
      if (!b) {
        b = this.alloc(e);
        list.push(b);
      }
      b.pos.copy(e.position);
      b.vel.copy(e.velocity);
      b.own = true;
      b.visual = true;
    }

    // 3. memory: a bandit that just slipped out of every sensor is still flown against for a
    //    few seconds (dead-reckoned, not weapons quality) — no flip-flopping in the merge
    const keep = 4 + 6 * skill.level;
    const mem = this.memory;
    const seen = list.length;
    for (let i = 0; i < seen; i++) {
      const b = list[i];
      let m: Memory | null = null;
      for (let k = 0; k < mem.length; k++) if (mem[k].id === b.id) m = mem[k];
      if (!m) {
        m = this.memPool.pop() ?? { id: 0, pos: new Vector3(), vel: new Vector3(), t: 0 };
        m.id = b.id;
        mem.push(m);
      }
      m.pos.copy(b.pos);
      m.vel.copy(b.vel);
      m.t = now;
    }
    for (let k = mem.length - 1; k >= 0; k--) {
      const m = mem[k];
      const age = now - m.t;
      if (age <= 0) continue;
      const e = world.getEntity(m.id);
      if (age > keep || !e || e.kind !== 'aircraft' || !e.alive) {
        if (age > keep * 3 || !e || !e.alive) {
          mem[k] = mem[mem.length - 1];
          mem.pop();
          this.memPool.push(m);
        }
        continue;
      }
      const b = this.alloc(e);
      b.pos.copy(m.pos).addScaledVector(m.vel, age);
      b.vel.copy(m.vel);
      list.push(b);
    }

    // 4. derived fields
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      b.range = b.pos.distanceTo(ac.position);
      const e = b.ent;
      b.fighter = FIGHTERS.has(e.type);
      b.threat = e.radar.lockedId === ac.id ? 2 : e.radar.designatedId === ac.id ? 1 : 0;
      if (b.threat < 2 && b.fighter && b.range < 3_500) {
        // nose on us at close range (gun / IR threat)
        _fwd.set(0, 0, -1).applyQuaternion(e.quaternion);
        _rel.subVectors(ac.position, e.position);
        if (_fwd.dot(_rel) > 0.9 * _rel.length()) b.threat = 2;
      }
    }

    // 5. missile reaction gating
    const inc = ac.incoming;
    for (let i = 0; i < inc.length; i++) {
      const id = inc[i].missileId;
      if (!this.reactAt.has(id)) {
        // alert pilots react faster to a close-in threat (they're already looking)
        const k = inc[i].distance < 4_000 ? 0.6 : 1;
        this.reactAt.set(id, now + skill.reaction * k * (0.6 + 0.8 * rng()));
      }
    }
    if (this.reactAt.size > inc.length + 4) {
      for (const id of this.reactAt.keys()) {
        let found = false;
        for (let i = 0; i < inc.length; i++) if (inc[i].missileId === id) found = true;
        if (!found) this.reactAt.delete(id);
      }
    }
  }

  /** Most urgent inbound missile the pilot has reacted to (null if none). */
  threatMissile(now: number, inc: IncomingMissile[]): IncomingMissile | null {
    for (let i = 0; i < inc.length; i++) {
      const t = this.reactAt.get(inc[i].missileId);
      if (t !== undefined && now >= t) return inc[i];
    }
    return null;
  }

  find(id: number | null): Bandit | null {
    if (id === null) return null;
    const list = this.bandits;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /** Closest bandit (optionally fighters only). */
  closest(fightersOnly = false): Bandit | null {
    let best: Bandit | null = null;
    for (const b of this.bandits) {
      if (fightersOnly && !b.fighter) continue;
      if (!best || b.range < best.range) best = b;
    }
    return best;
  }

  /**
   * GCI vector: a coarse position of `target`, refreshed every `period` s with an error of
   * `err` m (interceptor scrambles, mission 'attack' tasks). Returns false if the target is gone.
   */
  updateGci(target: AircraftEntity | null, now: number, period: number, err: number, rng: () => number): boolean {
    if (!target || !target.alive) {
      this.gciId = null;
      return false;
    }
    if (this.gciId !== target.id || now - this.gciTime > period) {
      this.gciId = target.id;
      this.gciTime = now;
      const a = rng() * Math.PI * 2;
      const r = err * Math.sqrt(rng());
      this.gciPos.copy(target.position).add(_rel.set(Math.cos(a) * r, (rng() - 0.5) * err * 0.2, Math.sin(a) * r));
      this.gciVel.copy(target.velocity);
    }
    return true;
  }

  /** GCI position dead-reckoned to `now`. */
  gciEstimate(now: number, out: Vector3): Vector3 {
    return out.copy(this.gciPos).addScaledVector(this.gciVel, Math.max(0, now - this.gciTime));
  }

  private alloc(e: AircraftEntity): Bandit {
    const b = this.pool.pop() ?? {
      id: 0,
      ent: e,
      pos: new Vector3(),
      vel: new Vector3(),
      range: 0,
      own: false,
      visual: false,
      sensor: false,
      threat: 0,
      fighter: true,
    };
    b.id = e.id;
    b.ent = e;
    b.own = false;
    b.visual = false;
    b.sensor = false;
    b.threat = 0;
    return b;
  }

  private gciError(id: number, range: number, now: number, rng: () => number): Vector3 {
    let s = this.errors.get(id);
    if (!s) {
      s = { v: new Vector3(), t: now };
      this.errors.set(id, s);
    }
    const mag = 500 + 0.04 * range;
    const dt = Math.min(1, now - s.t);
    s.t = now;
    // random walk, pulled back so it stays around `mag`
    s.v.x += (rng() - 0.5) * mag * 0.6 * dt - s.v.x * 0.1 * dt;
    s.v.z += (rng() - 0.5) * mag * 0.6 * dt - s.v.z * 0.1 * dt;
    s.v.y += (rng() - 0.5) * mag * 0.15 * dt - s.v.y * 0.1 * dt;
    const l = s.v.length();
    if (l > mag * 1.5) s.v.multiplyScalar((mag * 1.5) / l);
    return s.v;
  }

  private lineOfSight(ac: AircraftEntity, e: AircraftEntity, world: SimWorld, now: number): boolean {
    let c = this.losCache.get(e.id);
    if (!c) {
      c = { t: -99, ok: true };
      this.losCache.set(e.id, c);
    }
    if (now - c.t > 0.5) {
      c.t = now;
      c.ok = world.terrain.lineOfSight(ac.position, e.position);
    }
    return c.ok;
  }
}
