/**
 * Friendly sites to defend: the ground groups of the mission's `protect` objectives (the Wiri fuel
 * tanks in Instant Action Defend). Hostile-only filters keep friendly ground targets off every display,
 * so the HMD, the TSD and the tactical map draw each site as ONE friendly symbol at its survivors'
 * centroid with the survivor count ("DEFEND 8/9"). A site is never registered for picking: friendly
 * ground targets can't be designated. Protected aircraft groups (Kiwi, Hammer) are already drawn as
 * friendlies, so only ground groups count.
 */
import type { MissionRunnerApi } from '../../core/contracts';
import type { Team } from '../../core/types';
import type { SimWorld } from '../../sim/api';

export interface ProtectedSite {
  group: string;
  /** Survivors' centroid (world metres). */
  x: number;
  y: number;
  z: number;
  alive: number;
  /** Group size (the objectives' progress total; never below `alive`). */
  total: number;
  /** "DEFEND 8/9" (cached string). */
  label: string;
  /** "8/9" (cached string): the radar inset's short label. */
  count: string;
}

const MAX_SITES = 4;
const pool: ProtectedSite[] = Array.from({ length: MAX_SITES }, () => ({ group: '', x: 0, y: 0, z: 0, alive: 0, total: 0, label: '', count: '' }));
const out: ProtectedSite[] = [];

/** protect objective id → group, per mission definition. */
let cacheDef: unknown = null;
const protectGroupOf = new Map<string, string>();
const groups: string[] = [];
const totals: number[] = [];
const labels = new Map<number, string>();
const counts = new Map<number, string>();

function siteLabel(alive: number, total: number): string {
  const key = alive * 1000 + total;
  let s = labels.get(key);
  if (!s) labels.set(key, (s = 'DEFEND ' + alive + '/' + total));
  return s;
}

function siteCount(alive: number, total: number): string {
  const key = alive * 1000 + total;
  let s = counts.get(key);
  if (!s) counts.set(key, (s = alive + '/' + total));
  return s;
}

/**
 * The live protected ground sites of `team` this frame (shared, reused array: read it before the next
 * call). Empty when the mission has no protect objective on a ground group.
 */
export function protectedSites(mission: MissionRunnerApi | null | undefined, world: SimWorld, team: Team): readonly ProtectedSite[] {
  out.length = 0;
  const def = mission?.def;
  if (!def) return out;
  if (def !== cacheDef) {
    cacheDef = def;
    protectGroupOf.clear();
    for (const o of def.script?.objectives ?? []) if (o.kind === 'protect') protectGroupOf.set(o.id, o.group);
  }
  if (protectGroupOf.size === 0) return out;
  // groups of the objectives this sortie actually runs (difficulty-gated ones are left out)
  groups.length = 0;
  totals.length = 0;
  for (const o of mission.objectives) {
    const g = protectGroupOf.get(o.id);
    if (!g) continue;
    let i = groups.indexOf(g);
    if (i < 0) {
      if (groups.length >= MAX_SITES) continue;
      i = groups.push(g) - 1;
      totals.push(0);
    }
    totals[i] = Math.max(totals[i], o.progress?.total ?? 0);
  }
  for (let i = 0; i < groups.length; i++) {
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const e of world.ground) {
      if (!e.alive || e.team !== team || e.groupId !== groups[i]) continue;
      n++;
      sx += e.position.x;
      sy += e.position.y;
      sz += e.position.z;
    }
    if (n === 0) continue; // an aircraft group, or the site is gone
    const s = pool[out.length];
    s.group = groups[i];
    s.x = sx / n;
    s.y = sy / n;
    s.z = sz / n;
    s.alive = n;
    s.total = Math.max(n, totals[i]);
    s.label = siteLabel(n, s.total);
    s.count = siteCount(n, s.total);
    out.push(s);
  }
  return out;
}
