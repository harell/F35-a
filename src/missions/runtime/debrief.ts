/**
 * F35-A — debrief extras: the informative end reason ("Shot down by an SA-10 Grumble"), 1–3
 * specific tips built from how the sortie went, and the medals earned (MEDALS catalogue, exported
 * through src/missions/index.ts for the UI).
 */
import type { MissionResult } from '../../core/contracts';
import { AIRCRAFT_INFO, SAM_INFO } from '../../core/data';
import type { AircraftType, SamType } from '../../core/types';
import type { MissionScript } from '../schema';
import { REASONS } from './reasons';
import { parTimeFor } from './scoring';
import type { MissionState } from './state';

export interface MedalDef {
  id: string;
  name: string;
  description: string;
}

/** Every award the game hands out (ids are stable: the UI may key artwork / saves on them). */
export const MEDALS = {
  air_medal: { id: 'air_medal', name: 'Air Medal', description: 'Completed a campaign mission with an A grade or better.' },
  dfc: { id: 'dfc', name: 'Distinguished Flying Cross', description: 'S grade on a campaign mission on Veteran or Ace.' },
  ace_in_a_day: { id: 'ace_in_a_day', name: 'Ace in a Day', description: 'Five air-to-air kills in one sortie.' },
  iron_hand: { id: 'iron_hand', name: 'Iron Hand', description: 'Destroyed two or more SAM / AAA sites in one sortie.' },
  bridge_runner: { id: 'bridge_runner', name: 'Bridge Runner', description: 'Flew under the Auckland Harbour Bridge.' },
  no_hits: { id: 'no_hits', name: 'Untouchable', description: 'Fought and won a mission without a hit and without losing a friendly.' },
  sharpshooter: { id: 'sharpshooter', name: 'Sharpshooter', description: 'Four or more shots with 80 % or better accuracy.' },
  gunslinger: { id: 'gunslinger', name: 'Gunslinger', description: 'Shot down an enemy aircraft with the GAU-22 gun.' },
  shepherd: { id: 'shepherd', name: 'Good Shepherd', description: 'Brought every friendly aircraft home.' },
  hot_pit: { id: 'hot_pit', name: 'Hot Pit', description: 'Rearmed at Whenuapai and went back to finish the job.' },
  southern_cross: { id: 'southern_cross', name: 'Southern Cross Campaign Medal', description: 'Completed Operation Southern Cross — Auckland is safe.' },
} as const satisfies Record<string, MedalDef>;

export type MedalId = keyof typeof MEDALS;

/** Every medal, in display order. */
export const MEDAL_LIST: MedalDef[] = Object.values(MEDALS);

const SAM_MUNITION: Record<string, SamType> = { m_3m9: 'sa6', m_9m33: 'sa8', m_48n6: 'sa10', m_9m330: 'sa15', m_igla: 'sa18' };
const IR_MUNITIONS = new Set(['r73', 'm_igla', 'aim9x']);
const RADAR_MUNITIONS = new Set(['r27', 'r77', 'aim120', 'm_3m9', 'm_9m33', 'm_48n6', 'm_9m330']);

/** "an SA-10", "an F-35", "a MiG-29", "an A-50". */
function article(word: string): string {
  return /^[aeiou]/i.test(word) || /^(SA-|F-|A-\d)/.test(word) ? 'an' : 'a';
}

/** What killed the player, readable ("an SA-10 Grumble", "a MiG-29's R-73", "Shilka fire"), or null. */
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
    const weapon = w === 'gun' ? 'gun' : w.toUpperCase().replace(/^R(\d)/, 'R-$1');
    return `${article(name)} ${name}'s ${weapon}`;
  }
  if (w === 'flak') return 'flak';
  return null;
}

/** Death reason for the debrief, e.g. "Shot down by an SA-10 Grumble". */
export function deathReason(s: MissionState, reason: 'crash' | 'shot' | 'collision' | 'fuel'): string {
  const base = REASONS[reason] ?? REASONS.shot;
  if (reason !== 'shot') return base;
  const k = killerText(s);
  return k ? `${base} by ${k}` : base;
}

/**
 * The mission asks for air-to-air kills: a 'destroy' or 'intercept' objective on a hostile aircraft
 * group (T02, c01, a Dogfight…). T01's rings or a pure strike are not.
 */
