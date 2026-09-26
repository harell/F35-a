/**
 * F35-A UI art — hangar store diagram: top-view F-35A with the loadout's weapons drawn in the internal
 * bays (cyan, stealthy) or on the wing pylons (amber — each external store adds radar cross-section).
 */
import type { LoadoutDef } from '../../core/data';
import type { WeaponId } from '../../core/types';
import { F35_STATIONS, finPath, frameFor, outlinePath } from './planform';

type Store = Exclude<WeaponId, 'gun'>;

/** Visual size (m, exaggerated for legibility): length, width. */
const SIZE: Record<Store, [number, number]> = {
  aim120: [3.1, 0.3],
  aim9x: [2.7, 0.26],
  gbu31: [3.6, 0.5],
  gbu39: [1.7, 0.24],
  aargm: [3.9, 0.3],
};

const AG = new Set<Store>(['gbu31', 'gbu39', 'aargm']);

interface Placed {
  weapon: Store;
  x: number;
  y: number;
  internal: boolean;
}

/**
 * Distribute a loadout over symmetric stations. Each side has one internal bay (x ≈ 0.35…1.25 m):
 * A/G stores and ARMs outboard, AMRAAMs inboard, spread evenly across the bay. External stores go
 * to the wing pylons (heavy inboard, AMRAAM mid, AIM-9X outboard).
 */
export function placeStores(l: LoadoutDef): Placed[] {
  const out: Placed[] = [];
  const S = F35_STATIONS;
  const bay: Store[] = [];
  for (const s of l.stores) if (s.internal) for (let i = 0; i < Math.ceil(s.count / 2); i++) bay.push(s.weapon);
  // missiles inboard (small x), A/G outboard
  bay.sort((a, b) => Number(AG.has(a)) - Number(AG.has(b)));
  const n = bay.length;
  bay.forEach((wpn, j) => {
    const x = 0.35 + ((j + 0.5) * 0.9) / Math.max(1, n);
    const y = (S.bayOuter[1] + S.bayInner[1]) / 2 + (wpn === 'gbu39' ? 0.6 : 0);
    for (const side of [1, -1]) out.push({ weapon: wpn, x: side * x, y, internal: true });
  });
  const pylons: [number, number][] = [S.pylonIn, S.pylonMid, S.pylonOut];
  const taken = new Set<number>();
  const pick = (pref: number[]) => {
    for (const i of pref) if (!taken.has(i)) return i;
    return pref[pref.length - 1];
  };
  for (const s of l.stores) {
    if (s.internal) continue;
    for (let i = 0; i < Math.ceil(s.count / 2); i++) {
      const idx = s.weapon === 'aim9x' ? pick([2, 1, 0]) : s.weapon === 'aim120' ? pick([1, 2, 0]) : pick([0, 1, 2]);
      taken.add(idx);
      const st = pylons[idx];
      for (const side of [1, -1]) out.push({ weapon: s.weapon, x: side * st[0], y: st[1], internal: false });
    }
  }
  return out;
}

export function storesDiagramSvg(l: LoadoutDef, w = 120, h = 120): string {
  const f = frameFor(w, h, 0.03);
  const X = (x: number) => (f.cx + x * f.k).toFixed(2);
  const Y = (y: number) => (f.top + y * f.k).toFixed(2);
  const parts: string[] = [];
  parts.push(`<path d="${outlinePath(f)}" fill="rgba(20,40,52,0.9)" stroke="rgba(170,230,250,0.55)" stroke-width="0.8" stroke-linejoin="round"/>`);
  parts.push(`<path d="${finPath(f)}" fill="rgba(30,60,76,0.9)" stroke="rgba(170,230,250,0.4)" stroke-width="0.6"/>`);
  // weapons bays outline
  const bw = 1.3 * f.k;
  const bh = 4.3 * f.k;
  for (const side of [1, -1]) {
    const bx = f.cx + side * 0.8 * f.k - bw / 2;
    parts.push(`<rect x="${bx.toFixed(2)}" y="${Y(7.6)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="${(0.3 * f.k).toFixed(2)}" fill="rgba(0,0,0,0.35)" stroke="rgba(95,227,255,0.35)" stroke-dasharray="1.5 1.5" stroke-width="0.6"/>`);
  }
  for (const p of placeStores(l)) {
    const [len, wid] = SIZE[p.weapon];
    const x = f.cx + p.x * f.k - (wid * f.k) / 2;
    const y = f.top + (p.y - len / 2) * f.k;
    const col = p.internal ? '#5fe3ff' : '#ffb13d';
    parts.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(wid * f.k).toFixed(2)}" height="${(len * f.k).toFixed(2)}" rx="${((wid * f.k) / 2).toFixed(2)}" fill="${col}" opacity="${p.internal ? 0.9 : 0.95}"/>`,
    );
    if (!p.internal) parts.push(`<line x1="${X(p.x)}" y1="${Y(p.y - 0.5)}" x2="${X(p.x)}" y2="${Y(p.y + 0.5)}" stroke="#3a2a10" stroke-width="0.5"/>`);
  }
  return `<svg class="stores-svg" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${parts.join('')}</svg>`;
}
