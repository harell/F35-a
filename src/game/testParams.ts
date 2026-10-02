/**
 * F35-A — URL parameters that only exist with the test hooks (dev server / VITE_TEST_HOOKS=1, see
 * TEST_HOOKS in core/data.ts). Kept out of Game.ts so they can be unit tested without a renderer.
 */

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
