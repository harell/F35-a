/**
 * HD terrain download scope (issue #5): loads an Auckland mission on each quality tier in a fresh
 * browser context and checks, from the network and the service worker's caches, that only the high
 * tier (with the HD terrain setting on) downloads auckland-linz-hd-*.bin. Also reports the Browns
 * Island / Mt Eden summits from the game's own terrain query, the time to start the mission and the
 * HD file's download time on an emulated mid-range connection (--mbps, default 10 Mbit/s, 40 ms RTT).
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node e2e/hd-terrain.mjs [--base=http://localhost:4173/] [--mission=c01] [--mbps=10]
 *
 * Run it against the production build (vite preview): the service worker only registers there.
 */
import { chromium } from 'playwright-core';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }),
);
const base = args.base || 'http://localhost:4173/';
const mission = args.mission || 'c01';
const mbps = Number(args.mbps || 10);
const HD = /auckland-linz-hd-[\w-]+\.bin$/;

const CASES = [
  { name: 'low', query: 'quality=low', expectHd: false },
  { name: 'medium', query: 'quality=medium', expectHd: false },
  { name: 'high', query: 'quality=high', expectHd: true },
  { name: 'high, HD off', query: 'quality=high&hdterrain=0', expectHd: false },
];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

let failures = 0;
for (const c of CASES) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const hdRequests = [];
  const hdTimes = [];
  ctx.on('request', (r) => HD.test(new URL(r.url()).pathname) && hdRequests.push(r.url()));
  ctx.on('requestfinished', (r) => {
    if (!HD.test(new URL(r.url()).pathname)) return;
    const t = r.timing();
    hdTimes.push(t.responseEnd);
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 40,
    downloadThroughput: (mbps * 1e6) / 8,
    uploadThroughput: (mbps * 1e6) / 32,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(`${base}?mission=${mission}&autostart=1&view=chase&${c.query}`, { waitUntil: 'load' });
  let started = true;
  try {
    await page.waitForFunction(() => window.__f35?.state().inMission, null, { timeout: 240_000 });
  } catch {
    started = false;
  }
  const loadS = (Date.now() - t0) / 1000;
  // let the service worker finish installing (it precaches the bundles' lazily referenced assets)
  const cached = await page
    .evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 20_000))]);
      if (!reg) return null;
      await new Promise((r) => setTimeout(r, 3000));
      const out = [];
      for (const k of await caches.keys()) for (const req of await (await caches.open(k)).keys()) out.push(req.url);
      return out;
    })
    .catch(() => null);
  const summits = started
    ? await page.evaluate(() => {
        const t = window.__f35.game.session.world.terrain;
        const max = (cx, cz, r) => {
          let m = -Infinity;
          for (let z = -r; z <= r; z += 8) for (let x = -r; x <= r; x += 8) if (x * x + z * z <= r * r) m = Math.max(m, t.heightAt(cx + x, cz + z));
          return m;
        };
        return { eden: max(190, 3220, 450), browns: max(11870, -2160, 450) };
      })
    : null;
  const hdCached = (cached ?? []).filter((u) => HD.test(new URL(u).pathname));
  const gotHd = hdRequests.length > 0;
  const ok = started && errors.length === 0 && gotHd === c.expectHd && (c.expectHd ? hdRequests.length === 1 : hdCached.length === 0);
  if (!ok) failures++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${c.name.padEnd(13)} mission ${started ? 'started' : 'DID NOT START'} in ${loadS.toFixed(1)} s  ` +
      `HD requests ${hdRequests.length}${hdTimes.length ? ` (${(hdTimes[0] / 1000).toFixed(2)} s download @ ${mbps} Mbit/s)` : ''}  ` +
      `SW cache: ${cached ? `${cached.length} entries, HD ${hdCached.length}` : 'n/a'}  ` +
      (summits ? `summits: Mt Eden ${summits.eden.toFixed(1)} m (LiDAR 194), Browns Island ${summits.browns.toFixed(1)} m (LiDAR 65)` : '') +
      (errors.length ? `  errors: ${errors.join(' | ')}` : ''),
  );
  await ctx.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
