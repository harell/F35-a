/**
 * F35-A — URL parameters that only exist with the test hooks (dev server / VITE_TEST_HOOKS=1, see
 * TEST_HOOKS in core/data.ts). Kept out of Game.ts so they can be unit tested without a renderer.
 */
import type { TimeOfDay, Weather } from '../core/types';
import { TIMES_OF_DAY, WEATHERS, type InstantConditions } from '../missions';

/**
 * `?seed=<n>`: a fixed combat RNG seed for every mission started in this page, so a browser run
 * reproduces (#66). The in-game combat system otherwise seeds each sortie from crypto.getRandomValues,
 * and two runs of the same mission diverge within seconds (draw-call reads at the same game time
 * differed up to 3×). Returns null when the test hooks are off or the value isn't an unsigned integer.
 */
export function testSeed(params: URLSearchParams, testHooks: boolean): number | null {
  if (!testHooks) return null;
  const v = params.get('seed')?.trim();
  if (!v || !/^\d{1,10}$/.test(v)) return null;
  const n = Number(v);
  return n <= 0xffff_ffff ? n : null;
}

/**
 * Brain options for `__f35.autopilot(true)`. With `?seed=` the brain gets that seed too: unseeded, its
 * seed comes from a counter shared by every brain made in the page, so a mission flown after others in
 * the same page would fly a different autopilot than the same mission flown first.
 */
export function autopilotBrainOpts(seed: number | null): { skill: number; seed?: number } {
  return seed === null ? { skill: 0.9 } : { skill: 0.9, seed };
}

/**
 * The frame loop's fixed-step accumulator after a frame of `dt` seconds. A held clock (`?seed=`,
 * `__f35.hold()`) never accumulates: only simulate() steps the sim.
 */
export function frameAccumulator(acc: number, dt: number, held: boolean): number {
  return held ? 0 : acc + dt;
}

/**
 * Whether the frame loop copies the touch controls into the player's jet: not under the autopilot, and
 * not while the clock is held (simulate() feeds the controls per step, and frames before it must not
 * leave an input on the jet that depends on how many frames ran).
 */
export function frameTakesControls(autopilot: boolean, held: boolean): boolean {
  return !autopilot && !held;
}

/**
 * `?tod=<dawn|day|dusk|night>&weather=<clear|scattered|overcast>`: the time of day and weather of an
 * Instant Action mission flown by `?mission=ia_<mode>_<theatre>` (missionById's conditions; #118).
 * Unknown values are left out and listed in `invalid` (the caller warns), so a typo flies the default
 * rather than nothing. Empty when the test hooks are off.
 */
export function testConditions(params: URLSearchParams, testHooks: boolean): { conditions: InstantConditions; invalid: string[] } {
  const conditions: InstantConditions = {};
  const invalid: string[] = [];
  if (!testHooks) return { conditions, invalid };
  const tod = params.get('tod')?.trim().toLowerCase();
  if (tod) {
    if ((TIMES_OF_DAY as readonly string[]).includes(tod)) conditions.timeOfDay = tod as TimeOfDay;
    else invalid.push(`tod=${tod} (${TIMES_OF_DAY.join('|')})`);
  }
  const weather = params.get('weather')?.trim().toLowerCase();
  if (weather) {
    if ((WEATHERS as readonly string[]).includes(weather)) conditions.weather = weather as Weather;
    else invalid.push(`weather=${weather} (${WEATHERS.join('|')})`);
  }
  return { conditions, invalid };
}
