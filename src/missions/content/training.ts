/**
 * F35-A — training missions (always unlocked, Auckland), in the order the campaign needs them
 * (MissionDef.lessons on each campaign mission), so a player flies only what the next mission asks for:
 *   T01 Basic flight — rings over the harbour, throttle / afterburner / turns                     → g01
 *   T02 Air-to-air — training Shaheds head-on: an AMRAAM, a row stepped through with FIRE, then
 *       the AIM-9X inside 2 km                                                                   → g01
 *   T03 Turn and gun — a Shahed head-on, an Immelmann, then g01's gun pass from behind           → g01
 *   T04 Maritime strike — StormBreaker on moving boats, AARGM-ER on a radar, a gun pass (trainingStrike.ts) → g02
 *   T05 Gulf Defence — three missile-defence drills against the IRGC air-defence boat (trainingDefence.ts) → g02
 *   T06 Live SAMs — live SA-6 + Shilka on g03's loadout: low, an AARGM-ER close in, a StormBreaker  → g03
 *   T07 Small Targets — sewer rats in Herne Bay: a StormBreaker while they stop (trainingSmallTargets.ts) → g03
 * Ids match the numbers players see. Saves from before this order hold the SA-6 lesson as 't03':
 * progress.ts moves it to 't06' once (LESSON_IDS_VERSION).
 */
import type { MissionDef } from '../../core/contracts';
import { AARGM_RULE, LOADOUTS } from '../../core/data';
import { SHAHED_SPEED } from '../../sim/drone/oneWay';
import type { Condition } from '../schema';
import { NEVER, P, flight, mission, site, target } from './common';
import { G01_GUN_PASS, G01_HINTS } from './irgc';
import { T05_DEFENCE } from './trainingDefence';
import { T04_STRIKE } from './trainingStrike';
import { T07_SMALL } from './trainingSmallTargets';

const DS = 'DARKSTAR';
const TOWER = 'Whenuapai Tower';

/* ───────────────────────── T01 — Basic flight ───────────────────────── */

const RINGS = [
  { id: 'r1', label: 'Ring 1', x: -5500, z: -4200, altitude: 1200 },
  { id: 'r2', label: 'Ring 2 — Harbour Bridge', x: P.harbourBridge.x, z: P.harbourBridge.z, altitude: 400 },
  { id: 'r3', label: 'Ring 3 — North Head', x: P.northHead.x, z: P.northHead.z, altitude: 800 },
  { id: 'r4', label: 'Ring 4 — Mission Bay', x: P.missionBay.x, z: P.missionBay.z + 600, altitude: 600 },
  { id: 'r5', label: 'Ring 5 — Mt Wellington', x: P.mtWellington.x, z: P.mtWellington.z, altitude: 2000 },
  { id: 'r6', label: 'Ring 6 — Mt Eden', x: P.mtEden.x, z: P.mtEden.z, altitude: 1500 },
];

