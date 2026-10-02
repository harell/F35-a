/**
 * F35-A — campaign progress (localStorage 'f35a.progress.v1').
 *
 * The first campaign mission and every training mission are always unlocked; completing a
 * campaign mission unlocks the next one. Best score/grade per mission (successful runs) plus
 * career totals.
 */
import type { CampaignProgress, MissionDef, MissionResult } from '../core/contracts';
import { isDeathReason } from './runtime/reasons';
import type { MissionResultExt } from './runtime/resultExt';
import { gradeRank } from './runtime/scoring';

export const PROGRESS_KEY = 'f35a.progress.v1';

/**
 * Extra, optional progress data kept inside the saved object (outside the CampaignProgress
 * contract): consecutive failures per campaign mission, missions skipped with skipMission() and
 * the destroyed Sky Tower. The UI reads them through failStreak() / wasSkipped() — e.g. to offer
 * "Retry on Recruit" / "Skip mission" after repeated failures — and the game through skyTowerRuin().
 */
export interface ProgressExtras {
  failStreak?: Record<string, number>;
  skipped?: string[];
  /** The player brought the Sky Tower down (fall heading, rad): Auckland sorties show its ruin. */
  skyTowerDown?: { fallHeading: number };
}
type Ext = CampaignProgress & ProgressExtras;

/**
 * The Sky Tower's ruin, if it is down in this save (else null). This is the one place that decides
 * how long it stays down — currently for good (issue #16, option (a)): only a fresh save brings it
 * back. A "the city rebuilds" rule would clear the flag here (or in applyResult).
 */
export function skyTowerRuin(p: CampaignProgress): { fallHeading: number } | null {
  const d = (p as Ext).skyTowerDown;
  return d && typeof d.fallHeading === 'number' && isFinite(d.fallHeading) ? { fallHeading: d.fallHeading } : null;
}

/** Record the Sky Tower as destroyed (returns a new object; a tower already down keeps its first ruin). */
export function markSkyTowerDown(p: CampaignProgress, fallHeading: number): CampaignProgress {
  if (skyTowerRuin(p)) return p;
  return { ...(p as Ext), skyTowerDown: { fallHeading } } as Ext;
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
 * Safety valve for a mission the player keeps failing: unlock the next campaign mission without
 * a win (returns a new object; the skipped mission keeps no grade).
 */
export function skipMission(p: CampaignProgress, missionId: string, campaign: MissionDef[]): CampaignProgress {
  const src = p as Ext;
  const next: Ext = { unlocked: [...p.unlocked], best: { ...p.best }, totals: { ...p.totals }, failStreak: { ...(src.failStreak ?? {}) }, skipped: [...(src.skipped ?? [])] };
  const i = campaign.findIndex((m) => m.id === missionId);
  if (i >= 0 && i + 1 < campaign.length && !next.unlocked.includes(campaign[i + 1].id)) next.unlocked.push(campaign[i + 1].id);
  if (!next.skipped!.includes(missionId)) next.skipped!.push(missionId);
  if (src.skyTowerDown) next.skyTowerDown = { ...src.skyTowerDown };
  return next;
}

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
  // a won or skipped mission unlocks the next one in the list: repairs saves made while c07 sat
  // between c06 and c08 (c07 and c12 were removed with rearming, issue #63)
  for (let i = 0; i + 1 < campaign.length; i++) {
    const id = campaign[i].id;
    if ((best[id] || out.skipped?.includes(id)) && !unlocked.has(campaign[i + 1].id)) {
      unlocked.add(campaign[i + 1].id);
      out.unlocked.push(campaign[i + 1].id);
    }
  }
  const ruin = skyTowerRuin(raw as CampaignProgress);
  if (ruin) out.skyTowerDown = ruin;
  return out;
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
  const src = p as Ext;
  const next: Ext = {
    unlocked: [...p.unlocked],
    best: { ...p.best },
    totals: { ...p.totals },
    failStreak: { ...(src.failStreak ?? {}) },
  };
  if (src.skipped) next.skipped = [...src.skipped];
  if (src.skyTowerDown) next.skyTowerDown = { ...src.skyTowerDown };
  const towerDown = (r as MissionResultExt).skyTowerDown;
  if (towerDown && !next.skyTowerDown) next.skyTowerDown = { fallHeading: towerDown.fallHeading };
  // consecutive failures (the UI can offer Recruit / skip after a few)
  if (r.success) delete next.failStreak![r.missionId];
  else next.failStreak![r.missionId] = (next.failStreak![r.missionId] ?? 0) + 1;
  next.totals.airKills += r.kills.air;
  next.totals.groundKills += r.kills.sam + r.kills.ground;
  if (r.success) next.totals.missions += 1;
  if (!r.success && isDeathReason(r.reason)) next.totals.deaths += 1;

  if (r.success) {
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
