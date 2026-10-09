/**
 * F35-A — training lesson T04 "Maritime Strike": the air-to-ground weapons of g02 against boats on
 * the Hauraki Gulf range, before g02 asks for them under a clock. Split out of the old SAMs & Strike
 * lesson (now T06, Live SAMs) so a player meets the release before the SA-6s.
 *   1. StormBreaker: two target boats sailing a loop; designate one (TGT), release the moment IN RANGE
 *      shows. The bomb tracks a moving boat, so the player turns for the next one while it glides.
 *   2. AARGM-ER: an air-defence boat at anchor, its radar on, a few kilometres north of the start. It fires practice
 *      rounds (a hit does no damage): the AARGM-ER homes on that radar, by the one rule (AARGM_RULE,
 *      core/data.ts): inside about 10 km while the radar is on, then press in. A range crew, it never shuts
 *      the radar down against the AARGM (`noArmShutdown`): a disciplined one went quiet and 4 of 6 bot runs'
 *      AARGMs, fired by the rule, missed (playtest r2, 2.3-d), so the drill was passed with a bomb.
 *   3. Gun: one boat, 3 km beyond the air-defence boat, where the AARGM pass ends low: a gun pass is the
 *      short way. Not enforced (the label says "try the gun"): a StormBreaker sinks it too, which is how the
 *      mission bot, which can't aim the gun at a boat, flies it.
 * Sized for a casual player (playtest 2026-10-10, 1.4-e/h: 397–562 s, a first AARGM fired from 30 km):
 * the drills sit close together and the start is a StormBreaker's reach from the first boat.
 * Every boat sails in open water at least 1 km from any shore (tests/missions-t04.test.ts).
 */
import type { MissionDef } from '../../core/contracts';
import { AARGM_RULE } from '../../core/data';
import { mission, site, target } from './common';

const DS = 'DARKSTAR';

/** The drills' boats (m): routes in the Gulf north of the Rangitoto Channel. */
export const STRIKE = {
  /**
   * Off Takapuna at 10,000 ft, about 9 km from the first boat: inside a StormBreaker's reach from there
   * (~11.5 km), so the first release comes within seconds; the second boat is 3 km further up the Gulf.
   */
  start: { x: 1500, z: -7500 },
  /**
   * Drill 1: two boats sailing a loop on the tanker's route up the Gulf; the second starts on it 3 km behind the
   * first, coming back down (from further up the Gulf its StormBreaker glided 75 s: r2, 2.3-d).
   */
  d1Path: [
    { x: 7000, z: -15000 },
    { x: 8400, z: -21000 },
    { x: 8600, z: -26000 },
    { x: 8400, z: -21000 },
  ],
  /** Drill 1's second boat: on the loop's first leg, 3 km beyond the first. */
  d1Second: { x: 7700, z: -18000 },
  /** Drill 2: the air-defence boat, at anchor 6 km north of the start. */
  d2: { x: 3500, z: -13000 },
  /** Drill 3: the gun boat, 3 km beyond the air-defence boat. */
  d3Path: [
    { x: 4500, z: -16000 },
    { x: 2000, z: -16000 },
  ],
} as const;

const done = (id: string) => ({ kind: 'objective', id, state: 'complete' }) as const;
/** Fast boats at about 20 kt. */
const BOAT_SPEED = 10;

