/**
 * F35-A — training missions (always unlocked, Auckland), in the order the campaign needs them
 * (MissionDef.lessons on each campaign mission), so a player flies only what the next mission asks for:
 *   T01 Basic flight — rings over the harbour, throttle / afterburner / turns, RTB               → g01
 *   T02 Air-to-air — unarmed MiG-29 target drones: AMRAAM, multiple targets, AIM-9X / guns        → g01
 *   T03 Vertical reversals — Shahed drills: an Immelmann after a head-on pass, a loop to get
 *       behind a drone that is behind you, gun kills                                             → g01
 *   T04 Maritime strike — StormBreaker on moving boats, AARGM-ER on a radar, gun (trainingStrike.ts) → g02
 *   T05 Gulf Defence — missile defence drills against the IRGC air-defence boat (trainingDefence.ts) → g02
 *   T06 Live SAMs — live SA-6 + Shilka, chaff / flares / notching / terrain masking, JDAM          → g03
 * Ids match the numbers players see. Saves from before this order hold the SA-6 lesson as 't03':
 * progress.ts moves it to 't06' once (LESSON_IDS_VERSION).
 */
import type { MissionDef } from '../../core/contracts';
import { SHAHED_SPEED } from '../../sim/drone/oneWay';
import type { Condition } from '../schema';
import { NEVER, P, flight, mission, site, target } from './common';
import { T05_DEFENCE } from './trainingDefence';
import { T04_STRIKE } from './trainingStrike';

const DS = 'DARKSTAR';
const TOWER = 'Whenuapai Tower';

/* ───────────────────────── T1 — Basic flight ───────────────────────── */

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
    'Fly through six rings over the Waitematā and the isthmus — the Harbour Bridge, North Head, Mission Bay, Mt Wellington and Mt Eden — then bring the jet home to Whenuapai. Bonus points if you fly under the bridge.',
  ],
  recommendedLoadout: 'a2a_stealth',
  allowedLoadouts: ['a2a_stealth', 'a2a_beast'],
  player: { x: -9000, z: -6000, altitude: 1200, heading: 100, speed: 220, fuel: 0.9 },
  script: {
    autoHints: true,
    parTime: 300,
    awacs: { initialPictureAt: -1, pictureInterval: 0 },
    waypoints: [
      ...RINGS.map((r) => ({ id: r.id, label: r.label, kind: 'nav' as const, x: r.x, z: r.z, altitude: r.altitude, radius: 700 })),
      { id: 'home', label: 'Whenuapai', kind: 'rtb' as const, x: P.whenuapai.x, z: P.whenuapai.z, altitude: 800, radius: 3000 },
    ],
    objectives: [
      { id: 'o_rings', kind: 'waypoints', waypoints: RINGS.map((r) => r.id), label: 'Fly through all six rings', primary: true },
      { id: 'o_rtb', kind: 'rtb', x: P.whenuapai.x, z: P.whenuapai.z, radius: 3000, label: 'Return to Whenuapai', primary: true },
      // the stunt's own span test, and the stunt pays the bonus (one pass = +250, not +500)
      { id: 'o_bridge', kind: 'bridge', label: 'Fly under the Harbour Bridge', primary: false },
    ],
    triggers: [
      { id: 't_done', when: { kind: 'objective', id: 'o_rings', state: 'complete' }, actions: [{ kind: 'radio', from: TOWER, text: 'Viper 1, Tower. Nice flying. Come on home.' }] },
    ],
    hints: [
      { id: 'h1', text: 'STICK ({stickThumb}): pull back to climb, push to dive, sideways to roll', when: { kind: 'time', t: 1.5 }, duration: 7 },
      { id: 'h2', text: 'THROTTLE ({throttleThumb} thumb): slide up for power, past the detent for AFTERBURNER', when: { kind: 'time', t: 9 }, duration: 7 },
      { id: 'h3', text: 'Follow the steering cue to each ring. Next: the Harbour Bridge — the main span has 43 m clearance…', when: { kind: 'waypoint', id: 'r1' }, duration: 8 },
      { id: 'h4', text: 'To turn: roll into a bank, then pull. More pull = tighter turn, but you bleed speed', when: { kind: 'waypoint', id: 'r3' }, duration: 7 },
      { id: 'h5', text: 'Climb to the next ring: add power first, then raise the nose', when: { kind: 'waypoint', id: 'r4' }, duration: 7 },
      { id: 'h6', text: 'Too fast? Pull the throttle to IDLE: the speed brake opens at the stop', when: { kind: 'waypoint', id: 'r5' }, duration: 7 },
      { id: 'h7', text: 'Rings complete! Follow the RTB cue home to Whenuapai', when: { kind: 'objective', id: 'o_rings', state: 'complete' }, duration: 7 },
    ],
    opening: [{ kind: 'radio', from: TOWER, text: 'Viper 1, Whenuapai Tower. Training area is hot. Six rings over the harbour, then come home.', priority: 2 }],
    successText: 'Welcome back, Viper. You are cleared for weapons training.',
  },
});

