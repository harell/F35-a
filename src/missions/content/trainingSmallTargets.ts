/**
 * F35-A — training lesson T07 "Small Targets": the release g03's stoat asks for, before g03 asks for it
 * under the Waiheke air defences (MissionDef.lessons on g03: T06 Live SAMs, then this one).
 *
 * Herne Bay's old sewers carry wastewater and stormwater in the same pipes, and after heavy rain they
 * overflow (true of the real suburb: the overflow points spill dozens of times a year). In the game,
 * last night's overflow has flushed sewer rats out onto the streets. They run down to the beach and
 * swim for Watchman Island / Te Kākāwhakaara, about 600 m offshore. No rat may reach the island.
 *
 * The lesson is which bomb goes where, the skill g03's stoat needs:
 *  - the GBU-53/B StormBreaker is small (14 m blast) but can't track a small target on the move
 *    (sim/weapons/small.ts): release while a rat stops at a drain;
 *  - the GBU-31 JDAM tracks nothing and its blast is 60 m: on a street it hits the houses either side
 *    (runtime/collateral.ts counts them, the debrief lists them and they cost score and grade), in the
 *    water it kills the swimmer wherever it has paddled to since the release.
 * Three waves: two rats on the streets (StormBreakers at the drains), two already swimming (JDAMs over
 * the water), and two more down the streets that the player handles as they see fit.
 *
 * Rat routes run down real Herne Bay streets (LINZ road centrelines, world/scenery/aucklandRoads.ts),
 * every drain at least 8 m from the nearest house so a StormBreaker on a stopped rat hits no home;
 * tests/missions-t07.test.ts checks them against the coast and the houses. The local trap group is
 * fictional; no real organisation is named.
 */
import type { MissionDef } from '../../core/contracts';
import type { XZ } from '../schema';
import { NEVER, mission, target } from './common';

const DS = 'DARKSTAR';
/** The trap group's radio callsign (fictional, like the group). */
export const T07_TRAPPERS = 'TRAPPERS';
const TR = T07_TRAPPERS;

/** Watchman Island / Te Kākāwhakaara, the rats' goal (m; the map label in ui/art/aucklandPlaces.ts). */
export const T07_ISLAND: XZ = { x: -2_696, z: -1_500 };
/** A rat this close to the island's centre has reached it (m). */
export const T07_ISLAND_RADIUS = 25;

/** Rats on land: average dash speed (m/s), stop at each drain (s); in the water a steady swim (m/s). */
export const T07_RAT = { speed: 2.5, stopTime: 40, swimSpeed: 1.5 } as const;

/**
 * A rat's route: its start (the overflow manhole), the points after it in order (the drains first),
 * which of those are drains (a stop at each; indices into `route`), and the street it runs down.
 * The last point is the island.
 */
export interface T07Route {
  street: string;
  start: XZ;
  route: XZ[];
  drains: number[];
}

/** The routes, by rat. Wave 1 and wave 3 run down the streets; wave 2 starts in the water. */
export const T07_ROUTES = {
  wallace: {
    street: 'Wallace Street',
    start: { x: -2_509, z: -315 },
    route: [{ x: -2_554, z: -495 }, { x: -2_590, z: -633 }, { x: -2_684, z: -672 }, { x: -2_703, z: -747 }, T07_ISLAND],
    drains: [0, 1, 2],
  },
  hamilton: {
    street: 'Hamilton Road',
    start: { x: -2_148, z: -368 },
    route: [{ x: -2_190, z: -580 }, { x: -2_234, z: -796 }, { x: -2_249, z: -876 }, T07_ISLAND],
    drains: [0, 1, 2],
  },
  swimWest: { street: 'the water off the beach', start: { x: -2_850, z: -950 }, route: [T07_ISLAND], drains: [] },
  swimEast: { street: 'the water off the point', start: { x: -2_450, z: -1_100 }, route: [T07_ISLAND], drains: [] },
  sentinel: {
    street: 'Sentinel Road',
    start: { x: -2_327, z: -347 },
    route: [{ x: -2_380, z: -550 }, { x: -2_431, z: -752 }, { x: -2_446, z: -816 }, T07_ISLAND],
    drains: [0, 1, 2],
  },
  lawrence: {
    street: 'Lawrence Street',
    start: { x: -2_418, z: -337 },
    route: [{ x: -2_465, z: -518 }, { x: -2_521, z: -731 }, { x: -2_630, z: -781 }, T07_ISLAND],
    drains: [0, 1, 2],
  },
} as const satisfies Record<string, T07Route>;