export const T01: MissionDef = mission({
  id: 't01',
  kind: 'training',
  index: 1,
  title: 'Basic Flight',
  subtitle: 'Stick, throttle, turns — six rings over the city',
  timeOfDay: 'day',
  weather: 'clear',
  briefing: [
    'Welcome to the F-35A Lightning II. Before the shooting starts, get a feel for the jet over the city you are here to defend.',
    'The side-stick sits under your stick thumb (right by default; left in the left-handed layout; Tilt steering replaces it): pull to climb, push to dive, sideways to roll. The throttle is under the other thumb: slide it up for power and past the detent for afterburner. The fly-by-wire keeps you inside the 9 g limit — mostly.',
    'Fly through six rings over the Waitematā and the isthmus: the Harbour Bridge, North Head, Mission Bay, Mt Wellington and Mt Eden. Bonus points if you fly under the bridge.',
  ],
  recommendedLoadout: 'a2a_stealth',
  allowedLoadouts: ['a2a_stealth', 'a2a_beast'],
  player: { x: -9000, z: -6000, altitude: 1200, heading: 100, speed: 220, fuel: 0.9 },
  script: {
    autoHints: true,
    parTime: 240,
    awacs: { initialPictureAt: -1, pictureInterval: 0 },
    // the lesson ends at the last ring: no campaign mission has the player fly home (playtest r1, 1.4-a)
    waypoints: RINGS.map((r) => ({ id: r.id, label: r.label, kind: 'nav' as const, x: r.x, z: r.z, altitude: r.altitude, radius: 700 })),
    objectives: [
      { id: 'o_rings', kind: 'waypoints', waypoints: RINGS.map((r) => r.id), label: 'Fly through all six rings', primary: true },
      // the stunt's own span test, and the stunt pays the bonus (one pass = +250, not +500)
      { id: 'o_bridge', kind: 'bridge', label: 'Fly under the Harbour Bridge', primary: false },
    ],
    hints: [
      { id: 'h1', text: 'STICK ({stickThumb}): pull back to climb, push to dive, sideways to roll', when: { kind: 'time', t: 1.5 }, duration: 7 },
      { id: 'h2', text: 'THROTTLE ({throttleThumb} thumb): slide up for power, past the detent for AFTERBURNER', when: { kind: 'time', t: 9 }, duration: 7 },
      { id: 'h3', text: 'Follow the steering cue to each ring. Next: the Harbour Bridge — the main span has 43 m clearance…', when: { kind: 'waypoint', id: 'r1' }, duration: 8 },
      { id: 'h4', text: 'To turn: roll into a bank, then pull. More pull = tighter turn, but you bleed speed', when: { kind: 'waypoint', id: 'r3' }, duration: 7 },
      { id: 'h5', text: 'Climb to the next ring: add power first, then raise the nose', when: { kind: 'waypoint', id: 'r4' }, duration: 7 },
      { id: 'h6', text: 'Too fast? Pull the throttle to IDLE: the speed brake opens at the stop', when: { kind: 'waypoint', id: 'r5' }, duration: 7 },
    ],
    opening: [{ kind: 'radio', from: TOWER, text: 'Viper 1, Whenuapai Tower. Training area is hot. Six rings over the harbour: enjoy the view.', priority: 2 }],
    successText: 'Nice flying, Viper. You are cleared for weapons training.',
  },
});

/* ───────────────────────── T02 — Air-to-air ───────────────────────── */

/** A hint's text in g01 (G01_HINTS): the lessons say it in Buzz Kill's words, so the two can't drift. */
const g01Hint = (id: string): string => G01_HINTS!.find((h) => h.id === id)!.text;

/**
 * The Beast load's AMRAAMs: drill 1 takes one and drill 2's row one each, so they are gone by drill 3
 * (the autoselect moves on to the AIM-9X), as g01's swarm uses them up before the AIM-9X and the gun.
 */
const T02_AMRAAMS = LOADOUTS.a2a_beast.stores.reduce((n, s) => n + (s.weapon === 'aim120' ? s.count : 0), 0);
export const T02_ROW = T02_AMRAAMS - 1;
/** The drills' Shaheds fly this far below the jet (m; kept clear of the ground): from the start height, g01's 1,000 ft. */
const T02_BELOW = -1200;

