/**
 * Report how the hand-placed Auckland positions sit against the real LINZ coastline, and suggest
 * the nearest point with a margin for the ones on the wrong side of it.
 *
 *   npx vite-node tools/linz/landmarks.ts [margin m = 50]
 *
 * Checks the landmarks (src/core/auckland.ts AKL_LANDMARKS: on land unless their `site` says
 * 'water' or 'shore'; tests/world-landmarks.test.ts asserts the same), the named mission positions
 * (src/missions/content/common.ts P) and the vertices of the hand-traced roads
 * (src/world/scenery/motorways.ts). Signed distance: + land, − water (m), measured to the same
 * coast segments the terrain uses (aucklandMapData: the LINZ rings plus the crater lakes).
 * The suggestions are a starting point: review every move by hand (a coast road or a beach is
 * meant to sit on the shore, a bridge abutment along its deck, …).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { AKL_LANDMARKS, geoToWorld, worldToGeo } from '../../src/core/auckland';
import { P } from '../../src/missions/content/common';
import { HAND_ARTERIALS, HAND_MOTORWAYS } from '../../src/world/scenery/motorways';
import { aucklandMapData } from '../../src/world/terrain/theaters/auckland';
import { setAucklandLinz } from '../../src/world/terrain/theaters/aucklandLinz';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MARGIN = Number(process.argv[2] ?? 50);

setAucklandLinz(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(HERE, '../../src/world/terrain/data/auckland-linz.bin')))));
const map = aucklandMapData();

/** Coast segments within `r` m of (x, z) (the full set is ≈ 100 k pieces). */
function localSegments(x: number, z: number, r: number): Float32Array {
  const s = map.segments;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    if (Math.min(s[i], s[i + 2]) > x + r || Math.max(s[i], s[i + 2]) < x - r) continue;
    if (Math.min(s[i + 1], s[i + 3]) > z + r || Math.max(s[i + 1], s[i + 3]) < z - r) continue;
    out.push(s[i], s[i + 1], s[i + 2], s[i + 3]);
  }
  return Float32Array.from(out);
}

function dist(segs: Float32Array, x: number, z: number): number {
  let best = Infinity;
  for (let s = 0; s < segs.length; s += 4) {
    const ax = segs[s];
    const az = segs[s + 1];
    const dx = segs[s + 2] - ax;
    const dz = segs[s + 3] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, (ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2);
  }
  return Math.sqrt(best);
}

const SEARCH = 4000;

/** Signed coast distance (m, + land); ±SEARCH when the coast is farther than that. */
export function signedCoast(x: number, z: number, segs = localSegments(x, z, SEARCH)): number {
  return (map.isLand(x, z) ? 1 : -1) * Math.min(SEARCH, dist(segs, x, z));
}

/** Nearest point (10 m rings, 2° rays) whose signed distance is ≥ margin (land) or ≤ −margin (water). */
function nearest(x: number, z: number, margin: number, land: boolean): { x: number; z: number; moved: number } | null {
  const segs = localSegments(x, z, SEARCH + margin);
  for (let r = 10; r <= SEARCH - margin; r += 10)
    for (let a = 0; a < 360; a += 2) {
      const px = x + Math.sin((a * Math.PI) / 180) * r;
      const pz = z - Math.cos((a * Math.PI) / 180) * r;
      const d = signedCoast(px, pz, segs);
      if (land ? d >= margin : d <= -margin) return { x: px, z: pz, moved: r };
    }
  return null;
}

const fmt = (v: number) => v.toFixed(0).padStart(6);

/** wantLand: true = on land ≥ MARGIN inland, false = in the water, null = informative only. */
function report(label: string, x: number, z: number, wantLand: boolean | null) {
  const d = signedCoast(x, z);
  const ok = wantLand === null || (wantLand ? d >= MARGIN : d < 0);
  let line = `${ok ? '  ' : '✗ '}${label.padEnd(34)} x ${fmt(x)} z ${fmt(z)}  coast ${fmt(d)} m`;
  if (!ok && wantLand !== null) {
    const n = nearest(x, z, MARGIN, wantLand);
    if (n) {
      const g = worldToGeo(n.x, n.z);
      line += `  → lat ${g.lat.toFixed(5)} lon ${g.lon.toFixed(5)} (x ${fmt(n.x)} z ${fmt(n.z)}, moved ${n.moved} m)`;
    } else line += '  → nothing within the search radius';
  }
  console.log(line);
}

console.log(`Landmarks (✗: closer than ${MARGIN} m to the coast or in the water; site 'water' must be water, 'shore' is informative)`);
for (const l of AKL_LANDMARKS) {
  const p = geoToWorld(l.lat, l.lon);
  report(`${l.id} [${l.site ?? 'land'}]`, p.x, p.z, l.site === 'shore' ? null : l.site !== 'water');
}

console.log('\nMission positions (common.ts P; informative: ships and open-water points belong in the water)');
for (const [k, p] of Object.entries(P)) report(k, p.x, p.z, null);

console.log(`\nHand-traced road vertices in the water (motorways may cross on bridges / causeways)`);
for (const r of [...HAND_MOTORWAYS, ...HAND_ARTERIALS])
  r.ll.forEach(([lat, lon], i) => {
    const p = geoToWorld(lat, lon);
    if (signedCoast(p.x, p.z) < 0) report(`${r.name} #${i}`, p.x, p.z, HAND_ARTERIALS.includes(r) ? true : null);
  });
