/**
 * F35-A — training lesson T4 "Gulf Defence": defending against missiles, drill by drill, with
 * practice rounds (a hit does no damage) and the defence coach's call-outs (runtime/defenceCoach.ts).
 *
 * Built from the measured defence table (stack/sam-defence-advice; tests/missions-defencecoach.test.ts),
 * against the IRGC Navy air-defence boat the player meets in g02 (a Tor-type radar SAM to 12 km and
 * 20,000 ft, shoulder-launched heat-seekers inside 5 km). Measured with the mission bot on the real
 * flight model, rounds hit / fired:
 *   1. deny the shot: over the boats above 23,000 ft, nothing reaches you (none fired);
 *   2. beam + CMS: in at 10,000 ft until it shoots, then turn 90° and press CMS every 2–3 s from ~6 s
 *      to impact (13/52; nothing 61/82, the beam alone 36/48, CMS mashed 23/59, running 39/50);
 *   3. low first: down to 500 ft at the IP before closing in, then beam it (beam alone down low 15/58,
 *      with CMS 8/53; nothing 66/88);
 *   4. the heat-seeker: past the boat 3–4 km off, low; beam it hard, afterburner off, CMS late
 *      (1/37 passing 3.5 km off; 3/48 over the top; a break into it 29/48);
 *   exam: through a gate between two boats, two missiles defeated without a hit.
 * Each drill wants defeats in a row (a hit starts the count again): three in drill 2, two in 3 and 4.
 * Luck alone strings them together rarely (a pilot ignoring the warning, 6 runs of 10 minutes: drill 2
 * never passed with three, 3 of 6 with two); the student (beam + CMS) passes each in a minute or two.
 * A jet already on the beam is never shot at: every drill starts by flying at the boat. Each drill's
 * boats cease fire when it is done ('hold_fire'), so only the drill in hand shoots; drill 4 gets a
 * fresh boat (a boat carries four heat-seekers, and drill 3's low passes can spend them). Flares and
 * chaff are topped up every 30 s and after each drill: a held button still empties them in one
 * engagement (the coach's "chaff empty").
 */
import type { MissionDef } from '../../core/contracts';
import { mission, site } from './common';

const DS = 'DARKSTAR';

/** The drills' boats and points (m). Boats in open water at least 1.5 km from any shore (LINZ coast). */
export const T04 = {
  start: { x: -5000, z: -17000 },
  /** Drill 1: two boats, and the point beyond them reached above DENY_ALT. */
  b1: [{ x: 8000, z: -16000 }, { x: 9000, z: -17500 }],
  d1End: { x: 20000, z: -16000 },
  /** Drill 2: one boat. */
  b2: { x: 26000, z: -30000 },
  /** Drill 3: one boat, and the IP 8.5 km east of it where the jet gets down low first. */
  b3: { x: 8000, z: -32000 },
  d3Ip: { x: 16000, z: -35000 },
  /** Drill 4: a fresh boat (spawned when the drill opens), and the pass point 3.5 km west of it. */
  b4: { x: 0, z: -30000 },
  d4Pass: { x: -3500, z: -30000 },
  /** Exam: two boats 8 km apart either side of the gate (4 km from each), then out to the north. */
  exam: [{ x: 2000, z: -22000 }, { x: 10000, z: -22000 }],
  gate: { x: 6000, z: -22000 },
  exit: { x: 6000, z: -12000 },
} as const;

/** Above this (m MSL, ~23,000 ft) the boats' missiles can't reach the jet (the Tor's ceiling is 6,000 m). */
export const DENY_ALT = 7000;
/** Drill 3 counts a defeat only with the jet below this (m AGL, ~650 ft). */
export const LOW_AGL = 200;

const done = (id: string) => ({ kind: 'objective', id, state: 'complete' }) as const;