export const T02: MissionDef = mission({
  id: 't02',
  kind: 'training',
  index: 2,
  title: 'Air-to-Air',
  subtitle: 'Missiles and the heat-seeker on drones',
  timeOfDay: 'day',
  weather: 'scattered',
  briefing: [
    'Buzz Kill is a swarm of Shahed drones: slow, dumb, and they never shoot back. Practise on training Shaheds first, with the Beast load: six AMRAAMs, two AIM-9Xs and the gun.',
    `Drill 1, one drone head-on: tap the box around it (or TGT) to lock it, point your nose at it, wait for SHOOT and fire. The AMRAAM finds it by itself. Drill 2, a row of ${T02_ROW}: after each launch the next drone is boxed, so keep pressing FIRE.`,
    'Drill 3, one more head-on: the AMRAAMs are gone and the AIM-9X is up. Its seeker needs the tone (a growl), so fire inside about 2 km.',
  ],
  recommendedLoadout: 'a2a_beast',
  // the Beast load is g01's, and drill 3 needs its AIM-9X
  allowedLoadouts: ['a2a_beast'],
  player: { x: -6000, z: -8000, altitude: 1500, heading: 60, speed: 230 },
  script: {
    // no auto hints: they teach the crank and PITBULL, and a Shahed never shoots back
    autoHints: false,
    parTime: 240,
    awacs: { initialPictureAt: -1, pictureInterval: 0 },
    // each drill's drones appear ahead of the jet, wherever it is (relative), flying at it: a training
    // Shahed's one-way target lies 15 km behind the jet, so it never gets there before the drill is flown
    groups: [
      flight('drone1', 'shahed136', 1, { x: 0, z: -15_000 }, T02_BELOW, 0, SHAHED_SPEED, 'bomber', {
        relative: 'player',
        fixedCount: true,
        callsign: 'Drone',
        noun: 'drones',
        announce: false,
        spawn: { kind: 'time', t: 3 },
        oneWay: { targetX: 0, targetZ: 15_000 },
      }),
      // a row abreast, 300 m apart, holding its spacing until it passes the jet
      flight('row', 'shahed136', T02_ROW, { x: 0, z: -15_000 }, T02_BELOW, 0, SHAHED_SPEED, 'bomber', {
        relative: 'player',
        fixedCount: true,
        formation: 'wall',
        spacing: 100,
        callsign: 'Drone',
        firstNumber: 2,
        noun: 'drones',
        announce: false,
        spawn: NEVER,
        oneWay: { targetX: 0, targetZ: 15_000, route: [{ x: 0, z: 0 }] },
      }),
      // head-on again, as the swarm's last drones meet the jet in g01: the AIM-9X's tone comes inside ~2 km
      flight('drone3', 'shahed136', 1, { x: 0, z: -10_000 }, T02_BELOW, 0, SHAHED_SPEED, 'bomber', {
        relative: 'player',
        fixedCount: true,
        callsign: 'Drone',
        firstNumber: T02_ROW + 2,
        noun: 'drones',
        announce: false,
        spawn: NEVER,
        oneWay: { targetX: 0, targetZ: 15_000 },
      }),
    ],
    objectives: [
      { id: 'o_d1', kind: 'destroy', groups: ['drone1'], label: 'Head-on: one drone, one AMRAAM', primary: true },
      { id: 'o_d2', kind: 'destroy', groups: ['row'], label: `A row of ${T02_ROW}: keep pressing FIRE`, primary: true, activeAt: { kind: 'objective', id: 'o_d1', state: 'complete' } },
      { id: 'o_d3', kind: 'destroy', groups: ['drone3'], label: 'The AIM-9X: on the tone, inside 2 km', primary: true, activeAt: { kind: 'objective', id: 'o_d2', state: 'complete' } },
    ],
    triggers: [
      {
        id: 't_row',
        when: { kind: 'objective', id: 'o_d1', state: 'complete' },
        delay: 4,
        actions: [
          { kind: 'radio', from: DS, text: `Viper 1, Darkstar. Good kill. ${T02_ROW} more, in a row, head-on.` },
          { kind: 'spawn', group: 'row' },
        ],
      },
      {
        id: 't_last',
        when: { kind: 'objective', id: 'o_d2', state: 'complete' },
        delay: 4,
        actions: [
          { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Last one, head-on. Take it with the AIM-9X.' },
          { kind: 'spawn', group: 'drone3' },
        ],
      },
    ],
    hints: [
      { id: 'h1', text: 'Drone ahead, head-on. Tap the box around it (or TGT) to lock it', when: { kind: 'time', t: 5 }, until: { kind: 'player_radar', state: 'designated' }, duration: 8 },
      { id: 'h2', text: 'Point your nose at the box: the lock builds within 30° of the nose', when: { kind: 'player_radar', state: 'designated' }, until: { kind: 'player_radar', state: 'locked' }, duration: 8 },
      { id: 'h3', text: 'LOCKED. Wait for SHOOT, then FIRE', when: { kind: 'player_radar', state: 'locked' }, until: { kind: 'player_fired' }, duration: 8 },
      { id: 'h4', text: 'Missile away: the AMRAAM finds the drone by itself', when: { kind: 'player_fired' }, until: { kind: 'objective', id: 'o_d1', state: 'complete' }, duration: 6 },
      { id: 'h5', text: `${T02_ROW} drones in a row. Lock one, FIRE on SHOOT`, when: { kind: 'group_spawned', group: 'row' }, duration: 7 },
      { id: 'h6', text: g01Hint('h_swarm'), when: { kind: 'all', of: [{ kind: 'group_spawned', group: 'row' }, { kind: 'player_fired', count: 2 }] }, duration: 8 },
      { id: 'h7', text: 'Last drone, head-on, for the AIM-9X: it is on the FIRE button once the AMRAAMs are gone', when: { kind: 'group_spawned', group: 'drone3' }, duration: 6 },
      { id: 'h8', text: g01Hint('h_9x'), when: { kind: 'all', of: [{ kind: 'group_spawned', group: 'drone3' }, { kind: 'player_weapon', weapon: 'aim9x' }] }, duration: 8 },
      { id: 'h9', text: g01Hint('h_gun'), when: { kind: 'player_weapon', weapon: 'gun' }, duration: 10 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Training Shahed inbound, head-on. It cannot shoot back. Lock it and take the shot.', priority: 2 }],
    successText: 'Air-to-air qualification complete. Next: turn and gun.',
  },
});

/* ───────────────────────── T06 — Live SAMs ───────────────────────── */

const sa6 = P.rangSW;
const shilka = P.rangS;
/** The fuel tank on Motutapu, behind Rangitoto from the SA-6 (6 km from it). */
const depot = { x: 13000, z: -8900 };
/**
 * g03's way through a SAM, on g03's loadout (playtest 2026-10-10, 1.4-a: the lesson used to fly a JDAM,
 * which no campaign mission carries, round a 60 km route that dodged the SA-6 by range, with 200 s
 * of nothing). The jet starts over the western harbour 20 km from the SA-6 and goes low over the water
 * (under the SA-6's 80 m floor, out of the Shilka's 2.5 km reach), fires an AARGM-ER inside 10 km while
 * the radar is on and presses straight in behind it, then puts a StormBreaker on the tank.
 */
export const T06_SAM = {
  start: { x: -11000, z: 1800 },
  /** Down low over the harbour off the city, 8 km from the SA-6. */
  low: { x: 1000, z: -1500 },
  sa6,
  shilka,
  depot,
} as const;
const T06_HEADING = Math.round((Math.atan2(T06_SAM.low.x - T06_SAM.start.x, -(T06_SAM.low.z - T06_SAM.start.z)) * 180) / Math.PI);

export const T06: MissionDef = mission({
  // 't03' before the campaign order (#271): old saves are migrated (progress.ts)
  id: 't06',
  kind: 'training',
  index: 6,
  title: 'Live SAMs',
  subtitle: 'Low past a live SA-6, then kill its radar',
  timeOfDay: 'day',
  weather: 'clear',
  briefing: [
    'Live-fire SAM training, with what you carry over Waiheke: two AARGM-ERs and two StormBreakers. An SA-6 on Rangitoto guards a fuel tank on Motutapu, the island behind it, and a Shilka (ZSU-23-4) anti-aircraft gun sits on Rangitoto\'s south shore. The missiles are real.',
    `Get down low over the harbour: below 250 ft the SA-6 can't engage you. Keep 3 km from the Shilka. You start with the AARGM-ER up (AARGM on the FIRE button) and the SA-6 boxed: ${AARGM_RULE}. Fired from far out, it only quiets the radar for a few seconds.`,
    'Last, a StormBreaker on the fuel tank: TGT, climb, release when IN RANGE shows. If a missile comes, turn 90° to put it on your wing (beam it) and press CMS, which drops chaff and flares together, every 2–3 s from about 6 s to impact.',
  ],
  recommendedLoadout: 'sead_precision',
  allowedLoadouts: ['sead_precision'],
  player: { x: T06_SAM.start.x, z: T06_SAM.start.z, altitude: 900, heading: T06_HEADING, speed: 240 },
  script: {
    autoHints: true,
    parTime: 180,
    awacs: { initialPictureAt: -1 },
    sams: [site('sa6', 'sa6', 'sa6', sa6, { heading: 240 }), site('zsu', 'aaa', 'zsu23', shilka)],
    ground: [target('fuel', 'depot', 'fuel', depot)],
    objectives: [
      { id: 'o_sa6', kind: 'destroy', groups: ['sa6'], label: 'AARGM-ER on the SA-6: inside 10 km, radar on', primary: true },
      { id: 'o_depot', kind: 'destroy', groups: ['depot'], label: 'StormBreaker on the fuel tank behind it', primary: true },
    ],
    waypoints: [
      { id: 'wp_low', label: 'Harbour: down low', kind: 'nav', x: T06_SAM.low.x, z: T06_SAM.low.z, altitude: 60, radius: 1500 },
      { id: 'wp_sa6', label: 'SA-6', kind: 'target', x: sa6.x, z: sa6.z, objective: 'o_sa6' },
      { id: 'wp_depot', label: 'Fuel tank', kind: 'target', x: depot.x, z: depot.z, objective: 'o_depot' },
    ],
    triggers: [
      {
        id: 't_launch',
        when: { kind: 'sam_engaged' },
        actions: [{ kind: 'hint', text: 'SAM LAUNCH! Beam it 90° and press CMS every 2–3 s from ~6 s to impact', duration: 9 }],
      },
      {
        id: 't_silent',
        when: { kind: 'group_destroyed', group: 'sa6' },
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. SA-6 is down. Now the tank on Motutapu: StormBreaker.', priority: 2 }],
      },
    ],
    hints: [
      { id: 'h1', text: 'The SA-6 reaches 20 km. Go LOW over the harbour: under 250 ft it can\'t engage you', when: { kind: 'time', t: 3 }, duration: 9 },
      { id: 'h2', text: 'AARGM on FIRE, the SA-6 boxed: fire inside 10 km while its radar is on, then press straight in', when: { kind: 'area', x: sa6.x, z: sa6.z, radius: 13000 }, duration: 9 },
      { id: 'h3', text: 'The Shilka shreds anything low and close: keep 3 km from it', when: { kind: 'area', x: shilka.x, z: shilka.z, radius: 5000, below: 3000 }, duration: 7 },
      { id: 'h4', text: 'Now WPN until FIRE reads GBU-53 (the StormBreaker), TGT the fuel tank: climb, release on IN RANGE', when: { kind: 'player_fired' }, duration: 9 },
      { id: 'h5', text: 'Missile coming: beam it, a CMS press every 2–3 s from ~6 s to impact', when: { kind: 'missile_inbound' }, duration: 7 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Live SAM training over Rangitoto. The SA-6 is real. Get low, kill its radar, bomb the tank.', priority: 2 }],
    successText: 'SAM qualification complete. Next: small targets, before Waiheke.',
  },
});

/* ───────────────────────── T03 — Turn and Gun ───────────────────────── */

const KT = 0.514444;
const FT = 0.3048;
/**
 * Measured in the flight model (clean jet, 1,000 ft): a half loop from 300 kt in afterburner tops out
 * ~850 m up at ~120 kt after ~14 s. Rolled out of the Immelmann, the drone that passed under the jet is
 * ahead and below it, going its way: the gun pass from behind (g01's numbers, G01_GUN_PASS).
 */
const T03_START = { x: 24000, z: -22000, altitude: 1500, heading: 270, speed: 350 * KT, fuel: 0.9 };
/** Before a new drone comes head-on (a retry): this fast and this high (MSL), straight and level. */
const T03_READY_AT = { kt: 280, ft: 2300 };
const T03_READY: Condition = {
  kind: 'all',
  of: [
    { kind: 'player_speed', above: T03_READY_AT.kt * KT },
    { kind: 'area', x: 0, z: 0, radius: 60_000, above: T03_READY_AT.ft * FT },
    // straight and level, as the hint says (a trigger's delay needs it held throughout): a drone that
    // appears while the jet is still diving out of its gun pass meets it below its own height
    { kind: 'player_level' },
  ],
};
const GUN = G01_GUN_PASS;
/** The lesson's clock (s): time for several tries (the chip on the briefing shows it). */
const T03_TIME_LIMIT = 720;

export const T03: MissionDef = mission({
  id: 't03',
  kind: 'training',
  index: 3,
  title: 'Turn and Gun',
  subtitle: 'Immelmann, then a gun pass on a Shahed',
  timeOfDay: 'day',
  weather: 'clear',
  briefing: [
    'Shaheds fly at about 100 knots; you can barely fly that slowly. In Buzz Kill you pass the swarm head-on, then turn round and come in behind it. Turn round upwards, with an Immelmann: you stay over the drone\'s track and slow down at the top.',
    'A training Shahed comes at you head-on, 500 ft below. Let it pass under you and count three. Then full afterburner and pull straight up; over the top, on your back, roll upright. The drone is now ahead of you and below, going your way.',
    `Then the gun pass, as in Buzz Kill: throttle back and come in behind it at about ${GUN.approachKt} knots, closing at about ${GUN.closureKt}. Sit about ${GUN.belowFt} ft below it and fire short bursts at ${GUN.burstFrom} to ${GUN.burstTo} m. Only the gun today, and its warhead is live: kill it beyond 150 m. The clock gives you ${T03_TIME_LIMIT / 60} minutes: time for several tries.`,
  ],
  recommendedLoadout: 'clean',
  allowedLoadouts: ['clean'],
  gunAmmo: 400,
  timeLimit: T03_TIME_LIMIT,
  player: T03_START,
  script: {
    autoHints: false,
    parTime: 180,
    awacs: { initialPictureAt: -1, pictureInterval: 0 },
    groups: [
      // 3 km ahead, 150 m below and flying at the jet; its target lies 15 km behind the jet
      flight('imm_drone', 'shahed136', 1, { x: 0, z: -3000 }, -150, 0, SHAHED_SPEED, 'bomber', {
        relative: 'player',
        fixedCount: true,
        callsign: 'Drone',
        noun: 'drones',
        announce: false,
        spawn: { kind: 'time', t: 3 },
        oneWay: { targetX: 0, targetZ: 15_000 },
      }),
    ],
    objectives: [
      { id: 'o_imm', kind: 'maneuver', maneuver: 'immelmann', label: 'Head-on pass, then an Immelmann', primary: true },
      // byPlayer: a drone that reaches its one-way target and blows up got away, it isn't a kill
      { id: 'o_kill', kind: 'destroy', groups: ['imm_drone'], byPlayer: true, label: 'Gun the drone from behind', primary: true, activeAt: { kind: 'objective', id: 'o_imm', state: 'complete' } },
    ],
    triggers: [
      {
        // shot down (or lost) before the Immelmann: a new drone, head-on again
        id: 't_imm_retry',
        when: { kind: 'all', of: [{ kind: 'group_destroyed', group: 'imm_drone' }, { kind: 'not', of: { kind: 'objective', id: 'o_imm', state: 'complete' } }, T03_READY] },
        delay: 3,
        repeat: 5,
        actions: [
          { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. That one does not count. Another drone, head-on. Pass it, then the Immelmann.' },
          { kind: 'respawn', group: 'imm_drone' },
        ],
      },
      {
        // got away after the Immelmann (it reached its one-way target): another one, head-on
        id: 't_kill_retry',
        when: { kind: 'all', of: [{ kind: 'group_destroyed', group: 'imm_drone' }, { kind: 'objective', id: 'o_imm', state: 'complete' }, { kind: 'not', of: { kind: 'objective', id: 'o_kill', state: 'complete' } }, T03_READY] },
        delay: 4,
        repeat: 5,
        actions: [
          { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. That one got away. Another drone, head-on. Pass it, Immelmann, and gun it.' },
          { kind: 'respawn', group: 'imm_drone' },
        ],
      },
      {
        // no drone and not ready for the next one: say what brings it
        id: 't_wait',
        when: { kind: 'all', of: [{ kind: 'group_destroyed', group: 'imm_drone' }, { kind: 'not', of: { kind: 'objective', id: 'o_kill', state: 'complete' } }, { kind: 'not', of: T03_READY }] },
        delay: 3,
        repeat: 20,
        actions: [{ kind: 'hint', text: `Next drone: fly straight and level above ${T03_READY_AT.ft.toLocaleString('en-NZ')} ft, over ${T03_READY_AT.kt} knots`, duration: 8 }],
      },
    ],
    hints: [
      { id: 'h1', text: 'Drone ahead, head-on and 500 ft below. Let it pass under you: do not shoot yet', when: { kind: 'group_spawned', group: 'imm_drone' }, until: { kind: 'objective', id: 'o_imm', state: 'complete' }, duration: 8 },
      { id: 'h2', text: 'IMMELMANN: it passes under you, count three, full AFTERBURNER, pull up. Over the top: roll upright', when: { kind: 'time', t: 11 }, until: { kind: 'objective', id: 'o_imm', state: 'complete' }, duration: 12 },
      { id: 'h3', text: 'Good Immelmann. It is ahead and below, going your way: throttle back, dive in behind it', when: { kind: 'objective', id: 'o_imm', state: 'complete' }, until: { kind: 'objective', id: 'o_kill', state: 'complete' }, duration: 7 },
      // the gun pass in Buzz Kill's words (G01_HINTS), so the lesson and the mission can't drift apart
      { id: 'h4', text: g01Hint('h_gun'), when: { kind: 'objective', id: 'o_imm', state: 'complete' }, until: { kind: 'objective', id: 'o_kill', state: 'complete' }, duration: 10 },
      { id: 'h5', text: g01Hint('h_overshoot'), when: { kind: 'objective', id: 'o_imm', state: 'complete' }, until: { kind: 'objective', id: 'o_kill', state: 'complete' }, duration: 8 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Training drone inbound, head-on. Guns only. Pass it, then the Immelmann.', priority: 2 }],
    successText: 'Turn and gun complete. Use it on the real swarm.',
  },
});

/** In `index` order: what the Training screen lists and the NEXT lesson button walks. */
export const TRAINING_MISSIONS: MissionDef[] = [T01, T02, T03, T04_STRIKE, T05_DEFENCE, T06, T07_SMALL];
