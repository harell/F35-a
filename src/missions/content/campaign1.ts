/**
 * F35-A — campaign "Operation Southern Cross", missions 1–6 (Auckland).
 *
 * Fiction: a hostile expeditionary force has seized the Hauraki Gulf islands (Rangitoto,
 * Motutapu, Waiheke, Motuihe), set up SAM belts and flies fighters off a bulldozed strip on
 * Waiheke. F-35As from RNZAF Base Auckland (Whenuapai) defend the city. Enemy targets are
 * always military; the CBD, Sky Tower and Harbour Bridge are things you protect.
 */
import type { MissionDef } from '../../core/contracts';
import type { Condition } from '../schema';
import { FEATURES, NEVER, P, WAIHEKE_RUNWAY_HDG, fighterSweep, flight, mission, runwayPoint, site, target, wingmen } from './common';

const DS = 'DARKSTAR';

/* ───────────────────────── 1. Dawn Patrol — CAP over the Waitematā (teaches BVR) ───────────────────────── */

const c01Start = { x: -9000, z: -6200, altitude: 3000, heading: 75, speed: 230, fuel: 0.9 };

export const C01: MissionDef = mission({
  id: 'c01',
  kind: 'campaign',
  index: 1,
  title: 'Dawn Patrol',
  subtitle: 'CAP over the Waitematā — MiG-29 sweep',
  timeOfDay: 'dawn',
  weather: 'clear',
  briefing: [
    '04:12. A hostile expeditionary force came ashore on Rangitoto, Motutapu and Waiheke in the dark. Within the hour their fighters were probing the Waitematā, and Auckland woke up to sirens and jet noise over the harbour.',
    'Operation Southern Cross starts now. You and Viper 2 are the first F-35As off the runway at Whenuapai. Climb to CAP ALPHA over the upper harbour and let DARKSTAR, the AWACS orbiting over the Hunua Ranges, talk you onto a pair of MiG-29s sweeping in from the Gulf.',
    'A clean F-35 is almost invisible to a Fulcrum radar, so see them first: tap the TD box (or TGT) to lock — keep the nose within 30° while it locks — wait for SHOOT, fire, then crank 50° to support the missile. Keep them off the North Shore. Expect company once the first pair goes down. Out of missiles? Hold over Whenuapai to rearm.',
  ],
  recommendedLoadout: 'a2a_stealth',
  allowedLoadouts: ['a2a_stealth', 'a2a_beast'],
  player: c01Start,
  script: {
    autoHints: true,
    parTime: 360,
    groups: [
      wingmen(1, c01Start),
      flight('fulcrum1', 'mig29', 2, { x: 22000, z: -21000 }, 5500, 235, 240, 'fighter', {
        skillOffset: -0.2,
        task: { kind: 'patrol', x: 4000, z: -12000, radius: 6000, altitude: 5000 },
      }),
      flight('fulcrum2', 'mig29', 2, { x: 27000, z: -13000 }, 6000, 262, 250, 'fighter', {
        skillOffset: -0.15,
        spawn: NEVER,
        task: { kind: 'patrol', x: 6000, z: -9000, radius: 6000, altitude: 5500 },
      }),
    ],
    objectives: [
      { id: 'o_sweep', kind: 'destroy', groups: ['fulcrum1'], label: 'Splash the MiG-29 sweep', primary: true },
      { id: 'o_second', kind: 'destroy', groups: ['fulcrum2'], label: 'Splash the second MiG pair', primary: true, activeAt: { kind: 'objective', id: 'o_sweep', state: 'complete' } },
      { id: 'o_shore', kind: 'intercept', groups: ['fulcrum1', 'fulcrum2'], x: P.takapuna.x, z: P.takapuna.z, radius: 3000, label: 'Keep the MiGs off the North Shore', primary: false },
    ],
    waypoints: [
      { id: 'wp_cap', label: 'CAP Alpha', kind: 'cap', x: -1000, z: -7500, altitude: 5000, objective: 'o_second' },
      { id: 'wp_home', label: 'Whenuapai', kind: 'rtb', x: P.whenuapai.x, z: P.whenuapai.z, altitude: 1000 },
    ],
    triggers: [
      { id: 't_two', when: { kind: 'time', t: 14 }, actions: [{ kind: 'radio', from: 'Viper 2', text: 'Two, in fighting wing. Radar hot.' }] },
      {
        id: 't_second',
        when: { kind: 'objective', id: 'o_sweep', state: 'complete' },
        delay: 7,
        actions: [
          { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Two more Fulcrums just lifted off the Waiheke strip, heading your way.' },
          { kind: 'spawn', group: 'fulcrum2' },
        ],
      },
    ],
    // after the title banner (0–2.5 s) and the short opening call — one text block at a time
    hints: [{ id: 'h_start', text: '{controls}. Climb toward the CAP and follow the steering cue', when: { kind: 'time', t: 9 }, duration: 8 }],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Fulcrums over the Gulf. Cleared to engage.', priority: 2 }],
    successText: 'Harbour is clear. Nice shooting, Viper.',
  },
});

/* ───────────────────────── 2. Shepherd — cover Kiwi flight's egress (protect) ───────────────────────── */

const c02Start = { x: -6000, z: -14000, altitude: 4500, heading: 70, speed: 240 };
const home = { kind: 'area', who: { group: 'kiwi' }, x: P.whenuapai.x, z: P.whenuapai.z, radius: 5000 } as const;
/**
 * Kiwi is safe: it has made it home to Whenuapai AND every fighter chasing it is splashed or driven
 * off. Home alone was free (playtest 2026-10-02, 2.3-c, issue #57): Kiwi's short route got it there
 * at ~100 s, before the hunters could reach it, and a Kiwi jet shot down afterwards cost nothing
 * while the mission ran on forever. Now the protect stays live until the chase is over.
 */
const kiwiSafe: Condition = {
  kind: 'all',
  of: [
    { kind: 'trigger', id: 't_home' },
    { kind: 'objective', id: 'o_bandits', state: 'complete' },
    // ...with Viper there to see it home (review, issue #57: parked 50 km away, the chasers went home on
    // their own after ~800 s and were credited as driven off, so the parked player still won)
    { kind: 'area', x: P.whenuapai.x, z: P.whenuapai.z, radius: 20_000 },
  ],
};
/** Kiwi is bingo: if the chase hasn't been settled by then, Kiwi flames out (mission failed, never an endless run). */
const KIWI_BINGO_T = 720;

export const C02: MissionDef = mission({
  id: 'c02',
  kind: 'campaign',
  index: 2,
  title: 'Shepherd',
  subtitle: 'Bring Kiwi flight home — protect',
  timeOfDay: 'day',
  weather: 'scattered',
  briefing: [
    'Kiwi flight, two F-35As, spent the night hammering landing craft off Rakino Island. They are Winchester — no missiles left — and short on fuel, limping home across the Gulf at low speed.',
    'The enemy has noticed. DARKSTAR has a pair of MiG-29s closing on Kiwi from the north-east, and Flankers are spinning up on Waiheke. Kiwi cannot fight back.',
    'Meet them over the Gulf, kill the pursuers and bring both jets home to Whenuapai. Kiwi has about twelve minutes of fuel. If Kiwi goes down, the mission goes with it.',
  ],
  recommendedLoadout: 'a2a_beast',
  allowedLoadouts: ['a2a_stealth', 'a2a_beast'],
  player: c02Start,
  script: {
    autoHints: true,
    parTime: 330,
    groups: [
      wingmen(1, c02Start, { orders: { holdFireUntilPlayerFires: true } }),
      flight('kiwi', 'f35a', 2, { x: 17000, z: -19000 }, 6000, 243, 200, 'bomber', {
        team: 'blue',
        callsign: 'Kiwi',
        fixedCount: true,
        unarmed: true,
        fuel: 0.25,
        loadout: 'strike_stealth',
        announce: false,
        task: {
          kind: 'route',
          points: [
            { x: 5000, z: -13000, altitude: 5000 },
            { x: -4000, z: -9000, altitude: 3000 },
            { x: P.whenuapai.x, z: P.whenuapai.z, altitude: 1200 },
          ],
        },
      }),
      // fighter pairs stay pairs on Ace (sharper pilots + GCI instead of more of them)
      flight('hunters', 'mig29', 2, { x: 33000, z: -28000 }, 6500, 243, 260, 'interceptor', { skillOffset: -0.1, maxCount: 2, task: { kind: 'attack_group', group: 'kiwi' } }),
      flight('flankers', 'su27', 2, { x: 33000, z: -9000 }, 7000, 275, 250, 'interceptor', { skillOffset: -0.05, maxCount: 2, spawn: { kind: 'time', t: 80 }, task: { kind: 'attack_group', group: 'kiwi' } }),
    ],
    objectives: [
      { id: 'o_kiwi', kind: 'protect', group: 'kiwi', minSurvivors: 1, until: kiwiSafe, label: 'Get Kiwi flight home to Whenuapai', primary: true },
      { id: 'o_bandits', kind: 'destroy', groups: ['hunters', 'flankers'], label: 'Splash the fighters chasing Kiwi', primary: true },
      { id: 'o_both', kind: 'protect', group: 'kiwi', minSurvivors: 2, until: kiwiSafe, label: 'Bring both Kiwi jets home', primary: false },
    ],
    waypoints: [
      { id: 'wp_meet', label: 'Rendezvous', kind: 'nav', x: 7000, z: -14500, altitude: 5000 },
      { id: 'wp_home', label: 'Whenuapai', kind: 'rtb', x: P.whenuapai.x, z: P.whenuapai.z, altitude: 1000 },
    ],
    triggers: [
      { id: 't_flankers', when: { kind: 'time', t: 78 }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. More trade: Flankers airborne off Waiheke, vectoring on Kiwi.' }] },
      {
        id: 't_home',
        when: home,
        actions: [
          { kind: 'radio', from: 'Kiwi 1', text: "Kiwi's home, holding over the field. Viper, keep them off us till they're gone." },
          // stay near the field (at the end of its route the flight would head back out over the Gulf).
          // The bomber brain flies this as a ~20 km racetrack round Whenuapai, not a 3 km circle.
          { kind: 'retask', group: 'kiwi', task: { kind: 'patrol', x: P.whenuapai.x, z: P.whenuapai.z, radius: 3000, altitude: 1200 } },
        ],
      },
      {
        id: 't_kiwi_hit',
        when: { kind: 'group_destroyed', group: 'kiwi', count: 1 },
        actions: [
          { kind: 'radio', from: 'Kiwi 1', text: "Kiwi 2 is down! Viper, get these guys off me!", priority: 3 },
          // attack_group resolves to one jet when the task is set: point the chasers at the survivor.
          // Interceptors aren't GCI-committed, so with their target dead they loitered and o_bandits
          // (and with it o_kiwi) never resolved: the mission ran on forever (issue #57 review).
          { kind: 'retask', group: 'hunters', task: { kind: 'attack_group', group: 'kiwi' } },
          { kind: 'retask', group: 'flankers', task: { kind: 'attack_group', group: 'kiwi' } },
        ],
      },
      {
        id: 't_kiwi_bingo',
        when: { kind: 'all', of: [{ kind: 'time', t: KIWI_BINGO_T }, { kind: 'not', of: { kind: 'objective', id: 'o_kiwi', state: 'complete' } }] },
        actions: [
          { kind: 'radio', from: 'Kiwi 1', text: "Kiwi's out of gas. We're punching out.", priority: 3 },
          { kind: 'end', success: false, reason: 'Kiwi flight ran out of fuel' },
        ],
      },
    ],
    hints: [{ id: 'h_kiwi', text: "Kiwi flight is unarmed — kill the MiGs chasing them before they get into missile range", when: { kind: 'time', t: 6 }, duration: 8 }],
    opening: [
      { kind: 'radio', from: 'Kiwi 1', text: 'Kiwi 1, Winchester and bingo, two Fulcrums in trail. Any Viper, need a hand!', priority: 2 },
      { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Kiwi is 15 miles north-east of you. Commit.' },
    ],
    successText: 'Kiwi is on the ground. Good shepherding, Viper.',
  },
});

/* ───────────────────────── 3. Iron Hand — SEAD on Rangitoto ───────────────────────── */

const c03Start = { x: -13000, z: -2000, altitude: 4000, heading: 80, speed: 240 };

export const C03: MissionDef = mission({
  id: 'c03',
  kind: 'campaign',
  index: 3,
  title: 'Iron Hand',
  subtitle: 'SEAD — silence the Rangitoto SAMs',
  timeOfDay: 'day',
  weather: 'clear',
  briefing: [
    "From the slopes of Rangitoto an SA-6 battery and an SA-8 now cover the whole harbour. Nothing can fly over the city while they live — not our tankers, not the rescue helicopters, not the ferries' air cover.",
    "You're going in with AARGM anti-radiation missiles and GBU-39 small diameter bombs. The SA-6 sits on the south-west slope facing the city; the SA-8 is on the eastern shore. Shilkas guard the approaches and an early-warning radar near the summit is feeding them.",
    'Fire the AARGM while a radar is emitting — it rides the beam home, and keeps going even if they shut down. SDBs glide 30 km from altitude. Stay in the bays and stay stealthy.',
  ],
  recommendedLoadout: 'sead_stealth',
  allowedLoadouts: ['sead_stealth', 'strike_stealth', 'strike_beast', 'strike_sdb2'],
  player: c03Start,
  script: {
    autoHints: true,
    parTime: 420,
    groups: [
      wingmen(1, c03Start),
      flight('migcap', 'mig29', 2, { x: 24000, z: -18000 }, 5000, 230, 240, 'cap', {
        skillOffset: -0.05,
        spawn: { kind: 'time', t: 150 },
        task: { kind: 'patrol', x: 12000, z: -11000, radius: 6000, altitude: 5000 },
      }),
    ],
    sams: [
      site('sa6', 'rangi_sa6', 'sa6', P.rangSW, { heading: 225 }),
      site('sa8', 'rangi_sa8', 'sa8', P.rangE, { heading: 90 }),
      site('zsu1', 'rangi_aaa', 'zsu23', P.rangS),
      site('zsu2', 'rangi_aaa', 'zsu23', { x: 9600, z: -5500 }, { minDifficulty: 'pilot' }),
      site('sa15pop', 'popup', 'sa15', P.brownsIs, { emcon: true, minDifficulty: 'veteran' }),
    ],
    ground: [target('ewr', 'rangi_ewr', 'ewr', P.rangN, { name: 'EW Radar' })],
    objectives: [
      { id: 'o_sa6', kind: 'destroy', groups: ['rangi_sa6'], label: 'Destroy the SA-6 battery', primary: true },
      { id: 'o_sa8', kind: 'destroy', groups: ['rangi_sa8'], label: 'Destroy the SA-8', primary: true },
      { id: 'o_ewr', kind: 'destroy', groups: ['rangi_ewr'], label: 'Destroy the early-warning radar', primary: false },
      { id: 'o_aaa', kind: 'destroy', groups: ['rangi_aaa'], label: 'Silence the Shilkas', primary: false },
      { id: 'o_cap', kind: 'destroy', groups: ['migcap'], label: 'Splash the MiG CAP', primary: false, activeAt: { kind: 'group_spawned', group: 'migcap' } },
    ],
    waypoints: [
      { id: 'wp_ip', label: 'IP Devonport', kind: 'ip', x: P.devonport.x - 3000, z: P.devonport.z + 500, altitude: 3000 },
      { id: 'wp_sa6', label: 'SA-6', kind: 'target', x: P.rangSW.x, z: P.rangSW.z, objective: 'o_sa6' },
      { id: 'wp_sa8', label: 'SA-8', kind: 'target', x: P.rangE.x, z: P.rangE.z, objective: 'o_sa8' },
    ],
    triggers: [
      {
        id: 't_sa6_dead',
        when: { kind: 'objective', id: 'o_sa6', state: 'complete' },
        delay: 3,
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Straight Flush is off the air. The SA-8 is next.' }],
      },
      { id: 't_cap', when: { kind: 'time', t: 148 }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. MiGs launching to cover Rangitoto. Viper 2, engage.' }] },
    ],
    hints: [
      { id: 'h_arm', text: 'SEAD: WPN selects AARGM. Tap TGT on the SA-6 while its radar is on, then fire', when: { kind: 'time', t: 5 }, duration: 10 },
      { id: 'h_sdb', text: 'SDBs glide ~30 km from altitude: select SDB, designate the SA-8 with TGT, release inside 20 km', when: { kind: 'objective', id: 'o_sa6', state: 'complete' }, duration: 9 },
    ],
    opening: [{ kind: 'radio', from: DS, text: "Viper 1, Darkstar. Rangitoto's SAMs are up and painting the harbour: SA-6 on the south-west slope, SA-8 on the east shore. Magnum at will.", priority: 2 }],
    successText: 'Rangitoto is quiet. The harbour is ours again.',
  },
});

/* ───────────────────────── 4. Broken Wing — strike the Waiheke airstrip ───────────────────────── */

const c04Start = { x: 2500, z: -1500, altitude: 5000, heading: 95, speed: 240 };
const strip = P.waiAirstrip;
const rw = (v: number, u: number) => runwayPoint(strip, WAIHEKE_RUNWAY_HDG, v, u);

export const C04: MissionDef = mission({
  id: 'c04',
  kind: 'campaign',
  index: 4,
  title: 'Broken Wing',
  subtitle: 'Strike the enemy airstrip on Waiheke',
  timeOfDay: 'dusk',
  weather: 'scattered',
  features: [FEATURES.whenuapai, FEATURES.waihekeStrip],
  briefing: [
    "The enemy has bulldozed a 2,000-metre strip across Waiheke's vineyards and is flying MiG-29s off it. Satellite passes this afternoon count four Fulcrums on the apron, two hardened shelters and a fuel farm.",
    'Take the southern route through the Tāmaki Strait, well clear of the SA-8 on Motutapu, and put two JDAMs into the parked jets. An SA-6 covers the western end of the island and Shilkas sit either side of the runway. Weasel flight goes in ahead of you with AARGMs for the SA-6; Viper 2 flies top cover against the MiGs.',
    'Climb high for the attack: from 25,000 ft a JDAM glides about 10 km, far outside the Shilkas and above the Tor. Run in northbound from the IP off Beachlands, let it go the moment IN RANGE shows, then turn away. Beast mode carries six JDAMs for the hangars and fuel too — but every pylon makes you easier to see.',
  ],
  recommendedLoadout: 'strike_stealth',
  allowedLoadouts: ['strike_stealth', 'strike_beast', 'sead_stealth', 'strike_sdb2'],
  player: c04Start,
  script: {
    autoHints: true,
    parTime: 480,
    groups: [
      flight('weasel', 'f35a', 2, { x: 4000, z: 1500 }, 6500, 95, 240, 'fighter', {
        team: 'blue',
        callsign: 'Weasel',
        fixedCount: true,
        loadout: 'sead_stealth',
        announce: false,
        task: { kind: 'attack_group', group: 'wai_sa6' },
      }),
      flight('cap', 'mig29', 2, { x: 26000, z: -12000 }, 5500, 250, 230, 'cap', { task: { kind: 'patrol', x: 26000, z: -11000, radius: 6000, altitude: 5500 } }),
      // Viper 2 flies top cover as a sweep ahead of the player, straight at the MiG CAP
      fighterSweep(1, { x: 7000, z: -3500 }, 7000, 75, 'cap'),
      // One Fulcrum scrambles (two on Ace, enemyCountScale 1.5), and only once the player is on the bomb
      // run (11 km: the JDAM release is ~9.5 km out). A pair rolling at 16 km, while the player was still
      // crossing the strait with his two AMRAAMs spent on the CAP, ran down the Veteran bot every time (#58)
      flight('scramble', 'mig29', 1, rw(-900, 0), 500, WAIHEKE_RUNWAY_HDG, 170, 'interceptor', {
        spawn: {
          kind: 'all',
          of: [
            { kind: 'area', x: strip.x, z: strip.z, radius: 11000 },
            { kind: 'not', of: { kind: 'group_destroyed', group: 'parked' } },
          ],
        },
        task: { kind: 'attack_player' },
      }),
    ],
    sams: [
      site('sa6', 'wai_sa6', 'sa6', P.waiW, { heading: 250 }),
      site('zsuW', 'wai_aaa', 'zsu23', rw(-700, 150), { minDifficulty: 'pilot' }),
      site('zsuE', 'wai_aaa', 'zsu23', rw(700, 150)),
      // Recruit / Pilot: no Tor — its point defence shot the JDAMs down and made sortie 4 a wall (i2 review).
      // Veteran+: it guards the east end of the island, > 3 km (its point-defence bubble) from the parked
      // jets, so the two JDAMs aren't shot down on the apron; it still covers the strip against a low pass (#58)
      site('sa15', 'wai_sa15', 'sa15', P.waiE, { minDifficulty: 'veteran' }),
      site('manpads', 'wai_manpads', 'sa18', { x: 27300, z: -6900 }, { minDifficulty: 'veteran' }),
      // Recruit / Pilot: the Motutapu Osa is gone (a dogfight with the CAP drifts right into it)
      site('sa8', 'motu_sa8', 'sa8', P.motuN, { minDifficulty: 'veteran' }),
    ],
    ground: [
      target('jet1', 'parked', 'parked_jet', rw(-180, 320), { heading: 170, name: 'MiG-29' }),
      target('jet2', 'parked', 'parked_jet', rw(-120, 320), { heading: 170, name: 'MiG-29' }),
      target('jet3', 'parked', 'parked_jet', rw(100, 320), { heading: 170, name: 'MiG-29' }),
      target('jet4', 'parked', 'parked_jet', rw(160, 320), { heading: 170, name: 'MiG-29' }),
      target('hangar1', 'hangars', 'hangar', rw(-400, 560), { heading: 170 }),
      target('hangar2', 'hangars', 'hangar', rw(0, 560), { heading: 170 }),
      target('fuel1', 'fuel', 'fuel', rw(600, 620)),
      target('fuel2', 'fuel', 'fuel', rw(680, 620)),
    ],
    objectives: [
      { id: 'o_jets', kind: 'destroy', groups: ['parked'], label: 'Destroy the parked MiG-29s', primary: true },
      { id: 'o_hangars', kind: 'destroy', groups: ['hangars'], label: 'Destroy the hardened shelters', primary: false },
      { id: 'o_fuel', kind: 'destroy', groups: ['fuel'], label: 'Torch the fuel farm', primary: false },
      { id: 'o_sa6', kind: 'destroy', groups: ['wai_sa6'], label: 'Destroy the SA-6', primary: false },
    ],
    waypoints: [
      // the southern route at 25,000 ft (above the SA-8 / Tor / Shilka envelopes; the SA-6 is
      // Weasel's), then a northbound run-in from the IP off Beachlands, ~13 km out (12.9 km from the Tor)
      { id: 'wp_strait', label: 'Tāmaki Strait', kind: 'nav', x: 15000, z: 3000, altitude: 7500 },
      { id: 'wp_ip', label: 'IP Beachlands', kind: 'ip', x: 23500, z: 6500, altitude: 7500 },
      { id: 'wp_strip', label: 'Airstrip', kind: 'target', x: rw(0, 320).x, z: rw(0, 320).z, objective: 'o_jets' },
    ],
    triggers: [
      {
        id: 't_scramble',
        when: { kind: 'group_spawned', group: 'scramble' },
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Scramble, scramble! Fulcrum rolling on the Waiheke runway.', priority: 2 }],
      },
      {
        id: 't_jets_dead',
        when: { kind: 'objective', id: 'o_jets', state: 'complete' },
        delay: 2,
        actions: [{ kind: 'radio', from: DS, text: "Viper 1, Darkstar. Good hits! Those Fulcrums aren't flying again." }],
      },
      { id: 't_sa6', when: { kind: 'objective', id: 'o_sa6', state: 'complete' }, delay: 2, actions: [{ kind: 'radio', from: 'Weasel 1', text: 'Weasel 1: the SA-6 is down. Your turn, Viper.' }] },
    ],
    hints: [
      { id: 'h_high', text: 'Climb to 25,000 ft on the way in: the higher you release, the further the JDAM glides', when: { kind: 'time', t: 6 }, duration: 8 },
      { id: 'h_rel', text: 'Designate the parked jets with TGT and release the moment IN RANGE shows — then turn away', when: { kind: 'area', x: strip.x, z: strip.z, radius: 20000 }, duration: 8 },
    ],
    opening: [
      { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Four Fulcrums on the Waiheke apron and a pair on CAP north of the island. Come in from the south.', priority: 2 },
      { kind: 'radio', from: 'Weasel 1', text: 'Weasel 1, pushing for the SA-6. Magnum in two minutes.' },
    ],
    successText: 'The Waiheke strip is out of business.',
  },
});

/* ───────────────────────── 5. Backfire — intercept the bomber raid ───────────────────────── */

const c05Start = { x: -2000, z: -13000, altitude: 6500, heading: 50, speed: 250 };

export const C05: MissionDef = mission({
  id: 'c05',
  kind: 'campaign',
  index: 5,
  title: 'Backfire',
  subtitle: 'Intercept the Tu-22M3 raid on the city',
  timeOfDay: 'day',
  weather: 'overcast',
  briefing: [
    'The enemy has run out of patience. Long-range Tu-22M3 Backfires are inbound from the north-east with Su-27 Flankers riding shotgun. Each bomber carries a cruise missile aimed at the port and the CBD.',
    'The Backfires launch once they are within 7 km of the Sky Tower. Kill them before that — once the raid loses two-thirds of its bombers, the rest will turn for home. DARKSTAR expects a second raid from the north a couple of minutes behind the first.',
    'Backfires are big, fast and dumb: they will not turn to fight. The Flankers will. Beast mode gives you six AMRAAMs and two Sidewinders — on this one, firepower beats stealth.',
  ],
  recommendedLoadout: 'a2a_beast',
  allowedLoadouts: ['a2a_beast', 'a2a_stealth'],
  player: c05Start,
  script: {
    parTime: 420,
    groups: [
      wingmen(1, c05Start, { loadout: 'a2a_beast' }),
      flight('raid', 'tu22m', 3, { x: 34000, z: -33000 }, 9000, 240, 240, 'bomber', {
        maxCount: 4,
        formation: 'wall',
        spacing: 700,
        task: {
          kind: 'route',
          points: [
            { x: 22000, z: -27000, altitude: 9000 },
            { x: 12000, z: -15000, altitude: 8500 },
            { x: 0, z: 0, altitude: 8000 },
          ],
        },
      }),
      flight('escort', 'su27', 2, { x: 32500, z: -30500 }, 9500, 240, 250, 'escort', { maxCount: 2, task: { kind: 'escort_group', group: 'raid' } }),
      flight('raid2', 'tu22m', 2, { x: -6000, z: -35500 }, 9000, 160, 240, 'bomber', {
        maxCount: 3,
        spawn: { kind: 'time', t: 150 },
        formation: 'wall',
        spacing: 700,
        task: {
          kind: 'route',
          points: [
            { x: 2000, z: -22000, altitude: 8500 },
            { x: 0, z: 0, altitude: 8000 },
          ],
        },
      }),
    ],
    objectives: [
      {
        id: 'o_raid',
        kind: 'intercept',
        groups: ['raid'],
        x: 0,
        z: 0,
        radius: 7000,
        abortFraction: 0.67,
        abortTo: { x: 34000, z: -34000, altitude: 9000 },
        label: 'Stop the Backfire raid before missile range',
        primary: true,
      },
      {
        id: 'o_raid2',
        kind: 'intercept',
        groups: ['raid2'],
        x: 0,
        z: 0,
        radius: 7000,
        abortFraction: 0.67,
        abortTo: { x: -6000, z: -35500, altitude: 9000 },
        label: 'Stop the second raid from the north',
        primary: true,
        activeAt: { kind: 'group_spawned', group: 'raid2' },
      },
      { id: 'o_escort', kind: 'destroy', groups: ['escort'], label: 'Splash the Flanker escort', primary: false },
    ],
    waypoints: [
      { id: 'wp_int', label: 'Intercept', kind: 'cap', x: 17000, z: -21000, altitude: 8000, objective: 'o_raid' },
      { id: 'wp_int2', label: 'Intercept North', kind: 'cap', x: 1000, z: -20000, altitude: 8000, objective: 'o_raid2' },
    ],
    triggers: [
      { id: 't_raid2', when: { kind: 'time', t: 148 }, actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Second raid! Backfires from the north, angels 30.', priority: 2 }] },
      {
        id: 't_launch_warn',
        when: { kind: 'any', of: [{ kind: 'area', who: { group: 'raid' }, x: 0, z: 0, radius: 15000 }, { kind: 'area', who: { group: 'raid2' }, x: 0, z: 0, radius: 15000 }] },
        actions: [
          { kind: 'radio', from: DS, text: 'Viper 1, Darkstar! Backfires are minutes from launch range — kill them now!', priority: 3 },
          { kind: 'hud', text: 'BOMBERS NEARING LAUNCH RANGE', tone: 'warn', duration: 3 },
        ],
      },
    ],
    hints: [{ id: 'h_beast', text: "Bombers can't dodge: shoot them from max range, then turn on the Flankers", when: { kind: 'time', t: 8 }, duration: 8 }],
    opening: [
      {
        kind: 'radio',
        from: DS,
        text: 'Viper 1, Darkstar. Raid warning! Backfires with Flanker escort inbound from the north-east. If they get within 7 kilometres of the Tower, they launch.',
        priority: 2,
      },
    ],
    successText: 'The city is safe. Outstanding work, Viper.',
  },
});

/* ───────────────────────── 6. Strait Shooter — ship strike in the Tāmaki Strait ───────────────────────── */

const c06Start = { x: 1000, z: 7000, altitude: 3500, heading: 75, speed: 240 };

export const C06: MissionDef = mission({
  id: 'c06',
  kind: 'campaign',
  index: 6,
  title: 'Strait Shooter',
  subtitle: 'Sink the corvettes in the Tāmaki Strait',
  timeOfDay: 'day',
  weather: 'scattered',
  briefing: [
    'Two enemy corvettes are escorting a supply ship through the Tāmaki Strait, between Waiheke and the eastern suburbs, bringing fuel and missiles to the island garrisons.',
    'Sink both corvettes. An SA-15 Tor on Motuihe Island and an SA-8 on the south shore of Waiheke cover the strait, a Shilka sits on Browns Island at the mouth of the Tāmaki River, and a pair of Flankers is holding CAP overhead.',
    "The corvettes are creeping along a patrol line at two knots. A JDAM flies to where the ship was when you let it go — release the moment IN RANGE shows from 25,000 ft and the blast does the rest (STEER LEFT or STEER RIGHT instead means the ship is outside the bomb's turn: turn that way). Fly to the IP south of Beachlands and run in northbound: up there you are above the Tor and the SA-8 (both top out below 20,000 ft) and well outside their reach. Viper 2 will take on the Flankers.",
  ],
  recommendedLoadout: 'strike_stealth',
  allowedLoadouts: ['strike_stealth', 'strike_beast', 'sead_stealth', 'strike_sdb2'],
  player: c06Start,
  script: {
    parTime: 480,
    groups: [
      flight('flankers', 'su27', 2, { x: 26000, z: -1000 }, 5500, 250, 240, 'cap', { skillOffset: -0.05, task: { kind: 'patrol', x: 21000, z: -2500, radius: 7000, altitude: 5000 } }),
      // Viper 2 takes on the Flankers: a sweep ahead of the player, straight at the CAP
      fighterSweep(1, { x: 5500, z: 5000 }, 6500, 70, 'flankers'),
    ],
    sams: [
      site('sa15', 'motuihe_sa15', 'sa15', P.motuihe),
      site('sa8', 'wai_sa8', 'sa8', P.waiS),
      site('zsu', 'browns_aaa', 'zsu23', P.brownsIs, { minDifficulty: 'pilot' }),
      site('manpads', 'wai_manpads', 'sa18', P.waiW, { minDifficulty: 'veteran' }),
    ],
    ground: [
      // slow patrol line (≈2 kn): a JDAM flies to where the ship was at release, so a fast ship
      // would sail out of the blast during a long glide. Issue #65 weighed one corvette at 5–8 m/s
      // so the StormBreaker's tracking shows; not done: a JDAM released on IN RANGE from 25,000 ft
      // (56 s fall) sinks a 1 m/s corvette but misses one at 3 m/s or more, so the recommended
      // 2-JDAM load could no longer sink both
      target('cv1', 'fleet', 'ship', { x: 24000, z: 1000 }, { name: 'Corvette 531', path: [{ x: 17000, z: -500 }, { x: 24000, z: 1000 }], loop: true, speed: 1 }),
      target('cv2', 'fleet', 'ship', { x: 25500, z: 1800 }, { name: 'Corvette 532', path: [{ x: 18500, z: 300 }, { x: 25500, z: 1800 }], loop: true, speed: 1 }),
      target('supply', 'supply', 'ship', { x: 20500, z: -2300 }, { name: 'Supply Ship' }),
    ],
    objectives: [
      { id: 'o_fleet', kind: 'destroy', groups: ['fleet'], label: 'Sink both corvettes', primary: true },
      { id: 'o_supply', kind: 'destroy', groups: ['supply'], label: 'Sink the supply ship', primary: false },
      { id: 'o_sa15', kind: 'destroy_sams', x: P.motuihe.x, z: P.motuihe.z, radius: 1500, label: 'Destroy the SA-15 on Motuihe', primary: false },
      { id: 'o_cap', kind: 'destroy', groups: ['flankers'], label: 'Splash the Flanker CAP', primary: false },
    ],
    waypoints: [
      // south of Beachlands at 25,000 ft: 16 km from the Motuihe Tor and 15 km from the SA-8,
      // ~10 km (JDAM glide) from the patrol line — the briefed run-in is northbound
      { id: 'wp_ip', label: 'IP Beachlands', kind: 'ip', x: 21500, z: 11000, altitude: 7500 },
      { id: 'wp_fleet', label: 'Corvettes', kind: 'target', x: 21000, z: 500, objective: 'o_fleet' },
    ],
    triggers: [
      {
        id: 't_one_down',
        when: { kind: 'group_destroyed', group: 'fleet', count: 1 },
        delay: 2,
        actions: [{ kind: 'radio', from: DS, text: "Viper 1, Darkstar. One corvette burning. The other's still making way — finish it." }],
      },
    ],
    hints: [{ id: 'h_ships', text: 'Ships: TGT, release at IN RANGE. StormBreaker tracks the ship; JDAM does not', when: { kind: 'area', x: 21000, z: 500, radius: 22000 }, duration: 8 }],
    opening: [
      { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Two corvettes and a supply ship in the Tāmaki Strait. SA-15 on Motuihe, SA-8 on Waiheke south. Flankers overhead.', priority: 2 },
    ],
    successText: "The strait is closed to them. That'll hurt their island garrisons.",
  },
});

export const CAMPAIGN_PART1: MissionDef[] = [C01, C02, C03, C04, C05, C06];