export const T04_DEF: MissionDef = mission({
  id: 't04',
  kind: 'training',
  index: 4,
  title: 'Gulf Defence',
  subtitle: 'Beat the air-defence boats’ missiles, drill by drill',
  timeOfDay: 'day',
  weather: 'clear',
  briefing: [
    'Missile defence on the Hauraki Gulf range, against the IRGC air-defence boat you meet over the Gulf: a radar missile good to 12 km and 20,000 ft, and shoulder-launched heat-seekers inside 5 km. The boats fire practice rounds: a hit does no damage, and the call-out after every missile tells you how it ended and why. The sea is still real.',
    'Four drills, then an exam. One: fly over the boats above 23,000 ft and watch nothing reach you. Two: fly at the boat at 10,000 ft until it shoots, then turn 90° to put it on your wing (beam it) and press CMS every two or three seconds from about 6 s to impact. Running loses: the missile is faster, and you are caught in the turn. Three: get down to 500 ft at the IP, before you close in, then beam it: low and on the beam, the radar loses you. Four: pass 3 to 4 km off the boat, low. A heat-seeker (orange arrow) gets the same hard turn across it, afterburner off, and CMS late, in the last three seconds. Turning into it makes it worse.',
    'Exam: through the gate between two boats and out, defeating two missiles without a hit. Each drill wants missiles beaten in a row, three in drill two, and repeats until you get it: turn back in to draw another shot. A jet already on the beam is never shot at.',
  ],
  recommendedLoadout: 'a2a_stealth',
  allowedLoadouts: ['a2a_stealth'],
  // nothing to shoot today: the lesson is the defence
  gunAmmo: 0,
  player: { x: T04.start.x, z: T04.start.z, altitude: 7600, heading: 90, speed: 240 },
  script: {
    practiceRounds: true,
    defenceCoach: true,
    autoHints: true,
    parTime: 600,
    awacs: { initialPictureAt: -1, pictureInterval: 0 },
    groups: [],
    ground: [],
    sams: [
      site('b1a', 'b1', 'ad_boat', T04.b1[0], { name: 'Range boat 1', noHarass: true }),
      site('b1b', 'b1', 'ad_boat', T04.b1[1], { name: 'Range boat 2', noHarass: true }),
      site('b2', 'b2', 'ad_boat', T04.b2, { name: 'Range boat 3', noHarass: true }),
      site('b3', 'b3', 'ad_boat', T04.b3, { name: 'Range boat 4', noHarass: true }),
      site('b4', 'b4', 'ad_boat', T04.b4, { name: 'Range boat 5', spawn: done('o_d3'), noHarass: true }),
      site('ex1', 'exam', 'ad_boat', T04.exam[0], { name: 'Exam boat 1', spawn: done('o_d4'), noHarass: true }),
      site('ex2', 'exam', 'ad_boat', T04.exam[1], { name: 'Exam boat 2', spawn: done('o_d4'), noHarass: true }),
    ],
    objectives: [
      { id: 'o_d1', kind: 'reach', x: T04.d1End.x, z: T04.d1End.z, radius: 3000, above: DENY_ALT, label: 'Drill 1: over the boats above 23,000 ft', primary: true },
      { id: 'o_d2', kind: 'missile_drill', groups: ['b2'], guidance: 'radar', defeat: 3, inARow: true, label: 'Drill 2: beam it + CMS, three missiles in a row', primary: true, activeAt: done('o_d1') },
      { id: 'o_d3', kind: 'missile_drill', groups: ['b3'], guidance: 'radar', defeat: 2, inARow: true, maxAgl: LOW_AGL, label: 'Drill 3: low first, two in a row below 650 ft', primary: true, activeAt: done('o_d2') },
      { id: 'o_d4', kind: 'missile_drill', groups: ['b4'], guidance: 'ir', defeat: 2, inARow: true, label: 'Drill 4: beat two heat-seekers in a row', primary: true, activeAt: done('o_d3') },
      { id: 'o_exam', kind: 'waypoints', waypoints: ['wp_gate', 'wp_exit'], label: 'Exam: through the gate and out', primary: true, activeAt: done('o_d4') },
      { id: 'o_clean', kind: 'missile_drill', groups: ['exam'], defeat: 2, maxHits: 0, label: 'Exam: defeat two missiles without a hit', primary: false, activeAt: done('o_d4') },
    ],
    waypoints: [
      { id: 'wp_d1', label: 'Drill 1: high', kind: 'nav', x: T04.d1End.x, z: T04.d1End.z, altitude: 7600, radius: 3000, objective: 'o_d1' },
      { id: 'wp_d2', label: 'Drill 2: boat', kind: 'target', x: T04.b2.x, z: T04.b2.z, altitude: 3000, objective: 'o_d2' },
      { id: 'wp_d3ip', label: 'Drill 3: down to 500 ft', kind: 'ip', x: T04.d3Ip.x, z: T04.d3Ip.z, altitude: 150, radius: 2000 },
      { id: 'wp_d3', label: 'Drill 3: boat, low', kind: 'target', x: T04.b3.x, z: T04.b3.z, altitude: 150, objective: 'o_d3' },
      { id: 'wp_d4', label: 'Drill 4: 3–4 km off the boat', kind: 'target', x: T04.d4Pass.x, z: T04.d4Pass.z, altitude: 150, objective: 'o_d4' },
      { id: 'wp_gate', label: 'Exam gate', kind: 'nav', x: T04.gate.x, z: T04.gate.z, altitude: 1500, radius: 2000 },
      { id: 'wp_exit', label: 'Exam exit', kind: 'nav', x: T04.exit.x, z: T04.exit.z, altitude: 1500 },
    ],
    triggers: [
      // range control tops the dispensers up: a held button still empties them in one engagement
      // (the coach's "chaff empty"), but a careful pilot never runs dry over a long drill
      { id: 't_cms', when: { kind: 'start' }, repeat: 30, actions: [{ kind: 'refill_cms' }] },
      {
        id: 't_d1',
        when: done('o_d1'),
        actions: [{ kind: 'hold_fire', group: 'b1' }, { kind: 'refill_cms' }, { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Nothing fired: up there they cannot reach you. Drill two: the boat to the south-east.' }],
      },
      {
        id: 't_d2',
        when: done('o_d2'),
        actions: [{ kind: 'hold_fire', group: 'b2' }, { kind: 'refill_cms' }, { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Good beam. Drill three: down to 500 feet at the IP first, then the boat to the west.' }],
      },
      {
        id: 't_d3',
        when: done('o_d3'),
        actions: [{ kind: 'hold_fire', group: 'b3' }, { kind: 'refill_cms' }, { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Low and on the beam, it lost you. Drill four: a new boat to the west. Pass it 3 to 4 kilometres off, and watch for the heat-seeker.' }],
      },
      {
        id: 't_d4',
        when: done('o_d4'),
        actions: [{ kind: 'hold_fire', group: 'b4' }, { kind: 'refill_cms' }, { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Drills complete. Exam: two boats either side of the gate, to the north. Through it and out.', priority: 2 }],
      },
    ],
    hints: [
      { id: 'h_d1', text: 'Drill 1: stay above 23,000 ft over the boats. Their missiles can’t reach that high', when: { kind: 'time', t: 5 }, duration: 9 },
      { id: 'h_d2', text: 'Drill 2: fly at the boat at 10,000 ft. When it shoots: beam it, CMS every 2–3 s', when: { kind: 'objective', id: 'o_d2', state: 'active' }, duration: 10 },
      { id: 'h_d3', text: 'Drill 3: down to 500 ft at the IP, BEFORE you close in. When it shoots, beam it', when: { kind: 'objective', id: 'o_d3', state: 'active' }, duration: 10 },
      { id: 'h_d4', text: 'Drill 4: pass 3–4 km off the boat, low. Heat-seeker: beam it hard, CMS late', when: { kind: 'objective', id: 'o_d4', state: 'active' }, duration: 10 },
      { id: 'h_exam', text: 'Exam: through the gate and out. Beam each missile and press CMS', when: { kind: 'objective', id: 'o_exam', state: 'active' }, duration: 10 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Gulf range is hot, practice rounds only. Drill one: over the boats, above 23,000 feet.', priority: 2 }],
    successText: 'Missile defence qualification complete. The Gulf boats are yours, Viper.',
  },
});