/* ───────────────────────── T2 — Air-to-air ───────────────────────── */

export const T02: MissionDef = mission({
  id: 't02',
  kind: 'training',
  index: 2,
  title: 'Air-to-Air',
  subtitle: 'AMRAAM, Sidewinder and gun vs drones',
  timeOfDay: 'day',
  weather: 'scattered',
  briefing: [
    'Three waves of unarmed MiG-29 target drones will launch over the Gulf. They cannot shoot back, so take your time and do it by the book.',
    'Beyond visual range, the AMRAAM drill: (1) tap the TD box (or TGT) to designate the drone — that also commands a radar LOCK; (2) point the nose at it: the lock only builds while it is within 30° of the nose; (3) wait for SHOOT — IN RANGE alone means a long, low-odds shot; (4) fire; (5) crank — turn 50° off the drone and keep it on the radar until the missile calls PITBULL.',
    'Up close: the AIM-9X locks wherever you look. Put the drone in the seeker circle, wait for the lock tone and fire. Out of missiles? The GAU-22 gun: put the pipper on the target and hold the trigger inside 1,200 m.',
  ],
  recommendedLoadout: 'a2a_beast',
  allowedLoadouts: ['a2a_beast', 'a2a_stealth'],
  player: { x: -6000, z: -8000, altitude: 4000, heading: 60, speed: 240 },
  script: {
    autoHints: true,
    parTime: 360,
    groups: [
      flight('drone1', 'mig29', 1, { x: 12000, z: -17000 }, 4000, 240, 220, 'fighter', {
        skill: 0,
        fixedCount: true,
        unarmed: true,
        callsign: 'Drone',
        task: { kind: 'patrol', x: 8000, z: -14000, radius: 4000, altitude: 4000 },
      }),
      flight('drone2', 'mig29', 2, { x: 16000, z: -16000 }, 5000, 250, 220, 'fighter', {
        skill: 0.1,
        fixedCount: true,
        unarmed: true,
        callsign: 'Drone',
        firstNumber: 2,
        spawn: NEVER,
        task: { kind: 'patrol', x: 8000, z: -12000, radius: 5000, altitude: 5000 },
      }),
      flight('drone3', 'mig29', 1, { x: 14000, z: -6000 }, 4000, 270, 230, 'interceptor', {
        skill: 0.2,
        fixedCount: true,
        unarmed: true,
        callsign: 'Drone',
        firstNumber: 4,
        spawn: NEVER,
        task: { kind: 'attack_player' },
      }),
    ],
    objectives: [
      { id: 'o_d1', kind: 'destroy', groups: ['drone1'], label: 'BVR: kill the drone with an AMRAAM', primary: true },
      { id: 'o_d2', kind: 'destroy', groups: ['drone2'], label: 'Two targets: designate and shoot each', primary: true, activeAt: { kind: 'objective', id: 'o_d1', state: 'complete' } },
      { id: 'o_d3', kind: 'destroy', groups: ['drone3'], label: 'Dogfight: AIM-9X or guns', primary: true, activeAt: { kind: 'objective', id: 'o_d2', state: 'complete' } },
    ],
    triggers: [
      {
        id: 't_wave2',
        when: { kind: 'objective', id: 'o_d1', state: 'complete' },
        delay: 4,
        actions: [
          { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Good kill. Two more drones launching, north-east.' },
          { kind: 'spawn', group: 'drone2' },
        ],
      },
      {
        id: 't_wave3',
        when: { kind: 'objective', id: 'o_d2', state: 'complete' },
        delay: 4,
        actions: [
          { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Last drone is programmed to merge with you. Knife fight.' },
          { kind: 'spawn', group: 'drone3' },
          { kind: 'hint', text: 'WPN selects the AIM-9X (beast loadout) or the GUN: look at the drone, wait for the TONE, fire', duration: 9 },
        ],
      },
    ],
    hints: [
      { id: 'h1', text: 'Step 1: the drone is on your radar. Tap its TD box (or TGT) to designate it and command a LOCK', when: { kind: 'time', t: 4 }, until: { kind: 'player_radar', state: 'designated' }, duration: 9 },
      { id: 'h2', text: 'Step 2: point the nose at the TD box — the lock only builds within 30° of the nose', when: { kind: 'player_radar', state: 'designated' }, until: { kind: 'player_radar', state: 'locked' }, duration: 8 },
      { id: 'h2b', text: 'Step 3: LOCKED. Wait for SHOOT — IN RANGE alone is a long, low-odds shot', when: { kind: 'player_radar', state: 'locked' }, until: { kind: 'player_fired' }, duration: 8 },
      { id: 'h2c', text: 'Step 4: now CRANK — turn 50° off the drone and keep it on the radar until PITBULL', when: { kind: 'player_fired' }, until: { kind: 'objective', id: 'o_d1', state: 'complete' }, duration: 8 },
      { id: 'h3', text: 'Two targets: TGT moves the TD box and the lock to the next drone — shoot one, then the other', when: { kind: 'group_spawned', group: 'drone2' }, duration: 8 },
      { id: 'h4', text: 'Out of missiles? Select the GUN and put the pipper on the drone inside 1,200 m', when: { kind: 'player_fired', count: 7 }, duration: 8 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Target drone airborne north-east of you. It is unarmed. Do it by the book.', priority: 2 }],
    successText: 'Air-to-air qualification complete.',
  },
});

/* ───────────────────────── T6 — Live SAMs ───────────────────────── */

const sa6 = P.rangSW;
/** The fuel depot on Motutapu (centre of the two tanks). */
const depot = { x: 13000, z: -8900 };

export const T06: MissionDef = mission({
  // 't03' before the campaign order (#271): old saves are migrated (progress.ts)
  id: 't06',
  kind: 'training',
  index: 6,
  title: 'Live SAMs',
  subtitle: 'Survive a live SA-6 and JDAM a fuel depot',
  timeOfDay: 'day',
  weather: 'clear',
  briefing: [
    'Live-fire SAM training. An SA-6 battery and a Shilka on Rangitoto cover a fuel depot on Motutapu, the island behind it. The missiles are real. The steering cue takes you north round the SA-6, beyond the range its radar can pick up a clean F-35, to an IP north-east of Motutapu: run in from there.',
    'Radars that see you show on the RWR; threat rings are on the TSD. A clean F-35 is hard to see, but not invisible. If a SAM launches: turn to put the missile on your wing (beam it) and press CMS every two or three seconds from about 6 s to impact: one press drops chaff and flares together, at launch they are wasted, and a held button wears them out. The notch works best low, but be low before the shot: a dive after the launch is too late. Do not run: the missile is faster. Against a heat-seeker, the same hard turn across it, afterburner off, and CMS late, in the last three seconds.',
    'Better still, deny the shot: below 300 ft the volcano blocks the radar line of sight. Then the strike: climb high, tap WPN to select the JDAM, TGT to designate the fuel tanks, and release the moment IN RANGE shows (STEER means turn toward the target first). The bomb flies itself; you turn for home. There is no rearming, so make each release count.',
  ],
  recommendedLoadout: 'strike_stealth',
  allowedLoadouts: ['strike_stealth', 'sead_stealth', 'strike_beast'],
  player: { x: -13000, z: -1500, altitude: 3500, heading: 80, speed: 230 },
  script: {
    autoHints: true,
    parTime: 360,
    awacs: { initialPictureAt: -1 },
    sams: [site('sa6', 'sa6', 'sa6', sa6, { heading: 240 }), site('zsu', 'aaa', 'zsu23', P.rangS)],
    // the depot sits behind Rangitoto from the SA-6, 6 km from it, so a JDAM released from the IP side
    // stays outside the SA-6's reach on a stealthy jet; it used to sit 3 km from the SA-6 on Rangitoto's
    // eastern slope, where every release point was inside it (playtest 2026-10-02, 1.1-e, issue #57)
    ground: [target('fuel1', 'depot', 'fuel', { x: 12800, z: -9000 }), target('fuel2', 'depot', 'fuel', { x: 13200, z: -8800 })],
    objectives: [
      { id: 'o_depot', kind: 'destroy', groups: ['depot'], label: 'Destroy the fuel depot with a JDAM', primary: true },
      { id: 'o_sa6', kind: 'destroy', groups: ['sa6'], label: 'Destroy the SA-6', primary: false },
      { id: 'o_aaa', kind: 'destroy', groups: ['aaa'], label: 'Destroy the Shilka', primary: false },
    ],
    waypoints: [
      // round the north of the SA-6 ring (≥ 15 km from it) to an IP north-east of Motutapu, 18 km from the
      // SA-6: beyond the range its radar picks up a clean F-35 (at the cued altitudes the route is in its
      // line of sight, so this works by range, not terrain masking). The old IP over North Head was 6 km
      // from the SA-6 in plain sight across the channel (issue #57)
      { id: 'wp_north', label: 'Long Bay', kind: 'nav', x: -4000, z: -17000, altitude: 3000 },
      { id: 'wp_gulf', label: 'Tiritiri', kind: 'nav', x: 10000, z: -24000, altitude: 6000 },
      { id: 'wp_ip', label: 'IP Motutapu', kind: 'ip', x: 22000, z: -16000, altitude: 7500 },
      { id: 'wp_depot', label: 'Fuel depot', kind: 'target', x: depot.x, z: depot.z, objective: 'o_depot' },
    ],
    triggers: [
      {
        id: 't_launch',
        when: { kind: 'sam_engaged' },
        actions: [{ kind: 'hint', text: 'SAM LAUNCH! Beam it 90° and press CMS every 2–3 s from ~6 s to impact', duration: 9 }],
      },
    ],
    hints: [
      { id: 'h1', text: 'The RWR shows radars looking at you. The SA-6 ring is on the TSD — its missiles reach 20 km', when: { kind: 'time', t: 3 }, duration: 8 },
      { id: 'h2', text: 'Stay clean and in the bays: the SA-6 only sees a stealthy F-35 at ~10 km', when: { kind: 'area', x: sa6.x, z: sa6.z, radius: 24000 }, duration: 7 },
      { id: 'h3', text: 'Go low: below 300 ft the volcano blocks the radar line of sight', when: { kind: 'area', x: sa6.x, z: sa6.z, radius: 14000, above: 300 }, duration: 8 },
      { id: 'h4', text: 'Tap WPN to select the JDAM, TGT to designate the fuel tanks, release the moment IN RANGE shows', when: { kind: 'area', x: depot.x, z: depot.z, radius: 13000 }, duration: 9 },
      { id: 'h5', text: 'Missile on the MAWS: count down the time-to-impact. CMS from ~6 s, a press every 2–3 s', when: { kind: 'missile_inbound' }, duration: 7 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Live SAM training over Rangitoto. The SA-6 is real. Get in, drop a JDAM on the depot, get out alive.', priority: 2 }],
    successText: 'SAM and strike qualification complete. You are ready, Viper.',
  },
});

/* ───────────────────────── T3 — Vertical reversals ───────────────────────── */

const KT = 0.514444;
/**
 * Measured in the flight model (clean jet, 1,000 ft): a loop from 300 kt in afterburner takes
 * ~26 s and ~880 m of height and comes out ~500 m on from where it started; from 200 kt it only
 * goes round in afterburner (on MIL it hangs on its back at 73 kt). A half loop from 300 kt
 * tops out ~850 m up at ~120 kt after ~14 s. In those 26 s a Shahed flies ~1.3 km: a drone
 * ~200 m behind the jet when the loop starts is ~600 m ahead of it at the bottom, gun range.
 */
const T03_START = { x: 24000, z: -22000, altitude: 1500, heading: 270, speed: 350 * KT, fuel: 0.9 };
/** Fast and high enough for the drill's next drone. */
const T03_READY: Condition = {
  kind: 'all',
  of: [
    { kind: 'player_speed', above: 280 * KT },
    { kind: 'area', x: 0, z: 0, radius: 60_000, above: 700 },
  ],
};

export const T03: MissionDef = mission({
  id: 't03',
  kind: 'training',
  index: 3,
  title: 'Vertical Reversals',
  subtitle: 'Immelmann and loop vs Shahed drones — guns only',
  timeOfDay: 'day',
  weather: 'clear',
  briefing: [
    'Shaheds fly at 100 knots; you can barely fly that slowly. In Buzz Kill you will pass them head-on and overshoot them from behind. Turn round in the vertical instead: you stay over the drone\'s track and slow down at the top.',
    'Drill 1, the Immelmann. A training Shahed comes at you head-on, 500 ft below. Let it pass under you and count three: that puts room between you. Then full afterburner and pull straight up. Over the top, on your back, roll upright. You come out about 1,200 m above it and 1,500 m behind it, slow and going its way. Throttle back, dive in behind it and gun it from 600 m.',
    'Drill 2, the loop. A second drone appears 200 m behind you, going your way. Full afterburner, full back stick, wings level all the way round. The loop brings you back to where you started, and in those 25 seconds the drone flies under you: at the bottom it is about 600 m ahead. Throttle to idle and gun it.',
    'Only the gun today. Below 300 knots the loop only goes round in afterburner. Kill the drones beyond 150 m: their warheads are live.',
  ],
  recommendedLoadout: 'clean',
  allowedLoadouts: ['clean'],
  gunAmmo: 400,
  timeLimit: 720,
  player: T03_START,
  script: {
    autoHints: false,
    parTime: 300,
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
      // 200 m behind the jet, at its height and going its way; its target lies 15 km ahead
      flight('loop_drone', 'shahed136', 1, { x: 0, z: 200 }, 0, 0, SHAHED_SPEED, 'bomber', {
        relative: 'player',
        fixedCount: true,
        callsign: 'Drone',
        firstNumber: 2,
        noun: 'drones',
        announce: false,
        spawn: NEVER,
        oneWay: { targetX: 0, targetZ: -15_000 },
      }),
    ],
    objectives: [
      { id: 'o_imm', kind: 'maneuver', maneuver: 'immelmann', label: 'Head-on pass, then an Immelmann', primary: true },
      { id: 'o_kill1', kind: 'destroy', groups: ['imm_drone'], label: 'Gun the drone from behind', primary: true, activeAt: { kind: 'objective', id: 'o_imm', state: 'complete' } },
      { id: 'o_loop', kind: 'maneuver', maneuver: 'loop', label: 'Drone behind you: loop', primary: true, activeAt: { kind: 'group_spawned', group: 'loop_drone' } },
      { id: 'o_kill2', kind: 'destroy', groups: ['loop_drone'], label: 'Gun the second drone', primary: true, activeAt: { kind: 'objective', id: 'o_loop', state: 'complete' } },
    ],
    triggers: [
      {
        id: 't_imm_done',
        when: { kind: 'objective', id: 'o_imm', state: 'complete' },
        actions: [{ kind: 'hint', text: 'Good Immelmann. It is ahead and below, going your way: throttle back, dive in behind it, gun it at 600 m', duration: 9 }],
      },
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
        id: 't_loop',
        when: { kind: 'all', of: [{ kind: 'objective', id: 'o_kill1', state: 'complete' }, T03_READY] },
        delay: 4,
        actions: [
          { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Drone two, two hundred metres behind you. Loop now!', priority: 2 },
          { kind: 'spawn', group: 'loop_drone' },
          { kind: 'hint', text: 'It is BEHIND you: LOOP NOW. Full afterburner, full back stick, wings level all the way round', duration: 9 },
        ],
      },
      {
        id: 't_loop_done',
        when: { kind: 'objective', id: 'o_loop', state: 'complete' },
        actions: [{ kind: 'hint', text: 'It flew under you: now it is ahead. Throttle to IDLE and gun it at 600 m', duration: 9 }],
      },
      {
        // shot down (or lost) before the loop: a new drone behind the jet
        id: 't_loop_retry',
        when: { kind: 'all', of: [{ kind: 'group_destroyed', group: 'loop_drone' }, { kind: 'not', of: { kind: 'objective', id: 'o_loop', state: 'complete' } }, T03_READY] },
        delay: 4,
        repeat: 6,
        actions: [
          { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. That one does not count. Another drone behind you. Loop!' },
          { kind: 'respawn', group: 'loop_drone' },
        ],
      },
    ],
    hints: [
      { id: 'h1', text: 'Drone ahead, head-on and 500 ft below. Let it pass under you: do not shoot yet', when: { kind: 'group_spawned', group: 'imm_drone' }, until: { kind: 'objective', id: 'o_imm', state: 'complete' }, duration: 8 },
      { id: 'h2', text: 'IMMELMANN: it passes under you, count three, full AFTERBURNER, pull up. Over the top: roll upright', when: { kind: 'time', t: 11 }, until: { kind: 'objective', id: 'o_imm', state: 'complete' }, duration: 12 },
      { id: 'h3', text: 'Next drill: straight and level above 2,000 ft, over 300 knots. The next drone appears right behind you', when: { kind: 'objective', id: 'o_kill1', state: 'complete' }, until: { kind: 'group_spawned', group: 'loop_drone' }, duration: 10 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Training drone inbound, head-on. Guns only. Pass it, then the Immelmann.', priority: 2 }],
    successText: 'Vertical reversals complete. Use them on the real swarm.',
  },
});


/** In `index` order: what the Training screen lists and the NEXT lesson button walks. */
export const TRAINING_MISSIONS: MissionDef[] = [T01, T02, T03, T04_STRIKE, T05_DEFENCE, T06];
