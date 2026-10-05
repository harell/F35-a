/**
 * F35-A — IRGC campaign, mission 3: "Stoat of Emergency" (epic #196).
 *
 * The IRGC holds Waiheke Island. A trap-line volunteer group asks for air support against one stoat
 * on the Onetangi dunes, heading for a nest of NZ dotterel chicks. The jet has to get through the
 * island's layered air defences, find the target under the overcast and kill it before the clock runs out.
 *
 * The defences are laid out so no route is free (#197): the end of every route is inside the
 * airstrip SA-6's ring and the ZSU's reach; the Motuihe SA-6 is covered by the Tor's point defence;
 * patrolling AD boats guard the open water north and south, and their optical trackers (and the island
 * sites' own, `closeCue`) don't care about stealth; the target is revealed only to a jet under the
 * cloud deck within G03_REVEAL.radius of it; and the clock rules out the long way round Waiheke's
 * east end. Two AARGM-ERs for seven radars: the player picks which sites to kill, which to slip
 * past (terrain masking, the notch, chaff, the SA-6's radar floor) and which to outlast.
 *
 * Geometry is checked on the real LINZ coast in tests/missions-g03.test.ts.
 */
import type { MissionDef } from '../../core/contracts';
import { OVERCAST_DECK } from '../../core/weather';
import type { XZ } from '../schema';
import { P, mission, site, target } from './common';

const DS = 'DARKSTAR';

/** The nest on the Onetangi dunes, east of the enemy airstrip (m). */
export const G03_NEST: XZ = { x: 28_250, z: -6_700 };

/** Mission clock (s): the target reaches the nest at 4:00. */
export const G03_CLOCK = 240;

/**
 * The stoat (#200, sim/stoat.ts): it runs east along the dune line from its start, stops at three
 * bait stations the volunteers set close to the nest (the drop windows) and ends at the nest. Its
 * first leg is the long one, so the windows fall when a jet that came the long way round can be
 * there: about 1:09–1:49, 2:03–2:43 and 2:57–3:37, each long enough for the run-in and a
 * StormBreaker's glide. Undisturbed it arrives at about 3:55, inside G03_CLOCK; a near miss makes
 * it bolt and cuts its stop short.
 */
export const G03_STOAT = {
  start: { x: 27_850, z: -6_745 } as XZ,
  /** The bait stations, in order. */
  stations: [
    { x: 28_090, z: -6_735 },
    { x: 28_140, z: -6_725 },
    { x: 28_190, z: -6_715 },
  ] as XZ[],
  /** Average dash speed (m/s) and the stop at each station (s). */
  speed: 3.5,
  stopTime: 40,
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
 * open), so stealth and the notch alone don't carry the straight line past them.
 */
export const G03_ISLAND_CUE = { range: 7_000, bayRange: 10_000 } as const;

/** Fixed sites (m). */
export const G03_SITES = {
  /**
   * The Motuihe pair: the Tor's point defence (3 km) covers the SA-6 1 km away. The Tor stands on the
   * island's north-east end, 8 km from the Tāmaki Strait: the strait is a corridor its patrol boat
   * guards, not the Tor (the SA-6 sees down it, but can't engage a jet under its 80 m floor).
   */
  motuiheSa6: { x: 16_200, z: -3_400 } as XZ,
  motuiheTor: { x: 16_600, z: -4_300 } as XZ,
  /** The enemy airstrip between Oneroa and Onetangi: covers the end of every route. */
  airstripSa6: P.waiAirstrip,
  /** The ridge above Onetangi: covers the low drop pass. */
  ridgeZsu: { x: 28_200, z: -6_400 } as XZ,
} as const;

