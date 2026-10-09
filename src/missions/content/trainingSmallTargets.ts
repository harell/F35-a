/**
 * F35-A — training lesson T07 "Small Targets": the release g03's stoat asks for, before g03 asks for it
 * under the Waiheke air defences (MissionDef.lessons on g03: T06 Live SAMs, then this one).
 *
 * Herne Bay's old sewers carry wastewater and stormwater in the same pipes, and after heavy rain they
 * overflow (true of the real suburb: the overflow points spill dozens of times a year). In the game,
 * last night's overflow has flushed sewer rats out onto the streets. They run down to the beach and
 * swim for Watchman Island / Te Kākāwhakaara, about 600 m offshore. No rat may reach the island.
 *
 * The lesson is g03's release, with the same bomb: the GBU-53/B StormBreaker can't track a target this
 * small on the move (sim/weapons/small.ts), so release while a rat stops at a drain. Two rats, one wave
 * (playtest 2026-10-10, 1.4-b: the JDAM waves are gone, no campaign mission carries a JDAM). A rat that
 * gets past its drains swims, and a StormBreaker can't find a swimmer either.
 *
 * Rat routes run down real Herne Bay streets (LINZ road centrelines, world/scenery/aucklandRoads.ts);
 * tests/missions-t07.test.ts checks them against the coast. The local trap group is fictional; no real
 * organisation is named.
 */
import type { MissionDef } from '../../core/contracts';
import type { XZ } from '../schema';
import { mission, target } from './common';

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

/** The routes, by rat: down the streets to the beach, then the swim. */
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
} as const satisfies Record<string, T07Route>;

/** The rats' mission group. */
export const T07_GROUP = 'rats';

/** The middle of the streets, for the target waypoint. */
const STREETS: XZ = { x: -2_450, z: -620 };

/** The player: over the upper harbour off Point Chevalier, heading east for Herne Bay, about 9 km out. */
const t07Start = { x: -11_500, z: -1_500, altitude: 1_500, heading: 90, speed: 220 };

function rat(name: keyof typeof T07_ROUTES) {
  const r: T07Route = T07_ROUTES[name];
  return target(`rat_${name}`, T07_GROUP, 'rat', r.start, {
    name: 'Rat',
    runner: { route: [...r.route], stations: [...r.drains], speed: T07_RAT.speed, stopTime: T07_RAT.stopTime, swimSpeed: T07_RAT.swimSpeed, clock: 'spawn' },
  });
}

export const T07_SMALL: MissionDef = mission({
  id: 't07',
  kind: 'training',
  index: 7,
  title: 'Small Targets',
  subtitle: 'StormBreakers on sewer rats in Herne Bay',
  timeOfDay: 'day',
  weather: 'scattered',
  briefing: [
    "Training, with live rats. Last night's rain overloaded Herne Bay's old sewers and flushed the rats out. Two are running down Wallace Street and Hamilton Road to the beach, to swim for Watchman Island, 600 metres offshore, which the local trappers keep pest-free. No rat reaches the island.",
    'A rat is too small for the StormBreaker to track while it runs, so release while it stops at a drain to sniff. A rat that gets past its drains swims, and the bomb can\'t find a swimmer either. The stoat on Waiheke needs the same release.',
    'Check the FIRE button reads GBU-53, the StormBreaker (WPN changes weapon). TGT picks a rat; tap the target camera to zoom the pod onto it. Release on a stop, the moment IN RANGE shows.',
  ],
  // g03's bomb on g02's load: StormBreakers to spare while the release is learned (g03's own load, two
  // StormBreakers and two AARGM-ERs, is allowed too)
  recommendedLoadout: 'strike_maritime',
  allowedLoadouts: ['strike_maritime', 'sead_precision'],
  player: t07Start,
  script: {
    autoHints: true,
    parTime: 180,
    awacs: { initialPictureAt: -1, pictureInterval: 0 },
    ground: Object.keys(T07_ROUTES).map((n) => rat(n as keyof typeof T07_ROUTES)),
    objectives: [{ id: 'o_rats', kind: 'destroy', groups: [T07_GROUP], label: 'StormBreakers on the rats, while they stop at the drains', primary: true }],
    waypoints: [{ id: 'wp_streets', label: 'Herne Bay', kind: 'target', x: STREETS.x, z: STREETS.z, altitude: 600, radius: 1500, objective: 'o_rats' }],
    triggers: [
      {
        id: 't_trappers',
        when: { kind: 'time', t: 10 },
        actions: [{ kind: 'radio', from: TR, text: 'Viper, Marine Parade Trappers. Two rats out of the manholes, top of Wallace Street and Hamilton Road. They stop at every drain on the way down.' }],
      },
      {
        id: 't_alert',
        when: { kind: 'runner_alert', group: T07_GROUP },
        actions: [{ kind: 'radio', from: TR, text: 'That one has sat up. It is looking at you.' }],
      },
      {
        id: 't_swimming',
        when: { kind: 'area', who: { group: T07_GROUP }, x: T07_ISLAND.x, z: T07_ISLAND.z, radius: 700 },
        actions: [{ kind: 'radio', from: TR, text: 'One is in the water and swimming. A StormBreaker won\'t find it now.', priority: 2 }],
      },
      {
        // a rat on the island: the sortie is lost
        id: 't_island',
        when: { kind: 'area', who: { group: T07_GROUP }, x: T07_ISLAND.x, z: T07_ISLAND.z, radius: T07_ISLAND_RADIUS },
        actions: [{ kind: 'end', success: false, reason: 'A rat reached Watchman Island' }],
      },
      {
        id: 't_done',
        when: { kind: 'group_destroyed', group: T07_GROUP },
        actions: [{ kind: 'radio', from: TR, text: 'That is both of them. The island is clean. Cheers, Viper.' }],
      },
    ],
    hints: [
      { id: 'h_pod', text: 'TGT designates a rat. Tap the target camera to ZOOM the pod: it is 20 cm long', when: { kind: 'time', t: 5 }, duration: 9 },
      { id: 'h_stops', text: 'StormBreaker: release while the rat STOPS at a drain. Running, the bomb can\'t track it', when: { kind: 'area', x: STREETS.x, z: STREETS.z, radius: 7000 }, duration: 9 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Herne Bay is all yours. Two rats on the streets: catch them at the drains.', priority: 2 }],
    successText: 'Two rats, none on the island. That is the release the stoat needs, Viper.',
    costSummary: { comparison: { label: 'A rat trap, for comparison', nzd: 40 }, removed: { label: 'Rats removed', group: T07_GROUP } },
  },
});
