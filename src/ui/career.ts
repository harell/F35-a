/**
 * F35-A UI — pure helpers for difficulty text, onboarding and the service record (unit-tested in
 * tests/ui-career.test.ts). Everything that touches storage is wrapped in try/catch: private mode,
 * sandboxed iframes and full quotas must never break a menu.
 */
import type { CampaignProgress, MissionDef, MissionResult } from '../core/contracts';
import { DIFFICULTIES } from '../core/data';
import { loadSettings, saveSettings } from '../core/settings';
import type { Difficulty, DifficultyParams, Settings } from '../core/types';
import { fixedDifficulty } from '../missions/difficulty';

export const DIFFICULTY_ORDER: Difficulty[] = ['recruit', 'pilot', 'veteran', 'ace'];

/** Short fact list derived from the live DIFFICULTIES numbers (never hand-written, so it can't go stale). */
export function difficultyFacts(d: DifficultyParams): string[] {
  const out: string[] = [];
  out.push(d.flightAssist ? 'Flight-path hold · gentle buffet' : 'No flight-path hold · G-LOC');
  const hits = d.playerMissileHitsToKill;
  out.push(hits > 1 ? `Survive ${hits} missile hits` : 'One missile hit kills');
  const pct = Math.round((d.enemyCountScale - 1) * 100);
  out.push(pct === 0 ? 'Standard enemy numbers' : pct < 0 ? `${pct}% enemies` : `+${pct}% enemies`);
  out.push(d.generousShootCues ? 'Early SHOOT cues' : 'Strict SHOOT cues');
  out.push(`Score ×${d.scoreMultiplier}`);
  return out;
}

/** One short line per difficulty (the leading sentence(s) of the data.ts description, ≥ 30 chars). */
export function difficultyShort(d: DifficultyParams): string {
  const parts = d.description.match(/[^.!]+[.!]?/g) ?? [d.description];
  let out = '';
  for (const p of parts) {
    out += p;
    if (out.trim().length >= 30) break; // "Balanced." alone says too little — take the next sentence too
  }
  return out.trim();
}

/**
 * Change the difficulty from a menu: update the live settings object (it is the Game's own object,
 * so the next sortie uses it) and persist only that field (URL overrides such as ?quality= stay
 * out of storage).
 */
export function setDifficulty(settings: Settings, id: Difficulty): void {
  if (!(id in DIFFICULTIES)) return;
  settings.difficulty = id;
  const saved = loadSettings();
  saved.difficulty = id;
  saveSettings(saved);
}

/**
 * Settings opened from the pause menu: when a new difficulty applies. The running mission keeps the
 * difficulty it was built with (Game.runSession), and a lesson flies at Pilot whatever the setting
 * (missionDifficulty, #68), so for a lesson neither the next sortie of it nor a restart changes it.
 */
export function midSortieDifficultyNote(running: Pick<MissionDef, 'kind'> | null): string {
  const fixed = running ? fixedDifficulty(running) : null;
  if (fixed) return `Lessons always fly at ${DIFFICULTIES[fixed]?.label ?? fixed}: a new difficulty applies to the campaign and Instant Action.`;
  return 'A new difficulty applies from the next sortie (or RESTART).';
}

/** Toast after the difficulty changes in settings opened from the pause menu (see midSortieDifficultyNote). */
export function difficultyChangeToast(id: Difficulty, running: Pick<MissionDef, 'kind'> | null): string {
  const label = DIFFICULTIES[id]?.label ?? id;
  const fixed = running ? fixedDifficulty(running) : null;
  if (fixed) return `Difficulty: ${label} — for the campaign and Instant Action; lessons always fly at ${DIFFICULTIES[fixed]?.label ?? fixed}`;
  return `Difficulty: ${label} — applies from the next sortie or a restart`;
}

/* ───────────────────────── onboarding ───────────────────────── */

const ONBOARD_KEY = 'f35a.ui.onboarded.v1';
const PROGRESS_KEY = 'f35a.progress.v1';
const SETTINGS_KEY = 'f35a.settings.v1';
export const BASIC_TRAINING = ['t01', 't02', 't03'];

function store(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** First launch: nothing saved yet and the Training prompt was never dismissed. */
export function isFirstLaunch(): boolean {
  try {
    const s = store();
    if (!s) return false;
    return !s.getItem(ONBOARD_KEY) && !s.getItem(PROGRESS_KEY) && !s.getItem(SETTINGS_KEY);
  } catch {
    return false;
  }
}

export function dismissOnboarding(): void {
  try {
    store()?.setItem(ONBOARD_KEY, '1');
  } catch {
    /* ignore */
  }
}

/** Basic training (T01–T03) all flown successfully. */
export function basicTrainingDone(p: CampaignProgress): boolean {
  return BASIC_TRAINING.every((id) => !!p.best[id]);
}

/* ───────────────────────── career ───────────────────────── */

export interface Rank {
  name: string;
  abbr: string;
  /** Career points needed. */
  at: number;
}

/** RNZAF officer ranks. */
export const RANKS: Rank[] = [
  { name: 'Pilot Officer', abbr: 'PLTOFF', at: 0 },
  { name: 'Flying Officer', abbr: 'FGOFF', at: 3 },
  { name: 'Flight Lieutenant', abbr: 'FLTLT', at: 8 },
  { name: 'Squadron Leader', abbr: 'SQNLDR', at: 16 },
  { name: 'Wing Commander', abbr: 'WGCDR', at: 28 },
  { name: 'Group Captain', abbr: 'GPCAPT', at: 44 },
];

/** Career points: 2 per mission won, 1 per air kill, ½ per ground/SAM kill, 1 per A/S grade held. */
export function careerPoints(p: CampaignProgress): number {
  const t = p.totals;
  const top = Object.values(p.best).filter((b) => b.grade === 'S' || b.grade === 'A').length;
  return t.missions * 2 + t.airKills + t.groundKills * 0.5 + top;
}

export function careerRank(p: CampaignProgress): { rank: Rank; next: Rank | null; points: number; toNext: number } {
  const points = careerPoints(p);
  let i = 0;
  while (i + 1 < RANKS.length && points >= RANKS[i + 1].at) i++;
  const next = RANKS[i + 1] ?? null;
  return { rank: RANKS[i], next, points, toNext: next ? Math.max(0, next.at - points) : 0 };
}

/* ───────────────────────── medals earned (UI-owned storage) ───────────────────────── */

const MEDALS_KEY = 'f35a.medals.v1';
export interface MedalRecord {
  count: number;
  /** Mission id where it was first earned. */
  first: string;
}

export function loadMedals(): Record<string, MedalRecord> {
  try {
    const raw = store()?.getItem(MEDALS_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object') return {};
    const out: Record<string, MedalRecord> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const r = v as Partial<MedalRecord>;
      if (r && typeof r.count === 'number' && r.count > 0) out[k] = { count: Math.floor(r.count), first: String(r.first ?? '') };
    }
    return out;
  } catch {
    return {};
  }
}

/** Adds a sortie's medals to the saved tally; returns the ids earned for the first time. */
export function recordMedals(r: Pick<MissionResult, 'missionId' | 'medals'>): string[] {
  const medals = r.medals ?? [];
  if (!medals.length) return [];
  const all = loadMedals();
  const fresh: string[] = [];
  for (const m of medals) {
    const cur = all[m.id];
    if (cur) cur.count++;
    else {
      all[m.id] = { count: 1, first: r.missionId };
      fresh.push(m.id);
    }
  }
  try {
    store()?.setItem(MEDALS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
  return fresh;
}
