/**
 * F35-A — campaign "Operation Southern Cross", missions 7–12 (Auckland): AWACS hunt, the
 * low-level strike under the SA-10, escorting Hammer flight, the night defence of the city,
 * the SA-10 itself and the Su-57 finale.
 */
import type { MissionDef } from '../../core/contracts';
import type { Condition } from '../schema';
import { FEATURES, P, WAIHEKE_RUNWAY_HDG, flight, mission, off, runwayPoint, site, target, wingmen } from './common';

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
    'The A-50 will run as soon as it realises it is being hunted, and a relief orbit arrives in nine minutes. The Su-35 is a far better fighter than the MiG-29: stay in the bays, stay invisible, and let DARKSTAR call the picture off bullseye — the Sky Tower.',
  ],
  recommendedLoadout: 'a2a_stealth',
  allowedLoadouts: ['a2a_stealth', 'a2a_beast'],
  player: c07Start,
  timeLimit: 540,
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
      flight('guard', 'su35', 2, { x: 10500, z: -28000 }, 9500, 0, 230, 'escort', { skillOffset: 0.05, task: { kind: 'escort_group', group: 'mainstay' } }),
      flight('cap', 'su35', 2, { x: 22000, z: -20000 }, 7500, 250, 240, 'cap', { skillOffset: 0.05, task: { kind: 'patrol', x: 16000, z: -19000, radius: 7000, altitude: 7500 } }),
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
      { id: 't_relief', when: { kind: 'time', t: 420 }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Two minutes until their relief orbit arrives.', priority: 2 }] },
    ],
    opening: [
      { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Mainstay orbiting north of Tiritiri, two Su-35s on him, two more on CAP. Bullseye is the Tower.', priority: 2 },
    ],
    successText: "The Mainstay is in the sea. They're flying blind now.",
  },
});

/* ───────────────────────── 8. Under the Umbrella — low-level strike beneath the SA-10 ───────────────────────── */

