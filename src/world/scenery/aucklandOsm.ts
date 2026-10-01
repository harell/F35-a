/**
 * OpenStreetMap layers for the Auckland theatre: real airfield layouts (Open data 1) and the waterside /
 * strategic-site layers of Open data 2 (piers, breakwaters, marinas, port land, berths, cranes, the dry dock,
 * storage tanks, military and naval land with their buildings, stadiums and the big bridge outlines).
 *
 * src/world/scenery/data/auckland-osm.bin is baked offline by tools/osm/bake.py from a pinned OSM extract
 * (see tools/osm/README.md), reprojected to game XZ with the same equirectangular formula as geoToWorld
 * (src/core/auckland.ts). The data is © OpenStreetMap contributors, ODbL 1.0, and so is this derived file
 * (docs/CREDITS.md). One small gzip file (≈ 45 kB), fetched once per page load next to the LINZ data. When
 * it is missing the airfields fall back to the template layout (airbase.ts) on the real runways
 * (src/core/airfields.ts), so offline play and the tests keep working.
 *
 * Format (little-endian): 'AKLO' | u32 version | f32 quantum (m) | u32 strings | u32 features | varint
 * attribution string | strings (u8 length + UTF-8; string 0 is empty) | features: u8 layer, u8 flags
 * (bit 0 area, bit 1 paved, bit 2 fuel tank, bit 3 floating pier, bit 4 container crane), varint name, varint
 * ref (runway designators / ICAO), varint width (0.5 m; a building's height), varint vertex count, vertices.
 * Vertices are zig-zag varint deltas (in quanta) from the previous vertex written (the first from the origin).
 * Areas are outer rings, closed implicitly; points (berths, cranes, towers) have one vertex.
 */
import osmUrl from './data/auckland-osm.bin?url';
import { fetchMaybeGzip } from '../terrain/theaters/aucklandLinz';
import { AIRFIELDS, type AirfieldDef, type AirfieldId } from '../../core/airfields';

/** Resolved by Vite relative to the bundle (works from the game, the labs and the artifact build). */
export const OSM_URL: string = osmUrl;

// Layer ids: keep in sync with L in tools/osm/bake.py
export const OSM_AERODROME = 0;
export const OSM_RUNWAY = 1;
export const OSM_TAXIWAY = 2;
export const OSM_APRON = 3;
export const OSM_HANGAR = 4;
export const OSM_TERMINAL = 5;
export const OSM_TOWER = 6;
export const OSM_HELIPAD = 7;
export const OSM_PIER = 8;
export const OSM_BREAKWATER = 9;
export const OSM_MARINA = 10;
export const OSM_PORT = 11;
export const OSM_TANK = 12;
export const OSM_MILITARY = 13;
export const OSM_NAVAL = 14;
/** Derived: an aerodrome's levelled core (runway strips, taxiways, aprons, hangars), see bake.py. */
export const OSM_CORE = 15;
/** Dry docks (waterway=dock): Calliope Dock at Devonport. */
export const OSM_DOCK = 16;
/** Berths (seamark:type=berth), points with the berth's name. */
export const OSM_BERTH = 17;
/** Cranes (man_made=crane), points; `container` marks the Ports of Auckland quay cranes. */
export const OSM_CRANE = 18;
export const OSM_STADIUM = 19;
/** Sports pitches inside a stadium. */
export const OSM_PITCH = 20;
/** Buildings inside military / naval land (outside aerodromes); `width` holds the height (0 = unknown). */
export const OSM_BUILDING = 21;
/** Bridge outlines (man_made=bridge) longer than 600 m: the Harbour Bridge and the other big crossings. */
export const OSM_BRIDGE = 22;

export interface OsmFeature {
  layer: number;
  /** Outer ring (closed implicitly) rather than a line. */
  area: boolean;
  /** Sealed surface (asphalt, concrete, …). */
  paved: boolean;
  /** Storage tank holding fuel / oil / gas. */
  fuel: boolean;
  /** Floating pier (a pontoon). */
  floating: boolean;
  /** Container (ship-to-shore) crane. */
  container: boolean;
  name: string;
  /** Runway designators ("03/21"), or the ICAO code of an airfield core. */
  ref: string;
  /** Width (m), 0 when unknown (runways / taxiways get a default in the bake); a building's height. */
  width: number;
  /** Flat [x0, z0, x1, z1, ...] (m, game XZ). */
  pts: Float32Array;
}

export interface OsmData {
  /** "© OpenStreetMap contributors, ODbL 1.0. Data: <extract> (<timestamp>)". */
  attribution: string;
  features: OsmFeature[];
}

const MAGIC = 'AKLO';
const VERSION = 2;

let current: OsmData | null = null;
let version = 0;
const layouts = new Map<AirfieldId, AirfieldLayout | null>();

/** Decoded OSM data, or null when it has not been (or could not be) loaded. */
export function aucklandOsm(): OsmData | null {
  return current;
}

/** Changes whenever the installed data changes (cache key for derived data). */
export function aucklandOsmVersion(): number {
  return version;
}

/** Install decompressed bytes (null clears → hand-placed fallback). Throws on malformed data. */
export function setAucklandOsm(bytes: Uint8Array | null): void {
  current = bytes ? decodeOsm(bytes) : null;
  layouts.clear();
  version++;
}

/** Fetch, decompress and install the data; false (fallback kept) on any failure. */
export async function loadAucklandOsm(url = OSM_URL): Promise<boolean> {
  if (current) return true;
  try {
    setAucklandOsm(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] OSM Auckland data unavailable, using the template airfields', err);
    return false;
  }
}

const unzig = (z: number) => (z % 2 ? -(z + 1) / 2 : z / 2);