export function hasAirToAirObjective(script: Pick<MissionScript, 'objectives' | 'groups'>): boolean {
  const air = new Set(script.groups.filter((g) => g.team === 'red').map((g) => g.id));
  return script.objectives.some((o) => (o.kind === 'destroy' || o.kind === 'intercept') && o.groups.some((id) => air.has(id)));
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

  if (r.reason.startsWith(REASONS.skytower))
    add('The Sky Tower is a protected landmark: check what is behind your target before you pickle, and never let a missile or bomb fly through the CBD.');
  if (died) {
    if (st.downReason === 'fuel') add('Afterburner drinks fuel: cruise at MIL power and RTB to Whenuapai when BINGO shows — hold over the field to refuel.');
    else if (st.downReason === 'crash' || st.downReason === 'collision')
      add('Watch your altitude and let Auto-GCAS fly the pull-up — don’t fight the stick when it takes over.');
    else if (samType === 'sa10') add('Stay below 300 ft and keep Rangitoto between you and Motutapu: the SA-10 cannot see through the volcano.');
    else if (samType === 'zsu23') add('Shilkas shred anything low and close: stay above 5,000 ft or more than 3 km from the flak.');
    else if (samType === 'sa18' || IR_MUNITIONS.has(w)) add('Heat-seeker: pop FLARES and break hard into the missile, and come out of afterburner.');
    else if (samType) add('SAM launch: beam it — turn 90° to the missile, dive for the deck and pump CHAFF in the last seconds.');
    else if (RADAR_MUNITIONS.has(w)) add('Radar missile: put it on your wing (beam), drop CHAFF — and shoot first: a clean F-35 sees them long before they see you.');
    else if (w === 'gun') add('Guns kill: don’t let a bandit sit behind you — keep your speed up and turn into him.');
  }

  if (!r.success && !died) {
    if (r.reason === REASONS.time) add('Out of time: go straight for the primary objective — the steering cue points at it.');
    else if (r.reason === REASONS.ao) add('Stay inside the area of operations — turn back as soon as RETURN TO AO shows.');
    else if (r.reason.startsWith('Objective failed')) {
      if (/Hammer|Kiwi|package|alive/i.test(r.reason)) add('Protect missions: kill the fighters going for the friendlies first — ignore bonus targets until they are safe.');
      else if (/raid|Backfire|bomber/i.test(r.reason)) add('Bombers don’t dodge: shoot them from long range the moment SHOOT shows, then deal with the escort.');
      else add('A primary objective failed: the objective list in the pause menu shows what must survive or die.');
    }
  }

  if (st.aamShots >= 2 && st.longShots >= Math.max(2, st.aamShots * 0.4)) add('Wait for SHOOT before firing: AMRAAMs launched from max range run out of energy and miss.');
  if (st.aamShots >= 3 && st.misses >= st.aamShots * 0.5) add('Your missiles were defeated: shoot inside SHOOT, then crank 50° so the bandit can’t turn cold on the missile.');
  if (st.winchester > 0 && st.rearms === 0 && !r.success) add('Out of weapons? Follow the steering cue to Whenuapai and hold over the field below 5,000 ft for 5 s to rearm.');

  if (r.success) {
    if (r.damageTaken > 40) add('You took heavy damage: defend every missile warning at once — chaff and a hard beam turn beat a missile at range.');
    if (r.friendlyLosses > 0) add('Friendlies went down: stay between the bandits and the package, and shoot the closest threat first.');
    if (r.grade !== 'S' && r.accuracy < 0.5 && r.shotsFired >= 3) add('Tighten your shots: fire inside the SHOOT cue for a much better hit rate.');
    if (s.flightKills > 0 && s.flightKills >= r.kills.air + r.kills.sam + r.kills.ground)
      add(`Your wingman scored ${s.flightKills} of the flight's kills: S and A grades need at least half of them to be yours — lead the fight.`);
    if (r.grade === 'S' && r.difficulty !== 'ace') add('Perfect sortie — try it on a harder difficulty.');
  }
  if (tips.length === 0) {
    if (!r.success) add('Fly Training first: T02 teaches the lock and SHOOT cue, T03 how to survive SAMs.');
    // the time tip only when there was time to gain, and the AMRAAM advice only where there is something to shoot
    else if (r.time > parTimeFor(s.def))
      add(hasAirToAirObjective(s.script) ? 'Faster missions score higher: fly the steering cue and use the AMRAAM’s reach.' : 'Faster missions score higher: fly the steering cue.');
  }
  return tips;
}

/** Medals earned this sortie. */
export function awardMedals(s: MissionState, r: MissionResult, finale: boolean): MedalDef[] {
  const out: MedalDef[] = [];
  const give = (m: MedalDef) => out.push({ ...m });
  const campaign = s.def.kind === 'campaign';
  if (s.stats.bridge) give(MEDALS.bridge_runner);
  if (r.kills.air >= 5) give(MEDALS.ace_in_a_day);
  if (r.kills.sam >= 2) give(MEDALS.iron_hand);
  if (s.stats.gunKills > 0) give(MEDALS.gunslinger);
  if (r.success) {
    if (campaign && (r.grade === 'S' || r.grade === 'A')) give(MEDALS.air_medal);
    if (campaign && r.grade === 'S' && (r.difficulty === 'veteran' || r.difficulty === 'ace')) give(MEDALS.dfc);
    // the whole flight came home untouched (i2 review: awarded while Viper 2 was lost), from a fight
    // the player took part in: hostiles and at least one shot (playtest 2026-10-02, 2.3-b: a parked,
    // 0-shot Defend win got it)
    if (r.damageTaken <= 0 && r.friendlyLosses === 0 && s.enemiesSpawned > 0 && r.shotsFired > 0) give(MEDALS.no_hits);
    if (r.shotsFired >= 4 && r.accuracy >= 0.8) give(MEDALS.sharpshooter);
    let friendlies = 0;
    for (const g of s.groups.values()) if (g.team === 'blue' && g.air && g.air.role !== 'wingman') friendlies += g.expected;
    if (friendlies > 0 && r.friendlyLosses === 0) give(MEDALS.shepherd);
    if (s.stats.rearms > 0) give(MEDALS.hot_pit);
    if (finale) give(MEDALS.southern_cross);
  }
  return out;
}