const c08Start = { x: -22000, z: 4500, altitude: 1200, heading: 70, speed: 230 };
const channel = { x: 12100, z: -5000 };

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
    'The enemy has brought an SA-10 Grumble onto Motutapu. At medium altitude it can kill anything over Auckland, and under its umbrella they are loading landing ships in the channel east of Rangitoto for a push onto the North Shore.',
    'We cannot touch the SA-10 yet. So we go under it. Rangitoto rises 260 metres out of the harbour: if you stay below 300 feet and keep the volcano between you and Motutapu, the Grumble cannot see you.',
    'Fly the harbour at wave-top height — under the Harbour Bridge if you have the nerve — pass North Head, pop up just enough to toss your JDAMs on the landing ships, and get back down. Shilkas and MANPADS guard the Rangitoto shore.',
  ],
  recommendedLoadout: 'strike_stealth',
  allowedLoadouts: ['strike_stealth', 'strike_beast', 'sead_stealth'],
  player: c08Start,
  script: {
    parTime: 540,
    groups: [
      flight('migs', 'mig29', 2, { x: 20000, z: -16000 }, 6500, 225, 240, 'fighter', {
        skillOffset: 0.1,
        spawn: { kind: 'area', x: channel.x, z: channel.z, radius: 15000 },
        task: { kind: 'patrol', x: 12000, z: -8000, radius: 6000, altitude: 6000 },
      }),
    ],
    sams: [
      site('sa10', 'sa10', 'sa10', P.motuN, { heading: 220 }),
      site('zsu', 'aaa', 'zsu23', { x: 9900, z: -6100 }),
      site('manpads', 'aaa', 'sa18', { x: 10500, z: -7300 }, { minDifficulty: 'pilot' }),
      site('sa15pop', 'popup', 'sa15', P.brownsIs, { emcon: true, minDifficulty: 'veteran' }),
    ],
    ground: [
      target('lst1', 'landing', 'ship', { x: 12100, z: -5300 }, { name: 'Landing Ship', heading: 200 }),
      target('lst2', 'landing', 'ship', { x: 12800, z: -4700 }, { name: 'Landing Ship', heading: 210 }),
      target('lst3', 'landing', 'ship', { x: 11600, z: -4300 }, { name: 'Landing Ship', heading: 190 }),
      target('fuel1', 'depot', 'fuel', { x: 10400, z: -6300 }),
      target('fuel2', 'depot', 'fuel', { x: 10100, z: -5800 }),
    ],
    objectives: [
      { id: 'o_ships', kind: 'destroy', groups: ['landing'], count: 2, label: 'Sink at least two landing ships', primary: true },
      { id: 'o_depot', kind: 'destroy', groups: ['depot'], label: 'Destroy the fuel depot on Rangitoto', primary: false },
      { id: 'o_aaa', kind: 'destroy', groups: ['aaa'], label: 'Silence the Rangitoto flak', primary: false },
      { id: 'o_low', kind: 'reach', x: P.northHead.x, z: P.northHead.z, radius: 1500, below: 120, label: 'Pass North Head below 400 ft', primary: false },
    ],
    waypoints: [
      { id: 'wp_teatatu', label: 'Te Atatū', kind: 'nav', x: -7000, z: -1500, altitude: 150 },
      { id: 'wp_bridge', label: 'Harbour Bridge', kind: 'nav', x: P.harbourBridge.x, z: P.harbourBridge.z, altitude: 30, radius: 900 },
      { id: 'wp_ip', label: 'IP North Head', kind: 'ip', x: P.northHead.x, z: P.northHead.z, altitude: 60, radius: 1500 },
      { id: 'wp_ships', label: 'Landing ships', kind: 'target', x: channel.x, z: channel.z, objective: 'o_ships' },
    ],
    triggers: [
      {
        id: 't_spotted',
        when: { kind: 'sam_engaged' },
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. You are painted — get down! Get down behind the volcano!', priority: 3 }],
      },
      {
        id: 't_ships',
        when: { kind: 'objective', id: 'o_ships', state: 'complete' },
        delay: 2,
        actions: [{ kind: 'radio', from: DS, text: "Viper 1, Darkstar. That's enough to stop the landing. Stay low on the way out." }],
      },
    ],
    hints: [
      { id: 'h_low', text: 'The SA-10 kills anything high. Stay below 300 ft and keep Rangitoto between you and Motutapu', when: { kind: 'time', t: 4 }, duration: 10 },
      { id: 'h_bridge', text: 'Harbour Bridge ahead: the main span has 43 m of clearance…', when: { kind: 'area', x: P.harbourBridge.x, z: P.harbourBridge.z, radius: 3500 }, duration: 6 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Grumble is up on Motutapu. Nothing high survives out there tonight. Go low.', priority: 2 }],
    successText: 'The landing is off. Get home low and fast.',
  },
});

/* ───────────────────────── 9. Hammer Down — escort the strike package ───────────────────────── */

