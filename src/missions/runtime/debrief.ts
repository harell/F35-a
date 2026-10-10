/**
 * F35-A — debrief extras: the informative end reason ("Shot down by an SA-6 Gainful"), 1–3
 * specific tips built from how the sortie went, and the medals earned (MEDALS catalogue, exported
 * through src/missions/index.ts for the UI).
 */
import type { MissionDef, MissionResult } from '../../core/contracts';
import { TRAINING_MISSIONS } from '../content/training';
import { AIRCRAFT_INFO, SAM_INFO } from '../../core/data';
import type { AircraftType, SamType } from '../../core/types';
import { fixedDifficulty } from '../difficulty';
import type { MissionScript } from '../schema';
import { REASONS } from './reasons';
import { noFight, parTimeFor } from './scoring';
import type { MissionState } from './state';

export interface MedalDef {
  id: string;
  name: string;
  description: string;
  /** No mission awards it any more: the cabinet shows it only to a pilot who earned it before. */
  retired?: boolean;
}

/** Every award the game hands out (ids are stable: the UI may key artwork / saves on them). */
export const MEDALS = {
  air_medal: { id: 'air_medal', name: 'Air Medal', description: 'Completed a campaign mission with an A grade or better.' },
  dfc: { id: 'dfc', name: 'Distinguished Flying Cross', description: 'S grade on a campaign mission on Veteran.' },
  ace_in_a_day: { id: 'ace_in_a_day', name: 'Ace in a Day', description: 'Five air-to-air kills in one sortie.' },
  iron_hand: { id: 'iron_hand', name: 'Iron Hand', description: 'Destroyed two or more SAM / AAA sites in one sortie.' },
  bridge_runner: { id: 'bridge_runner', name: 'Bridge Runner', description: 'Flew under the Auckland Harbour Bridge.' },
  no_hits: { id: 'no_hits', name: 'Untouchable', description: 'Fought and won a mission without a hit and without losing a friendly.' },
  sharpshooter: { id: 'sharpshooter', name: 'Sharpshooter', description: 'Four or more shots with 80 % or better accuracy.' },
  gunslinger: { id: 'gunslinger', name: 'Gunslinger', description: 'Shot down an enemy aircraft with the GAU-22 gun.' },
  // Southern Cross's escort missions awarded it; none of today's missions has friendlies to bring home
  shepherd: { id: 'shepherd', name: 'Good Shepherd', description: 'Brought every friendly aircraft home.', retired: true },
} as const satisfies Record<string, MedalDef>;

export type MedalId = keyof typeof MEDALS;

/** Every medal, in display order. */
export const MEDAL_LIST: MedalDef[] = Object.values(MEDALS);

const SAM_MUNITION: Record<string, SamType> = { m_3m9: 'sa6', m_9m330: 'sa15', m_igla: 'ad_boat' };
const IR_MUNITIONS = new Set(['r73', 'm_igla', 'aim9x']);
const RADAR_MUNITIONS = new Set(['r27', 'r77', 'aim120', 'm_3m9', 'm_9m330']);

/** "an SA-10", "an F-35", "a MiG-29". */
function article(word: string): string {
  return /^[aeiou]/i.test(word) || /^(SA-|F-|A-\d)/.test(word) ? 'an' : 'a';
}

/** What killed the player, readable ("an SA-6 Gainful", "a MiG-29's R-73", "Shilka fire"), or null. */
export function killerText(s: MissionState): string | null {
  const st = s.stats;
  const w = st.lastHitWeapon;
  if (!w) return null;
  if (st.lastHitBy === 'sam' && st.lastHitType) {
    const sam = st.lastHitType as SamType;
    if (sam === 'zsu23') return 'Shilka flak';
    const nato = SAM_INFO[sam]?.nato ?? sam.toUpperCase();
    return `${article(nato)} ${nato}`;
  }
  if (SAM_MUNITION[w]) {
    const nato = SAM_INFO[SAM_MUNITION[w]].nato;
    return `${article(nato)} ${nato}`;
  }
  if (st.lastHitBy === 'aircraft' && st.lastHitType) {
    const name = AIRCRAFT_INFO[st.lastHitType as AircraftType]?.name ?? st.lastHitType;
    // an aircraft's 'flak' is a one-way drone's warhead going off next to the player
    const weapon = w === 'gun' ? 'gun' : w === 'flak' ? 'warhead' : w.toUpperCase().replace(/^R(\d)/, 'R-$1');
    return `${article(name)} ${name}'s ${weapon}`;
  }
  if (w === 'flak') return 'flak';
  return null;
}

