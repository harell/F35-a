/**
 * F35-A — training lesson T07 "Small Targets": the release g03's stoat asks for, before g03 asks for it
 * under the Waiheke air defences (MissionDef.lessons on g03: T06 Live SAMs, then this one).
 *
 * Herne Bay's old sewers carry wastewater and stormwater in the same pipes, and after heavy rain they
 * overflow (true of the real suburb: the overflow points spill dozens of times a year). In the game,
 * last night's overflow has flushed sewer rats out, and they have made themselves at home: two run
 * round the blocks off Wallace Street and Hamilton Road, and one sits on the roof of the Shangri-La, the
 * 57 m apartment tower just off Jervois Road and Herne Bay's only tall building.
 *
 * The lesson is g03's release, with the same bomb and no other (the owner's call, 2026-10-16): the GBU-53/B
 * StormBreaker can't track a target this small on the move (sim/weapons/small.ts), so release while a
 * street rat stops at a drain. The street rats loop round their blocks for as long as it takes; there is
 * no fail condition. The roof rat sits still, the easy one, and the StormBreaker that kills it brings the
 * tower down (sim/World.ts roofCollapse): the target camera opens out to WIDE on the fall.
 *
 * Rat routes run along real Herne Bay streets (LINZ road centrelines, world/scenery/aucklandRoads.ts);
 * tests/missions-t07.test.ts checks them against the roads and the coast. The local trap group is
 * fictional; no real organisation is named.
 */
import type { MissionDef } from '../../core/contracts';
import type { XZ } from '../schema';
import { mission, target } from './common';

const DS = 'DARKSTAR';
/** The trap group's radio callsign (fictional, like the group). */
export const T07_TRAPPERS = 'TRAPPERS';
const TR = T07_TRAPPERS;

/** Street rats: average dash speed (m/s) and the stop at each drain (s). */
export const T07_RAT = { speed: 2.5, stopTime: 40 } as const;

/**
 * A street rat's circuit: its start, the points after it in order, which of those are drains (a stop at
 * each; indices into `route`), and the street it starts on. After the last point it runs back to the
 * start and round again.
 *
 * Each starts a few seconds short of its first drain, on the leg from the overflow manhole it came out of
 * (the last point, on Jervois Road's corner): flown straight in from the start, the jet comes into release
 * range just as the rats stop, so the first pass has a drop window (#309 playtest: from the manholes they ran
 * for the first 73 and 86 s, and a pilot who flew straight in had passed them by the first stop).
 */
export interface T07Route {
  street: string;
  start: XZ;
  route: XZ[];
  drains: number[];
}

/** The circuits, by rat: round a block each, on the road centrelines. */
export const T07_ROUTES = {
  wallace: {
    street: 'Wallace Street',
    start: { x: -2_547, z: -466 },
    // down Wallace St, along Sarsfield St, up Lawrence St, back along Jervois Rd to the manhole
    route: [
      { x: -2_554, z: -495 },
      { x: -2_590, z: -634 },
      { x: -2_612, z: -711 },
      { x: -2_522, z: -731 },
      { x: -2_465, z: -518 },
      { x: -2_419, z: -338 },
      { x: -2_449, z: -334 },
      { x: -2_498, z: -329 },
      { x: -2_509, z: -316 },
    ],
    drains: [0, 1, 3, 4],
  },
  hamilton: {
    street: 'Hamilton Road',
    start: { x: -2_182, z: -541 },
    // down Hamilton Rd, along Sarsfield St, up Curran St, back along Jervois Rd past the Shangri-La to the manhole
    route: [
      { x: -2_190, z: -580 },
      { x: -2_235, z: -797 },
      { x: -2_143, z: -818 },
      { x: -2_019, z: -847 },
      { x: -2_001, z: -722 },
      { x: -1_984, z: -608 },
      { x: -1_954, z: -404 },
      { x: -1_948, z: -390 },
      { x: -1_983, z: -386 },
      { x: -2_055, z: -378 },
      { x: -2_124, z: -371 },
      { x: -2_148, z: -368 },
    ],
    drains: [0, 1, 3, 5, 9],
  },
} as const satisfies Record<string, T07Route>;

/** The Shangri-La: its footprint centre (m), where the roof rat sits (core/cbdBuildingNames.ts names it). */
export const T07_TOWER: XZ = { x: -2_018, z: -421 };