/** Mission group ids: one per wave. */
export const T07_GROUPS = { wave1: 'rats1', wave2: 'rats2', wave3: 'rats3' } as const;
const G = T07_GROUPS;

/** The rats of each wave. */
export const T07_WAVES: Record<keyof typeof T07_GROUPS, (keyof typeof T07_ROUTES)[]> = {
  wave1: ['wallace', 'hamilton'],
  wave2: ['swimWest', 'swimEast'],
  wave3: ['sentinel', 'lawrence'],
};

/** The middle of the streets, for the target waypoint. */
const STREETS: XZ = { x: -2_450, z: -620 };

/** The player: over the upper harbour off Point Chevalier, heading east for Herne Bay, about 9 km out. */
const t07Start = { x: -11_500, z: -1_500, altitude: 1_500, heading: 90, speed: 220 };

function rat(name: keyof typeof T07_ROUTES, group: string, spawned: boolean) {
  const r: T07Route = T07_ROUTES[name];
  return target(`rat_${name}`, group, 'rat', r.start, {
    name: 'Rat',
    spawn: spawned ? undefined : NEVER,
    runner: { route: [...r.route], stations: [...r.drains], speed: T07_RAT.speed, stopTime: T07_RAT.stopTime, swimSpeed: T07_RAT.swimSpeed, clock: 'spawn' },
  });
}

