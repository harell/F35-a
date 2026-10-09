/**
 * F35-A — training lesson T05 "Gulf Defence": defending against missiles, drill by drill, with
 * practice rounds (a hit does no damage) and the defence coach's call-outs (runtime/defenceCoach.ts).
 *
 * Built from the measured defence table (stack/sam-defence-advice; tests/missions-defencecoach.test.ts),
 * against the IRGC Navy air-defence boat the player meets in g02 (a Tor-type radar SAM to 12 km and
 * 20,000 ft, shoulder-launched heat-seekers inside 5 km). Measured with the mission bot on the real
 * flight model, rounds hit / fired:
 *   1. beam + CMS: in at 10,000 ft until it shoots, then turn 90° and press CMS every 2–3 s from ~6 s
 *      to impact (13/52; nothing 61/82, the beam alone 36/48, CMS mashed 23/59, running 39/50);
 *   2. low first: below LOW_AGL at the IP (the marked point) before closing in, then beam it (beam
 *      alone down low 15/58, with CMS 8/53; nothing 66/88);
 *   3. the heat-seeker: past the boat 3–4 km off, low; beam it hard, afterburner off, CMS late
 *      (1/37 passing 3.5 km off; 3/48 over the top; a break into it 29/48).
 * Sized for a casual player (playtest 2026-10-10, 1.4-e/f): the old drill "above 23,000 ft, nothing
 * fires" is one briefing sentence, and there is no exam. Each drill wants two defeats in a row (a hit
 * starts the count again; a boat fires a pair, so one good pass can do it), and after DRILL_MOVE_ON_AFTER
 * missiles that didn't count the coach moves the player on (`moveOn`): a pilot who hasn't learned the
 * beam yet still finishes the lesson. A jet already on the beam is never shot at: every drill starts by
 * flying at the boat. Each drill's boat ceases fire when it is done ('hold_fire'), so only the drill in
 * hand shoots; drill 3 gets a fresh boat (a boat carries four heat-seekers, and drill 2's low passes can
 * spend them) that fires only its heat-seekers (`irOnly`): its radar rounds don't count towards the drill,
 * and four of them cost ~55 s before the first heat-seeker (playtest r2, 2.3-j). Its heat-seekers are
 * restocked once spent (`restock`): four rounds beaten and missed in turn left the drill with neither two
 * in a row nor four misses, and nothing more to fire (a soft lock, r2). Flares and chaff are topped up
 * every 30 s and after each drill: a held button still empties them in one engagement (the coach's "chaff
 * empty").
 */
import type { MissionDef } from '../../core/contracts';
import { mission, site } from './common';

const DS = 'DARKSTAR';

/** The drills' boats and points (m). Boats in open water at least 1.5 km from any shore (LINZ coast). */
export const DEFENCE = {
  /** 13.5 km west of drill 1's boat at 10,000 ft, nose on it (and outside drill 2's ring): the first shot comes within half a minute. */
  start: { x: 16000, z: -21000 },
  /** Drill 1: one boat. */
  b1: { x: 26000, z: -30000 },
  /** Drill 2: one boat, and the IP 8.5 km east of it where the jet gets down low first. */
  b2: { x: 8000, z: -32000 },
  d2Ip: { x: 16000, z: -35000 },
  /** Drill 3: a fresh boat (spawned when the drill opens), and the pass point 3.5 km east of it, on the way from drill 2. */
  b3: { x: 0, z: -30000 },
  d3Pass: { x: 3500, z: -30000 },
} as const;

/** Drill 2 counts a defeat only with the jet below this (m AGL). */
export const LOW_AGL = 200;
/** LOW_AGL as the texts say it (ft, to the nearest 50: 650): one number in every text (playtest r2, 2.1-h). */
export const LOW_FT = Math.round(LOW_AGL / 0.3048 / 50) * 50;
/** Missiles that didn't count on one drill before the coach moves the player on. */
export const DRILL_MOVE_ON_AFTER = 4;

const done = (id: string) => ({ kind: 'objective', id, state: 'complete' }) as const;
/** Heading (degrees clockwise from north, −z) from the start to drill 1's boat. */
const START_HEADING = Math.round((Math.atan2(DEFENCE.b1.x - DEFENCE.start.x, -(DEFENCE.b1.z - DEFENCE.start.z)) * 180) / Math.PI);

