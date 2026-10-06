/**
 * F35-A — IRGC campaign, mission 3: "Stoat of Emergency" (epic #196).
 *
 * The Guard (#211) holds Waiheke Island. A trap-line volunteer group asks for air support against one stoat
 * on the Onetangi dunes, heading for a nest of NZ dotterel chicks. The jet has to get through the
 * island's layered air defences and find the target under the overcast. There is no clock: the stoat sits
 * feeding at a bait station and one bomb kills it. Getting there alive is the mission.
 *
 * The defences are laid out so no route is free (#197): the end of every route is inside the
 * airstrip SA-6's ring and the ZSU's reach; the Motuihe SA-6 is covered by the Tor's point defence;
 * patrolling AD boats guard the open water north and south, and their optical trackers (and the island
 * sites' own, `closeCue`) don't care about stealth; the target is revealed only to a jet under the
 * cloud deck within G03_REVEAL.radius of it. Two AARGM-ERs for seven radars: the player picks which sites to kill, which to slip
 * past (terrain masking, the notch, chaff, the SA-6's radar floor) and which to outlast.
 *
 * Geometry is checked on the real LINZ coast in tests/missions-g03.test.ts.
 */
import type { MissionDef } from '../../core/contracts';
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

/**
 * Par time (s) for the debrief's score. There is no mission clock: the air defences are the challenge,
 * not the time.
 */
export const G03_PAR = 240;

/**
 * The stoat (#200, sim/stoat.ts): it sits feeding at the volunteers' bait station near the nest and
 * doesn't leave, so a bomb released at it hits (a GBU-53/B tracks a small target while it stands
 * still: sim/weapons/small.ts). Its route is the station alone: it is at the end of its route from the
 * start, so it never runs, and a near miss doesn't move it. Targeted, it still stands up in the
 * periscope stance.
 */
export const G03_STOAT = {
  /** The bait station it feeds at (m). */
  station: { x: 28_140, z: -6_725 } as XZ,
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
    'Tasking from the Waiheke Trap Line volunteers. Their trail camera has one adult stoat on the dunes at Onetangi, beside a nest of NZ dotterel chicks. It has found their bait station and is feeding: it is not going anywhere. One StormBreaker will do it. The hard part is getting there.',
    'The Guard holds the island. An SA-6 and a Tor stand on Motuihe, the Tor covering the SA-6 against anti-radiation missiles. A second SA-6 guards the airstrip beside the beach, with a ZSU-23-4 on the ridge above it. IRGC Navy air-defence boats patrol north of Rangitoto, off Onetangi and in the Tāmaki Strait. Every one of them carries an optical tracker that sees you inside 7 to 9 km whatever your shaping.',
    'You carry two AARGM-ERs and two GBU-53/B StormBreakers. You will not destroy them all, and you will not need to. Pick your way in, kill what blocks it, and use the terrain, the notch and chaff for the rest. An AARGM fired from far out only silences a radar for a few seconds: fire it close in and go straight in behind it.',
    'The cloud base is about 6,000 ft. You will only find the target from under the cloud, within 6 km of the nest. Rules of engagement: the stoat is the only authorised target on the island.',
  ],
  recommendedLoadout: 'sead_precision',
  allowedLoadouts: ['sead_precision'],
  player: g03Start,
  script: {
    parTime: G03_PAR,
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
      // the stoat: revealed only under the cloud near the nest, feeding at the bait station
      target('stoat', G.target, 'stoat', G03_STOAT.station, {
        name: 'Stoat',
        spawn: reveal,
        stoat: { route: [G03_STOAT.station], stations: [] },
      }),
    ],
    objectives: [{ id: 'o_target', kind: 'destroy', groups: [G.target], label: 'Kill the stoat at the bait station', primary: true }],
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
        actions: [{ kind: 'radio', from: TL, text: 'Viper, Waiheke Trap Line. Camera seven still has it at the bait station, feeding. Take your time getting here.' }],
      },
      {
        id: 't_alert',
        when: { kind: 'stoat_alert', group: G.target },
        actions: [{ kind: 'radio', from: TL, text: 'It has stood up. It is looking straight at you.' }],
      },
      {
        id: 't_caught',
        when: { kind: 'group_destroyed', group: G.target },
        actions: [{ kind: 'radio', from: TL, text: 'Trap 114, catch logged. Cheers, Viper.' }],
      },
    ],
    hints: [
      { id: 'h_plan', text: 'No free route: pick a path, kill what blocks it, mask and notch the rest', when: { kind: 'time', t: 6 }, duration: 8 },
      // the sweep's lesson (#198): an AARGM fired from far out only silences a radar for a few seconds
      { id: 'h_arm', text: 'An AARGM silences a radar for seconds: fire it close in, then attack straight after', when: { kind: 'player_weapon', weapon: 'aargm' }, duration: 8 },
    ],
    opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Waiheke air defences are up. Your target is on the Onetangi dunes, under the cloud.', priority: 2 }],
    successText: 'Stoat down, nest intact. Good shooting, Viper. RTB.',
    // the debrief's cost summary (#201, runtime/costs.ts): the sortie against one volunteer's trap
    costSummary: { comparison: { label: "Volunteer's trap, for comparison", nzd: 40 }, removed: { label: 'Stoats removed', group: G.target } },
  },
});