/** Death reason for the debrief, e.g. "Shot down by an SA-6 Gainful". */
export function deathReason(s: MissionState, reason: 'crash' | 'shot' | 'collision' | 'fuel'): string {
  const base = REASONS[reason] ?? REASONS.shot;
  if (reason !== 'shot') return base;
  const k = killerText(s);
  return k ? `${base} by ${k}` : base;
}

/**
 * The Codex entry that explains what ended a failed sortie, for the debrief's "What happened?" link.
 * Ids are Codex entries (src/ui/codex/data.ts); tests/ui-codex.test.ts checks each one exists.
 */
export function codexTopic(s: MissionState, r: MissionResult): string | undefined {
  if (r.success || r.freeFlight) return undefined;
  if (r.reason === REASONS.fuel) return 'fuel';
  if (r.reason === REASONS.crash) return 'pullup';
  if (!r.reason.startsWith(REASONS.shot)) return undefined;
  const w = s.stats.lastHitWeapon;
  if (!w) return undefined;
  if (w === 'm_igla') return 'silent'; // shoulder-fired: no radar warning at all
  if (s.stats.lastHitBy === 'sam' || SAM_MUNITION[w]) return 'mud'; // radar SAMs and AAA
  if (IR_MUNITIONS.has(w)) return 'cms'; // heat-seekers: flares
  if (w === 'r77') return 'silent'; // silent in midcourse
  if (RADAR_MUNITIONS.has(w)) return 'launch';
  return undefined;
}

/**
 * The mission asks for air-to-air kills: a 'destroy' or 'intercept' objective on a hostile aircraft
 * group (T02, g01's Shahed swarm, a Dogfight…). T01's rings or a pure strike are not.
 */
export function hasAirToAirObjective(script: Pick<MissionScript, 'objectives' | 'groups'>): boolean {
  const air = new Set(script.groups.filter((g) => g.team === 'red').map((g) => g.id));
  return script.objectives.some((o) => (o.kind === 'destroy' || o.kind === 'intercept') && o.groups.some((id) => air.has(id)));
}

/**
 * The mission gives the player something to shoot: a destroy, intercept or protect objective. T05's
 * missile drills (boats firing practice rounds, nothing to kill) and T01's rings don't, so winning
 * them without a shot is no idle win (playtest r3.1 R31-3).
 */
export function hasShootingObjective(script: Pick<MissionScript, 'objectives'>): boolean {
  return script.objectives.some((o) => o.kind === 'destroy' || o.kind === 'destroy_sams' || o.kind === 'intercept' || o.kind === 'protect');
}

/**
 * The fallback tip after a loss: the lessons this mission asks for (MissionDef.lessons, the ones the
 * Training screen points at), by the number and name players see; a mission without any (a lesson,
 * Instant Action) gets the general advice.
 */
