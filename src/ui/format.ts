/**
 * F35-A UI — pure formatting / presentation helpers (unit-tested in tests/ui-format.test.ts).
 */
import type { CampaignDef, CampaignProgress, MissionDef, MissionResult } from '../core/contracts';
import type { LoadoutDef } from '../core/data';

/** 367.4 s → "6:07"; ≥ 1 h → "1:02:03". */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

export function formatPercent(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

/** 12345 → "12,345" (locale independent). */
export function formatScore(n: number): string {
  const v = Math.round(n);
  const neg = v < 0;
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${s}` : s;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export type GradeTone = 'gold' | 'good' | 'ok' | 'poor' | 'bad';

export function gradeTone(g: MissionResult['grade']): GradeTone {
  switch (g) {
    case 'S':
      return 'gold';
    case 'A':
      return 'good';
    case 'B':
    case 'C':
      return 'ok';
    case 'D':
      return 'poor';
    default:
      return 'bad';
  }
}

/**
 * Stealth rating 0..1 from a loadout's RCS multiplier: 1× (clean) → 100 %, beast mode (40–60×) → ~20–30 %.
 * Logarithmic because detection range scales with RCS^¼.
 */
export function stealthRating(rcsMultiplier: number): number {
  const m = Math.max(1, rcsMultiplier);
  return Math.max(0.05, Math.min(1, 1 - Math.log10(m) / 2.2));
}

/** "4× AIM-120D" style store summary lines grouped by weapon + bay/pylon. */
export function storeLines(l: LoadoutDef, names: Record<string, string>): { text: string; internal: boolean }[] {
  const merged = new Map<string, { weapon: string; count: number; internal: boolean }>();
  for (const s of l.stores) {
    const key = `${s.weapon}|${s.internal}`;
    const e = merged.get(key);
    if (e) e.count += s.count;
    else merged.set(key, { weapon: s.weapon, count: s.count, internal: s.internal });
  }
  return [...merged.values()].map((e) => ({ text: `${e.count}× ${names[e.weapon] ?? e.weapon.toUpperCase()}`, internal: e.internal }));
}

export type MissionCardState = 'locked' | 'open' | 'done';

export function missionState(m: MissionDef, progress: CampaignProgress): MissionCardState {
  if (progress.best[m.id]) return 'done';
  if (m.kind !== 'campaign') return 'open';
  return progress.unlocked.includes(m.id) ? 'open' : 'locked';
}

/** A campaign picker card: missions won of the total; `soon` while the campaign has no missions yet. */
export function campaignStatus(c: CampaignDef, progress: CampaignProgress): { done: number; total: number; soon: boolean } {
  const done = c.missions.filter((m) => progress.best[m.id]).length;
  return { done, total: c.missions.length, soon: c.missions.length === 0 };
}

/** Index of the mission a returning player most likely wants (first unlocked but not yet completed). */
export function suggestedMissionIndex(missions: MissionDef[], progress: CampaignProgress): number {
  let lastOpen = 0;
  for (let i = 0; i < missions.length; i++) {
    const st = missionState(missions[i], progress);
    if (st === 'open') return i;
    if (st !== 'locked') lastOpen = i;
  }
  return lastOpen;
}

/** World extents → nice scale-bar length (m) close to `target` px. */
export function niceScaleLength(metersPerPx: number, targetPx: number): number {
  const raw = metersPerPx * targetPx;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  for (const k of [1, 2, 5, 10]) if (k * pow >= raw * 0.7) return k * pow;
  return 10 * pow;
}
