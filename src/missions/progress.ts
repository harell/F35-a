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

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // privacy mode / sandboxed iframe
  }
}

/** Fresh progress for a campaign/training list. */
export function defaultProgress(campaign: MissionDef[], training: MissionDef[]): CampaignProgress {
  const unlocked = [...training.map((m) => m.id)];
  if (campaign[0]) unlocked.unshift(campaign[0].id);
  return { unlocked, best: {}, totals: { missions: 0, airKills: 0, groundKills: 0, deaths: 0 } };
}

/** Ensure the always-available missions are unlocked and the shape is sane. */
export function sanitizeProgress(raw: unknown, campaign: MissionDef[], training: MissionDef[]): CampaignProgress {
  const base = defaultProgress(campaign, training);
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
  return {
    unlocked: [...unlocked],
    best,
    totals: { missions: num(t.missions), airKills: num(t.airKills), groundKills: num(t.groundKills), deaths: num(t.deaths) },
  };
}

export function loadProgressFrom(campaign: MissionDef[], training: MissionDef[]): CampaignProgress {
  const st = storage();
  if (!st) return defaultProgress(campaign, training);
  try {
    const txt = st.getItem(PROGRESS_KEY);
    return sanitizeProgress(txt ? JSON.parse(txt) : null, campaign, training);
  } catch {
    return defaultProgress(campaign, training);
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
 * `campaign` is the ordered campaign list used for unlocking.
 */
export function applyResult(p: CampaignProgress, r: MissionResult, campaign: MissionDef[]): CampaignProgress {
  const next: CampaignProgress = {
    unlocked: [...p.unlocked],
    best: { ...p.best },
    totals: { ...p.totals },
  };
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
    const i = campaign.findIndex((m) => m.id === r.missionId);
    if (i >= 0 && i + 1 < campaign.length) {
      const id = campaign[i + 1].id;
      if (!next.unlocked.includes(id)) next.unlocked.push(id);
    }
  }
  return next;
}
