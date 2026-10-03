/**
 * F35-A — the IRGC campaign over Auckland and the Hauraki Gulf (epic #72): Shahed one-way attack
 * drones over the city and fast attack boats in the Gulf, launched from an IRGC mother ship.
 *
 * Missions: g01 "Buzz Kill", the Shahed swarm on the Sky Tower (#78); g02 "Straight Outta
 * Hauraki" (#82, irgcHauraki.ts), the escort through the boat swarm and the campaign's finale.
 * Mission ids are g01, g02, … ("Gulf"), next to Southern Cross's
 * c01–c11; every id must stay unique across campaigns (progress is keyed by mission id).
 */
import { AKL } from '../../core/auckland';
import type { CampaignDef, MissionDef } from '../../core/contracts';
import { SHAHED_SPEED } from '../../sim/drone/oneWay';
import { P, flight, mission } from './common';
import { G02 } from './irgcHauraki';

/**
 * Working title, shown in the menus. The campaign's real name ("Operation …") is not decided yet
 * (epic #72, "Not decided yet"): change it here and everything that names the campaign follows.
 */
export const IRGC_CAMPAIGN_NAME = 'IRGC Campaign';

const DS = 'DARKSTAR';

/* ───────────────────────── 1. Buzz Kill — a Shahed swarm on the Sky Tower (#78) ───────────────────────── */

/**
 * The swarm: 10 Shahed-136s in a triangle (rows of 1, 2, 3, 4), launched from the mother ship and
 * now over the eastern suburbs (Pakuranga), about 11 km out, nose on the Sky Tower over Mt Wellington,
 * Ellerslie and Newmarket. At 51 m/s that is about 3.6 minutes to impact: the mission length.
 */
export const G01_SWARM = {
  /** Lead drone start (m). */
  start: { x: 9800, z: 5600 },
  /** Route height (m MSL): clear of the volcanic cones (≤ 196 m), below the Sky Tower's top (328 m). */
  altitude: 300,
  /** Impact point on the tower axis (m MSL): the dive line meets the concrete shaft. */
  targetY: 160,
  /**
   * Last waypoint, this far short of the tower on the straight line in (m): every drone flies a
   * parallel track until here (the formation keeps its spacing over the suburbs), then converges.
   */
  lastLeg: 1200,
  /** Distance between drones (m): rows 80 m apart, 80 m between the drones of a row. */
  spacing: 80,
  /**
   * Each drone flies this much further back than the one before it (m): each row is stepped back
   * like an echelon. Converging on the tower, the swarm funnels into single file instead of each
   * row closing up into a bunch, so one missile never takes two drones (an AIM-120 kills a Shahed
   * out to about 25 m) and a gun pass from behind can walk through two in a row.
   */
  stagger: 65,
  count: 10,
  /**
   * Recruit flies nine (playtest 2026-10-02 bc94edd: the bot won 3/6 on Recruit with ten, below the
   * band). One more than the eight missiles: on Recruit a flawless missile run can still win with
   * the tower hit once (the bonus lost); a clean win, and every win from Pilot up, needs the gun.
   */
  recruitCount: 9,
} as const;

/** The Sky Tower's axis (the landmark stands on AKL.skytower, missions/runtime/landmarks.ts). */
const TOWER = AKL.skytower;
const g01Dir = (() => {
  const d = Math.hypot(G01_SWARM.start.x - TOWER.x, G01_SWARM.start.z - TOWER.z);
  return { x: (G01_SWARM.start.x - TOWER.x) / d, z: (G01_SWARM.start.z - TOWER.z) / d };
})();

/**
 * Gun pass numbers (the owner didn't know what speed to fly): the Shahed cruises at SHAHED_SPEED (51 m/s,
 * ~100 kt); the F-35's 1 g stall is ~72 m/s IAS (~140 kt). About 200 kt from behind closes at ~100 kt.
 * At that speed the jet flies ~12° nose-up, so the pipper rides ~11° above the flight path: level with
 * the drone it sits above it at every range (playtest r2, 2.1-b). Sitting 400 ft (122 m) below, the
 * drone rises into the pipper at ~600 m (pipper − drone: +1.7° at 750 m, −0.6° at 600 m, −4.4° at
 * 450 m; playtest r3, 3.1-a), hence bursts at 550–700 m. The HMD's OVERSHOOT is time to close < 4 s.
 * tests/missions-g01.test.ts checks the texts and the geometry against these numbers.
 */
export const G01_GUN_PASS = { approachKt: 200, closureKt: 100, belowFt: 400, burstFrom: 550, burstTo: 700 } as const;

/**
 * g01 hints: the plan at the start; after the first launch, how the swarm steps through the TD box (the
 * next unengaged drone is boxed after each launch); once the GUN is selected, the speed for the pass and
 * what to do on an overshoot.
 */
export const G01_HINTS: MissionDef['script']['hints'] = [
  { id: 'h_plan', text: 'Missiles head-on at range, then the gun from behind at about 200 kt', when: { kind: 'time', t: 9 }, duration: 8 },
  {
    id: 'h_swarm',
    text: 'After each launch the next drone is boxed: keep pressing FIRE. TGT steps through them.',
    when: { kind: 'all', of: [{ kind: 'player_fired', count: 1 }, { kind: 'not', of: { kind: 'player_weapon', weapon: 'gun' } }] },
    duration: 8,
  },
  {
    // the 9X sees a Shahed's small engine only close in: NO SEEKER beyond ~2 km head-on (playtest r2, 2.1-e)
    id: 'h_9x',
    text: 'AIM-9X: the seeker needs the tone. Fire inside about 2 km',
    when: { kind: 'player_weapon', weapon: 'aim9x' },
    duration: 6,
  },
  {
    id: 'h_gun',
    text: 'Shaheds cruise at ~100 kt. From behind at about 200 kt (Vc 100), short bursts at 550–700 m',
    when: { kind: 'player_weapon', weapon: 'gun' },
    duration: 10,
  },
  {
    id: 'h_overshoot',
    text: 'Sit 400 ft below it: the drone rises into the pipper near 600 m. Overshot? Pull up, come round',
    when: { kind: 'player_weapon', weapon: 'gun' }, // (follows h_gun: scripted hints show once each, in order)
    duration: 8,
  },
];