/** The street rats' mission group, and the roof rat's. */
export const T07_GROUP = 'rats';
export const T07_ROOF_GROUP = 'roof_rat';

/** The middle of the streets, for the target waypoint. */
const STREETS: XZ = { x: -2_300, z: -560 };

/** The player: over the upper harbour off Point Chevalier, heading east for Herne Bay, about 9 km out. */
const t07Start = { x: -11_500, z: -1_500, altitude: 1_500, heading: 90, speed: 220 };

function rat(name: keyof typeof T07_ROUTES) {
  const r: T07Route = T07_ROUTES[name];
  return target(`rat_${name}`, T07_GROUP, 'rat', r.start, {
    name: 'Rat',
    runner: { route: [...r.route], stations: [...r.drains], speed: T07_RAT.speed, stopTime: T07_RAT.stopTime, clock: 'spawn', loop: true },
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
    "Training, with live rats. Last night's rain overloaded Herne Bay's old sewers, and the rats that came out have made themselves at home. Two run round the blocks off Wallace Street and Hamilton Road. One is on the roof of the Shangri-La, the tower just off Jervois Road.",
    'A rat is too small for the StormBreaker to track while it runs, so release while it stops at a drain to sniff. The roof rat sits still: that is the easy one.',
    'Check the FIRE button reads GBU-53, the StormBreaker. TGT picks a rat, and the target camera zooms the pod onto it. Release on a stop, the moment IN RANGE shows.',
  ],
  // g03's bomb and nothing else. No AARGM-ER: a rat has no radar to home on.
  recommendedLoadout: 'strike_precision',
  allowedLoadouts: ['strike_precision'],
  player: t07Start,
  script: {
    autoHints: true,
    parTime: 240,
    awacs: { initialPictureAt: -1, pictureInterval: 0 },
    ground: [
      ...Object.keys(T07_ROUTES).map((n) => rat(n as keyof typeof T07_ROUTES)),
      // on the Shangri-La's roof, sitting still: the StormBreaker that kills it brings the tower down
      target('rat_roof', T07_ROOF_GROUP, 'rat', T07_TOWER, { name: 'Rat', onRoof: true, runner: { route: [], stations: [] } }),
    ],
    objectives: [{ id: 'o_rats', kind: 'destroy', groups: [T07_GROUP, T07_ROOF_GROUP], label: 'StormBreakers on the rats, while they stop', primary: true }],
    waypoints: [{ id: 'wp_streets', label: 'Herne Bay', kind: 'target', x: STREETS.x, z: STREETS.z, altitude: 600, radius: 1500, objective: 'o_rats' }],
    triggers: [
      {
        id: 't_trappers',
        when: { kind: 'time', t: 10 },
        actions: [{ kind: 'radio', from: TR, text: 'Viper, Marine Parade Trappers. Two rats round the blocks off Wallace Street and Hamilton Road, and one on the Shangri-La\'s roof.' }],
      },
      {
        id: 't_alert',
        when: { kind: 'runner_alert', group: T07_GROUP },
        actions: [{ kind: 'radio', from: TR, text: 'That one has sat up. It is looking at you.' }],
      },
      {
        id: 't_tower',
        when: { kind: 'group_destroyed', group: T07_ROOF_GROUP },
        actions: [{ kind: 'radio', from: TR, text: 'Well. That rat is off the roof.' }],
      },
      {
        id: 't_done',
        when: { kind: 'all', of: [{ kind: 'group_destroyed', group: T07_GROUP }, { kind: 'group_destroyed', group: T07_ROOF_GROUP }] },
        actions: [{ kind: 'radio', from: TR, text: 'That is all three. Herne Bay is rat-free.' }],
      },
    ],
    hints: [
      { id: 'h_pod', text: 'TGT designates a rat: the target camera ZOOMs the pod onto it. It is 20 cm long', when: { kind: 'time', t: 5 }, duration: 9 },
      { id: 'h_stops', text: 'StormBreaker: release while the rat STOPS at a drain. Running, the bomb can\'t track it', when: { kind: 'area', x: STREETS.x, z: STREETS.z, radius: 7000 }, duration: 9 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Herne Bay is all yours. Three rats: catch them standing still.', priority: 2 }],
    successText: 'Three rats. That is the release the stoat needs, Viper.',
    costSummary: { comparison: { label: 'A rat trap, for comparison', nzd: 40 }, removed: { label: 'Rats removed', groups: [T07_GROUP, T07_ROOF_GROUP] } },
  },
});