export const T05_DEFENCE: MissionDef = mission({
  id: 't05',
  kind: 'training',
  index: 5,
  title: 'Gulf Defence',
  subtitle: 'Beat the air-defence boats’ missiles, drill by drill',
  timeOfDay: 'day',
  weather: 'clear',
  briefing: [
    'Missile defence on the Gulf range, against the IRGC air-defence boats you meet over the Gulf: a radar missile good to 12 km and 20,000 ft, and heat-seekers inside 5 km. Above 23,000 ft nothing they carry reaches you. Today they fire practice rounds: a hit does no damage, and a call-out after every missile tells you how it went.',
    `Three drills, two missiles beaten in a row each. One: fly at the boat until it shoots, then turn 90° to put the missile on your wing (beam it) and press CMS, which drops chaff and flares, every two or three seconds from about 6 s to impact. Do not run: the missile is faster. Two: get below ${LOW_FT} ft before you close in, then beam it. Low and on the beam, its radar loses you.`,
    'Three: pass 3 to 4 km off a boat, low. Against a heat-seeker (orange arrow), the same hard turn across it, afterburner off, and CMS in the last three seconds. Hit? Turn round and pass the boat again for another try.',
  ],
  // the defence table was measured on this load; the lighter clean jet flies the drills differently (the
  // student bot hung in drill 3 on one seed of six, its boat out of heat-seekers: playtest r2, 2.1-h).
  // No gun rounds: nothing is shot at today
  recommendedLoadout: 'a2a_stealth',
  allowedLoadouts: ['a2a_stealth'],
  gunAmmo: 0,
  player: { x: DEFENCE.start.x, z: DEFENCE.start.z, altitude: 3000, heading: START_HEADING, speed: 240 },
  script: {
    practiceRounds: true,
    defenceCoach: true,
    autoHints: true,
    parTime: 300,
    awacs: { initialPictureAt: -1, pictureInterval: 0 },
    groups: [],
    ground: [],
    sams: [
      site('b1', 'b1', 'ad_boat', DEFENCE.b1, { name: 'Range boat 1', noHarass: true }),
      site('b2', 'b2', 'ad_boat', DEFENCE.b2, { name: 'Range boat 2', noHarass: true }),
      site('b3', 'b3', 'ad_boat', DEFENCE.b3, { name: 'Range boat 3', spawn: done('o_d2'), noHarass: true, irOnly: true, restock: true }),
    ],
    objectives: [
      { id: 'o_d1', kind: 'missile_drill', groups: ['b1'], guidance: 'radar', defeat: 2, inARow: true, moveOn: DRILL_MOVE_ON_AFTER, label: 'Drill 1: beam it + CMS, two missiles in a row', primary: true },
      { id: 'o_d2', kind: 'missile_drill', groups: ['b2'], guidance: 'radar', defeat: 2, inARow: true, maxAgl: LOW_AGL, moveOn: DRILL_MOVE_ON_AFTER, label: `Drill 2: low first, two in a row below ${LOW_FT} ft`, primary: true, activeAt: done('o_d1') },
      { id: 'o_d3', kind: 'missile_drill', groups: ['b3'], guidance: 'ir', defeat: 2, inARow: true, moveOn: DRILL_MOVE_ON_AFTER, label: 'Drill 3: beat two heat-seekers in a row', primary: true, activeAt: done('o_d2') },
    ],
    waypoints: [
      { id: 'wp_d1', label: 'Drill 1: boat', kind: 'target', x: DEFENCE.b1.x, z: DEFENCE.b1.z, altitude: 3000, objective: 'o_d1' },
      { id: 'wp_d2ip', label: `Drill 2: below ${LOW_FT} ft`, kind: 'ip', x: DEFENCE.d2Ip.x, z: DEFENCE.d2Ip.z, altitude: 150, radius: 2000 },
      { id: 'wp_d2', label: 'Drill 2: boat, low', kind: 'target', x: DEFENCE.b2.x, z: DEFENCE.b2.z, altitude: 150, objective: 'o_d2' },
      { id: 'wp_d3', label: 'Drill 3: 3–4 km off the boat', kind: 'target', x: DEFENCE.d3Pass.x, z: DEFENCE.d3Pass.z, altitude: 150, objective: 'o_d3' },
    ],
    triggers: [
      // range control tops the dispensers up: a held button still empties them in one engagement
      // (the coach's "chaff empty"), but a careful pilot never runs dry over a long drill
      { id: 't_cms', when: { kind: 'start' }, repeat: 30, actions: [{ kind: 'refill_cms' }] },
      // (no praise: a drill can also end with the coach moving the player on)
      {
        id: 't_d1',
        when: done('o_d1'),
        actions: [{ kind: 'hold_fire', group: 'b1' }, { kind: 'refill_cms' }, { kind: 'radio', from: DS, text: `Viper 1, Darkstar. Drill two: below ${LOW_FT} feet at the marked point first, then the boat to the west.` }],
      },
      {
        id: 't_d2',
        when: done('o_d2'),
        actions: [{ kind: 'hold_fire', group: 'b2' }, { kind: 'refill_cms' }, { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Drill three: a new boat to the west. Pass it 3 to 4 kilometres off, low, and watch for the heat-seeker.' }],
      },
      { id: 't_d3', when: done('o_d3'), actions: [{ kind: 'hold_fire', group: 'b3' }] },
    ],
    hints: [
      { id: 'h_d1', text: 'Drill 1: fly at the boat. When it shoots: beam it, CMS every 2–3 s', when: { kind: 'time', t: 5 }, duration: 10 },
      { id: 'h_d2', text: `Drill 2: below ${LOW_FT} ft at the marked point, BEFORE you close in. When it shoots, beam it`, when: { kind: 'objective', id: 'o_d2', state: 'active' }, duration: 10 },
      { id: 'h_d3', text: 'Drill 3: pass 3–4 km off the boat, low. Heat-seeker: beam it hard, CMS late', when: { kind: 'objective', id: 'o_d3', state: 'active' }, duration: 10 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Gulf range is hot, practice rounds only. Drill one: the boat ahead. Fly at it until it shoots.', priority: 2 }],
    successText: 'Drills done, Viper. Any drill the range moved you on from is worth another go before the Gulf.',
  },
});