/** The player: on CAP over the upper Waitematā, nose east-south-east; the swarm is about 22 km away, 20° right. */
const g01Start = { x: -9000, z: -5500, altitude: 3000, heading: 100, speed: 230, fuel: 0.9 };

export const G01: MissionDef = mission({
  id: 'g01',
  kind: 'campaign',
  index: 1,
  title: 'Buzz Kill',
  subtitle: 'Shahed swarm on the Sky Tower — guns required',
  timeOfDay: 'day',
  weather: 'scattered',
  briefing: [
    '13:40. An IRGC mother ship, a converted container ship lying off the Hauraki Gulf, has launched a swarm of Shahed-136 one-way attack drones. They crossed the coast at Howick in a tight triangle and are droning in over the eastern suburbs, nose on the Sky Tower. Impact in under four minutes.',
    'Shaheds are dumb: a fixed course at 1,000 ft and 100 knots, no weapons, no reaction to you. But there are more of them than the eight missiles you carry at most. The gun is not optional today: you have extra rounds.',
    'Take the swarm head-on with missiles at range, then turn in behind for gun passes. Come in from behind at about 200 knots, closing at about 100 (the Vc by your gun pipper), and fire short bursts at 550 to 700 m. Sit about 400 ft below the drone: at that speed the jet flies nose-high and the pipper rides above your flight path, so level behind a drone it sits above it. From 400 ft below, the drone rises into the pipper at about 600 m. Closing too fast? OVERSHOOT: pull up and come round. Kill them beyond 150 m or the warhead blast will hit you too.',
    'The tower can take one hit. A second brings it down. Chasing the last drone into the CBD, remember your own missile can bring the tower down too: close in with the gun instead. Every drone you shoot down falls on someone\'s house. Shoot them down early.',
  ],
  recommendedLoadout: 'a2a_beast',
  // air-to-air only, and every air-to-air missile the game has: the player meets both, the AIM-120
  // and the AIM-9X, on the same jet (#136). g02 introduces the air-to-ground weapons.
  allowedLoadouts: ['a2a_beast'],
  player: g01Start,
  // the gun is required (10 drones, at most 8 missiles): more than the real 180 rounds (#77)
  gunAmmo: { recruit: 400, pilot: 400, veteran: 380, ace: 360 },
  script: {
    autoHints: true,
    parTime: 210,
    groups: [
      flight('shaheds', 'shahed136', G01_SWARM.count, G01_SWARM.start, G01_SWARM.altitude, 0, SHAHED_SPEED, 'bomber', {
        fixedCount: true,
        countFor: { recruit: G01_SWARM.recruitCount },
        formation: 'triangle',
        spacing: G01_SWARM.spacing,
        callsign: 'Shahed',
        noun: 'Shaheds',
        oneWay: {
          stagger: G01_SWARM.stagger,
          targetX: TOWER.x,
          targetZ: TOWER.z,
          targetY: G01_SWARM.targetY,
          route: [{ x: Math.round(TOWER.x + g01Dir.x * G01_SWARM.lastLeg), z: Math.round(TOWER.z + g01Dir.z * G01_SWARM.lastLeg) }],
        },
      }),
    ],
    objectives: [
      { id: 'o_swarm', kind: 'destroy', groups: ['shaheds'], label: 'Shoot down the Shahed swarm', primary: true },
      // the HUD shows this with its progress, drones shot down / in the swarm ("1/10"): the label says what
      // that counts (it read "Keep every Shahed off the Sky Tower 1/10", playtest 1.4-k, #115)
      { id: 'o_tower', kind: 'intercept', groups: ['shaheds'], x: TOWER.x, z: TOWER.z, radius: 500, label: 'Down every Shahed short of the Sky Tower', primary: false },
    ],
    waypoints: [
      { id: 'wp_swarm', label: 'Swarm', kind: 'target', x: 5000, z: 2900, altitude: 1500, radius: 2000, objective: 'o_swarm' },
      { id: 'wp_home', label: 'Whenuapai', kind: 'rtb', x: P.whenuapai.x, z: P.whenuapai.z, altitude: 1000 },
    ],
    triggers: [
      { id: 't_close', when: { kind: 'area', who: { group: 'shaheds' }, x: TOWER.x, z: TOWER.z, radius: 4000 }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Shaheds four kilometres from the tower. Get on them!', priority: 2 }] },
      { id: 't_half', when: { kind: 'group_destroyed', group: 'shaheds', count: 5 }, actions: [{ kind: 'radio', from: DS, text: 'Half the swarm is down. Keep going, Viper.' }] },
    ],
    hints: G01_HINTS,
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. A Shahed swarm over Pakuranga, heading for the Sky Tower. Weapons free.', priority: 2 }],
    successText: 'Swarm destroyed. The tower is still standing. Good shooting, Viper.',
  },
});

export const IRGC_CAMPAIGN: CampaignDef = {
  id: 'irgc',
  name: IRGC_CAMPAIGN_NAME,
  description: 'Shahed drone swarms over the city, fast attack boats in the Hauraki Gulf',
  // 1. Buzz Kill (#78); 2. Straight Outta Hauraki (#82), in its own module (irgcHauraki.ts)
  missions: [G01, G02],
};

