/**
 * F35-A audio — speed-of-sound delay line for one-shot sounds (pure logic, unit-tested).
 *
 * A distant explosion / SAM launch is heard when its sound front (radius = c·elapsed) reaches
 * the listener's CURRENT position — so a jet racing away hears it later (or never), one racing
 * towards it hears it sooner. Slots and payloads are pre-allocated (no per-frame garbage).
 * Time is sim time, so pausing the game also freezes sounds in flight.
 */
import { SPEED_OF_SOUND } from '../acoustics';

interface Slot<T> {
  active: boolean;
  x: number;
  y: number;
  z: number;
  t0: number;
  /** Give up after this many seconds (source out of earshot). */
  maxWait: number;
  payload: T;
}

export class DelayQueue<T> {
  private readonly slots: Slot<T>[] = [];

  constructor(
    capacity: number,
    makePayload: () => T,
    private readonly c = SPEED_OF_SOUND,
  ) {
    for (let i = 0; i < capacity; i++) this.slots.push({ active: false, x: 0, y: 0, z: 0, t0: 0, maxWait: 0, payload: makePayload() });
  }

  get pending(): number {
    let n = 0;
    for (const s of this.slots) if (s.active) n++;
    return n;
  }

  /**
   * Reserve a slot for a sound emitted at (x,y,z) at time t0. Returns the payload object to
   * fill in. When full, the oldest pending sound is replaced.
   */
  push(x: number, y: number, z: number, t0: number, maxWait: number): T {
    let slot: Slot<T> | null = null;
    let oldest: Slot<T> | null = null;
    for (const s of this.slots) {
      if (!s.active) {
        slot = s;
        break;
      }
      if (!oldest || s.t0 < oldest.t0) oldest = s;
    }
    if (!slot) slot = oldest!;
    slot.active = true;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.t0 = t0;
    slot.maxWait = maxWait;
    return slot.payload;
  }

  /** Fire every sound whose front has reached the listener; `onArrive(payload, distance, lateBy)`. */
  update(now: number, lx: number, ly: number, lz: number, onArrive: (payload: T, distance: number) => void): void {
    for (const s of this.slots) {
      if (!s.active) continue;
      const elapsed = now - s.t0;
      const dx = s.x - lx;
      const dy = s.y - ly;
      const dz = s.z - lz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (elapsed * this.c >= d) {
        s.active = false;
        onArrive(s.payload, d);
      } else if (elapsed > s.maxWait || elapsed < -1) {
        s.active = false; // out of earshot, or the clock jumped back (new mission)
      }
    }
  }

  clear(): void {
    for (const s of this.slots) s.active = false;
  }
}
