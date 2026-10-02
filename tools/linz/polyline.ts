/**
 * Shared helpers of the LINZ line bakes (roads.ts, railways.ts): the cached WFS download and
 * polyline geometry in game XZ (m).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { geoToWorld } from '../../src/core/auckland';

export interface Feature {
  properties: Record<string, string | number | boolean | null>;
  geometry: { type: string; coordinates: number[][] | number[][][] };
}
/** A WFS GetFeature as GeoJSON (WGS84), cached in `work`; needs LINZ_API_KEY to download. */
export function fetchWfs(work: string, file: string, typeName: string, cql: string): Feature[] {
  const out = path.join(work, file);
  if (!fs.existsSync(out)) {
    const key = process.env.LINZ_API_KEY;
    if (!key) throw new Error(`${out} is not cached and LINZ_API_KEY is not set (free key: https://data.linz.govt.nz)`);
    const url = `https://data.linz.govt.nz/services;key=${key}/wfs`;
    const q = { service: 'WFS', version: '2.0.0', request: 'GetFeature', outputFormat: 'json', srsName: 'EPSG:4326', typeNames: typeName, cql_filter: cql };
    console.log(`fetching ${file} …`);
    execFileSync('curl', ['-sSfG', url, ...Object.entries(q).flatMap(([k, v]) => ['--data-urlencode', `${k}=${v}`]), '-o', out + '.part']);
    fs.renameSync(out + '.part', out);
  }
  const fc = JSON.parse(fs.readFileSync(out, 'utf8')) as { features: Feature[] };
  console.log(`${file}: ${fc.features.length} features`);
  return fc.features;
}

export type Pt = [number, number];
export const project = (c: number[]): Pt => {
  const p = geoToWorld(c[1], c[0]);
  return [p.x, p.z];
};
/** The polylines of a (Multi)LineString feature in game XZ. */
export const lines = (f: Feature): Pt[][] => (f.geometry.type === 'LineString' ? [f.geometry.coordinates as number[][]] : (f.geometry.coordinates as number[][][])).map((l) => l.map(project));

export function segDist(px: number, pz: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(a[0] + dx * t - px, a[1] + dz * t - pz);
}
export function polyDist(px: number, pz: number, pl: Pt[]): number {
  let d = Infinity;
  for (let i = 0; i + 1 < pl.length; i++) d = Math.min(d, segDist(px, pz, pl[i], pl[i + 1]));
  return d;
}
/** Douglas–Peucker. */
export function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i][0], pts[i][1], pts[a], pts[b]);
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
export function densify(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1];
    const [bx, bz] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}
/** Split a polyline into runs where keep(p) holds, then into tunnel / open runs. */
export function runs(pts: Pt[], flag: (p: Pt, i: number) => number): { pts: Pt[]; flag: number }[] {
  const out: { pts: Pt[]; flag: number }[] = [];
  let cur: Pt[] = [];
  let cf = -2;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const f = flag(p, i);
    if (f !== cf) {
      if (cur.length > 1 && cf >= 0) out.push({ pts: cur, flag: cf });
      // the boundary vertex belongs to both runs (no gap where a road enters a tunnel)
      cur = cur.length && f >= 0 && cf >= 0 ? [cur[cur.length - 1]] : [];
      cf = f;
    }
    cur.push(p);
  }
  if (cur.length > 1 && cf >= 0) out.push({ pts: cur, flag: cf });
  return out;
}

export const keyOf = (p: Pt) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;

/** Merge sections end to end through nodes shared by exactly two sections of the same group. */
export function chain(secs: { group: string; pts: Pt[] }[]): { group: string; pts: Pt[] }[] {
  const at = new Map<string, number[]>();
  secs.forEach((s, i) => {
    for (const p of [s.pts[0], s.pts[s.pts.length - 1]]) {
      const k = keyOf(p);
      const l = at.get(k);
      if (l) l.push(i);
      else at.set(k, [i]);
    }
  });
  const used = new Uint8Array(secs.length);
  const out: { group: string; pts: Pt[] }[] = [];
  const next = (end: Pt, group: string): Pt[] | null => {
    const l = at.get(keyOf(end));
    if (!l || l.length !== 2) return null;
    for (const j of l) {
      if (used[j] || secs[j].group !== group) continue;
      used[j] = 1;
      const p = secs[j].pts;
      return keyOf(p[0]) === keyOf(end) ? p : p.slice().reverse();
    }
    return null;
  };
  secs.forEach((s, i) => {
    if (used[i]) return;
    used[i] = 1;
    let pts = s.pts.slice();
    for (let n = next(pts[pts.length - 1], s.group); n; n = next(pts[pts.length - 1], s.group)) pts = pts.concat(n.slice(1));
    // next() returns a run starting at the shared node: reversed, it ends there
    for (let n = next(pts[0], s.group); n; n = next(pts[0], s.group)) pts = n.slice().reverse().slice(0, -1).concat(pts);
    out.push({ group: s.group, pts });
  });
  return out;
}

/** Local direction of a polyline at vertex i. */
export const dirAt = (pts: Pt[], i: number): Pt => {
  const a = pts[Math.max(0, i - 1)];
  const b = pts[Math.min(pts.length - 1, i + 1)];
  return [b[0] - a[0], b[1] - a[1]];
};
