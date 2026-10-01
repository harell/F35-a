/* F35-A — service worker (offline play after the first visit).
 *
 *  - versioned caches: "f35a-precache-<VERSION>" (app shell, icons, voice clips) and
 *    "f35a-runtime-<VERSION>" (everything else fetched later: hashed JS/CSS chunks, workers, textures);
 *    older f35a-* caches are deleted on activate
 *  - install: precache '/', index.html, the manifest and icons, then read index.html to discover the
 *    hashed bundle files (Vite writes them there) and precache those; voice clips are precached if
 *    present (missing clips are skipped). Large optional assets only some devices use (ON_DEMAND: the
 *    high tier's HD terrain) are never precached; they are cached on first use like other hashed files
 *  - navigation requests: network-first (fresh deploys win), falling back to the cached shell
 *  - hashed bundle files (assets/*-<hash>.*): cache-first, filled on demand (the URL changes with the content)
 *  - un-hashed public files (audio/…, textures/…, icons/…, the manifest): stale-while-revalidate — served
 *    from cache instantly, refreshed in the background, so replaced voice clips / textures reach players
 *    on their next load even if VERSION were forgotten
 * Registered from src/main.ts in production builds only.
 * VERSION ends with a content hash of every file under public/audio, public/textures and public/icons
 * plus the manifest; tests/ui-pwa.test.ts recomputes it and fails (printing the new value) whenever an
 * asset changes without the version changing, so every asset change also reinstalls this worker.
 */
const VERSION = '1.1.0-e81f06ef';
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

/** Large optional assets (high quality tier only): never precached, so low / medium devices never download them. */
const ON_DEMAND = /\/auckland-linz-hd-[\w-]+\.bin$/;

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
 * ON_DEMAND assets are left out (they are cached on first use instead).
 */
function referencedAssets(code, bundleUrl) {
  const out = new Set();
  const ext = 'js|mjs|css|ttf|otf|woff2?|png|jpe?g|webp|ktx2|mp3|ogg|m4a|json|bin|wasm';
  const pub = new RegExp(`["'\`(](?:\\./|/)?((?:assets|textures|audio)/[\\w\\-./]+?\\.(?:${ext}))["'\`)]`, 'g');
  const rel = new RegExp(`new URL\\(\\s*["'\`]([\\w\\-.]+\\.(?:${ext}))["'\`]\\s*,\\s*import\\.meta\\.url`, 'g');
  let m;
  while ((m = pub.exec(code))) out.add(scopeUrl(m[1]));
  while ((m = rel.exec(code))) out.add(new URL(m[1], bundleUrl).href);
  return [...out].filter((u) => !ON_DEMAND.test(new URL(u).pathname));
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

/** True for URLs whose content can change without the URL changing (public/ files copied verbatim). */
function isUnhashed(url) {
  const p = url.pathname;
  return /\/(?:audio|textures|icons)\//.test(p) || p.endsWith('.webmanifest');
}

/** Serve from cache immediately (if present) and refresh that cache entry from the network. */
async function staleWhileRevalidate(event) {
  const req = event.request;
  let owner = null;
  let hit;
  for (const name of [PRECACHE, RUNTIME]) {
    const c = await caches.open(name);
    hit = await c.match(req);
    if (hit) {
      owner = c;
      break;
    }
  }
  const refresh = fetch(req, { cache: 'no-cache' })
    .then(async (res) => {
      if (res.ok && res.status === 200 && res.type === 'basic') {
        const c = owner || (await caches.open(RUNTIME));
        await c.put(req, res.clone());
        if (!owner) await trimRuntime();
      }
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(refresh);
    return hit;
  }
  return (await refresh) || Response.error();
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
  if (isUnhashed(url)) {
    event.respondWith(staleWhileRevalidate(event));
    return;
  }
  event.respondWith(cacheFirst(req));
});