export const T07_SMALL: MissionDef = mission({
  id: 't07',
  kind: 'training',
  index: 7,
  title: 'Small Targets',
  subtitle: 'StormBreaker or JDAM: sewer rats in Herne Bay',
  timeOfDay: 'day',
  weather: 'scattered',
  briefing: [
    "Training, with live rats. Last night's rain overloaded the old combined sewers under Herne Bay again: the overflow manholes have been spilling since dawn, and the water has flushed the sewer rats out. The Marine Parade Trappers have them on camera, coming up at the top of the streets and running down to the beach. From there they swim for Watchman Island, 600 metres offshore, which the trappers have kept pest-free for years. No rat reaches the island.",
    'Two bombs, two jobs. The GBU-53/B StormBreaker is small: its blast stays in the street. But a rat is too small for it to track on the move, so release while the rat stops at a drain to sniff. The GBU-31 JDAM tracks nothing: it goes where the rat was when you pickled, and its 2,000 lb blast reaches 60 metres. On a street that means the houses either side. In the water it means the rat, wherever it has swum to.',
    'Three waves. The first runs down Wallace Street and Hamilton Road: StormBreakers at the drains. The second is already in the water: JDAMs, released low and close so the rat can\'t swim clear before the bomb arrives. The third is yours to work out. Every home inside one of your bombs\' blast is called on the radio and goes on your record.',
    'You carry four StormBreakers and three JDAMs, and the gun. Tap WPN to choose the bomb, TGT to designate a rat, and tap the target camera to zoom the pod onto it.',
  ],
  recommendedLoadout: 'strike_mixed',
  allowedLoadouts: ['strike_mixed'],
  player: t07Start,
  script: {
    autoHints: true,
    parTime: 480,
    awacs: { initialPictureAt: -1, pictureInterval: 0 },
    collateral: true,
    ground: [
      ...T07_WAVES.wave1.map((n) => rat(n, G.wave1, true)),
      ...T07_WAVES.wave2.map((n) => rat(n, G.wave2, false)),
      ...T07_WAVES.wave3.map((n) => rat(n, G.wave3, false)),
    ],
    objectives: [
      { id: 'o_w1', kind: 'destroy', groups: [G.wave1], label: 'Wave 1: StormBreakers on the rats at the drains', primary: true },
      { id: 'o_w2', kind: 'destroy', groups: [G.wave2], label: 'Wave 2: JDAMs on the swimmers', primary: true, activeAt: { kind: 'objective', id: 'o_w1', state: 'complete' } },
      { id: 'o_w3', kind: 'destroy', groups: [G.wave3], label: 'Wave 3: the last two, without hitting a home', primary: true, activeAt: { kind: 'objective', id: 'o_w2', state: 'complete' } },
    ],
    waypoints: [{ id: 'wp_streets', label: 'Herne Bay', kind: 'target', x: STREETS.x, z: STREETS.z, altitude: 600, radius: 1500, objective: 'o_w1' }],
    triggers: [
      {
        id: 't_trappers',
        when: { kind: 'time', t: 10 },
        actions: [{ kind: 'radio', from: TR, text: 'Viper, Marine Parade Trappers. Two rats out of the manholes, top of Wallace Street and Hamilton Road. They stop at every drain on the way down.' }],
      },
      {
        id: 't_wave2',
        when: { kind: 'group_destroyed', group: G.wave1 },
        delay: 4,
        actions: [
          { kind: 'radio', from: TR, text: 'Two more already in the water, off the beach and off the point. Swimming for the island.', priority: 2 },
          { kind: 'spawn', group: G.wave2 },
        ],
      },
      {
        id: 't_wave3',
        when: { kind: 'group_destroyed', group: G.wave2 },
        delay: 4,
        actions: [
          { kind: 'radio', from: TR, text: 'Last two, top of Sentinel Road and Lawrence Street. Your call how you take them.', priority: 2 },
          { kind: 'spawn', group: G.wave3 },
        ],
      },
      {
        id: 't_alert',
        when: { kind: 'runner_alert', group: G.wave1 },
        actions: [{ kind: 'radio', from: TR, text: 'That one has sat up. It is looking at you.' }],
      },
      {
        id: 't_swimming',
        when: { kind: 'any', of: [{ kind: 'area', who: { group: G.wave1 }, x: T07_ISLAND.x, z: T07_ISLAND.z, radius: 700 }, { kind: 'area', who: { group: G.wave3 }, x: T07_ISLAND.x, z: T07_ISLAND.z, radius: 700 }] },
        actions: [{ kind: 'radio', from: TR, text: 'One is in the water and swimming. A StormBreaker won\'t find it now.', priority: 2 }],
      },
      // a rat on the island: the sortie is lost
      ...Object.values(G).map((group) => ({
        id: `t_island_${group}`,
        when: { kind: 'area' as const, who: { group }, x: T07_ISLAND.x, z: T07_ISLAND.z, radius: T07_ISLAND_RADIUS },
        actions: [{ kind: 'end' as const, success: false, reason: 'A rat reached Watchman Island' }],
      })),
      {
        id: 't_done',
        when: { kind: 'group_destroyed', group: G.wave3 },
        actions: [{ kind: 'radio', from: TR, text: 'That is all of them. The island is clean. Cheers, Viper.' }],
      },
    ],
    hints: [
      { id: 'h_pod', text: 'TGT designates a rat. Tap the target camera to ZOOM the pod: it is 20 cm long', when: { kind: 'time', t: 5 }, duration: 9 },
      { id: 'h_stops', text: 'StormBreaker (WPN): release while the rat STOPS at a drain. Running, the bomb can\'t track it', when: { kind: 'area', x: STREETS.x, z: STREETS.z, radius: 7000 }, duration: 9 },
      { id: 'h_jdam_street', text: 'A JDAM\'s blast reaches 60 m: on the street that is the houses. Keep it for the water', when: { kind: 'all', of: [{ kind: 'player_weapon', weapon: 'gbu31' }, { kind: 'objective', id: 'o_w1', state: 'active' }] }, duration: 8 },
      { id: 'h_swim', text: 'Swimmers never stop: a StormBreaker can\'t track them. JDAM, released low and close', when: { kind: 'group_spawned', group: G.wave2 }, duration: 9 },
      { id: 'h_choice', text: 'StormBreakers at the drains, or JDAMs once they are in the water. Never a JDAM on the street', when: { kind: 'group_spawned', group: G.wave3 }, duration: 9 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Herne Bay is all yours. Rats on the streets, houses either side: pick your bomb.', priority: 2 }],
    successText: 'Six rats, no rat on the island. You know which bomb goes where, Viper.',
    costSummary: { comparison: { label: 'A rat trap, for comparison', nzd: 40 }, removed: { label: 'Rats removed', group: [G.wave1, G.wave2, G.wave3] } },
  },
});
