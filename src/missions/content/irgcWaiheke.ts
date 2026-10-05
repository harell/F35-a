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
  /** The Motuihe pair: the Tor's point defence (3 km) covers the SA-6 0.7 km away. */
  motuiheSa6: { x: 16_500, z: -4_000 } as XZ,
  motuiheTor: { x: 16_200, z: -3_400 } as XZ,
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
  /** Off Onetangi: the north approach to the beach. */
  n2: [
    { x: 24_000, z: -11_000 },
    { x: 30_000, z: -11_000 },
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
      // stand-in for the stoat (#200 replaces it): revealed only under the cloud near the nest
      target('stoat', G.target, 'bunker', G03_NEST, { name: 'Target', spawn: reveal }),
    ],
    objectives: [{ id: 'o_target', kind: 'destroy', groups: [G.target], label: 'Kill the target before it reaches the nest', primary: true }],
    waypoints: [{ id: 'wp_nest', label: 'Onetangi', kind: 'target', x: G03_NEST.x, z: G03_NEST.z, altitude: 600, radius: 1500, objective: 'o_target' }],
    triggers: [
      {
        id: 't_reveal',
        when: { kind: 'group_spawned', group: G.target },
        actions: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. You are under the cloud. Target on the Onetangi dunes, east of the airstrip.', priority: 2 }],
      },
    ],
    hints: [{ id: 'h_plan', text: 'No free route: pick a path, kill what blocks it, mask and notch the rest', when: { kind: 'time', t: 6 }, duration: 8 }],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Waiheke air defences are up. Target is on the Onetangi dunes, under the cloud.', priority: 2 }],
    successText: 'Target down. Good shooting, Viper. RTB.',
  },
});