export function lessonTip(def: Pick<MissionDef, 'lessons'>): string {
  const lessons = (def.lessons ?? []).map((id) => TRAINING_MISSIONS.find((m) => m.id === id)).filter((m): m is MissionDef => !!m);
  if (lessons.length === 0) return 'Fly Training first: each lesson prepares a campaign mission.';
  const names = lessons.map((m) => `Training ${String(m.index).padStart(2, '0')}, ${m.title}`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Fly ${list} first: ${names.length === 1 ? 'it prepares' : 'they prepare'} this mission.`;
}

/** 1–3 specific tips for the debrief. */
export function buildTips(s: MissionState, r: MissionResult): string[] {
  const tips: string[] = [];
  const st = s.stats;
  const add = (t: string) => {
    if (tips.length < 3 && !tips.includes(t)) tips.push(t);
  };
  const w = st.lastHitWeapon ?? '';
  const died = s.playerDied;
  const samType = st.lastHitBy === 'sam' ? (st.lastHitType as SamType | null) : w in SAM_MUNITION ? SAM_MUNITION[w] : null;

  if (r.reason === REASONS.skytowerLost)
    add('The swarm got through: launch at range and let each missile take a new drone (TGT steps on), then gun the leakers from behind at about 200 kt.');
  else if (r.reason.startsWith(REASONS.skytower))
    add('The Sky Tower is a protected landmark: check what is behind your target before you pickle, and never let a missile or bomb fly through the CBD.');
  if (died) {
    if (st.downReason === 'fuel') add('Afterburner drinks fuel and there is no refuelling: cruise at MIL power, and when BINGO shows finish the job and head home.');
    else if (st.downReason === 'crash' || st.downReason === 'collision')
      add(
        s.difficulty.autoGcas
          ? 'Watch your altitude and let Auto-GCAS fly the pull-up — don’t fight the stick when it takes over.'
          : 'Watch your altitude: above Recruit there is no Auto-GCAS, so the pull-up is yours — start it early.',
      );
    else if (samType === 'zsu23') add('Shilkas shred anything low and close: stay above 5,000 ft or more than 3 km from the flak.');
    else if (w === 'm_igla') add('The boat\'s heat-seeker: turn hard across it (beam it), come out of afterburner and press CMS late, in the last 3 seconds. Turning into it makes it worse.');
    else if (IR_MUNITIONS.has(w)) add('Heat-seeker: turn hard across it (beam it), come out of afterburner and press CMS late, in the last 3 seconds. Turning into it makes it worse.');
    else if (samType) add('SAM launch: beam it — turn 90° to the missile and drop CHAFF every few seconds from about 6 s to impact. Diving after the launch is too late: be low before it.');
    else if (RADAR_MUNITIONS.has(w)) add('Radar missile: put it on your wing (beam), drop CHAFF — and shoot first: a clean F-35 sees them long before they see you.');
    else if (w === 'gun') add('Guns kill: don’t let a bandit sit behind you — keep your speed up and turn into him.');
    // the IRGC Navy's air-defence boats (g02, g03): a lesson drills exactly that defence, with practice
    // rounds that can't hurt you (player feedback 2026-10-08: stuck at g02, unable to evade them)
    if (samType === 'ad_boat' && s.def.id !== 't05') add('Training 05, Gulf Defence, drills the defence against these boats with practice rounds that can’t hurt you.');
  }

  if (!r.success && !died) {
    if (r.reason === REASONS.time) add('Out of time: go straight for the primary objective — the steering cue points at it.');
    else if (r.reason === REASONS.ao) add('Stay inside the area of operations — turn back as soon as RETURN TO AO shows.');
    // g03's stoat at the nest: a lesson drills the release at a stop on targets that can't shoot back
    else if (/stoat/i.test(r.reason)) add('Release while the stoat stops at a bait station: Training 07, Small Targets, drills that release on rats that can’t shoot back.');
    // T07's own rats: the lesson's rule
    else if (/rat reached/i.test(r.reason)) add('Release the StormBreaker while the rat stops at a drain: running or swimming, the bomb can’t track it.');
    else if (r.reason.startsWith('Objective failed')) {
      if (/tanker|Kōtuku/i.test(r.reason)) add('Escort the tanker: StormBreakers on the suicide boats first, released early from height, then the missile boats before they count down.');
      else add('A primary objective failed: the objective list in the pause menu shows what must survive or die.');
    }
  }

  // a win capped at C because the player wasn't in the fight: say so first, it explains the grade
  const idle = r.success && hasShootingObjective(s.script) && noFight({ enemiesSpawned: s.enemiesSpawned, hits: r.hits, kills: r.kills });
  if (idle)
    add(`You won without ${r.shotsFired > 0 ? 'landing a hit' : 'firing a shot'}: S and A grades need you in the fight — engage the bandits yourself.`);

  if (st.aamShots >= 2 && st.longShots >= Math.max(2, st.aamShots * 0.4)) add('Wait for SHOOT before firing: AMRAAMs launched from max range run out of energy and miss.');
  if (st.aamShots >= 3 && st.misses >= st.aamShots * 0.5) add('Your missiles were defeated: shoot inside SHOOT, then crank 50° so the bandit can’t turn cold on the missile.');
  if (st.winchester > 0 && !r.success) add('You ran out of weapons with targets left, and there is no rearming: wait for SHOOT or IN RANGE so every shot counts.');

  if (r.success) {
    if (r.damageTaken > 40) add('You took heavy damage: defend every missile warning at once — chaff and a hard beam turn beat a missile at range.');
    if (r.friendlyLosses > 0) add('Friendlies went down: stay between the bandits and the package, and shoot the closest threat first.');
    if (r.grade !== 'S' && r.accuracy < 0.5 && r.shotsFired >= 3) add('Tighten your shots: fire inside the SHOOT cue for a much better hit rate.');
    if (!idle && s.flightKills > 0 && s.flightKills >= r.kills.air + r.kills.sam + r.kills.ground)
      add(`Your wingman scored ${s.flightKills} of the flight's kills: S and A grades need at least half of them to be yours — lead the fight.`);
    // not in a lesson: training flies at Pilot whatever the setting, so a harder one changes nothing there
    if (r.grade === 'S' && r.difficulty !== 'veteran' && !fixedDifficulty(s.def)) add('Perfect sortie — try it on a harder difficulty.');
  }
  if (tips.length === 0) {
    if (!r.success) add(lessonTip(s.def));
    // the time tip only when there was time to gain, and the AMRAAM advice only where there is something to shoot
    else if (r.time > parTimeFor(s.def))
      add(hasAirToAirObjective(s.script) ? 'Faster missions score higher: fly the steering cue and use the AMRAAM’s reach.' : 'Faster missions score higher: fly the steering cue.');
  }
  return tips;
}

