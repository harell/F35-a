/**
 * F35-A — shared mission-building helpers and named Auckland positions.
 *
 * Positions are metres in world space (origin = Sky Tower, +X east, −Z north). Land positions
 * come from the landmarks (src/core/auckland.ts, checked against the real LINZ coastline) or were
 * placed against it by hand so SAM sites and compounds sit on land with their pad radius to spare
 * (tests/world-linz.test.ts, tests/world-landmarks.test.ts); ship positions sit in open water.
 */
import { AKL, BRIDGE_SPAN_T } from '../../core/auckland';
import { airfieldFeature } from '../../core/airfields';
import type { IntelMarker, MissionDef, SceneryFeature } from '../../core/contracts';
import { AIRCRAFT_INFO, SAM_INFO } from '../../core/data';
import type { AircraftType, GroundTargetType, SamType } from '../../core/types';
import { SAM_DATA } from '../../sim/sam/samData';
import type { AircraftGroupDef, Condition, GroundTargetDef, MissionScript, SamSiteDef, XZ } from '../schema';
import { emptyScript } from '../schema';

/** Same terrain seed for every Auckland mission so the city looks the same all campaign. */
export const AKL_SEED = 1840;

/** A condition that is never true on its own (group spawned only by a trigger action). */
export const NEVER: Condition = { kind: 'not', of: { kind: 'start' } };

const pt = (id: string): XZ => ({ x: Math.round(AKL[id].x), z: Math.round(AKL[id].z) });
/** Point `t` of the way from landmark `a` to landmark `b`. */
const along = (a: string, b: string, t: number): XZ => ({
  x: Math.round(AKL[a].x + (AKL[b].x - AKL[a].x) * t),
  z: Math.round(AKL[a].z + (AKL[b].z - AKL[a].z) * t),
});

/** Named places (m). */
export const P = {
  skytower: { x: 0, z: 0 },
  whenuapai: pt('whenuapai'),
  bridgeS: pt('bridge_s'),
  bridgeN: pt('bridge_n'),
  /** Under the navigation span (the bridge model's hump, on the deck centreline). */
  harbourBridge: along('bridge_s', 'bridge_n', BRIDGE_SPAN_T),
  devonport: pt('devonport'),
  northHead: pt('north_head'),
  takapuna: pt('takapuna'),
  brownsBay: pt('browns_bay'),
  port: pt('port'),
  missionBay: pt('tamaki_drive'),
  mtEden: pt('mt_eden'),
  oneTreeHill: pt('one_tree_hill'),
  mtWellington: pt('mt_wellington'),
  hobsonville: pt('hobsonville'),
  beachlands: pt('beachlands'),
  airport: pt('akl_airport'),
  /** Wiri oil terminal (the storage tanks are WIRI_TANKS, core/sites.ts). */
  wiri: pt('wiri'),
  // Rangitoto (shield volcano, centre 8.7/-6.85 km, radius 2.8 km)
  rangitoto: { x: 8700, z: -6850 },
  rangSW: { x: 7400, z: -5700 },
  rangS: { x: 8400, z: -5000 },
  rangE: { x: 10300, z: -7000 },
  rangN: { x: 8900, z: -8400 },
  rangW: { x: 7000, z: -7400 },
  // Motutapu (grassy island NE of Rangitoto)
  motutapu: { x: 12800, z: -9000 },
  motuN: { x: 12910, z: -10430 },
  motuE: { x: 13700, z: -8700 },
  motuS: { x: 12700, z: -7700 },
  // Small islands (sites ≥ 150–250 m inside the LINZ coastline)
  motuihe: { x: 16170, z: -4490 },
  brownsIs: { x: 11830, z: -1720 },
  rakino: { x: 16700, z: -13850 },
  tiritiri: { x: 11480, z: -27460 },
  // Waiheke (16 km E–W)
  waiW: { x: 22610, z: -6700 },
  // fictional enemy strip, laid along the flat ground between Oneroa and Onetangi (fits the real coast)
  waiAirstrip: { x: 26900, z: -6600 },
  waiC: { x: 28600, z: -5300 },
  waiS: { x: 26300, z: -4400 },
  waiE: { x: 32000, z: -3700 },
  // Open water
  gulfNE: { x: 30000, z: -28000 },
  gulfN: { x: 8000, z: -32000 },
  channel: { x: 12300, z: -5200 }, // between Rangitoto, Motutapu and Motuihe
  strait: { x: 21000, z: -500 }, // Tāmaki Strait
} as const;

