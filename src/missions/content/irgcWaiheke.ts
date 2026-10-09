/**
 * F35-A — IRGC campaign, mission 3: "Stoat of Emergency" (epic #196).
 *
 * The Guard (#211) holds Waiheke Island. A trap-line volunteer group asks for air support against one stoat
 * on the Onetangi dunes, heading for a nest of NZ dotterel chicks. The jet has to get through the
 * island's layered air defences, find the target under the overcast and kill it before the clock runs out.
 *
 * The defences are layered, and there are several ways through them, none free (#197; for casual
 * players, playtest 2026-10-10 r1): low down the Tāmaki Strait under the Motuihe SA-6's radar floor,
 * past the strait's patrol boat; round the north of the islands, an AARGM for each boat in the way;
 * or straight across, after an AARGM at the Motuihe SA-6 from close in (or simply defending its shots).
 * The ZSU covers the drop pass at the end of every route; the boats' optical trackers (and the island
 * sites' own, `closeCue`) don't care about stealth; the target is revealed only to a jet under the
 * cloud deck within G03_REVEAL.radius of it, and it can be bombed only at its stops, so the clock and
 * the stops decide how long a jet can take. Veteran adds a Tor covering the Motuihe SA-6 and the
 * airstrip SA-6 over the nest. Two AARGM-ERs: the player picks which radars to kill, which to slip
 * past (terrain masking, the notch, chaff, the SA-6's radar floor) and which to outlast.
 *
 * Geometry is checked on the real LINZ coast in tests/missions-g03.test.ts.
 */
import type { MissionDef } from '../../core/contracts';
import { AARGM_RULE } from '../../core/data';
import { OVERCAST_DECK } from '../../core/weather';
import type { XZ } from '../schema';
import { P, mission, site, target } from './common';

const DS = 'DARKSTAR';
/**
 * The volunteers' radio callsign. The group is fictional, like every local name in this mission
 * (tests/missions-g03.test.ts checks the senders).
 */
export const G03_VOLUNTEERS = 'TRAP LINE';
const TL = G03_VOLUNTEERS;

/** The nest on the Onetangi dunes, east of the enemy airstrip (m). */
export const G03_NEST: XZ = { x: 28_250, z: -6_700 };

/** Mission clock (s): the target reaches the nest just inside 5:20. */
export const G03_CLOCK = 320;

/**
 * The stoat (#200, sim/runner.ts): it runs east along the dune line from its start, stops at three
 * bait stations the volunteers set close to the nest (the drop windows) and ends at the nest. Its
 * first leg is the long one, so the windows fall when the ways in get there (the bot's routes reveal
 * it at 2:20–3:20): about 1:28–2:28, 2:43–3:43 and 3:58–4:58, so a jet that finds it at 3:00
 * still has two stops long enough for the run-in and a StormBreaker's glide (playtest 2026-10-10,
 * 1.3-b: with 40 s stops ending at 3:37, one). Undisturbed it arrives at about 5:15, inside
 * G03_CLOCK; a near miss makes it bolt and cuts its stop short.
 */
export const G03_STOAT = {
  start: { x: 27_780, z: -6_745 } as XZ,
  /** The bait stations, in order. */
  stations: [
    { x: 28_090, z: -6_735 },
    { x: 28_140, z: -6_725 },
    { x: 28_190, z: -6_715 },
  ] as XZ[],
  /** Average dash speed (m/s) and the stop at each station (s). */
  speed: 3.5,
  stopTime: 60,
} as const;

/**
 * The target is revealed (spawned) only once the jet has been below the overcast deck within this
 * radius of the nest: a jet above the cloud, or a stand-off release from far out, has nothing to aim at.
 */
export const G03_REVEAL = { radius: 6_000, below: OVERCAST_DECK.altitude } as const;

/** Mission group ids. */
export const G03_GROUPS = {
  target: 'stoat',
  motuihe: 'motuihe_sams',
  airstrip: 'airstrip_sam',
  ridge: 'ridge_aaa',
  boats: 'ad_boats',
} as const;

/**
 * Close-in cue of the island radar sites (an electro-optical tracker, as the AD boats'
 * SamTypeData.closeCue). Their radars see a clean F-35 at about a quarter of their quoted range
 * (SA-6 ≈ 10 km, Tor ≈ 6.5 km), and less low over the water, where beaming them puts the jet in the
 * Doppler notch; the tracker sees it inside 7 km whatever its shaping or aspect (10 km with the bay
 * open), so stealth and the notch alone don't carry the straight line past them: the SA-6's floor,
 * an AARGM or a good defence does.
 */
export const G03_ISLAND_CUE = { range: 7_000, bayRange: 10_000 } as const;