export function decodeOsm(bytes: Uint8Array): OsmData {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('bad OSM data header');
  const q = dv.getFloat32(8, true);
  const nStrings = dv.getUint32(12, true);
  const nFeatures = dv.getUint32(16, true);
  let o = 20;
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (o >= bytes.length) throw new Error('bad OSM data size');
      const b = bytes[o++];
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
  };
  const attr = varint();
  const dec = new TextDecoder();
  const strings: string[] = [];
  for (let i = 0; i < nStrings; i++) {
    const n = bytes[o++];
    strings.push(dec.decode(bytes.subarray(o, o + n)));
    o += n;
  }
  const str = (i: number) => {
    if (i >= strings.length) throw new Error('bad OSM string index');
    return strings[i];
  };
  let px = 0;
  let pz = 0;
  const features: OsmFeature[] = [];
  for (let f = 0; f < nFeatures; f++) {
    const layer = bytes[o++];
    const flags = bytes[o++];
    const name = str(varint());
    const ref = str(varint());
    const width = varint() / 2;
    const n = varint();
    const pts = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      px += unzig(varint());
      pz += unzig(varint());
      pts[i * 2] = px * q;
      pts[i * 2 + 1] = pz * q;
    }
    features.push({
      layer,
      area: (flags & 1) !== 0,
      paved: (flags & 2) !== 0,
      fuel: (flags & 4) !== 0,
      floating: (flags & 8) !== 0,
      container: (flags & 16) !== 0,
      name,
      ref,
      width,
      pts,
    });
  }
  if (o !== bytes.length) throw new Error('bad OSM data size');
  return { attribution: str(attr), features };
}

/** The installed features of one layer (empty without OSM data). */
export function osmLayer(layer: number): OsmFeature[] {
  return current ? current.features.filter((f) => f.layer === layer) : [];
}

/* ───────────────────────────── Airfield layouts ───────────────────────────── */

export interface OsmRunway {
  /** Designators, e.g. "03/21" (the first end is `a`). */
  ref: string;
  /** Threshold ends (m, game XZ): the centreline's first and last vertex. */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  width: number;
  paved: boolean;
  /** Full centreline (flat XZ). */
  pts: Float32Array;
}

export interface AirfieldLayout {
  id: AirfieldId;
  def: AirfieldDef;
  runways: OsmRunway[];
  /** Taxiway centrelines with their widths. */
  taxiways: OsmFeature[];
  aprons: OsmFeature[];
  hangars: OsmFeature[];
  terminals: OsmFeature[];
  /** Control towers (a point or a footprint). */
  towers: OsmFeature[];
  /** Fuel / storage tanks on the field. */
  tanks: OsmFeature[];
  /** The levelled core outline (flat XZ ring). */
  core: Float32Array;
  /** The aerodrome boundary (flat XZ ring). */
  boundary: Float32Array;
}

/** Even–odd point-in-ring test (flat XZ ring). */
export function pointInRing(ring: ArrayLike<number>, x: number, z: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const zi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const zj = ring[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance (m) from (x, z) to the nearest edge of a ring or polyline. */
export function distToPath(pts: ArrayLike<number>, x: number, z: number, closed: boolean): number {
  const n = pts.length / 2;
  if (n === 1) return Math.hypot(x - pts[0], z - pts[1]);
  let best = Infinity;
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % n;
    const ax = pts[i * 2];
    const az = pts[i * 2 + 1];
    const dx = pts[j * 2] - ax;
    const dz = pts[j * 2 + 1] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (d < best) best = d;
  }
  return best;
}

function centroidOf(pts: Float32Array): [number, number] {
  let sx = 0;
  let sz = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    sx += pts[i * 2];
    sz += pts[i * 2 + 1];
  }
  return [sx / n, sz / n];
}

/**
 * The real layout of one of the theatre's airfields (src/core/airfields.ts), or null without OSM data.
 * Everything within (or touching) the aerodrome boundary grown by 150 m belongs to it; the levelled core
 * is the derived outline carrying the airfield's ICAO code.
 */
export function airfieldLayout(id: AirfieldId): AirfieldLayout | null {
  if (!current) return null;
  if (layouts.has(id)) return layouts.get(id)!;
  const def = AIRFIELDS[id];
  const fs = current.features;
  const core = fs.find((f) => f.layer === OSM_CORE && f.ref === def.icao);
  const boundary = fs.find((f) => f.layer === OSM_AERODROME && (f.ref === def.icao || pointInRing(f.pts, def.x, def.z)));
  if (!core || !boundary) {
    layouts.set(id, null);
    return null;
  }
  const near = (f: OsmFeature) => {
    const [cx, cz] = centroidOf(f.pts);
    return pointInRing(boundary.pts, cx, cz) || distToPath(boundary.pts, cx, cz, true) < 150;
  };
  const of = (layer: number) => fs.filter((f) => f.layer === layer && near(f));
  const runways: OsmRunway[] = of(OSM_RUNWAY)
    .filter((f) => f.pts.length >= 4 && f.ref)
    .map((f) => {
      const n = f.pts.length;
      return { ref: f.ref, ax: f.pts[0], az: f.pts[1], bx: f.pts[n - 2], bz: f.pts[n - 1], width: f.width, paved: f.paved, pts: f.pts };
    });
  const layout: AirfieldLayout = {
    id,
    def,
    runways,
    taxiways: of(OSM_TAXIWAY),
    aprons: of(OSM_APRON),
    hangars: of(OSM_HANGAR),
    terminals: of(OSM_TERMINAL),
    towers: of(OSM_TOWER),
    tanks: of(OSM_TANK),
    core: core.pts,
    boundary: boundary.pts,
  };
  layouts.set(id, layout);
  return layout;
}