/** Waiheke enemy airstrip runway heading (deg). */
export const WAIHEKE_RUNWAY_HDG = 90;

/** Home base + enemy forward airstrip + the Motutapu logistics site (terrain flattening). */
export const FEATURES = {
  /** RNZAF Base Auckland: runways 03/21 and 08/26 (the world builds the real layout, src/core/airfields.ts). */
  whenuapai: airfieldFeature('whenuapai'),
  waihekeStrip: { type: 'airbase', x: P.waiAirstrip.x, z: P.waiAirstrip.z, rotation: WAIHEKE_RUNWAY_HDG, size: 0.8 } as SceneryFeature,
  motutapuDepot: { type: 'industrial', x: 13300, z: -9800, size: 0.6 } as SceneryFeature,
};

export const BASE_FEATURES: SceneryFeature[] = [FEATURES.whenuapai, FEATURES.waihekeStrip];

/**
 * Point in a runway frame: `v` metres along the runway heading from `base`, `u` metres to its
 * right (the apron / shelters side of the WORLD airbase layout).
 */
export function runwayPoint(base: XZ, headingDeg: number, v: number, u: number): XZ {
  const h = (headingDeg * Math.PI) / 180;
  return {
    x: Math.round(base.x + Math.sin(h) * v + Math.cos(h) * u),
    z: Math.round(base.z - Math.cos(h) * v + Math.sin(h) * u),
  };
}

/** Offset a point by (dx, dz) metres. */
export function off(p: XZ, dx: number, dz: number): XZ {
  return { x: p.x + dx, z: p.z + dz };
}

/* ───────────────────────────── Builders ───────────────────────────── */

type GroupExtra = Partial<Omit<AircraftGroupDef, 'id' | 'type' | 'count' | 'x' | 'z' | 'altitude' | 'heading' | 'speed' | 'role'>>;

/** Aircraft group. */
export function flight(
  id: string,
  type: AircraftType,
  count: number,
  at: XZ,
  altitude: number,
  heading: number,
  speed: number,
  role: AircraftGroupDef['role'],
  extra: GroupExtra = {},
): AircraftGroupDef {
  return { id, type, team: extra.team ?? (type === 'f35a' ? 'blue' : 'red'), count, x: at.x, z: at.z, altitude, heading, speed, role, ...extra };
}

/** Friendly wingmen ("Viper 2"…) flying off the player's right wing. */
export function wingmen(count: number, playerStart: { x: number; z: number; altitude: number; heading: number; speed: number }, extra: GroupExtra = {}): AircraftGroupDef {
  const h = (playerStart.heading * Math.PI) / 180;
  const at = { x: Math.round(playerStart.x + Math.cos(h) * 350 - Math.sin(h) * 250), z: Math.round(playerStart.z + Math.sin(h) * 350 + Math.cos(h) * 250) };
  return flight('viper', 'f35a', count, at, playerStart.altitude, playerStart.heading, playerStart.speed, 'wingman', {
    team: 'blue',
    callsign: 'Viper',
    firstNumber: 2,
    formation: 'echelon',
    fixedCount: true,
    announce: false,
    ...extra,
  });
}

/**
 * Friendly wingmen flown as a fighter sweep: pushed a few km ahead of the player and sent at a
 * hostile group (a 'wingman' only commits inside 15 km of the player, which leaves the player
 * alone with a CAP that commits on him first). Callsigns Viper 2… like wingmen(). Define it
 * AFTER the target group so the attack task resolves at spawn.
 */
export function fighterSweep(count: number, at: XZ, altitude: number, heading: number, group: string, extra: GroupExtra = {}): AircraftGroupDef {
  return flight('viper', 'f35a', count, at, altitude, heading, 250, 'fighter', {
    team: 'blue',
    callsign: 'Viper',
    firstNumber: 2,
    fixedCount: true,
    loadout: 'a2a_stealth',
    announce: false,
    task: { kind: 'attack_group', group },
    ...extra,
  });
}

/** SAM / AAA site. */
export function site(id: string, group: string, type: SamType, at: XZ, extra: Partial<Omit<SamSiteDef, 'id' | 'group' | 'type' | 'x' | 'z'>> = {}): SamSiteDef {
  return { id, group, type, x: at.x, z: at.z, ...extra };
}

/** Ground target. */
export function target(
  id: string,
  group: string,
  type: GroundTargetType,
  at: XZ,
  extra: Partial<Omit<GroundTargetDef, 'id' | 'group' | 'type' | 'x' | 'z'>> = {},
): GroundTargetDef {
  return { id, group, type, x: at.x, z: at.z, ...extra };
}

