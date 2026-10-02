/**
 * First-time flow polish (issue #70, playtest 2026-10-02 round 4):
 *  - tilt chosen but no orientation data: Input flies the touch stick, so the hints and c01's text
 *    describe the stick and a toast says tilt is unavailable (4.2-b).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Settings } from '../src/core/types';
import { missionById } from '../src/missions';
import { TILT_UNAVAILABLE_TOAST, currentControlPrefs, followActiveScheme } from '../src/missions/runtime/controlsText';
import { harness } from './missions-helpers';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}
const g = globalThis as unknown as { localStorage?: MemStorage };
let savedStorage: MemStorage | undefined;
const useSettings = (s: Partial<Settings>) => {
  g.localStorage = new MemStorage();
  g.localStorage.setItem('f35a.settings.v1', JSON.stringify(s));
};
beforeAll(() => {
  savedStorage = g.localStorage;
});
afterAll(() => {
  g.localStorage = savedStorage;
  followActiveScheme('stick', 'stick');
});

describe('tilt chosen, no orientation data: the texts describe the stick (4.2-b)', () => {
  it('T01 re-words its STICK hint and c01 its controls hint once Input falls back; a toast says so', () => {
    useSettings({ controlScheme: 'tilt', leftHanded: true });
    expect(followActiveScheme('tilt', 'tilt')).toBeNull(); // tilt flying: no override, no toast
    const t01 = harness(missionById('t01')!);
    t01.run(2);
    expect(t01.runner.hint).toMatch(/tilting the phone/);
    // Input's grace period ran out without a deviceorientation event: it flies the touch stick
    expect(followActiveScheme('tilt', 'stick')).toBe(TILT_UNAVAILABLE_TOAST);
    expect(TILT_UNAVAILABLE_TOAST).toMatch(/tilt unavailable/i);
    t01.run(0.1);
    // the hint already on screen follows (left-handed: the stick is under the left thumb)
    expect(t01.runner.hint).toMatch(/^STICK \(left thumb\)/);
    expect(t01.runner.hint).not.toMatch(/tilt/i);
    // the toast fires once, not every frame
    expect(followActiveScheme('tilt', 'stick')).toBeNull();
    expect(currentControlPrefs()).toEqual({ controlScheme: 'stick', leftHanded: true });

    const c01 = harness(missionById('c01')!);
    let seen = '';
    c01.run(12, () => {
      if (c01.runner.hint?.includes('Climb toward the CAP')) seen = c01.runner.hint;
    });
    expect(seen).toMatch(/^Right thumb THROTTLE, left thumb STICK\. Climb/);

    // the sensor wakes up after all: back to the tilt wording, no toast
    expect(followActiveScheme('tilt', 'tilt')).toBeNull();
    expect(currentControlPrefs()).toEqual({ controlScheme: 'tilt', leftHanded: true });
  });
});
