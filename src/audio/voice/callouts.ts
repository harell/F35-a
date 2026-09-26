/**
 * F35-A audio — situational pilot callouts and "missile defeated" detection (pure logic,
 * unit-tested in tests/audio-callouts.test.ts).
 *
 *  CalloutTracker   RWR spike → pilot "Spike!" (air threat) / "Mud spike!" (SAM / AAA track),
 *                   Betty BINGO → pilot "Bingo fuel, RTB". Rate-limited so they never chatter.
 *  DefeatTracker    a missile that was aimed at the player drops off the MAWS list (notched,
 *                   decoyed, out of energy, guidance lost) or ends with a non-hit reason
 *                   → one positive "missile defeated" cue. A missile that actually hit is not
 *                   celebrated. No allocations per frame (fixed arrays).
 */
import type { VoiceId } from '../../core/types';

/** Minimum seconds between two spike calls of the same kind. */
export const SPIKE_CALL_INTERVAL = 25;
/** Minimum seconds between two bingo calls. */
export const BINGO_CALL_INTERVAL = 90;

export class CalloutTracker {
  private prevAir = false;
  private prevGround = false;
  private lastAir = -Infinity;
  private lastGround = -Infinity;
  private lastBingo = -Infinity;

  reset(): void {
    this.prevAir = this.prevGround = false;
    this.lastAir = this.lastGround = this.lastBingo = -Infinity;
  }

  /**
   * Per frame. `spikeAir` / `spikeGround`: an air / surface emitter tracks the player.
   * Returns a pilot call to queue, or null.
   */
  update(now: number, spikeAir: boolean, spikeGround: boolean): VoiceId | null {
    let out: VoiceId | null = null;
    if (spikeGround && !this.prevGround && now - this.lastGround >= SPIKE_CALL_INTERVAL) {
      this.lastGround = now;
      out = 'p_mud_spike';
    } else if (spikeAir && !this.prevAir && now - this.lastAir >= SPIKE_CALL_INTERVAL) {
      this.lastAir = now;
      out = 'p_spike';
    }
    this.prevAir = spikeAir;
    this.prevGround = spikeGround;
    return out;
  }

  /** Betty BINGO appeared: the pilot calls it on the radio (rate-limited). */
  onBingo(now: number): VoiceId | null {
    if (now - this.lastBingo < BINGO_CALL_INTERVAL) return null;
    this.lastBingo = now;
    return 'p_bingo';
  }
}

/** How long a missile that left the MAWS list has to be reported as a hit before we call it defeated. */
export const DEFEAT_CONFIRM = 0.3;
/** Minimum seconds between two defeated cues (a salvo defeated together gets one cue). */
export const DEFEAT_CUE_GAP = 0.6;

const MAX_TRACK = 16;

export class DefeatTracker {
  /** Missile ids on the MAWS list last frame. */
  private readonly prev = new Int32Array(MAX_TRACK);
  private prevN = 0;
  /** Missiles that left the list, waiting for DEFEAT_CONFIRM: id and time. */
  private readonly pendId = new Int32Array(MAX_TRACK);
  private readonly pendT = new Float64Array(MAX_TRACK);
  private pendN = 0;
  /** Recently resolved ids (hit or already cued) so an id is never cued twice. */
  private readonly done = new Int32Array(MAX_TRACK);
  private doneHead = 0;
  private lastCue = -Infinity;
  private now = 0;
  private hitAt = -Infinity;

  reset(): void {
    this.prevN = this.pendN = 0;
    this.done.fill(-1);
    this.lastCue = -Infinity;
    this.hitAt = -Infinity;
  }

  constructor() {
    this.done.fill(-1);
  }

  private isDone(id: number): boolean {
    for (let i = 0; i < MAX_TRACK; i++) if (this.done[i] === id) return true;
    return false;
  }

  private markDone(id: number): void {
    this.done[this.doneHead] = id;
    this.doneHead = (this.doneHead + 1) % MAX_TRACK;
  }

  private dropPending(id: number): void {
    for (let i = 0; i < this.pendN; i++) {
      if (this.pendId[i] === id) {
        this.pendN--;
        this.pendId[i] = this.pendId[this.pendN];
        this.pendT[i] = this.pendT[this.pendN];
        return;
      }
    }
  }

  private cue(id: number): boolean {
    this.markDone(id);
    this.dropPending(id);
    if (this.now - this.lastCue < DEFEAT_CUE_GAP) return false;
    this.lastCue = this.now;
    return true;
  }

  /**
   * A missile aimed at the player ended (munition:end with targetId = player).
   * Returns true when the defeated cue should play now.
   */
  onEnd(id: number, reason: string): boolean {
    if (this.isDone(id)) return false;
    if (reason === 'hit' || reason === 'proximity') {
      this.markDone(id);
      this.dropPending(id);
      this.hitAt = this.now;
      return false;
    }
    return this.cue(id);
  }

  /** The player took damage now (a hit ends every "defeated" guess made just before it). */
  onPlayerHit(): void {
    this.hitAt = this.now;
  }

  /**
   * Per frame with the ids currently on the player's MAWS list (`count` entries of `ids`).
   * Returns true when the defeated cue should play now.
   */
  update(now: number, ids: ArrayLike<number>, count: number, alive: boolean): boolean {
    this.now = now;
    const n = Math.min(count, MAX_TRACK);
    // ids that vanished since last frame → pending
    for (let i = 0; i < this.prevN; i++) {
      const id = this.prev[i];
      let still = false;
      for (let j = 0; j < n; j++) if (ids[j] === id) still = true;
      if (!still && !this.isDone(id) && this.pendN < MAX_TRACK) {
        this.pendId[this.pendN] = id;
        this.pendT[this.pendN] = now;
        this.pendN++;
      }
    }
    this.prevN = n;
    for (let j = 0; j < n; j++) this.prev[j] = ids[j];

    let fire = false;
    for (let i = this.pendN - 1; i >= 0; i--) {
      const id = this.pendId[i];
      // back on the list (guidance re-acquired) → not defeated
      let back = false;
      for (let j = 0; j < n; j++) if (ids[j] === id) back = true;
      if (back || !alive || this.hitAt >= this.pendT[i] - 0.05) {
        if (!back) this.markDone(id);
        this.dropPending(id);
        continue;
      }
      if (now - this.pendT[i] >= DEFEAT_CONFIRM) {
        if (this.cue(id)) fire = true;
      }
    }
    return fire;
  }
}