/** Fixed sites (m). */
export const G03_SITES = {
  /**
   * Motuihe: the SA-6 on the straight line in, and on Veteran a Tor whose point defence (3 km) covers it
   * 1 km away. The Tor stands on the island's north-east end, 8 km from the Tāmaki Strait: the strait is
   * a corridor its patrol boat guards, not the Tor (the SA-6 sees down it, but can't engage a jet under
   * its 80 m floor).
   */
  motuiheSa6: { x: 16_200, z: -3_400 } as XZ,
  motuiheTor: { x: 16_600, z: -4_300 } as XZ,
  /** The enemy airstrip between Oneroa and Onetangi (Veteran): covers the end of every route. */
  airstripSa6: P.waiAirstrip,
  /** The ridge above Onetangi: covers the low drop pass. */
  ridgeZsu: { x: 28_200, z: -6_400 } as XZ,
} as const;

/**
 * Patrolling air-defence boats: routes (looped) and speed (m/s). No harassing long shots
 * (`noHarass`, the g02 boats' DifficultyParams.adBoatHarass): the reveal radius already brings the jet
 * in close for its drop, and with three boats round the island every release drew two or three long
 * salvos on Pilot (playtest 2026-10-10, 1.3-b).
 */
export const G03_BOATS = {
  /**
   * North of Rakino: the north detour. Far enough out (≥ 8 km from the straight line) that a jet beaming
   * the Motuihe SA-6 off the straight line isn't in its reach as well.
   */
  n1: [
    { x: 11_000, z: -18_000 },
    { x: 18_500, z: -18_000 },
  ] as XZ[],
  /**
   * Off Onetangi: the north approach to the beach. Far enough out (8 km from the nest) that a pop-up
   * from behind the island's ridge to the south stays outside its reach.
   */
  n2: [
    { x: 24_000, z: -15_000 },
    { x: 32_000, z: -15_000 },
  ] as XZ[],
  /** The Tāmaki Strait: the south detour. */
  s: [
    { x: 20_000, z: 1_000 },
    { x: 28_000, z: 1_500 },
  ] as XZ[],
  speed: 8,
} as const;

/** The player: on CAP over west Auckland, as in g01/g02, about 44 km from the nest. */
const g03Start = { x: -15_000, z: -2_700, altitude: 3_000, heading: 85, speed: 250, fuel: 0.55 };

const G = G03_GROUPS;
const reveal = { kind: 'area', x: G03_NEST.x, z: G03_NEST.z, radius: G03_REVEAL.radius, below: G03_REVEAL.below } as const;

