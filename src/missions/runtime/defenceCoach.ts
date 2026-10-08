/**
 * F35-A — the defence coach (MissionScript.defenceCoach; the t05 lesson).
 *
 * Follows every missile fired at the player, from launch to its end, and samples what the player
 * did in its end game (the last ~8 s): beam (moving across the radar's line of sight), flying at it,
 * running from it, CMS presses, g. When it ends, one HUD call-out says how and why:
 *   - defeated: chaff (a radar missile seduced), flares (a heat-seeker seduced), the notch (the
 *     radar lost the track: beam and clutter, or the terrain), outflown (it missed: couldn't turn);
 *   - hit: the first thing that went wrong, in the order the lesson teaches it (ran, flew at it,
 *     chaff empty, no CMS, CMS held / mashed; a heat-seeker: no CMS late, no hard turn across it), else
 *     "some get through".
 * The order and the advice follow the measured defence table (2026-10-08, stack/sam-defence-advice):
 * beam + a CMS press every 2–3 s from ~6 s is the defence; running loses; mashing wears the chaff out.
 * Against the heat-seeker the press late matters most (48 rounds each: CMS alone 5 hit, the turn
 * across it alone 12, nothing 15), then the turn.
 *
 * Every record also goes to MissionState.missileLog, which 'missile_drill' objectives count.
 */
import type { AircraftEntity } from '../../sim/entities';
import type { MissionState } from './state';

/**
 * How a missile fired at the player ended. 'void': it ended within MIN_FLIGHT of launch (into the
 * ground, the Sky Tower…): nothing the player did, neither counted nor called out. 'short': it missed
 * without ever reaching its end game (a long shot that fell short): called out, never a drill's defeat.
 */
export type MissileOutcome = 'chaff' | 'flares' | 'notch' | 'outflown' | 'short' | 'hit' | 'void';
/** The first fault behind a hit. */
export type DefenceFault = 'ran' | 'no_beam' | 'empty' | 'no_cms' | 'mashed' | 'ir_no_cms' | 'ir_no_turn' | 'unlucky';

export interface MissileRecord {
  missileId: number;
  /** Mission group of the site / aircraft that fired it. */
  group: string | null;
  guidance: 'radar' | 'ir';
  launchT: number;
  /** -1 while it flies. */
  endT: number;
  outcome: MissileOutcome | null;
  fault: DefenceFault | null;
  /** The player's height above the ground when it ended (m). */
  agl: number;
}

/** A missile that ended sooner than this after launch (s) was never a threat ('void'). */
export const MIN_FLIGHT = 2;
/** End game: the seconds to impact from which the coach watches the defence. */
export const COACH_WINDOW = 8;
/** CMS events closer together than this (s) are one press (a press drops a two-decoy salvo, 0.15 s apart). */
const PRESS_GAP = 0.4;
/** A press sooner than this after the previous one (s) is mashing / holding the button. */
export const MASH_GAP = 1.2;

export const COACH_TEXT: Record<MissileOutcome | DefenceFault, string> = {
  chaff: 'DEFEATED — beam and chaff',
  flares: 'DEFEATED — flares',
  notch: 'DEFEATED — the radar lost you: notch',
  outflown: 'DEFEATED — it couldn\'t follow you',
  short: 'It fell short: a long shot, out of reach',
  hit: 'PRACTICE HIT',
  void: '',
  ran: 'HIT — running loses, it\'s faster. Beam it',
  no_beam: 'HIT — you flew at it. Turn 90°: beam it',
  empty: 'HIT — chaff empty: one press every 2–3 s',
  no_cms: 'HIT — no CMS. A press every 2–3 s from ~6 s',
  mashed: 'HIT — CMS mashed: one press every 2–3 s',
  ir_no_cms: 'HIT — heat-seeker: CMS late, in the last 3 s',
  ir_no_turn: 'HIT — heat-seeker: turn hard across it',
  unlucky: 'HIT — good defence, some still get through',
};

interface Watch {
  rec: MissileRecord;
  /** The radar guiding it (a site, or the launching jet). */
  guiderId: number;
  beam: number;
  hot: number;
  cold: number;
  samples: number;
  /** Sim time it entered the end game (-1 = not yet). */
  endgameAt: number;
}