/* ───────────────────────────── Briefing data ───────────────────────────── */

/**
 * Briefing-map markers derived from the script: known SAM rings, enemy air groups present at
 * the start, ground-target groups (centroid), friendly flights, airbases.
 */
export function autoIntel(script: MissionScript, features: SceneryFeature[]): IntelMarker[] {
  const out: IntelMarker[] = [];
  for (const f of features) {
    if (f.type !== 'airbase') continue;
    const home = Math.hypot(f.x - P.whenuapai.x, f.z - P.whenuapai.z) < 3000;
    // free flight has no enemy: the Waiheke strip is just an airstrip
    out.push({ kind: 'airbase', label: home ? 'Whenuapai (home)' : script.freeFlight ? 'Waiheke airstrip' : 'Enemy airstrip', x: f.x, z: f.z });
  }
  for (const s of script.sams) {
    const known = s.known ?? !s.emcon;
    if (!known || (s.team ?? 'red') !== 'red' || (s.spawn && s.spawn.kind !== 'start')) continue;
    const d = SAM_DATA[s.type];
    out.push({ kind: 'sam', label: SAM_INFO[s.type].nato.split(' ')[0], x: s.x, z: s.z, radius: d.engageMax });
  }
  const groundGroups = new Map<string, { xs: number; zs: number; n: number; type: GroundTargetType; team: string; name?: string }>();
  for (const g of script.ground) {
    const e = groundGroups.get(g.group) ?? { xs: 0, zs: 0, n: 0, type: g.type, team: g.team ?? 'red', name: g.name };
    e.xs += g.x;
    e.zs += g.z;
    e.n++;
    groundGroups.set(g.group, e);
  }
  const label: Record<GroundTargetType, string> = {
    ewr: 'EW radar',
    bunker: 'Command bunker',
    fuel: 'Fuel depot',
    hangar: 'Hangars',
    parked_jet: 'Parked jets',
    truck: 'Convoy',
    tank: 'Armour',
    ship: 'Ships',
    factory: 'Depot',
    bridge: 'Bridge',
    suicide_boat: 'Suicide boats',
    missile_boat: 'Missile boats',
  };
  for (const e of groundGroups.values()) {
    const x = Math.round(e.xs / e.n);
    const z = Math.round(e.zs / e.n);
    // a neutral ship (g02's tanker) is the one being protected, not a strike target: mark it friendly, by name
    if (e.team === 'neutral') out.push({ kind: 'friendly', label: e.name ?? label[e.type], x, z });
    else out.push({ kind: e.team === 'blue' ? 'friendly' : 'target', label: label[e.type], x, z });
  }
  for (const g of script.groups) {
    if (g.spawn && g.spawn.kind !== 'start') continue;
    if (g.team === 'blue') {
      if (g.role === 'wingman') continue;
      out.push({ kind: 'friendly', label: `${g.callsign ?? 'Friendly'} flight`, x: g.x, z: g.z });
    } else {
      // 'mixed' Instant Action flights fly a lesser type below Veteran: show both
      const name = g.downgrade ? `${AIRCRAFT_INFO[g.downgrade.type].name} / ${AIRCRAFT_INFO[g.type].name}` : AIRCRAFT_INFO[g.type].name;
      out.push({ kind: 'air', label: `${g.count}× ${name}`, x: g.x, z: g.z });
    }
  }
  return out;
}

/** Objective bullets for the briefing screen. */
export function autoObjectiveText(script: MissionScript): string[] {
  return script.objectives.map((o) => (o.primary ? o.label : `Bonus: ${o.label}`));
}

type MissionInput = Omit<MissionDef, 'intel' | 'objectiveText' | 'script' | 'features' | 'seed' | 'theater'> &
  Partial<Pick<MissionDef, 'intel' | 'objectiveText' | 'features' | 'seed' | 'theater'>> & { script: Partial<MissionScript> };

/** Fill in the Auckland defaults, derived intel and objective text. */
export function mission(m: MissionInput): MissionDef {
  const script: MissionScript = { ...emptyScript(), ...m.script };
  const features = m.features ?? BASE_FEATURES;
  return {
    ...m,
    theater: m.theater ?? 'auckland',
    seed: m.seed ?? AKL_SEED,
    features,
    script,
    intel: [...autoIntel(script, features), ...(m.intel ?? [])],
    objectiveText: m.objectiveText ?? autoObjectiveText(script),
  };
}