export const G03: MissionDef = mission({
  id: 'g03',
  kind: 'campaign',
  index: 3,
  title: 'Stoat of Emergency',
  subtitle: 'Past the Waiheke air defences to a small target',
  timeOfDay: 'day',
  weather: 'overcast',
  briefing: [
    'Tasking from the Waiheke Trap Line volunteers. Their trail camera has one adult stoat on the dunes at Onetangi, moving east towards a nest of NZ dotterel chicks. It will reach the nest in just over five minutes. It stops at each of the three bait stations the volunteers set on its path: those stops are your drop windows, because a StormBreaker cannot track it while it runs.',
    'The Guard holds the island: an SA-6 on Motuihe, a Shilka (ZSU-23-4) gun on the ridge above the beach, and IRGC Navy air-defence boats north of Rakino, off Onetangi and in the Tāmaki Strait. The radars and the boats have optical trackers that see you inside 7 to 9 km whatever your shaping. On Veteran the SA-15 Tor covers the Motuihe SA-6 and a second SA-6 guards the airstrip.',
    `There is more than one way in. Low down the Tāmaki Strait, under the SA-6's radar floor. Round the north of the islands, an AARGM for each boat in your way. Or straight across, after an AARGM at the Motuihe SA-6. You carry two AARGM-ERs and two GBU-53/B StormBreakers. With an AARGM, ${AARGM_RULE}: fired from far out, it only silences a radar for a few seconds.`,
    'The cloud base is about 6,000 ft: you will only find the target from under the cloud, within 6 km of the nest. Rules of engagement: the stoat is the only authorised target on the island.',
  ],
  recommendedLoadout: 'sead_precision',
  allowedLoadouts: ['sead_precision'],
  // Live SAMs: the SA-6, terrain masking and the notch over land; Small Targets: the StormBreaker
  // released while a target too small to track stands still
  lessons: ['t06', 't07'],
  player: g03Start,
  timeLimit: G03_CLOCK,
  script: {
    // the built-in hints (playtest 2026-10-10, 1.2-f): the MISSILE! defence prompt when a SAM fires, and
    // the AARGM / StormBreaker steps (a StormBreaker at the stoat: wait for it to stop)
    autoHints: true,
    parTime: G03_CLOCK,
    sams: [
      site('mot_sa6', G.motuihe, 'sa6', G03_SITES.motuiheSa6, { closeCue: G03_ISLAND_CUE }),
      // Veteran's extra layer (playtest 2026-10-10, 1.3-a): on Recruit and Pilot the Tor made the straight line a wall
      // and the airstrip SA-6 killed at 3–5 km in the drop window on every route
      site('mot_tor', G.motuihe, 'sa15', G03_SITES.motuiheTor, { closeCue: G03_ISLAND_CUE, minDifficulty: 'veteran' }),
      site('strip_sa6', G.airstrip, 'sa6', G03_SITES.airstripSa6, { closeCue: G03_ISLAND_CUE, minDifficulty: 'veteran' }),
      site('ridge_zsu', G.ridge, 'zsu23', G03_SITES.ridgeZsu),
      site('ad_n1', G.boats, 'ad_boat', G03_BOATS.n1[0], { path: G03_BOATS.n1, loop: true, speed: G03_BOATS.speed, noHarass: true }),
      site('ad_n2', G.boats, 'ad_boat', G03_BOATS.n2[0], { path: G03_BOATS.n2, loop: true, speed: G03_BOATS.speed, noHarass: true }),
      site('ad_s', G.boats, 'ad_boat', G03_BOATS.s[0], { path: G03_BOATS.s, loop: true, speed: G03_BOATS.speed, noHarass: true }),
    ],
    ground: [
      // the stoat: revealed only under the cloud near the nest, its clock running from the start
      target('stoat', G.target, 'stoat', G03_STOAT.start, {
        name: 'Stoat',
        spawn: reveal,
        runner: { route: [...G03_STOAT.stations, G03_NEST], stations: [0, 1, 2], speed: G03_STOAT.speed, stopTime: G03_STOAT.stopTime },
      }),
    ],
    objectives: [{ id: 'o_target', kind: 'destroy', groups: [G.target], label: 'Kill the stoat before it reaches the nest', primary: true }],
    waypoints: [{ id: 'wp_nest', label: 'Onetangi', kind: 'target', x: G03_NEST.x, z: G03_NEST.z, altitude: 600, radius: 1500, objective: 'o_target' }],
    triggers: [
      {
        id: 't_reveal',
        when: { kind: 'group_spawned', group: G.target },
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Single contact, ground, Onetangi dunes. Type… stoat. Confirmed stoat.', priority: 2 }],
      },
      {
        id: 't_volunteers',
        when: { kind: 'time', t: 14 },
        actions: [{ kind: 'radio', from: TL, text: 'Viper, Waiheke Trap Line. Camera seven still has it on the dunes, heading east. We have three stations baited for you.' }],
      },
      // the volunteers call each bait station as the stoat reaches it: the drop windows
      ...G03_STOAT.stations.map((st, i) => ({
        id: `t_station${i + 1}`,
        when: { kind: 'area' as const, who: { group: G.target }, x: st.x, z: st.z, radius: 2 },
        actions: [{ kind: 'radio' as const, from: TL, text: ['It is at the first station. It will sit there a while.', 'Second station. It has stopped again.', 'Third station, the last one before the nest.'][i], priority: 2 }],
      })),
      {
        id: 't_alert',
        when: { kind: 'runner_alert', group: G.target },
        actions: [{ kind: 'radio', from: TL, text: 'It has stood up. It is looking straight at you.' }],
      },
      {
        id: 't_caught',
        when: { kind: 'group_destroyed', group: G.target },
        actions: [{ kind: 'radio', from: TL, text: 'Trap 114, catch logged. Cheers, Viper.' }],
      },
      {
        // the stoat at the nest: the sortie is lost (its clock and the mission's run together)
        id: 't_nest',
        when: { kind: 'area', who: { group: G.target }, x: G03_NEST.x, z: G03_NEST.z, radius: 3 },
        actions: [{ kind: 'end', success: false, reason: 'The stoat reached the nest' }],
      },
    ],
    hints: [
      { id: 'h_plan', text: 'Pick a way in: low down the strait, round the north, or straight in after an AARGM', when: { kind: 'time', t: 6 }, duration: 8 },
      // the sweep's lesson (#198): an AARGM fired from far out only silences a radar for a few seconds
      { id: 'h_arm', text: 'From far out an AARGM only silences a radar for seconds. Fire inside 10 km, radar on, then press in', when: { kind: 'player_weapon', weapon: 'aargm' }, duration: 8 },
      // the stoat (#200): a bomb can't track it while it runs (sim/weapons/small.ts)
      { id: 'h_stops', text: 'Release while the stoat stops at a bait station: running, a StormBreaker can\'t track it', when: { kind: 'group_spawned', group: G.target }, duration: 9 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Waiheke air defences are up. Your target is on the Onetangi dunes, under the cloud.', priority: 2 }],
    successText: 'Stoat down, nest intact. Good shooting, Viper. RTB.',
    // the debrief's cost summary (#201, runtime/costs.ts): the sortie against one volunteer's trap
    costSummary: { comparison: { label: "Volunteer's trap, for comparison", nzd: 40 }, removed: { label: 'Stoats removed', group: G.target } },
  },
});
