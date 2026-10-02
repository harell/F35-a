/**
 * F35-A — campaign progress (localStorage 'f35a.progress.v1').
 *
 * The first campaign mission and every training mission are always unlocked; completing a
 * campaign mission unlocks the next one. Best score/grade per mission (successful runs, and
 * every survival run) plus career totals.
 */
import type { CampaignProgress, MissionDef, MissionResult } from '../core/contracts';
import { isDeathReason } from './runtime/reasons';
import { gradeRank } from './runtime/scoring';

export const PROGRESS_KEY = 'f35a.progress.v1';

/**
 * Extra, optional progress data kept inside the saved object (outside the CampaignProgress
 * contract): consecutive failures per campaign mission and missions skipped with skipMission().
 * The UI reads them through failStreak() / wasSkipped() — e.g. to offer "Retry on Recruit" /
 * "Skip mission" after repeated failures.
 *
 * The Sky Tower is not in the save: it is never destroyed for good (issue #75 reverses #16), so
 * every sortie stands it up intact. Old saves still carry `skyTowerDown`; sanitizeProgress() drops it.
 */
export interface ProgressExtras {
  failStreak?: Record<string, number>;
  skipped?: string[];
}
type Ext = CampaignProgress & ProgressExtras;

/**
 * Ordered mission lists, one per campaign (src/missions/index.ts CAMPAIGNS). Each campaign's first
 * mission is always unlocked, and completing (or skipping) a mission unlocks the next one of the
 * same campaign. Career totals are shared by every campaign.
 *
 * Everything is keyed by mission id, and ids are unique across campaigns and training, so unlocks,
 * skips and fail streaks never leak from one campaign into another, and the save format is the
 * one-campaign format unchanged: a save from before the second campaign loads as it is, with that
 * campaign's first mission added to `unlocked`.
 */
export type CampaignChains = readonly (readonly MissionDef[])[];

/** The mission after `missionId` in its own campaign (null for a campaign's last mission or a non-campaign id). */
function nextInCampaign(campaigns: CampaignChains, missionId: string): MissionDef | null {
  for (const c of campaigns) {
    const i = c.findIndex((m) => m.id === missionId);
    if (i >= 0) return i + 1 < c.length ? c[i + 1] : null;
  }
  return null;
}

/** Consecutive failed attempts at a mission (0 after a success). */
export function failStreak(p: CampaignProgress, missionId: string): number {
  return (p as Ext).failStreak?.[missionId] ?? 0;
}

/** Mission was skipped (unlocked the next one without a win). */
export function wasSkipped(p: CampaignProgress, missionId: string): boolean {
  return !!(p as Ext).skipped?.includes(missionId);
}

/**
 * Safety valve for a mission the player keeps failing: unlock the next mission of its campaign
 * without a win (returns a new object; the skipped mission keeps no grade).
 */
export function skipMission(p: CampaignProgress, missionId: string, campaigns: CampaignChains): CampaignProgress {
  const src = p as Ext;
  const next: Ext = { unlocked: [...p.unlocked], best: { ...p.best }, totals: { ...p.totals }, failStreak: { ...(src.failStreak ?? {}) }, skipped: [...(src.skipped ?? [])] };
  const after = nextInCampaign(campaigns, missionId);
  if (after && !next.unlocked.includes(after.id)) next.unlocked.push(after.id);
  if (!next.skipped!.includes(missionId)) next.skipped!.push(missionId);
  return next;
}

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // privacy mode / sandboxed iframe
  }
}

/** Fresh progress: every campaign's first mission and all training unlocked. */
export function defaultProgress(campaigns: CampaignChains, training: readonly MissionDef[]): CampaignProgress {
  const unlocked = [...campaigns.flatMap((c) => (c[0] ? [c[0].id] : [])), ...training.map((m) => m.id)];
  return { unlocked, best: {}, totals: { missions: 0, airKills: 0, groundKills: 0, deaths: 0 } };
}

/** Ensure the always-available missions are unlocked and the shape is sane. */
export function sanitizeProgress(raw: unknown, campaigns: CampaignChains, training: readonly MissionDef[]): CampaignProgress {
  const base = defaultProgress(campaigns, training);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<CampaignProgress>;
  const unlocked = new Set<string>(base.unlocked);
  if (Array.isArray(r.unlocked)) for (const id of r.unlocked) if (typeof id === 'string') unlocked.add(id);
  const best: CampaignProgress['best'] = {};
  if (r.best && typeof r.best === 'object') {
    for (const [id, b] of Object.entries(r.best)) {
      if (b && typeof b.score === 'number' && typeof b.grade === 'string' && typeof b.difficulty === 'string') best[id] = { score: b.score, grade: b.grade, difficulty: b.difficulty };
    }
  }
  const t = r.totals ?? base.totals;
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const out: Ext = {
    unlocked: [...unlocked],
    best,
    totals: { missions: num(t.missions), airKills: num(t.airKills), groundKills: num(t.groundKills), deaths: num(t.deaths) },
  };
  const ext = raw as ProgressExtras;
  if (ext.failStreak && typeof ext.failStreak === 'object') {
    out.failStreak = {};
    for (const [id, n] of Object.entries(ext.failStreak)) if (num(n) > 0) out.failStreak[id] = num(n);
  }
  if (Array.isArray(ext.skipped)) out.skipped = ext.skipped.filter((id): id is string => typeof id === 'string');
  // (an old save's `skyTowerDown` is not copied: the tower stands again)
  return out;
}

export function loadProgressFrom(campaigns: CampaignChains, training: readonly MissionDef[]): CampaignProgress {
  const st = storage();
  if (!st) return defaultProgress(campaigns, training);
  try {
    const txt = st.getItem(PROGRESS_KEY);
    return sanitizeProgress(txt ? JSON.parse(txt) : null, campaigns, training);
  } catch {
    return defaultProgress(campaigns, training);
  }
}

export function saveProgressTo(p: CampaignProgress): void {
  const st = storage();
  if (!st) return;
  try {
    st.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* quota / privacy mode */
  }
}

/**
 * Fold a mission result into the progress (returns a new object; the input is not mutated).
 * `campaigns` are the ordered campaign lists: a win unlocks the next mission of its own campaign.
 */
export function applyResult(p: CampaignProgress, r: MissionResult, campaigns: CampaignChains): CampaignProgress {
  const src = p as Ext;
  const next: Ext = {
    unlocked: [...p.unlocked],
    best: { ...p.best },
    totals: { ...p.totals },
    failStreak: { ...(src.failStreak ?? {}) },
  };
  if (src.skipped) next.skipped = [...src.skipped];
  // consecutive failures (the UI can offer Recruit / skip after a few)
  if (r.success) delete next.failStreak![r.missionId];
  else next.failStreak![r.missionId] = (next.failStreak![r.missionId] ?? 0) + 1;
  next.totals.airKills += r.kills.air;
  next.totals.groundKills += r.kills.sam + r.kills.ground;
  if (r.success) next.totals.missions += 1;
  if (!r.success && isDeathReason(r.reason)) next.totals.deaths += 1;

  const survival = r.missionId.startsWith('ia_survival');
  if (r.success || survival) {
    const prev = next.best[r.missionId];
    const better = !prev || r.score > prev.score || (r.score === prev.score && gradeRank(r.grade) > gradeRank(prev.grade));
    if (better) next.best[r.missionId] = { score: r.score, grade: r.grade, difficulty: r.difficulty };
  }

  if (r.success) {
    const after = nextInCampaign(campaigns, r.missionId);
    if (after && !next.unlocked.includes(after.id)) next.unlocked.push(after.id);
  }
  return next;
}