/** Medals earned this sortie. */
export function awardMedals(s: MissionState, r: MissionResult): MedalDef[] {
  const out: MedalDef[] = [];
  const give = (m: MedalDef) => out.push({ ...m });
  const campaign = s.def.kind === 'campaign';
  if (s.stats.bridge) give(MEDALS.bridge_runner);
  if (r.kills.air >= 5) give(MEDALS.ace_in_a_day);
  if (r.kills.sam >= 2) give(MEDALS.iron_hand);
  if (s.stats.gunKills > 0) give(MEDALS.gunslinger);
  if (r.success) {
    if (campaign && (r.grade === 'S' || r.grade === 'A')) give(MEDALS.air_medal);
    if (campaign && r.grade === 'S' && r.difficulty === 'veteran') give(MEDALS.dfc);
    // the whole flight came home untouched (i2 review: awarded while Viper 2 was lost), from a fight
    // the player took part in: hostiles, and a hit or a kill (playtest 2026-10-02, 2.3-b: a parked,
    // 0-shot Defend win got it; #64 review: so did one gun burst into the air)
    const fought = s.enemiesSpawned > 0 && !noFight({ enemiesSpawned: s.enemiesSpawned, hits: r.hits, kills: r.kills });
    if (r.damageTaken <= 0 && r.friendlyLosses === 0 && fought) give(MEDALS.no_hits);
    if (r.shotsFired >= 4 && r.accuracy >= 0.8) give(MEDALS.sharpshooter);
  }
  return out;
}