export const T04_STRIKE: MissionDef = mission({
  id: 't04',
  kind: 'training',
  index: 4,
  title: 'Maritime Strike',
  subtitle: 'Bombs, missiles and the gun against boats',
  timeOfDay: 'day',
  weather: 'clear',
  briefing: [
    'Air-to-ground on the Hauraki Gulf range, with what you carry against the IRGC Navy’s fast boats over the Gulf: StormBreakers, two AARGM-ERs and the gun. The range boats are crewed by drones, and the air-defence boat fires practice rounds: a hit does no damage.',
    `One: two boats sailing up the Gulf. You start with the StormBreaker up (GBU-53 on the FIRE button) and a boat boxed (TGT picks the other): release the moment IN RANGE shows. The bomb tracks a moving boat on its own: turn for the next one while it glides. Two: an air-defence boat with its radar on. WPN to the AARGM-ER, TGT the boat, and ${AARGM_RULE}.`,
    'Three: practise a gun pass on the last boat. Get low, put the pipper on it and hold GUN inside 1,200 m.',
  ],
  recommendedLoadout: 'strike_maritime',
  allowedLoadouts: ['strike_maritime'],
  // g02's rounds: enough for a few gun passes on the last boat
  gunAmmo: 360,
  player: { x: STRIKE.start.x, z: STRIKE.start.z, altitude: 3000, heading: 30, speed: 240 },
  script: {
    practiceRounds: true,
    autoHints: true,
    parTime: 200,
    awacs: { initialPictureAt: -1, pictureInterval: 0 },
    groups: [],
    ground: [
      target('sb1', 'd1', 'suicide_boat', STRIKE.d1Path[0], { name: 'Range boat 1', path: [...STRIKE.d1Path], speed: BOAT_SPEED, loop: true }),
      target('sb2', 'd1', 'suicide_boat', STRIKE.d1Second, { name: 'Range boat 2', path: [...STRIKE.d1Path], speed: BOAT_SPEED, loop: true }),
      target('gb', 'd3', 'suicide_boat', STRIKE.d3Path[0], { name: 'Range boat 4', path: [...STRIKE.d3Path], speed: BOAT_SPEED, loop: true, spawn: done('o_d2') }),
    ],
    // at anchor, and a range crew that keeps its radar on: the AARGM fired by the rule homes all the way in
    sams: [site('ad', 'd2', 'ad_boat', STRIKE.d2, { name: 'Range boat 3', noHarass: true, noArmShutdown: true, spawn: done('o_d1') })],
    objectives: [
      { id: 'o_d1', kind: 'destroy', groups: ['d1'], label: 'Drill 1: sink both moving boats with StormBreakers', primary: true },
      { id: 'o_d2', kind: 'destroy', groups: ['d2'], label: 'Drill 2: AARGM-ER on the air-defence boat’s radar', primary: true, activeAt: done('o_d1') },
      { id: 'o_d3', kind: 'destroy', groups: ['d3'], label: 'Drill 3: sink the last boat (try the gun)', primary: true, activeAt: done('o_d2') },
    ],
    waypoints: [
      { id: 'wp_d1', label: 'Drill 1: boats', kind: 'target', x: STRIKE.d1Second.x, z: STRIKE.d1Second.z, objective: 'o_d1' },
      { id: 'wp_d2', label: 'Drill 2: air-defence boat', kind: 'target', x: STRIKE.d2.x, z: STRIKE.d2.z, objective: 'o_d2' },
      { id: 'wp_d3', label: 'Drill 3: gun boat', kind: 'target', x: (STRIKE.d3Path[0].x + STRIKE.d3Path[1].x) / 2, z: STRIKE.d3Path[0].z, altitude: 300, objective: 'o_d3' },
    ],
    triggers: [
      {
        id: 't_glide',
        when: { kind: 'player_fired' },
        delay: 2,
        actions: [{ kind: 'radio', from: DS, text: 'Bomb away. It tracks the boat on its own: turn for the next one.', priority: 2 }],
      },
    ],
    hints: [
      { id: 'h_d1', text: 'Drill 1: the StormBreaker is up (GBU-53 on FIRE) and a boat is boxed. Release the moment IN RANGE shows', when: { kind: 'time', t: 5 }, duration: 10 },
      { id: 'h_d2', text: 'Drill 2: AARGM (WPN), TGT the boat: fire inside 10 km while its radar is on, then press in', when: { kind: 'objective', id: 'o_d2', state: 'active' }, duration: 10 },
      { id: 'h_d3', text: 'Drill 3: the GUN. Get low, put the pipper on the boat and fire inside 1,200 m', when: { kind: 'objective', id: 'o_d3', state: 'active' }, duration: 10 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Gulf range is hot. Two target boats north-east of you, heading up the Gulf.', priority: 2 }],
    successText: 'Maritime strike qualification complete. Next, Viper: staying alive while you do it.',
  },
});
