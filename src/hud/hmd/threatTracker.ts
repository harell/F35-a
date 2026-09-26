/**
 * Missile-defeat bookkeeping for the HMD (pure logic, unit tested).
 *
 * The DAS/MAWS list (`player.incoming`) only holds missiles that can still hit the jet (sim/sensors/
 * maws.ts). The HUD remembers which missiles it has shown in the MISSILE warning and reports a
 * "MISSILE DEFEATED" when one of them
 *   - ends without hitting: 'munition:end' aimed at the player with reason decoyed / selfdestruct /
 *     ground / water (the sim reports the ORIGINAL target even when a flare/chaff seduced it), or
 *   - is still flying but dropped off the warning list for good (guidance broken, decoyed, overshot,
 *     out of energy) — confirmed after a short debounce so a missile that re-acquires is not
 *     announced by mistake.
 * A hit / proximity detonation on the player is never reported as defeated. Fixed-size arrays only.
 */

/** Minimal view of an incoming-missile entry (sim/entities IncomingMissile). */
export interface IncomingLike {
  missileId: number;
  bearing: number;
}

export type MissileEndReason = 'hit' | 'proximity' | 'ground' | 'water' | 'selfdestruct' | 'decoyed';

const CAP = 16;
/** Seconds a vanished (still flying) missile must stay off the list before it counts as defeated. */
export const DEFEAT_CONFIRM = 0.25;
/** Seconds the "MISSILE DEFEATED" cue stays up. */
export const DEFEAT_SHOW = 2;
/** Seconds a defeated missile's arrow stays (crossed out) on the threat ring. */
export const DEFEAT_MARK = 1.2;

export interface DefeatMark {
  bearing: number;
  age: number;
  active: boolean;
}

export class ThreatTracker {
  /** Missiles currently (or very recently) on the warning list. */
  private readonly ids = new Int32Array(CAP).fill(-1);
  private readonly brg = new Float32Array(CAP);
  /** > 0 while the missile is off the list but still flying (debounce timer, s). */
  private readonly gone = new Float32Array(CAP);
  /** Missiles already resolved (announced as defeated, or hit us) — never announce twice. */
  private readonly done = new Int32Array(CAP).fill(-1);
  private doneIdx = 0;

  /** Seconds since the last defeat (large = none). */
  defeatAge = 99;
  /** Missiles defeated since the last reset. */
  defeatedCount = 0;
  /** Crossed-out arrows on the threat ring. */
  readonly marks: DefeatMark[] = Array.from({ length: 4 }, () => ({ bearing: 0, age: 99, active: false }));

  reset(): void {
    this.ids.fill(-1);
    this.gone.fill(0);
    this.done.fill(-1);
    this.doneIdx = 0;
    this.defeatAge = 99;
    this.defeatedCount = 0;
    for (const m of this.marks) m.active = false;
  }

  /** True while the "MISSILE DEFEATED" cue should show. */
  get showing(): boolean {
    return this.defeatAge < DEFEAT_SHOW;
  }

  /**
   * Per frame. `incoming` = player.incoming; `alive(id)` = is that missile entity still flying;
   * `distance(id)` = its distance to the player (m) or Infinity.
   */
  update(incoming: readonly IncomingLike[], alive: (id: number) => boolean, dt: number, distance?: (id: number) => number): void {
    this.defeatAge += dt;
    for (const m of this.marks) {
      if (!m.active) continue;
      m.age += dt;
      if (m.age > DEFEAT_MARK) m.active = false;
    }
    // missiles that left the list
    for (let i = 0; i < CAP; i++) {
      const id = this.ids[i];
      if (id < 0) continue;
      let listed = false;
      for (let k = 0; k < incoming.length; k++) {
        if (incoming[k].missileId === id) {
          listed = true;
          this.brg[i] = incoming[k].bearing;
          break;
        }
      }
      if (listed) {
        this.gone[i] = 0;
        continue;
      }
      if (this.isDone(id)) {
        this.ids[i] = -1;
        continue;
      }
      if (!alive(id)) {
        // ended: 'munition:end' tells how (handled in onMunitionEnd); forget it after a moment
        this.gone[i] += dt;
        if (this.gone[i] > 1) this.ids[i] = -1;
        continue;
      }
      // still flying but no longer a threat: out of MAWS range is NOT a defeat (it may come back)
      const d = distance ? distance(id) : 0;
      if (d > 14_000) {
        this.ids[i] = -1;
        continue;
      }
      this.gone[i] += dt;
      if (this.gone[i] >= DEFEAT_CONFIRM) this.defeat(i);
    }
    // new / refreshed entries
    for (let k = 0; k < incoming.length; k++) {
      const id = incoming[k].missileId;
      if (this.indexOf(id) >= 0 || this.isDone(id)) continue;
      const slot = this.freeSlot();
      this.ids[slot] = id;
      this.brg[slot] = incoming[k].bearing;
      this.gone[slot] = 0;
    }
  }

  /** 'munition:end' handler. */
  onMunitionEnd(missileId: number, targetId: number | null, reason: MissileEndReason, playerId: number | null): void {
    if (playerId === null || targetId !== playerId) return;
    const i = this.indexOf(missileId);
    if (reason === 'hit' || reason === 'proximity') {
      // it got us: never "defeated"
      this.markDone(missileId);
      if (i >= 0) this.ids[i] = -1;
      return;
    }
    if (i < 0 || this.isDone(missileId)) return; // never shown on the warning: nothing to confirm
    this.defeat(i);
  }

  private defeat(i: number): void {
    const id = this.ids[i];
    this.markDone(id);
    this.ids[i] = -1;
    this.defeatAge = 0;
    this.defeatedCount++;
    let slot = this.marks[0];
    for (const m of this.marks) {
      if (!m.active) {
        slot = m;
        break;
      }
      if (m.age > slot.age) slot = m;
    }
    slot.active = true;
    slot.age = 0;
    slot.bearing = this.brg[i];
  }

  private indexOf(id: number): number {
    for (let i = 0; i < CAP; i++) if (this.ids[i] === id) return i;
    return -1;
  }

  private freeSlot(): number {
    for (let i = 0; i < CAP; i++) if (this.ids[i] < 0) return i;
    // full: reuse the one that has been gone the longest
    let best = 0;
    for (let i = 1; i < CAP; i++) if (this.gone[i] > this.gone[best]) best = i;
    return best;
  }

  private isDone(id: number): boolean {
    for (let i = 0; i < CAP; i++) if (this.done[i] === id) return true;
    return false;
  }

  private markDone(id: number): void {
    if (this.isDone(id)) return;
    this.done[this.doneIdx] = id;
    this.doneIdx = (this.doneIdx + 1) % CAP;
  }
}