const c09Start = { x: -6000, z: -5000, altitude: 6500, heading: 95, speed: 240 };
const strip = P.waiAirstrip;
const rw = (v: number, u: number) => runwayPoint(strip, WAIHEKE_RUNWAY_HDG, v, u);
const hammerAtTarget: Condition = { kind: 'area', who: { group: 'hammer' }, x: strip.x, z: strip.z, radius: 3500 };
const hammerHome: Condition = { kind: 'area', who: { group: 'hammer' }, x: 8000, z: 3000, radius: 6000 };

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
    "Hammer's jets are loaded for the ground and can't fight their way in. You are the escort. Flankers will come off the Gulf the moment Hammer is detected, and Su-35s are expected once the package commits to the target.",
    'The SA-6 on the western end of Waiheke sits close to the ingress route and will engage Hammer if it can see them. Kill it early if you can. At least two Hammer jets have to make it back over the city.',
  ],
  recommendedLoadout: 'a2a_beast',
  allowedLoadouts: ['a2a_beast', 'a2a_stealth', 'sead_stealth'],
  player: c09Start,
  script: {
    parTime: 540,
    groups: [
      flight('hammer', 'f35a', 4, { x: -8000, z: -3500 }, 6000, 95, 230, 'bomber', {
        team: 'blue',
        callsign: 'Hammer',
        fixedCount: true,
        loadout: 'strike_stealth',
        formation: 'box',
        spacing: 250,
        announce: false,
        task: {
          kind: 'route',
          points: [
            { x: 8000, z: 2500, altitude: 6000 },
            { x: 20000, z: -500, altitude: 6000 },
            { x: strip.x, z: strip.z + 300, altitude: 5000 },
            { x: 31000, z: -9000, altitude: 6000 },
          ],
        },
      }),
      flight('flankers', 'su27', 2, { x: 32000, z: -22000 }, 7000, 240, 250, 'interceptor', {
        skillOffset: 0.05,
        spawn: { kind: 'time', t: 50 },
        task: { kind: 'attack_group', group: 'hammer' },
      }),
      flight('sukhois', 'su35', 2, { x: 35000, z: -2000 }, 7500, 270, 250, 'interceptor', {
        skillOffset: 0.1,
        spawn: { kind: 'area', who: { group: 'hammer' }, x: strip.x, z: strip.z, radius: 12000 },
        task: { kind: 'attack_group', group: 'hammer' },
      }),
    ],
    sams: [site('sa6', 'wai_sa6', 'sa6', P.waiW, { heading: 200 }), site('zsu', 'wai_aaa', 'zsu23', rw(0, 150))],
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
        until: { kind: 'all', of: [{ kind: 'objective', id: 'o_strike', state: 'complete' }, hammerHome] },
        label: 'Keep at least two Hammer jets alive until they are home',
        primary: true,
      },
      { id: 'o_strike', kind: 'destroy', groups: ['depot'], label: 'Hammer destroys the Waiheke fuel farm', primary: true },
      { id: 'o_sa6', kind: 'destroy', groups: ['wai_sa6'], label: 'Kill the SA-6 before Hammer arrives', primary: false },
      { id: 'o_bandits', kind: 'destroy', groups: ['flankers', 'sukhois'], label: 'Splash the interceptors', primary: false },
      {
        id: 'o_all4',
        kind: 'protect',
        group: 'hammer',
        minSurvivors: 4,
        until: { kind: 'all', of: [{ kind: 'objective', id: 'o_strike', state: 'complete' }, hammerHome] },
        label: 'Bring all four Hammer jets home',
        primary: false,
      },
    ],
    waypoints: [
      { id: 'wp_push', label: 'Push point', kind: 'nav', x: 8000, z: 2000, altitude: 6500 },
      { id: 'wp_target', label: 'Waiheke strip', kind: 'target', x: strip.x, z: strip.z, objective: 'o_strike' },
      { id: 'wp_egress', label: 'Egress', kind: 'nav', x: 8000, z: 3000, altitude: 6000, objective: 'o_hammer' },
    ],
    triggers: [
      { id: 't_release', when: hammerAtTarget, delay: 1, actions: [{ kind: 'radio', from: 'Hammer 1', text: 'Hammer 1, in hot… bombs away!', voice: 'p_rifle', priority: 2 }] },
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
                { x: 20000, z: 3000, altitude: 6500 },
                { x: 8000, z: 3000, altitude: 6000 },
                { x: P.whenuapai.x, z: P.whenuapai.z, altitude: 2000 },
              ],
            },
          },
        ],
      },
      { id: 't_home', when: { kind: 'all', of: [{ kind: 'trigger', id: 't_impact' }, hammerHome] }, actions: [{ kind: 'radio', from: 'Hammer 1', text: "Hammer's feet dry over the city. Thanks for the escort, Viper." }] },
      { id: 't_su35', when: { kind: 'group_spawned', group: 'sukhois' }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Su-35s off the deck, east of Waiheke, going for Hammer!', priority: 2 }] },
      { id: 't_loss', when: { kind: 'group_destroyed', group: 'hammer', count: 1 }, actions: [{ kind: 'radio', from: 'Hammer 1', text: "Hammer's lost a jet! Viper, we need cover!", priority: 3 }] },
    ],
    opening: [
      { kind: 'radio', from: 'Hammer 1', text: 'Hammer 1, pushing. Viper, you have the lead on the fight.', priority: 2 },
      { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Picture clean for now. SA-6 active on Waiheke west.' },
    ],
    successText: 'Fuel farm destroyed and Hammer is home. Textbook escort.',
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
    'You and Viper 2 are the only fighters on alert. DARKSTAR will call each raid as it forms: kill the bombers before they get within 6 km of the Sky Tower — lose half a raid and the rest turn for home. A Fulcrum escort and a Flanker sweep will try to keep you busy.',
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
      flight('escortN', 'mig29', 2, { x: 7500, z: -34000 }, 9000, 185, 240, 'escort', { skillOffset: 0.05, task: { kind: 'escort_group', group: 'raidN' } }),
      flight('sweep', 'su27', 2, { x: 32000, z: -26000 }, 7500, 235, 250, 'fighter', {
        skillOffset: 0.1,
        spawn: { kind: 'time', t: 45 },
        task: { kind: 'patrol', x: 6000, z: -12000, radius: 7000, altitude: 7000 },
      }),
      flight('raidE', 'tu22m', 2, { x: 35000, z: -22000 }, 8000, 240, 220, 'bomber', {
        maxCount: 3,
        spawn: { kind: 'time', t: 100 },
        formation: 'wall',
        spacing: 700,
        task: { kind: 'route', points: [{ x: 20000, z: -10000, altitude: 7500 }, { x: 0, z: 0, altitude: 7000 }] },
      }),
      flight('raidW', 'tu22m', 2, { x: -35000, z: 9000 }, 700, 75, 230, 'bomber', {
        maxCount: 2,
        minDifficulty: 'veteran',
        spawn: { kind: 'time', t: 190 },
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
        label: 'Stop the low raid from the west',
        primary: true,
        minDifficulty: 'veteran',
        activeAt: { kind: 'group_spawned', group: 'raidW' },
      },
      { id: 'o_fighters', kind: 'destroy', groups: ['escortN', 'sweep'], label: 'Splash the escorts and the sweep', primary: false },
    ],
    waypoints: [
      { id: 'wp_n', label: 'North raid', kind: 'cap', x: 2000, z: -20000, altitude: 8000, objective: 'o_north' },
      { id: 'wp_e', label: 'East raid', kind: 'cap', x: 18000, z: -10000, altitude: 7500, objective: 'o_east' },
    ],
    triggers: [
      { id: 't_east', when: { kind: 'time', t: 98 }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Second raid forming east of Waiheke!', priority: 2 }] },
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
    'Choose your weapons carefully. Clean, in the bays, the Grumble only sees you inside about 19 km. With pylons it sees you at over 30. AARGMs ride its radar home when it emits; SDBs can glide in from 30 km. Viper 2 will take care of the fighters.',
  ],
  recommendedLoadout: 'sead_stealth',
  allowedLoadouts: ['sead_stealth', 'strike_stealth', 'strike_beast'],
  player: c11Start,
  script: {
    parTime: 540,
    groups: [
      wingmen(1, c11Start),
      flight('flankers', 'su35', 2, { x: 10000, z: -20000 }, 8000, 230, 240, 'cap', { skillOffset: 0.1, task: { kind: 'patrol', x: 6000, z: -15000, radius: 7000, altitude: 8000 } }),
      flight('reserve', 'su35', 2, { x: 30000, z: -20000 }, 7500, 250, 250, 'interceptor', {
        skillOffset: 0.1,
        spawn: { kind: 'any', of: [{ kind: 'group_destroyed', group: 'sa10' }, { kind: 'time', t: 240 }] },
        task: { kind: 'attack_player' },
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
      { id: 'wp_ip', label: 'IP Takapuna', kind: 'ip', x: P.takapuna.x, z: P.takapuna.z, altitude: 6000 },
      { id: 'wp_sa10', label: 'SA-10', kind: 'target', x: P.motuN.x, z: P.motuN.z, objective: 'o_sa10' },
    ],
    triggers: [
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
        text: 'The SA-10 turns its radar on when it sees you. Stay clean and stealthy, and fire the AARGM the moment it emits',
        when: { kind: 'time', t: 5 },
        duration: 10,
      },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Grumble is on Motutapu, Su-35s on CAP north of Rangitoto, Rakino radar feeding them. Kill the Grumble.', priority: 2 }],
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
  allowedLoadouts: ['strike_stealth', 'strike_beast', 'sead_stealth'],
  player: c12Start,
  script: {
    parTime: 600,
    groups: [
      wingmen(2, c12Start, { loadout: 'a2a_beast' }),
      flight('cap', 'su35', 2, { x: 10000, z: -18000 }, 7500, 220, 240, 'cap', { skillOffset: 0.15, task: { kind: 'patrol', x: 10000, z: -16000, radius: 7000, altitude: 7500 } }),
      flight('felons', 'su57', 2, { x: 26000, z: -20000 }, 9000, 240, 260, 'interceptor', {
        skill: 1,
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
      site('sa15', 'motu_sams', 'sa15', P.motuE),
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
  },
});

export const CAMPAIGN_PART2: MissionDef[] = [C07, C08, C09, C10, C11, C12];
