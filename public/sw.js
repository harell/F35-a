/* F35-A — service worker (offline play after the first visit).
 *
 *  - versioned caches: "f35a-precache-<VERSION>" (app shell, icons, voice clips) and
 *    "f35a-runtime-<VERSION>" (everything else fetched later: hashed JS/CSS chunks, workers, textures);
 *    older f35a-* caches are deleted on activate
 *  - install: precache '/', index.html, the manifest and icons, then read index.html to discover the
 *    hashed bundle files (Vite writes them there) and precache those; voice clips are precached if
 *    present (missing clips are skipped)
 *  - navigation requests: network-first (fresh deploys win), falling back to the cached shell
 *  - same-origin static assets: cache-first, filled on demand
 * Registered from src/main.ts in production builds only. Bump VERSION to force a clean update.
 */
const VERSION = '1.0.0-1';
const PREFIX = 'f35a-';
const PRECACHE = `${PREFIX}precache-${VERSION}`;
const RUNTIME = `${PREFIX}runtime-${VERSION}`;
const RUNTIME_MAX_ENTRIES = 160;

const CORE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon-180.png',
  'icons/icon.svg',
];

/* Must match VoiceId in src/core/types.ts (checked by tests/ui-pwa.test.ts). */
const VOICES = [
  'b_missile', 'b_pull_up', 'b_altitude', 'b_bingo', 'b_fuel_low', 'b_engine_fire', 'b_warning', 'b_over_g',
  'b_aoa', 'b_flares_low', 'b_chaff_low', 'b_hydraulics', 'b_speed',
  'p_fox3', 'p_fox2', 'p_rifle', 'p_magnum', 'p_guns', 'p_splash', 'p_spike', 'p_mud_spike', 'p_defending',
  'p_winchester', 'p_bingo', 'p_copy', 'p_engaged', 'p_target_destroyed',
  'a_bandits', 'a_new_picture', 'a_sam_launch', 'a_good_kill', 'a_mission_complete', 'a_mission_failed',
  'a_objective_complete', 'a_rtb', 'a_eject', 'a_friendly_down',
];

const scopeUrl = (p) => new URL(p, self.registration.scope).href;

/** Relative asset URLs referenced by the built index.html (script src, modulepreload / stylesheet href). */
function bundleAssets(html) {
  const out = new Set();
  const re = /(?:src|href)="([^"#?]+\.(?:js|mjs|css|woff2?|ttf|png|svg|webmanifest))"/g;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1];
    if (/^(?:[a-z]+:)?\/\//i.test(u)) continue; // cross-origin
    out.add(u.replace(/^\//, './'));
  }
  return [...out];
}

/**
 * Asset URLs referenced from inside a JS/CSS bundle: public paths ("textures/…", "audio/…") and
 * files emitted next to the bundle via `new URL('name-hash.ext', import.meta.url)` (workers, fonts).
 */
function referencedAssets(code, bundleUrl) {
  const out = new Set();
  const ext = 'js|mjs|css|ttf|otf|woff2?|png|jpe?g|webp|ktx2|mp3|ogg|m4a|json|bin|wasm';
  const pub = new RegExp(`["'\`(](?:\\./|/)?((?:assets|textures|audio)/[\\w\\-./]+?\\.(?:${ext}))["'\`)]`, 'g');
  const rel = new RegExp(`new URL\\(\\s*["'\`]([\\w\\-.]+\\.(?:${ext}))["'\`]\\s*,\\s*import\\.meta\\.url`, 'g');
  let m;
  while ((m = pub.exec(code))) out.add(scopeUrl(m[1]));
  while ((m = rel.exec(code))) out.add(new URL(m[1], bundleUrl).href);
  return [...out];
}

async function addAll(cache, urls) {
  // individually, so one missing file can't fail the whole install
  await Promise.allSettled(urls.map((u) => cache.add(new Request(scopeUrl(u), { cache: 'reload' }))));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      await addAll(cache, CORE);
      try {
        const res = await fetch(scopeUrl('index.html'), { cache: 'no-cache' });
        if (res.ok) {
          const bundles = bundleAssets(await res.text());
          await addAll(cache, bundles);
          // second level: files the bundles load lazily (terrain worker, HMD font, textures…)
          const nested = new Set();
          for (const b of bundles) {
            if (!/\.(?:js|mjs|css)$/.test(b)) continue;
            const hit = await cache.match(scopeUrl(b));
            if (hit) for (const a of referencedAssets(await hit.text(), scopeUrl(b))) nested.add(a);
          }
          await addAll(cache, [...nested]);
        }
      } catch {
        /* offline during install — runtime caching fills in later */
      }
      await addAll(cache, VOICES.map((v) => `audio/voice/${v}.mp3`));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([PRECACHE, RUNTIME]);
      for (const key of await caches.keys()) if (key.startsWith(PREFIX) && !keep.has(key)) await caches.delete(key);
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {
          /* unsupported */
        }
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function trimRuntime() {
  const cache = await caches.open(RUNTIME);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - RUNTIME_MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

async function networkFirstNavigation(event) {
  const req = event.request;
  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    const res = preload || (await fetch(req));
    if (res && res.ok) {
      const cache = await caches.open(PRECACHE);
      cache.put(scopeUrl('index.html'), res.clone()).catch(() => undefined);
      return res;
    }
    if (res) return res;
  } catch {
    /* offline → shell */
  }
  return (await caches.match(req)) || (await caches.match(scopeUrl('index.html'))) || (await caches.match(scopeUrl('./'))) || Response.error();
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // only cache complete, same-origin, successful responses (no partial audio ranges)
  if (res.ok && res.status === 200 && res.type === 'basic') {
    const copy = res.clone();
    caches
      .open(RUNTIME)
      .then((c) => c.put(req, copy))
      .then(trimRuntime)
      .catch(() => undefined);
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return; // let the network handle partial content
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event));
    return;
  }
  // don't cache the service worker itself or dev-server internals
  if (url.pathname.endsWith('/sw.js') || url.pathname.includes('/@vite') || url.pathname.includes('/node_modules/')) return;
  event.respondWith(cacheFirst(req));
});