/** Patrolling air-defence boats: routes (looped) and speed (m/s). */
export const G03_BOATS = {
  /** North of Rangitoto and Motutapu: the north detour. */
  n1: [
    { x: 11_000, z: -13_300 },
    { x: 18_500, z: -13_000 },
  ] as XZ[],
  /**
   * Off Onetangi: the north approach to the beach. Far enough out (≥ 6 km from the nest) that a pop-up
   * from behind the island's ridge to the south stays outside its reach.
   */
  n2: [
    { x: 24_000, z: -13_000 },
    { x: 32_000, z: -13_000 },
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
    'The IRGC holds Waiheke Island. A local trap-line volunteer group has asked for air support: one stoat has evaded their traps and is moving along the dunes at Onetangi towards a nest of NZ dotterel chicks. It will reach the nest in four minutes.',
    'The island is defended. An SA-6 and a Tor stand on Motuihe, the Tor covering the SA-6 against anti-radiation missiles. Another SA-6 guards the airstrip next to the beach, with a ZSU-23-4 on the ridge above it, and air-defence boats patrol the water north and south. Their optical trackers see you inside about 7 to 9 km whatever your shaping.',
    'You carry two AARGM-ERs and two GBU-53/B StormBreakers. You will not destroy them all, and you will not need to: pick your way in, kill what blocks it, and use the terrain, the notch and chaff for the rest.',
    'The cloud base is about 6,000 ft. The target only shows up once you are under the cloud within 6 km of the nest.',
  ],
  recommendedLoadout: 'sead_precision',
  allowedLoadouts: ['sead_precision'],
  player: g03Start,
  timeLimit: G03_CLOCK,
  script: {
    parTime: G03_CLOCK,
    sams: [
      site('mot_sa6', G.motuihe, 'sa6', G03_SITES.motuiheSa6, { closeCue: G03_ISLAND_CUE }),
      site('mot_tor', G.motuihe, 'sa15', G03_SITES.motuiheTor, { closeCue: G03_ISLAND_CUE }),
      site('strip_sa6', G.airstrip, 'sa6', G03_SITES.airstripSa6, { closeCue: G03_ISLAND_CUE }),
      site('ridge_zsu', G.ridge, 'zsu23', G03_SITES.ridgeZsu),
      site('ad_n1', G.boats, 'ad_boat', G03_BOATS.n1[0], { path: G03_BOATS.n1, loop: true, speed: G03_BOATS.speed }),
      site('ad_n2', G.boats, 'ad_boat', G03_BOATS.n2[0], { path: G03_BOATS.n2, loop: true, speed: G03_BOATS.speed }),
      site('ad_s', G.boats, 'ad_boat', G03_BOATS.s[0], { path: G03_BOATS.s, loop: true, speed: G03_BOATS.speed }),
    ],
    ground: [
      // the stoat: revealed only under the cloud near the nest, its clock running from the start
      target('stoat', G.target, 'stoat', G03_STOAT.start, {
        name: 'Stoat',
        spawn: reveal,
        stoat: { route: [...G03_STOAT.stations, G03_NEST], stations: [0, 1, 2], speed: G03_STOAT.speed, stopTime: G03_STOAT.stopTime },
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
        // the stoat at the nest: the sortie is lost (its clock and the mission's run together)
        id: 't_nest',
        when: { kind: 'area', who: { group: G.target }, x: G03_NEST.x, z: G03_NEST.z, radius: 3 },
        actions: [{ kind: 'end', success: false, reason: 'The stoat reached the nest' }],
      },
    ],
    hints: [
      { id: 'h_plan', text: 'No free route: pick a path, kill what blocks it, mask and notch the rest', when: { kind: 'time', t: 6 }, duration: 8 },
      // the sweep's lesson (#198): an AARGM fired from far out only silences a radar for a few seconds
      { id: 'h_arm', text: 'An AARGM silences a radar for seconds: fire it close in, then attack straight after', when: { kind: 'player_weapon', weapon: 'aargm' }, duration: 8 },
      // the stoat (#200): a bomb can't track it while it runs (sim/weapons/small.ts)
      { id: 'h_stops', text: 'Release while the stoat stops at a bait station: running, a StormBreaker can\'t track it', when: { kind: 'group_spawned', group: G.target }, duration: 9 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Waiheke air defences are up. Target is on the Onetangi dunes, under the cloud.', priority: 2 }],
    successText: 'Target down. Good shooting, Viper. RTB.',
  },
});
