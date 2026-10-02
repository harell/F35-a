/**
 * F35-A — the IRGC campaign over Auckland and the Hauraki Gulf (epic #72): Shahed one-way attack
 * drones over the city and fast attack boats in the Gulf, launched from an IRGC mother ship.
 *
 * Missions: g01 "Buzz Kill", the Shahed swarm on the Sky Tower (#78); g02 "Straight Outta
 * Hauraki" (#82) is still to come. Mission ids are g01, g02, … ("Gulf"), next to Southern Cross's
 * c01–c12; every id must stay unique across campaigns (progress is keyed by mission id).
 */
import { AKL } from '../../core/auckland';
import type { CampaignDef, MissionDef } from '../../core/contracts';
import { SHAHED_SPEED } from '../../sim/drone/oneWay';
import { P, flight, mission } from './common';

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
} as const;

/** The Sky Tower's axis (the landmark stands on AKL.skytower, missions/runtime/landmarks.ts). */
const TOWER = AKL.skytower;
const g01Dir = (() => {
  const d = Math.hypot(G01_SWARM.start.x - TOWER.x, G01_SWARM.start.z - TOWER.z);
  return { x: (G01_SWARM.start.x - TOWER.x) / d, z: (G01_SWARM.start.z - TOWER.z) / d };
})();

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
    '13:40. An IRGC mother ship, a converted container ship lying off the Hauraki Gulf, has launched a swarm of ten Shahed-136 one-way attack drones. They crossed the coast at Howick in a tight triangle and are droning in over the eastern suburbs, nose on the Sky Tower. Impact in under four minutes.',
    'Shaheds are dumb: a fixed course at 1,000 ft and 100 knots, no weapons, no reaction to you. But there are ten of them and you carry eight missiles at most. The gun is not optional today: you have extra rounds.',
    'Take the swarm head-on with missiles at range, then turn in behind for gun passes. From behind they are so slow you will overshoot unless you pull the throttle right back. Kill them beyond 150 m or the warhead blast will hit you too.',
    'The tower can take one hit. A second brings it down. Chasing the last drone into the CBD, remember your own missile can bring the tower down too: close in with the gun instead. Every drone you shoot down falls on someone\'s house. Shoot them down early.',
  ],
  recommendedLoadout: 'a2a_beast',
  allowedLoadouts: ['a2a_beast', 'a2a_stealth'],
  player: g01Start,
  // the gun is required (10 drones, at most 8 missiles): more than the real 180 rounds (#77)
  gunAmmo: { recruit: 400, pilot: 400, veteran: 380, ace: 360 },
  script: {
    autoHints: true,
    parTime: 210,
    groups: [
      flight('shaheds', 'shahed136', G01_SWARM.count, G01_SWARM.start, G01_SWARM.altitude, 0, SHAHED_SPEED, 'bomber', {
        fixedCount: true,
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
      { id: 'o_tower', kind: 'intercept', groups: ['shaheds'], x: TOWER.x, z: TOWER.z, radius: 500, label: 'Keep every Shahed off the Sky Tower', primary: false },
    ],
    waypoints: [
      { id: 'wp_swarm', label: 'Swarm', kind: 'target', x: 5000, z: 2900, altitude: 1500, radius: 2000, objective: 'o_swarm' },
      { id: 'wp_home', label: 'Whenuapai', kind: 'rtb', x: P.whenuapai.x, z: P.whenuapai.z, altitude: 1000 },
    ],
    triggers: [
      { id: 't_close', when: { kind: 'area', who: { group: 'shaheds' }, x: TOWER.x, z: TOWER.z, radius: 4000 }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Shaheds four kilometres from the tower. Get on them!', priority: 2 }] },
      { id: 't_half', when: { kind: 'group_destroyed', group: 'shaheds', count: 5 }, actions: [{ kind: 'radio', from: DS, text: 'Half the swarm is down. Keep going, Viper.' }] },
    ],
    hints: [{ id: 'h_plan', text: 'Missiles head-on at range, then the gun from behind: throttle right back', when: { kind: 'time', t: 9 }, duration: 8 }],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Ten Shaheds over Pakuranga, heading for the Sky Tower. Weapons free.', priority: 2 }],
    successText: 'Swarm destroyed. The tower is still standing. Good shooting, Viper.',
  },
});

export const IRGC_CAMPAIGN: CampaignDef = {
  id: 'irgc',
  name: IRGC_CAMPAIGN_NAME,
  description: 'Shahed drone swarms over the city, fast attack boats in the Hauraki Gulf',
  missions: [G01],
};