export class DefenceCoach {
  private readonly watches = new Map<number, Watch>();
  /** Times of the player's CMS presses (recent ones). */
  private readonly presses: number[] = [];
  private lastDecoy = -99;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly s: MissionState) {}

  attach(): void {
    const ev = this.s.events;
    this.offs.push(
      ev.on('munition:launch', (e) => {
        if (!this.live()) return;
        const p = this.s.player;
        if (!p || e.targetId !== p.id || e.shooter.team === p.team) return;
        const m = e.missile;
        if (m.def.category === 'bomb') return;
        const rec: MissileRecord = {
          missileId: m.id,
          group: (e.shooter as { groupId?: string }).groupId ?? null,
          guidance: m.def.guidance === 'ir' ? 'ir' : 'radar',
          launchT: this.s.time,
          endT: -1,
          outcome: null,
          fault: null,
          agl: 0,
        };
        this.s.missileLog.push(rec);
        this.watches.set(m.id, { rec, guiderId: e.shooter.id, beam: 0, hot: 0, cold: 0, samples: 0, endgameAt: -1 });
      }),
      ev.on('countermeasure', (e) => {
        if (!this.live()) return;
        const p = this.s.player;
        if (!p || e.ownerId !== p.id) return;
        const t = this.s.time;
        if (t - this.lastDecoy > PRESS_GAP) this.presses.push(t);
        this.lastDecoy = t;
        while (this.presses.length > 64) this.presses.shift();
      }),
      ev.on('munition:end', (e) => {
        if (!this.live()) return;
        const w = this.watches.get(e.missile.id);
        if (!w) return;
        this.watches.delete(e.missile.id);
        const m = e.missile as typeof e.missile & { decoyed?: boolean; trackBroken?: boolean };
        const hit = (e.reason === 'hit' || e.reason === 'proximity') && !m.decoyed;
        let outcome: MissileOutcome;
        if (this.s.time - w.rec.launchT < MIN_FLIGHT && !hit) outcome = 'void';
        else if (hit) outcome = 'hit';
        else if (m.decoyed) outcome = w.rec.guidance === 'ir' ? 'flares' : 'chaff';
        else if (m.trackBroken && w.rec.guidance === 'radar') outcome = 'notch';
        // a radar round that missed with chaff in the gate: the chaff spoiled its aim (sim/sam/endgame.ts)
        else if (w.rec.guidance === 'radar' && this.pressesIn(w).length > 0) outcome = 'chaff';
        else if (w.endgameAt < 0) outcome = 'short';
        else outcome = 'outflown';
        this.finish(w, outcome);
      }),
    );
  }

  detach(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.watches.clear();
  }

  /** Our mission is still the one running (the event bus outlives a torn-down mission). */
  private live(): boolean {
    return !this.s.disposed && !!this.s.world;
  }

  /** Mission logic tick (~10 Hz): sample the defence of every missile in its end game. */
  update(): void {
    const p = this.s.player;
    if (!p || !p.alive || this.watches.size === 0) return;
    const w0 = this.s.world;
    for (const w of this.watches.values()) {
      const m = w0.getEntity(w.rec.missileId);
      if (!m || !m.alive) continue;
      if (endgameTti(p, m.position, m.velocity) > COACH_WINDOW) continue;
      if (w.endgameAt < 0) w.endgameAt = this.s.time;
      // aspect to the guiding radar (a heat-seeker: to the missile itself)
      const g = w.rec.guidance === 'radar' ? w0.getEntity(w.guiderId) : null;
      const ref = g && g.alive ? g.position : m.position;
      const dx = p.position.x - ref.x;
      const dz = p.position.z - ref.z;
      const d = Math.hypot(dx, dz) || 1;
      const v = Math.hypot(p.velocity.x, p.velocity.z) || 1;
      // + = opening from the radar, − = closing on it
      const radial = (p.velocity.x * dx + p.velocity.z * dz) / d / v;
      if (radial > 0.6) w.cold++;
      else if (radial < -0.6) w.hot++;
      else w.beam++;
      w.samples++;
    }
  }

  private finish(w: Watch, outcome: MissileOutcome): void {
    const p = this.s.player;
    const rec = w.rec;
    rec.endT = this.s.time;
    rec.outcome = outcome;
    rec.agl = p ? p.flight.agl : 0;
    if (outcome === 'void') return;
    if (outcome === 'hit') rec.fault = this.fault(w);
    // a hit says why; a defeat says how
    const text = outcome === 'hit' ? COACH_TEXT[rec.fault ?? 'unlucky'] : COACH_TEXT[outcome];
    this.s.hud(text, outcome === 'hit' ? 'bad' : outcome === 'short' ? 'info' : 'good', 4);
  }

  /** The player's CMS presses in this missile's end game. */
  private pressesIn(w: Watch): number[] {
    const from = w.endgameAt >= 0 ? w.endgameAt : w.rec.launchT;
    const to = w.rec.endT >= 0 ? w.rec.endT : this.s.time;
    return this.presses.filter((t) => t >= from - 0.5 && t <= to);
  }

  /** The first thing that went wrong in the end game (the order the lesson teaches). */
  private fault(w: Watch): DefenceFault {
    const n = Math.max(1, w.samples);
    if (w.rec.guidance === 'ir') {
      if (this.pressesIn(w).length === 0) return 'ir_no_cms';
      return w.beam / n < 0.5 ? 'ir_no_turn' : 'unlucky';
    }
    if (w.cold / n > 0.5) return 'ran';
    if (w.hot / n > 0.5) return 'no_beam';
    const ps = this.pressesIn(w);
    if (ps.length === 0) return this.s.player && this.s.player.chaff <= 0 ? 'empty' : 'no_cms';
    let mashed = 0;
    for (let i = 1; i < ps.length; i++) if (ps[i] - ps[i - 1] < MASH_GAP) mashed++;
    if (ps.length >= 4 && mashed >= ps.length / 2) return 'mashed';
    return 'unlucky';
  }
}

/** Seconds to impact of a missile at `pos` moving at `vel` on the jet (Infinity when it isn't closing). */
function endgameTti(p: AircraftEntity, pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }): number {
  const dx = p.position.x - pos.x;
  const dy = p.position.y - pos.y;
  const dz = p.position.z - pos.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const vc = ((vel.x - p.velocity.x) * dx + (vel.y - p.velocity.y) * dy + (vel.z - p.velocity.z) * dz) / Math.max(1, d);
  return vc > 20 ? d / vc : Infinity;
}

/** The drill's missiles: fired by `groups` at or after `since` (when the drill opened) and ended. */
export function drillRecords(s: MissionState, groups: string[], since: number, guidance?: 'radar' | 'ir'): MissileRecord[] {
  return s.missileLog.filter((r) => r.endT >= 0 && r.launchT >= since && r.group !== null && groups.includes(r.group) && (!guidance || r.guidance === guidance));
}

/** A defeat a drill counts: the player beat it in its end game (not a void round, not a long shot that fell short). */
export function isDrillDefeat(r: MissileRecord): boolean {
  return r.outcome === 'chaff' || r.outcome === 'flares' || r.outcome === 'notch' || r.outcome === 'outflown';
}
