/**
 * Hit counters of the mission's protected civil ships that take more than one hit (the escorted
 * tanker, GroundTargetEntity.hitsToSink > 1): "TANKER HITS 1/2" in the HMD's top-left column for the whole
 * sortie (hits taken / hits that sink her), amber once she is hit, red "TANKER SUNK" after.
 * Ordinary civil ships (one hit sinks them) never show one.
 */
import type { SimWorld } from '../../sim/api';
import type { GroundTargetEntity } from '../../sim/entities';
import type { VesselClass } from '../../core/types';
import { isCivilVessel, vesselNoun } from '../../sim/civil/vessels';
import type { HudFrame } from './frame';

export interface VesselCounter {
  readonly ship: GroundTargetEntity;
  /** "TANKER HITS 1/2" / "TANKER SUNK" (cached string). */
  readonly text: string;
  /** 'main' untouched, 'warn' hit, 'danger' sunk. */
  readonly tone: 'main' | 'warn' | 'danger';
}

const MAX = 3;
const texts = new Map<number, string>();
/** Numeric key of the noun (a superyacht's is 4: "YACHT"). */
const CLASS_KEY: Partial<Record<VesselClass, number>> = { container: 1, cruise: 2, tanker: 3 };
const out: { ship: GroundTargetEntity; text: string; tone: VesselCounter['tone'] }[] = [];
const pool = Array.from({ length: MAX }, () => ({ ship: null as unknown as GroundTargetEntity, text: '', tone: 'main' as VesselCounter['tone'] }));

function counterText(g: GroundTargetEntity): string {
  // numeric key: no string built per frame
  const key = (g.vessel ? (CLASS_KEY[g.vessel] ?? 4) : 0) * 1e4 + (g.alive ? g.hits : 99) * 100 + g.hitsToSink;
  let s = texts.get(key);
  if (!s) {
    const noun = vesselNoun(g.vessel).toUpperCase();
    // "HITS": the count is hits taken, not ships or boats left (#115)
    texts.set(key, (s = g.alive ? `${noun} HITS ${g.hits}/${g.hitsToSink}` : `${noun} SUNK`));
  }
  return s;
}

/** The counters to show this frame (shared, reused array: read it before the next call). */
export function vesselCounters(world: SimWorld): readonly VesselCounter[] {
  out.length = 0;
  for (const g of world.ground) {
    if (!isCivilVessel(g) || g.hitsToSink <= 1) continue;
    if (out.length >= MAX) break;
    const c = pool[out.length];
    c.ship = g;
    c.text = counterText(g);
    c.tone = !g.alive ? 'danger' : g.hits > 0 ? 'warn' : 'main';
    out.push(c);
  }
  return out;
}

/** Draw the counters at (x, y) in the top-left column. Returns the next free y. */
export function drawVesselCounters(f: HudFrame, x: number, y: number): number {
  const list = vesselCounters(f.world);
  if (list.length === 0) return y;
  const { pen, pal, L } = f;
  const lh = 14 * L.u;
  pen.g.globalAlpha = 0.4 + 0.6 * f.declutter;
  for (const c of list) {
    const col = c.tone === 'danger' ? pal.danger : c.tone === 'warn' ? pal.warn : pal.main;
    if (!f.occ.hits(x, y - lh / 2, x + L.colW, y + lh / 2, 1)) pen.text(c.text, x, y, col, 12, 'left');
    y += lh;
  }
  pen.g.globalAlpha = 1;
  return y + 4 * L.u;
}
