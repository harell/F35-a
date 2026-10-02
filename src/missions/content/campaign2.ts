/**
 * F35-A — campaign "Operation Southern Cross", missions 7–12 (Auckland): AWACS hunt, the
 * low-level strike under the SA-10, escorting Hammer flight, the night defence of the city,
 * the SA-10 itself and the Su-57 finale.
 */
import type { MissionDef } from '../../core/contracts';
import type { Condition, TaskDef } from '../schema';
import { FEATURES, NEVER, P, WAIHEKE_RUNWAY_HDG, fighterSweep, flight, mission, off, runwayPoint, site, target, wingmen } from './common';

const DS = 'DARKSTAR';

/* ───────────────────────── 7. Eye in the Sky — AWACS hunt beyond Tiritiri Matangi ───────────────────────── */

const c07Start = { x: -10000, z: -12000, altitude: 7500, heading: 40, speed: 250 };

export const C07: MissionDef = mission({
  id: 'c07',
  kind: 'campaign',
  index: 7,
  title: 'Eye in the Sky',
  subtitle: 'Kill the A-50 Mainstay beyond Tiritiri Matangi',
  timeOfDay: 'dawn',
  weather: 'scattered',
  briefing: [
    'An A-50 Mainstay radar plane is orbiting beyond Tiritiri Matangi Island. From up there it sees every jet that leaves Whenuapai and hands the picture straight to their fighters and SAM crews.',
    "Kill it and they go blind. Two Su-35s fly close escort on the Mainstay and two more hold a CAP between it and the coast. An early-warning radar on Tiritiri feeds the network from the ground.",
    'The A-50 will run as soon as it realises it is being hunted, and a relief orbit arrives in twelve minutes. The Su-35 is a far better fighter than the MiG-29: stay in the bays, stay invisible, and let DARKSTAR call the picture off bullseye — the Sky Tower.',
  ],
  recommendedLoadout: 'a2a_stealth',
  allowedLoadouts: ['a2a_stealth', 'a2a_beast'],
  player: c07Start,
  // 12 min: room for one Winchester trip to Whenuapai and back (≈3 min) on top of the hunt
  timeLimit: 720,
  script: {
    parTime: 420,
    awacs: { style: 'bullseye', bullseye: { x: 0, z: 0, name: 'Tower' } },
    groups: [
      wingmen(1, c07Start),
      // spawn heading north: the AWACS brain lays its racetrack across the spawn heading (east–west here)
      flight('mainstay', 'a50', 1, { x: 9000, z: -29000 }, 9000, 0, 190, 'awacs', {
        fixedCount: true,
        task: { kind: 'patrol', x: 8000, z: -29000, radius: 5000, altitude: 9000 },
      }),
      flight('guard', 'su35', 2, { x: 10500, z: -30000 }, 9500, 0, 230, 'escort', { skillOffset: -0.25, maxCount: 2, task: { kind: 'escort_group', group: 'mainstay' } }),
      // the CAP starts well east of the Mainstay (beyond first-shot range of the player's start) and only
      // turns in when Darkstar has called it — the i2 review found an unavoidable R-77 kill at 55 s here
      flight('cap', 'su35', 2, { x: 34000, z: -26000 }, 7500, 90, 230, 'cap', { skillOffset: -0.15, maxCount: 2, task: { kind: 'patrol', x: 30000, z: -24000, radius: 6000, altitude: 7500 } }),
    ],
    sams: [site('sa8', 'tiri_sa8', 'sa8', off(P.tiritiri, 400, 200), { minDifficulty: 'veteran' })],
    ground: [target('ewr', 'tiri_ewr', 'ewr', P.tiritiri, { name: 'EW Radar' })],
    objectives: [
      { id: 'o_awacs', kind: 'destroy', groups: ['mainstay'], label: 'Shoot down the A-50 Mainstay', primary: true },
      { id: 'o_guard', kind: 'destroy', groups: ['guard'], label: 'Splash the Su-35 escort', primary: false },
      { id: 'o_cap', kind: 'destroy', groups: ['cap'], label: 'Splash the Su-35 CAP', primary: false },
      { id: 'o_ewr', kind: 'destroy', groups: ['tiri_ewr'], label: 'Destroy the radar on Tiritiri Matangi', primary: false },
    ],
    waypoints: [{ id: 'wp_orbit', label: 'Mainstay orbit', kind: 'target', x: 8000, z: -29000, altitude: 9000, objective: 'o_awacs' }],
    triggers: [
      {
        id: 't_run',
        when: { kind: 'any', of: [{ kind: 'area', x: 8000, z: -29000, radius: 22000 }, { kind: 'time', t: 400 }] },
        actions: [
          { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. The Mainstay is turning north — he knows you are there. Chase him down!', priority: 2 },
          { kind: 'retask', group: 'mainstay', task: { kind: 'rtb', x: 4000, z: -35500, altitude: 10000 } },
        ],
      },
      { id: 't_cap', when: { kind: 'time', t: 20 }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Su-35 CAP east of Tiritiri, 40 miles, cold. Stay low and west of them.', priority: 1 }] },
      { id: 't_relief', when: { kind: 'time', t: 600 }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Two minutes until their relief orbit arrives.', priority: 2 }] },
    ],
    opening: [
      { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Mainstay orbiting north of Tiritiri, two Su-35s on him, two more on CAP. Bullseye is the Tower.', priority: 2 },
    ],
    successText: "The Mainstay is in the sea. They're flying blind now.",
  },
});

/* ───────────────────────── 8. Under the Umbrella — low-level strike beneath the SA-10 ───────────────────────── */

const c08Start = { x: -24500, z: 4000, altitude: 1200, heading: 70, speed: 230 };
/**
 * The landing ships lie in the Rangitoto Channel off the volcano's south-west side, loading from
 * Rangitoto Wharf: the SA-10 on Motutapu's western slopes cannot see that water, nor the harbour approach
 * from the Harbour Bridge, below ~1,000 ft (Rangitoto blocks it — checked with
 * e2e/review/dev-missions-los.ts: masked at 60 m from the bridge to the wharf, and up to ~300 m
 * AGL around the wharf). Everything north / east of Rangitoto, or above ~1,500 ft, is in view.
 */
const wharf = { x: 4200, z: -4700 };

export const C08: MissionDef = mission({
  id: 'c08',
  kind: 'campaign',
  index: 8,
  title: 'Under the Umbrella',
  subtitle: 'Low-level strike beneath the Motutapu SA-10',
  timeOfDay: 'dusk',
  weather: 'clear',
  features: [FEATURES.whenuapai, FEATURES.waihekeStrip, FEATURES.motutapuDepot],
  briefing: [
    'The enemy has brought an SA-10 Grumble onto Motutapu. At medium altitude it can kill anything over Auckland, and under its umbrella landing ships in the Rangitoto Channel are loading troops from Rangitoto Wharf for a push onto the North Shore.',
    'We cannot touch the SA-10 yet. So we go under it. Rangitoto rises 260 metres out of the harbour: stay below 300 feet in the harbour and the Rangitoto Channel and the volcano hides you from Motutapu. Climb above 1,500 feet, or stray north or east of the island, and the Grumble sees you. The StormBreaker load carries no anti-radiation missile, so nothing on it can reach the Grumble: with it, staying low is the only defence.',
    'Fly the harbour at wave-top height — under the Harbour Bridge if you have the nerve — pass North Head and turn north into the channel. Pop up to about 800 feet only for the release: the GBU-39 small diameter bombs glide 1.5 km from there, so let them go the moment IN RANGE shows, then get straight back down. One SDB sinks a landing ship. MANPADS guard the Rangitoto shore: flares ready.',
  ],
  recommendedLoadout: 'sead_stealth',
  allowedLoadouts: ['sead_stealth', 'strike_stealth', 'strike_beast', 'strike_sdb2'],
  player: c08Start,
  script: {
    parTime: 540,
    groups: [
      flight('migs', 'mig29', 2, { x: 20000, z: -16000 }, 6500, 225, 240, 'fighter', {
        skillOffset: 0.1,
        // scramble once the ships are hit (a hot egress), or when the strike is taking too long
        spawn: { kind: 'any', of: [{ kind: 'objective', id: 'o_ships', state: 'complete' }, { kind: 'time', t: 300 }] },
        task: { kind: 'patrol', x: 8000, z: -6000, radius: 6000, altitude: 5000 },
      }),
    ],
    sams: [
      // on Motutapu's western slopes above Islington Bay: Rangitoto shadows the Rangitoto Channel from it
      site('sa10', 'sa10', 'sa10', { x: 12200, z: -8600 }, { heading: 230 }),
      site('zsu', 'aaa', 'zsu23', P.rangS),
      site('manpads', 'aaa', 'sa18', { x: 8000, z: -5600 }, { minDifficulty: 'pilot' }),
      site('sa15pop', 'popup', 'sa15', P.brownsIs, { emcon: true, minDifficulty: 'veteran' }),
    ],
    ground: [
      target('lst1', 'landing', 'ship', { x: wharf.x, z: wharf.z }, { name: 'Landing Ship', heading: 200, health: 300 }),
      target('lst2', 'landing', 'ship', { x: wharf.x + 500, z: wharf.z - 250 }, { name: 'Landing Ship', heading: 210, health: 300 }),
      target('lst3', 'landing', 'ship', { x: wharf.x - 500, z: wharf.z + 250 }, { name: 'Landing Ship', heading: 190, health: 300 }),
      target('fuel1', 'depot', 'fuel', { x: 7300, z: -5500 }),
      target('fuel2', 'depot', 'fuel', { x: 7600, z: -5800 }),
    ],
    objectives: [
      { id: 'o_ships', kind: 'destroy', groups: ['landing'], count: 2, label: 'Sink at least two landing ships', primary: true },
      { id: 'o_depot', kind: 'destroy', groups: ['depot'], label: 'Destroy the fuel depot at Rangitoto Wharf', primary: false },
      { id: 'o_aaa', kind: 'destroy', groups: ['aaa'], label: 'Silence the Rangitoto flak', primary: false },
      { id: 'o_low', kind: 'reach', x: P.northHead.x, z: P.northHead.z, radius: 1500, below: 120, label: 'Pass North Head below 400 ft', primary: false },
    ],
    waypoints: [
      { id: 'wp_teatatu', label: 'Te Atatū', kind: 'nav', x: -7000, z: -1500, altitude: 60 },
      { id: 'wp_bridge', label: 'Harbour Bridge', kind: 'nav', x: P.harbourBridge.x, z: P.harbourBridge.z, altitude: 30, radius: 900 },
      { id: 'wp_ip', label: 'IP North Head', kind: 'ip', x: P.northHead.x, z: P.northHead.z, altitude: 50, radius: 1500 },
      { id: 'wp_ships', label: 'Landing ships', kind: 'target', x: wharf.x, z: wharf.z, altitude: 60, objective: 'o_ships' },
    ],
    triggers: [
      {
        id: 't_spotted',
        when: { kind: 'sam_engaged' },
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. You are painted — get down! Get down behind the volcano!', priority: 3 }],
      },
      // Pacing (#59): after the opening calls, the low transit across the harbour was silent until the
      // first release: 95 s (7–102 s) on Pilot seed 0, over 90 s in every run swept (playtest
      // 2026-10-02, 1.1-i). Darkstar now calls the ships and the MiG alert part-way across, then the
      // run-in when the player nears the Harbour Bridge (or at 80 s, wherever the player is). Both lines
      // stay true until the ships are sunk. The MiGs only ever launch at 300 s with the ships still afloat:
      // o_ships is the only primary, so sinking the ships ends the mission in the same tick and the
      // group's o_ships spawn never fires. The group is 2 MiGs up to Veteran and 3 on Ace, so the call
      // names no count (review, #59; tests/missions-pacing.test.ts).
      {
        id: 't_pace_alert',
        when: { kind: 'all', of: [{ kind: 'time', t: 40 }, { kind: 'not', of: { kind: 'objective', id: 'o_ships', state: 'complete' } }] },
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Landing ships still loading at Rangitoto Wharf. MiG-29s on alert: take too long and they launch.', priority: 2 }],
      },
      {
        id: 't_pace_runin',
        when: {
          kind: 'all',
          of: [
            { kind: 'any', of: [{ kind: 'area', x: P.harbourBridge.x, z: P.harbourBridge.z, radius: 3000 }, { kind: 'time', t: 80 }] },
            { kind: 'trigger', id: 't_pace_alert' },
            { kind: 'not', of: { kind: 'objective', id: 'o_ships', state: 'complete' } },
          ],
        },
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Pass North Head on the deck, then turn north up the channel. Pop only to release, and get straight back down.', priority: 2 }],
      },
      {
        id: 't_ships',
        when: { kind: 'objective', id: 'o_ships', state: 'complete' },
        delay: 2,
        actions: [{ kind: 'radio', from: DS, text: "Viper 1, Darkstar. That's enough to stop the landing. Stay low on the way out — back west, under the bridge." }],
      },
    ],
    hints: [
      { id: 'h_low', text: 'The SA-10 kills anything high. Stay below 300 ft and keep Rangitoto between you and Motutapu', when: { kind: 'time', t: 4 }, duration: 10 },
      { id: 'h_bridge', text: 'Harbour Bridge ahead: the main span has 43 m of clearance…', when: { kind: 'area', x: P.harbourBridge.x, z: P.harbourBridge.z, radius: 3500 }, duration: 6 },
      { id: 'h_pop', text: 'Ships ahead: TGT the ship, pop to ~800 ft, release at IN RANGE, then back down', when: { kind: 'area', x: wharf.x, z: wharf.z, radius: 5000 }, duration: 8 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Grumble is up on Motutapu. Nothing high survives out there tonight. Go low.', priority: 2 }],
    successText: 'The landing is off. Get home low and fast.',
  },
});

/* ───────────────────────── 9. Hammer Down — escort the strike package ───────────────────────── */

const c09Start = { x: -6000, z: -5000, altitude: 6500, heading: 95, speed: 240 };
const strip = P.waiAirstrip;
const rw = (v: number, u: number) => runwayPoint(strip, WAIHEKE_RUNWAY_HDG, v, u);
/** Hammer's release basket: a JDAM toss from ~5 km (the route's run-in point is 3 km south of the strip). */
const hammerAtTarget: Condition = { kind: 'area', who: { group: 'hammer' }, x: strip.x, z: strip.z, radius: 5000 };
/**
 * Safety net: a package that went defensive (jinking at 350+ m/s, 1.4 g) can sail past the run-in
 * point and end up orbiting the last route point forever — the mission would never end. If there
 * is no release 200 s after the push, Hammer is sent straight over the strip (re-sent every 2 min).
 */
const HAMMER_REATTACK: TaskDef = {
  kind: 'route',
  points: [
    { x: strip.x, z: strip.z, altitude: 3200 }, // above the Shilkas' reach
    { x: 8000, z: 3000, altitude: 3000 },
  ],
};
/** Hammer's push point (the first ingress point). */
const pushPoint = { x: 9000, z: 3000 };
/** First egress point after the strike: back over the Tāmaki Strait, south-west of the island. */
const hammerEgress = { x: 22000, z: 3000 };
/**
 * Hammer is clear of Waiheke: every live Hammer jet more than 10 km from the strip, i.e. feet wet
 * over the strait (or the Gulf, when it jinked out east). The escort ends here, not at the old egress
 * point 14 km further west (playtest 2026-10-02, issue #57): the 3–4 minute cruise there, longer when
 * Hammer had jinked far east and came back round in wide turns, had nothing in it (201 s without an
 * event), and a damaged jet had to be nursed through it.
 */
const hammerClear: Condition = { kind: 'not', of: { kind: 'area', who: { group: 'hammer' }, x: strip.x, z: strip.z, radius: 10_000 } };
// (t_push: before Hammer spawns, hammerClear is vacuously true — a depot the player bombs first doesn't bring Hammer out)
const hammerOut: Condition = { kind: 'all', of: [{ kind: 'trigger', id: 't_push' }, { kind: 'objective', id: 'o_strike', state: 'complete' }, hammerClear] };
/** Ingress from the push point: down into the Tāmaki Strait, run in low from the south (under the SA-6's radar). */
const HAMMER_INGRESS: TaskDef = {
  kind: 'route',
  points: [
    { x: pushPoint.x, z: pushPoint.z, altitude: 4000 },
    { x: 17000, z: 2500, altitude: 900 },
    { x: 24500, z: 300, altitude: 300 },
    { x: strip.x + 300, z: strip.z + 3000, altitude: 400 },
    { x: 33000, z: 1500, altitude: 3000 },
  ],
};
/**
 * The escort is with Hammer: the player within 10 km of the push point (the "Push point" steering cue).
 * Hammer doesn't push without it (playtest 2026-10-02, 3.2-a, issue #57: a player parked 35 km away won
 * the mission on Weasel's and Hammer's work alone). The circle leaves out the player's start (17 km
 * from the push point), so a player who never moves gets no push.
 */
const ESCORT_RADIUS = 10_000;
const escortUp: Condition = { kind: 'area', x: pushPoint.x, z: pushPoint.z, radius: ESCORT_RADIUS };
/** Hammer is ready: the Flankers are dealt with (splashed or driven off), or it can't wait any longer. */
const hammerReady: Condition = { kind: 'any', of: [{ kind: 'group_defeated', group: 'flankers' }, { kind: 'time', t: 200 }] };
/** The push: Hammer is ready and the escort is up. */
const hammerPush: Condition = { kind: 'all', of: [escortUp, hammerReady] };
/** No escort by then: Hammer is bingo and goes home without striking (mission failed). */
const HAMMER_SCRUB_T = 420;

export const C09: MissionDef = mission({
  id: 'c09',
  kind: 'campaign',
  index: 9,
  title: 'Hammer Down',
  subtitle: 'Escort Hammer flight to Waiheke',
  timeOfDay: 'day',
  weather: 'scattered',
  briefing: [
    'The enemy is rebuilding the Waiheke airstrip and flying fuel in by sea. Hammer flight — four F-35As with JDAMs — is going to burn the fuel farm and the radar that runs the strip.',
    "Hammer's jets are loaded for the ground and can't fight their way in. They hold on the tanker west of the city until you clear the air: a pair of Flankers is coming off the Gulf — kill them and DARKSTAR calls \"Hammer, push\". Hammer can only wait about three minutes, and won't push without its escort: meet it at the push point east of the city (your steering cue) once the Flankers are dealt with. Su-35s scramble from the island a minute after the push: stay between them and Hammer.",
    'Weasel flight will go after the SA-6 on the eastern end of Waiheke with AARGMs, and Hammer runs in low through the Tāmaki Strait under its radar. At least two Hammer jets have to get clear of Waiheke again.',
  ],
  recommendedLoadout: 'a2a_beast',
  allowedLoadouts: ['a2a_beast', 'a2a_stealth', 'sead_stealth', 'strike_sdb2'],
  player: c09Start,
  script: {
    parTime: 540,
    groups: [
      // Hammer holds on the tanker west of the city and joins at the push point on "Hammer, push"
      flight('hammer', 'f35a', 4, { x: 0, z: 3000 }, 6000, 95, 230, 'bomber', {
        team: 'blue',
        callsign: 'Hammer',
        fixedCount: true,
        loadout: 'strike_stealth',
        formation: 'box',
        spacing: 250,
        announce: false,
        spawn: NEVER,
        task: HAMMER_INGRESS,
      }),
      flight('weasel', 'f35a', 2, { x: -4000, z: 1500 }, 7000, 95, 240, 'fighter', {
        team: 'blue',
        callsign: 'Weasel',
        fixedCount: true,
        loadout: 'sead_stealth',
        announce: false,
        task: { kind: 'attack_group', group: 'wai_sa6' },
      }),
      flight('flankers', 'su27', 2, { x: 32000, z: -22000 }, 7000, 240, 250, 'interceptor', {
        skillOffset: 0.05,
        maxCount: 2,
        spawn: { kind: 'time', t: 50 },
        task: { kind: 'attack_group', group: 'hammer' },
      }),
      flight('sukhois', 'su35', 2, { x: 35000, z: -2000 }, 7500, 270, 250, 'interceptor', {
        skillOffset: 0.05,
        maxCount: 2,
        spawn: NEVER,
        task: { kind: 'attack_group', group: 'hammer' },
      }),
    ],
    sams: [site('sa6', 'wai_sa6', 'sa6', P.waiE, { heading: 230 }), site('zsu', 'wai_aaa', 'zsu23', rw(0, 150))],
    ground: [
      target('fuel1', 'depot', 'fuel', rw(500, 620)),
      target('fuel2', 'depot', 'fuel', rw(580, 620)),
      target('fuel3', 'depot', 'fuel', rw(660, 620)),
      target('ewr', 'depot', 'ewr', rw(-800, 650), { name: 'Airfield Radar' }),
    ],
    objectives: [
      {
        id: 'o_hammer',
        kind: 'protect',
        group: 'hammer',
        minSurvivors: 2,
        until: hammerOut,
        label: 'Keep at least two Hammer jets alive until they are clear of Waiheke',
        primary: true,
      },
      { id: 'o_strike', kind: 'destroy', groups: ['depot'], label: 'Hammer destroys the Waiheke fuel farm', primary: true },
      { id: 'o_flankers', kind: 'destroy', groups: ['flankers'], label: 'Clear the Flankers so Hammer can push', primary: false, activeAt: { kind: 'group_spawned', group: 'flankers' } },
      { id: 'o_sukhois', kind: 'destroy', groups: ['sukhois'], label: 'Splash the Su-35 scramble', primary: false, activeAt: { kind: 'group_spawned', group: 'sukhois' } },
      { id: 'o_sa6', kind: 'destroy', groups: ['wai_sa6'], label: 'Kill the SA-6 before Hammer arrives', primary: false },
      {
        id: 'o_all4',
        kind: 'protect',
        group: 'hammer',
        minSurvivors: 4,
        until: hammerOut,
        label: 'Bring all four Hammer jets out',
        primary: false,
      },
    ],
    waypoints: [
      { id: 'wp_screen', label: 'Screen', kind: 'cap', x: 5000, z: -12000, altitude: 7000, objective: 'o_flankers' },
      // join Hammer: the push needs the player within ESCORT_RADIUS of here
      { id: 'wp_push', label: 'Push point', kind: 'nav', x: pushPoint.x, z: pushPoint.z, altitude: 6000, radius: 5000 },
      { id: 'wp_target', label: 'Waiheke strip', kind: 'target', x: strip.x, z: strip.z, objective: 'o_strike' },
      { id: 'wp_egress', label: 'Egress', kind: 'nav', x: hammerEgress.x, z: hammerEgress.z, altitude: 3000, objective: 'o_hammer' },
    ],
    triggers: [
      {
        id: 't_push',
        when: hammerPush,
        delay: 3,
        actions: [
          { kind: 'radio', from: DS, text: 'Hammer, Darkstar. Picture is as clean as it gets. Hammer, push!', priority: 3 },
          { kind: 'spawn', group: 'hammer' },
          { kind: 'radio', from: 'Hammer 1', text: 'Hammer 1, pushing. Going low through the strait.', priority: 2 },
          { kind: 'hud', text: 'HAMMER PUSHING', tone: 'info', duration: 3 },
        ],
      },
      {
        id: 't_su35',
        // after the push only: spawned before Hammer is up, their attack_group hammer task falls back to the player
        when: { kind: 'trigger', id: 't_push' },
        delay: 60,
        actions: [
          { kind: 'spawn', group: 'sukhois' },
          { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Su-35s off the deck, east of Waiheke, going for Hammer!', priority: 2 },
        ],
      },
      { id: 't_release', when: hammerAtTarget, delay: 1, actions: [{ kind: 'radio', from: 'Hammer 1', text: 'Hammer 1, in hot… bombs away!', voice: 'p_rifle', priority: 2 }] },
      {
        id: 't_reattack',
        when: { kind: 'all', of: [{ kind: 'trigger', id: 't_push' }, { kind: 'not', of: { kind: 'trigger', id: 't_release' } }] },
        delay: 200,
        repeat: 120,
        actions: [
          { kind: 'retask', group: 'hammer', task: HAMMER_REATTACK },
          { kind: 'radio', from: 'Hammer', text: 'Hammer overshot the target — coming around for another pass. Viper, keep them off us!', priority: 2 },
        ],
      },
      {
        id: 't_impact',
        when: { kind: 'trigger', id: 't_release' },
        delay: 12,
        actions: [
          { kind: 'strike', group: 'depot', by: 'hammer' },
          { kind: 'radio', from: 'Hammer 1', text: 'Shack! Good hits on the fuel farm. Hammer is egressing west.', priority: 2 },
          {
            kind: 'retask',
            group: 'hammer',
            task: {
              kind: 'route',
              points: [
                { x: hammerEgress.x, z: hammerEgress.z, altitude: 3000 },
                { x: 8000, z: 3000, altitude: 6000 },
                { x: P.whenuapai.x, z: P.whenuapai.z, altitude: 2000 },
              ],
            },
          },
        ],
      },
      {
        // ready to go but the escort is away: tell the player where to be (every 60 s until the push)
        id: 't_waiting',
        when: { kind: 'all', of: [hammerReady, { kind: 'not', of: escortUp }, { kind: 'not', of: { kind: 'trigger', id: 't_push' } }] },
        repeat: 60,
        actions: [{ kind: 'radio', from: 'Hammer 1', text: 'Hammer is ready to push, but not without an escort. Viper, join us at the push point east of the city.', priority: 2 }],
      },
      {
        id: 't_scrub',
        when: { kind: 'all', of: [{ kind: 'time', t: HAMMER_SCRUB_T }, { kind: 'not', of: { kind: 'trigger', id: 't_push' } }] },
        actions: [
          { kind: 'radio', from: 'Hammer 1', text: 'Hammer is bingo and nobody came to escort us. Scrubbing the strike, Hammer RTB.', priority: 3 },
          { kind: 'end', success: false, reason: 'Hammer went home without its escort' },
        ],
      },
      { id: 't_home', when: { kind: 'all', of: [{ kind: 'trigger', id: 't_impact' }, hammerClear] }, actions: [{ kind: 'radio', from: 'Hammer 1', text: "Hammer is feet wet and clear of the island. Thanks for the escort, Viper." }] },
      { id: 't_sa6', when: { kind: 'objective', id: 'o_sa6', state: 'complete' }, delay: 2, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. The Waiheke SA-6 is off the air.', priority: 2 }] },
      { id: 't_loss', when: { kind: 'group_destroyed', group: 'hammer', count: 1 }, actions: [{ kind: 'radio', from: 'Hammer 1', text: "Hammer's lost a jet! Viper, we need cover!", priority: 3 }] },
    ],
    hints: [
      { id: 'h_screen', text: 'Hammer waits until the Flankers are dead: fly the steering cue east and meet them over the Gulf', when: { kind: 'time', t: 6 }, duration: 9 },
      { id: 'h_escort', text: 'Hammer is pushing: stay between Hammer and the Su-35s coming from the east', when: { kind: 'group_spawned', group: 'hammer' }, duration: 8 },
    ],
    opening: [
      { kind: 'radio', from: 'Hammer 1', text: 'Hammer 1, holding on the tanker. Viper, clear us a path to the push point.', priority: 2 },
      { kind: 'radio', from: 'Weasel 1', text: 'Weasel 1, going for the SA-6. Magnum shortly.' },
      { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Picture clean for now. SA-6 active on Waiheke east. Expect Flankers from the north-east.' },
    ],
    successText: 'Fuel farm destroyed and Hammer is clear. Textbook escort.',
  },
});

/* ───────────────────────── 10. Night Harbour — night defence of the CBD ───────────────────────── */

const c10Start = { x: -9000, z: -6500, altitude: 5000, heading: 30, speed: 240 };

export const C10: MissionDef = mission({
  id: 'c10',
  kind: 'campaign',
  index: 10,
  title: 'Night Harbour',
  subtitle: 'Defend the city from night raids',
  timeOfDay: 'night',
  weather: 'clear',
  briefing: [
    'Intelligence intercepts point to a maximum-effort raid on Auckland tonight. Several Backfire groups will come at the city from different directions, each carrying cruise missiles meant for the port, the CBD and the Harbour Bridge.',
    'You and Viper 2 are the only fighters on alert. DARKSTAR will call each raid as it forms: kill the bombers before they get within 6 km of the Sky Tower — lose half a raid and the rest turn for home. A Fulcrum escort will try to keep you busy — and from Veteran up, a Flanker sweep follows once the first raid is dealt with.',
    'It will be dark out there. Trust the HMD and the TSD, and fight the picture DARKSTAR gives you. The city lights behind you are what you are defending.',
  ],
  recommendedLoadout: 'a2a_beast',
  allowedLoadouts: ['a2a_beast', 'a2a_stealth'],
  player: c10Start,
  script: {
    parTime: 480,
    groups: [
      wingmen(1, c10Start, { loadout: 'a2a_beast' }),
      flight('raidN', 'tu22m', 2, { x: 8000, z: -35000 }, 8500, 200, 220, 'bomber', {
        maxCount: 3,
        formation: 'wall',
        spacing: 700,
        task: { kind: 'route', points: [{ x: 1000, z: -24000, altitude: 8000 }, { x: 3000, z: -12000, altitude: 7500 }, { x: 0, z: 0, altitude: 7500 }] },
      }),
      flight('escortN', 'mig29', 2, { x: 7500, z: -34000 }, 9000, 185, 240, 'escort', { skillOffset: 0.05, maxCount: 2, task: { kind: 'escort_group', group: 'raidN' } }),
      // a single Flanker on Veteran, a pair on Ace (enemyCountScale 1.5): the pair's R-27s killed the
      // Veteran bot in 7 of 12 runs, before the eastern and western raids even arrived (#58)
      flight('sweep', 'su27', 1, { x: 32000, z: -26000 }, 7500, 235, 250, 'fighter', {
        skillOffset: 0,
        maxCount: 2,
        // Veteran and up only: on Pilot the Fulcrum escort is the fighter threat (the sweep's R-27/R-77s
        // killed the Pilot bot in every run of the i2 sweep). The sweep arrives once the first raid is handled (or at 2:30), not in the middle of it (i2 review:
        // the Pilot bot died to its R-27s at 137/159 s while still on the northern raid)
        minDifficulty: 'veteran',
        spawn: { kind: 'any', of: [{ kind: 'group_defeated', group: 'raidN' }, { kind: 'time', t: 150 }] },
        task: { kind: 'patrol', x: 6000, z: -12000, radius: 7000, altitude: 7000 },
      }),
      flight('raidE', 'tu22m', 2, { x: 35000, z: -22000 }, 8000, 240, 220, 'bomber', {
        maxCount: 3,
        spawn: { kind: 'time', t: 150 },
        formation: 'wall',
        spacing: 700,
        task: { kind: 'route', points: [{ x: 20000, z: -10000, altitude: 7500 }, { x: 0, z: 0, altitude: 7000 }] },
      }),
      flight('raidW', 'tu22m', 2, { x: -35000, z: 9000 }, 700, 75, 230, 'bomber', {
        maxCount: 2,
        minDifficulty: 'veteran',
        // pops up at 4:00, or earlier once the whole eastern raid is shot down (bombers turning for home don't
        // count): at a fixed 3:10 it came while the player was still out east, and leaked before he got back (#58)
        spawn: { kind: 'any', of: [{ kind: 'group_defeated', group: 'raidE' }, { kind: 'time', t: 240 }] },
        formation: 'wall',
        spacing: 700,
        noun: 'low Backfires',
        task: { kind: 'route', points: [{ x: -16000, z: 6000, altitude: 650 }, { x: 0, z: 0, altitude: 650 }] },
      }),
    ],
    objectives: [
      { id: 'o_north', kind: 'intercept', groups: ['raidN'], x: 0, z: 0, radius: 6000, abortFraction: 0.67, abortTo: { x: 8000, z: -35500, altitude: 9000 }, label: 'Stop the northern raid', primary: true },
      {
        id: 'o_east',
        kind: 'intercept',
        groups: ['raidE'],
        x: 0,
        z: 0,
        radius: 6000,
        abortFraction: 0.67,
        abortTo: { x: 35500, z: -22000, altitude: 9000 },
        label: 'Stop the eastern raid',
        primary: true,
        activeAt: { kind: 'group_spawned', group: 'raidE' },
      },
      {
        id: 'o_west',
        kind: 'intercept',
        groups: ['raidW'],
        x: 0,
        z: 0,
        radius: 6000,
        // like the other two raids (and the briefing): lose half of it and the rest turn for home (#58)
        abortFraction: 0.67,
        abortTo: { x: -35000, z: 9000, altitude: 700 },
        label: 'Stop the low raid from the west',
        primary: true,
        minDifficulty: 'veteran',
        activeAt: { kind: 'group_spawned', group: 'raidW' },
      },
      { id: 'o_fighters', kind: 'destroy', groups: ['escortN'], label: 'Splash the Fulcrum escort', primary: false },
      { id: 'o_sweep', kind: 'destroy', groups: ['sweep'], label: 'Splash the Flanker sweep', primary: false, minDifficulty: 'veteran', activeAt: { kind: 'group_spawned', group: 'sweep' } },
    ],
    waypoints: [
      { id: 'wp_n', label: 'North raid', kind: 'cap', x: 2000, z: -20000, altitude: 8000, objective: 'o_north' },
      { id: 'wp_e', label: 'East raid', kind: 'cap', x: 18000, z: -10000, altitude: 7500, objective: 'o_east' },
    ],
    triggers: [
      { id: 't_east', when: { kind: 'time', t: 146 }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Second raid forming east of Waiheke! Commit east.', priority: 2 }] },
      { id: 't_sweep', when: { kind: 'group_spawned', group: 'sweep' }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Flanker sweep inbound from the east, 30 miles. Watch for R-27s.', priority: 2 }] },
      { id: 't_west', when: { kind: 'group_spawned', group: 'raidW' }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar! Pop-up group low over the Waitākeres — they came in off the Tasman!', priority: 3 }] },
    ],
    opening: [
      { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Raids forming. First group: Backfires with Fulcrum escort, north over the Gulf. Keep the city lights on.', priority: 2 },
    ],
    successText: 'All raids destroyed. Auckland sleeps tonight.',
  },
});

/* ───────────────────────── 11. Grumble — kill the SA-10 ───────────────────────── */

const c11Start = { x: -24000, z: -2500, altitude: 6500, heading: 75, speed: 240 };

export const C11: MissionDef = mission({
  id: 'c11',
  kind: 'campaign',
  index: 11,
  title: 'Grumble',
  subtitle: 'Destroy the SA-10 on Motutapu',
  timeOfDay: 'day',
  weather: 'overcast',
  features: [FEATURES.whenuapai, FEATURES.waihekeStrip, FEATURES.motutapuDepot],
  briefing: [
    'This is the big one. The SA-10 Grumble on Motutapu is the keystone of their air defence: while it lives, nothing of ours flies over the Gulf. An SA-15 Tor sits beside it to swat incoming missiles and fighters.',
    'An early-warning radar on Rakino Island feeds the network, Su-35s hold a CAP north of Rangitoto, and a reserve pair will scramble when the Grumble is hit.',
    'Choose your weapons carefully. Clean, in the bays, the Grumble only sees you inside about 19 km — but every weapon release pops the bay doors and it will see that: fire, then beam and descend. AARGMs ride its radar home; SDBs glide in from 30 km at 30,000 ft. The Tor shoots down incoming AARGMs and SDBs aimed at anything within 3 km of it: kill the Tor first, or saturate it with everything at once.',
    'You are not alone. Vipers 2 and 3 set up a CAP ahead of you, west of the Grumble’s umbrella, and take on the Su-35s when they come for you. Weasel flight follows with AARGMs for the Tor — when Weasel calls Magnum, put your own weapons on the Grumble so they arrive together. Out of weapons? Rearm at Whenuapai and come back.',
  ],
  recommendedLoadout: 'sead_stealth',
  allowedLoadouts: ['sead_stealth', 'strike_stealth', 'strike_beast', 'strike_sdb2'],
  player: c11Start,
  script: {
    parTime: 540,
    groups: [
      flight('flankers', 'su35', 2, { x: 10000, z: -20000 }, 8000, 230, 240, 'cap', { skillOffset: 0.05, maxCount: 2, task: { kind: 'patrol', x: 6000, z: -15000, radius: 7000, altitude: 8000 } }),
      flight('reserve', 'su35', 2, { x: 30000, z: -20000 }, 7500, 250, 250, 'interceptor', {
        skillOffset: 0.05,
        maxCount: 2,
        spawn: { kind: 'any', of: [{ kind: 'group_destroyed', group: 'sa10' }, { kind: 'time', t: 330 }] },
        task: { kind: 'attack_player' },
      }),
      // Vipers 2–3: a fighter sweep a few km ahead, sent at the Su-35 CAP (as briefed — a wingman
      // only commits inside 15 km, which left the player alone with the Flankers at the IP)
      // Vipers 2–3 hold a CAP ahead of the player, west of the SA-10 umbrella, and commit (40 km)
      // on the Flankers as they come for him — measured better than sending them at the Su-35
      // station itself, 8 km from the Grumble, where they were shot down and left him alone
      fighterSweep(2, { x: -19000, z: -6500 }, 7500, 68, 'flankers', { task: { kind: 'patrol', x: -12000, z: -9000, radius: 5000, altitude: 7500 } }),
      // Weasel pair: AARGMs on the Tor, so the player's weapons on the Grumble can saturate it
      flight('weasel', 'f35a', 2, { x: -16000, z: 5000 }, 7000, 60, 240, 'fighter', {
        team: 'blue',
        callsign: 'Weasel',
        fixedCount: true,
        loadout: 'sead_stealth',
        announce: false,
        spawn: { kind: 'time', t: 30 },
        task: { kind: 'attack_group', group: 'sa15' },
      }),
    ],
    sams: [
      site('sa10', 'sa10', 'sa10', P.motuN, { heading: 220 }),
      site('sa15', 'sa15', 'sa15', P.motuE),
      site('zsu', 'aaa', 'zsu23', P.motuS, { minDifficulty: 'pilot' }),
      site('sa6', 'sa6', 'sa6', P.waiW, { heading: 250 }),
    ],
    ground: [target('ewr', 'ewr', 'ewr', P.rakino, { name: 'EW Radar' })],
    objectives: [
      { id: 'o_sa10', kind: 'destroy', groups: ['sa10'], label: "Destroy the SA-10 'Grumble' on Motutapu", primary: true },
      { id: 'o_sa15', kind: 'destroy', groups: ['sa15'], label: 'Destroy the SA-15 guarding it', primary: false },
      { id: 'o_ewr', kind: 'destroy', groups: ['ewr'], label: 'Destroy the early-warning radar on Rakino', primary: false },
      { id: 'o_cap', kind: 'destroy', groups: ['flankers', 'reserve'], label: 'Splash the Su-35s', primary: false },
      { id: 'o_sa6', kind: 'destroy', groups: ['sa6'], label: 'Destroy the SA-6 on Waiheke', primary: false },
    ],
    waypoints: [
      // IP ~28 km from the Grumble at 30,000 ft: AARGM / SDB stand-off range, outside its detection of a clean F-35
      { id: 'wp_ip', label: 'IP Hobsonville', kind: 'ip', x: -14000, z: -9000, altitude: 9000 },
      { id: 'wp_sa10', label: 'SA-10', kind: 'target', x: P.motuN.x, z: P.motuN.z, objective: 'o_sa10' },
    ],
    triggers: [
      {
        id: 't_weasel',
        when: { kind: 'group_spawned', group: 'weasel' },
        delay: 2,
        actions: [{ kind: 'radio', from: 'Weasel 1', text: 'Weasel 1, two-ship, pushing on the Tor. Magnum in about a minute — Viper 1, time your shots on the Grumble with ours.', priority: 2 }],
      },
      // Pacing (#59): once the CAP fight is over, the wait for a glide bomb or a low run-in to the
      // Grumble went silent for 100–200 s (playtest 2026-10-02, 1.1-i). While the Grumble lives,
      // Darkstar counts down to the reserve's 330 s scramble, so nothing is quiet for more than
      // ~70 s between the CAP fight and the reserve's pop-up call. (A dead Grumble ends the mission.)
      {
        id: 't_pace_up',
        when: { kind: 'all', of: [{ kind: 'time', t: 130 }, { kind: 'not', of: { kind: 'objective', id: 'o_sa10', state: 'complete' } }] },
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. The Grumble is still up and searching. Every release opens your bays: fire, then beam and descend.', priority: 2 }],
      },
      {
        id: 't_pace_engines',
        when: { kind: 'all', of: [{ kind: 'time', t: 200 }, { kind: 'not', of: { kind: 'objective', id: 'o_sa10', state: 'complete' } }] },
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Their reserve Su-35s are starting engines. Two minutes and they launch, Grumble or not.', priority: 2 }],
      },
      {
        id: 't_pace_taxi',
        when: { kind: 'all', of: [{ kind: 'time', t: 270 }, { kind: 'not', of: { kind: 'objective', id: 'o_sa10', state: 'complete' } }] },
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. The reserve Su-35s are taxiing. One minute.', priority: 2 }],
      },
      {
        id: 't_dead',
        when: { kind: 'objective', id: 'o_sa10', state: 'complete' },
        delay: 2,
        actions: [{ kind: 'radio', from: DS, text: "All players, Darkstar: the Grumble is down! Viper 1, reserve Su-35s scrambling — they're angry.", priority: 3 }],
      },
    ],
    hints: [
      {
        id: 'h_choice',
        text: 'Weasel takes the Tor: put your weapons on the Grumble from 30 km, then beam and descend',
        when: { kind: 'time', t: 5 },
        duration: 10,
      },
    ],
    opening: [
      { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Grumble is on Motutapu with a Tor beside it, Su-35s on CAP north of Rangitoto, Rakino radar feeding them. Kill the Grumble.', priority: 2 },
      { kind: 'radio', from: 'Viper 2', text: 'Two and Three, pushing ahead to CAP west of Rangitoto. We have the fighters.' },
    ],
    successText: 'The SA-10 is scrap. The Gulf is open.',
  },
});

/* ───────────────────────── 12. Felon — finale ───────────────────────── */

const c12Start = { x: -20000, z: -3500, altitude: 6500, heading: 80, speed: 240 };
const hq = P.motutapu;

export const C12: MissionDef = mission({
  id: 'c12',
  kind: 'campaign',
  index: 12,
  title: 'Felon',
  subtitle: 'Finale: the Motutapu bunker and the Su-57 aces',
  timeOfDay: 'dusk',
  weather: 'scattered',
  features: [FEATURES.whenuapai, FEATURES.waihekeStrip, FEATURES.motutapuDepot],
  briefing: [
    'Southern Cross comes down to this. With their SAM belt broken and the Mainstay gone, the invasion is run from a hardened command bunker on Motutapu. Destroy it and the island garrisons are leaderless.',
    "They know it too. Their best pilots are flying Su-57 Felons — stealthy, agile and flown by aces. DARKSTAR will struggle to hold them on radar; you will too. Everything they have left is on Motutapu: Tor, Shilkas, MANPADS, and an SA-6 on Waiheke. Another Backfire raid is expected mid-mission.",
    'Viper 2 and Viper 3 fly with you. Put a JDAM through the bunker roof, kill the Felons, and bring everyone home.',
  ],
  recommendedLoadout: 'strike_stealth',
  allowedLoadouts: ['strike_stealth', 'strike_beast', 'sead_stealth', 'strike_sdb2'],
  player: c12Start,
  script: {
    parTime: 600,
    groups: [
      wingmen(2, c12Start, { loadout: 'a2a_beast' }),
      flight('cap', 'su35', 2, { x: 10000, z: -18000 }, 7500, 220, 240, 'cap', { skillOffset: 0.15, task: { kind: 'patrol', x: 10000, z: -16000, radius: 7000, altitude: 7500 } }),
      flight('felons', 'su57', 2, { x: 26000, z: -20000 }, 9000, 240, 260, 'interceptor', {
        // their best pilots: well above the difficulty's norm, but still scaled by it
        skillOffset: 0.3,
        maxCount: 3,
        noun: 'Felons',
        spawn: { kind: 'any', of: [{ kind: 'area', x: hq.x, z: hq.z, radius: 22000 }, { kind: 'time', t: 120 }] },
        task: { kind: 'attack_player' },
      }),
      flight('raid', 'tu22m', 2, { x: 34000, z: -30000 }, 9000, 228, 230, 'bomber', {
        spawn: { kind: 'time', t: 240 },
        formation: 'wall',
        spacing: 700,
        task: { kind: 'route', points: [{ x: 14000, z: -14000, altitude: 8500 }, { x: 0, z: 0, altitude: 8000 }] },
      }),
    ],
    sams: [
      site('sa15', 'motu_sams', 'sa15', P.motuE, { minDifficulty: 'pilot' }),
      site('zsu1', 'motu_sams', 'zsu23', { x: 12200, z: -8500 }),
      site('zsu2', 'motu_sams', 'zsu23', { x: 13300, z: -9600 }, { minDifficulty: 'pilot' }),
      site('manpads', 'motu_sams', 'sa18', P.motuS, { minDifficulty: 'pilot' }),
      site('sa8', 'rangi_sa8', 'sa8', P.rangE),
      site('sa6', 'wai_sa6', 'sa6', P.waiW, { heading: 250 }),
      site('sa15pop', 'popup', 'sa15', P.motuihe, { emcon: true, minDifficulty: 'veteran' }),
    ],
    ground: [
      target('bunker', 'hq', 'bunker', hq, { name: 'Command Bunker' }),
      target('hqfuel1', 'hq_fuel', 'fuel', { x: 13300, z: -9950 }),
      target('hqfuel2', 'hq_fuel', 'fuel', { x: 13450, z: -9850 }),
    ],
    objectives: [
      { id: 'o_hq', kind: 'destroy', groups: ['hq'], label: 'Destroy the command bunker on Motutapu', primary: true },
      { id: 'o_felons', kind: 'destroy', groups: ['felons'], label: 'Splash the Su-57 aces', primary: true, activeAt: { kind: 'group_spawned', group: 'felons' } },
      { id: 'o_raid', kind: 'intercept', groups: ['raid'], x: 0, z: 0, radius: 10000, label: 'Stop the last Backfire raid', primary: false, activeAt: { kind: 'group_spawned', group: 'raid' } },
      { id: 'o_sams', kind: 'destroy_sams', x: hq.x, z: hq.z, radius: 2500, label: "Destroy Motutapu's air defences", primary: false },
      { id: 'o_cap', kind: 'destroy', groups: ['cap'], label: 'Splash the Su-35 CAP', primary: false },
    ],
    waypoints: [
      { id: 'wp_ip', label: 'IP Devonport', kind: 'ip', x: P.devonport.x, z: P.devonport.z, altitude: 5000 },
      { id: 'wp_hq', label: 'Command bunker', kind: 'target', x: hq.x, z: hq.z, objective: 'o_hq' },
    ],
    triggers: [
      { id: 't_felons', when: { kind: 'group_spawned', group: 'felons' }, actions: [{ kind: 'radio', from: DS, text: "Viper 1, Darkstar. Faint contacts east… it's the Felons. They're coming for you.", priority: 3 }] },
      { id: 't_raid', when: { kind: 'group_spawned', group: 'raid' }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Backfires inbound from the north-east — one last raid on the city!', priority: 2 }] },
      {
        id: 't_hq',
        when: { kind: 'objective', id: 'o_hq', state: 'complete' },
        delay: 2,
        actions: [{ kind: 'radio', from: DS, text: 'All players, Darkstar. The bunker is gone! Their command net just went silent.', priority: 3 }],
      },
    ],
    opening: [
      { kind: 'radio', from: DS, text: 'All Southern Cross players, Darkstar. This is it. Command bunker on Motutapu. Viper, lead the way.', priority: 2 },
      { kind: 'radio', from: 'Viper 2', text: 'Two.' },
      { kind: 'radio', from: 'Viper 3', text: 'Three.' },
    ],
    successText: 'Southern Cross is complete. The Gulf is ours. Welcome home, Viper.',
    campaignFinale: true,
  },
});

export const CAMPAIGN_PART2: MissionDef[] = [C07, C08, C09, C10, C11, C12];
