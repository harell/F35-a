/**
 * F35-A — training lesson T03 "Maritime Strike": the air-to-ground weapons of g02 against boats on
 * the Hauraki Gulf range, before g02 asks for them under a clock. Split out of the old SAMs & Strike
 * lesson (now T05, Live SAMs) so a player meets the release before the SA-6s.
 *   1. StormBreaker: two target boats sailing a loop; designate one (TGT), release from height the
 *      moment IN RANGE shows. The bomb tracks a moving boat; it glides slowly, so release early.
 *   2. AARGM-ER: an air-defence boat, its radar on. It fires practice rounds (a hit does no damage):
 *      the AARGM-ER homes on that radar, so fire it while the radar is on.
 *   3. Gun: one boat for a gun pass (asked for, not enforced: a StormBreaker sinks it too).
 * Every boat sails in open water at least 1.5 km from any shore (tests/missions-t03.test.ts).
 */
import type { MissionDef } from '../../core/contracts';
import { mission, site, target } from './common';

const DS = 'DARKSTAR';

/** The drills' boats (m): routes in the Gulf west of Motutapu and north of Rangitoto. */
export const T03 = {
  /**
   * Over the Waitematā, 14 km short of the first boats at 10,000 ft: out of a StormBreaker's reach
   * (~11.5 km from there). Turning away after a release heads back over the city, not off the AO.
   */
  start: { x: -2000, z: -4000 },
  /** Drill 1: two boats sailing a loop on the tanker's route up the Gulf. */
  d1Path: [
    { x: 7000, z: -15000 },
    { x: 8400, z: -21000 },
    { x: 8600, z: -26000 },
    { x: 8400, z: -21000 },
  ],
  /** Drill 2: the air-defence boat, sailing a short loop. */
  d2Path: [
    { x: 2000, z: -22000 },
    { x: 6000, z: -22000 },
  ],
  /** Drill 3: the gun boat. */
  d3Path: [
    { x: 0, z: -30000 },
    { x: -3500, z: -30000 },
  ],
} as const;

const done = (id: string) => ({ kind: 'objective', id, state: 'complete' }) as const;
/** Fast boats at about 20 kt. */
const BOAT_SPEED = 10;

export const T03_DEF: MissionDef = mission({
  id: 't03',
  kind: 'training',
  index: 3,
  title: 'Maritime Strike',
  subtitle: 'StormBreaker, AARGM-ER and gun against boats',
  timeOfDay: 'day',
  weather: 'clear',
  briefing: [
    'Air-to-ground on the Hauraki Gulf range, with the weapons you carry against the IRGC Navy’s fast boats: eight GBU-53/B StormBreakers, two AARGM-ERs and the gun. The range boats are crewed by drones. The air-defence boat fires practice rounds: a hit does no damage.',
    'One: two target boats are sailing up the Gulf. Tap WPN to select the StormBreaker, TGT to designate a boat, and release the moment IN RANGE shows (STEER means turn toward it first). The bomb tracks a moving boat on its own, but it glides slowly: release early, and from height, because height is range. Then the other boat.',
    'Two: an air-defence boat with its radar on. The AARGM-ER homes on that radar: select it with WPN, designate the boat and fire while the radar is on, from outside its 12 km reach if you can. Three: one last boat. Sink it with the gun: in g02 the bombs run out before the boats do. Get down low, put the pipper on it and hold the trigger inside 1,200 m.',
  ],
  recommendedLoadout: 'strike_maritime',
  allowedLoadouts: ['strike_maritime'],
  player: { x: T03.start.x, z: T03.start.z, altitude: 3000, heading: 40, speed: 240 },
  script: {
    practiceRounds: true,
    autoHints: true,
    parTime: 540,
    awacs: { initialPictureAt: -1, pictureInterval: 0 },
    groups: [],
    ground: [
      target('sb1', 'd1', 'suicide_boat', T03.d1Path[0], { name: 'Range boat 1', path: [...T03.d1Path], speed: BOAT_SPEED, loop: true }),
      target('sb2', 'd1', 'suicide_boat', { x: 8400, z: -21000 }, { name: 'Range boat 2', path: [...T03.d1Path.slice(2), ...T03.d1Path.slice(0, 2)], speed: BOAT_SPEED, loop: true }),
      target('gb', 'd3', 'suicide_boat', T03.d3Path[0], { name: 'Range boat 4', path: [...T03.d3Path], speed: BOAT_SPEED, loop: true, spawn: done('o_d2') }),
    ],
    sams: [site('ad', 'd2', 'ad_boat', T03.d2Path[0], { name: 'Range boat 3', path: [...T03.d2Path], speed: BOAT_SPEED, loop: true, noHarass: true, spawn: done('o_d1') })],
    objectives: [
      { id: 'o_d1', kind: 'destroy', groups: ['d1'], label: 'Drill 1: sink both moving boats with StormBreakers', primary: true },
      { id: 'o_d2', kind: 'destroy', groups: ['d2'], label: 'Drill 2: AARGM-ER on the air-defence boat’s radar', primary: true, activeAt: done('o_d1') },
      { id: 'o_d3', kind: 'destroy', groups: ['d3'], label: 'Drill 3: sink the last boat (a gun pass)', primary: true, activeAt: done('o_d2') },
    ],
    waypoints: [
      { id: 'wp_d1', label: 'Drill 1: boats', kind: 'target', x: 8400, z: -21000, objective: 'o_d1' },
      { id: 'wp_d2', label: 'Drill 2: air-defence boat', kind: 'target', x: 4000, z: T03.d2Path[0].z, objective: 'o_d2' },
      { id: 'wp_d3', label: 'Drill 3: gun boat', kind: 'target', x: -1750, z: T03.d3Path[0].z, altitude: 300, objective: 'o_d3' },
    ],
    triggers: [
      {
        id: 't_glide',
        when: { kind: 'player_fired' },
        delay: 2,
        actions: [{ kind: 'radio', from: DS, text: 'Bomb away. From that range it glides for about a minute: it tracks the boat, so turn for the next one.', priority: 2 }],
      },
    ],
    hints: [
      { id: 'h_d1', text: 'Drill 1: WPN selects the StormBreaker, TGT designates a boat. Release the moment IN RANGE shows', when: { kind: 'time', t: 5 }, duration: 10 },
      { id: 'h_d1b', text: 'Height is range: climb on the way in. The bomb tracks the boat, you turn for the next one', when: { kind: 'time', t: 20 }, until: { kind: 'player_fired' }, duration: 8 },
      { id: 'h_d2', text: 'Drill 2: WPN to the AARGM-ER, designate the boat and fire while its radar is on', when: { kind: 'objective', id: 'o_d2', state: 'active' }, duration: 10 },
      { id: 'h_d3', text: 'Drill 3: the GUN. Get low, put the pipper on the boat and fire inside 1,200 m', when: { kind: 'objective', id: 'o_d3', state: 'active' }, duration: 10 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Gulf range is hot. Two target boats north-east of you, heading up the Gulf.', priority: 2 }],
    successText: 'Maritime strike qualification complete. Next, Viper: staying alive while you do it.',
  },
});
