/**
 * LINZ road centrelines for the Auckland theatre (phase 2a: the real CBD street layout).
 *
 * src/world/terrain/data/auckland-roads.bin is baked offline by tools/linz/roads.ts (and the railways by
 * tools/linz/railways.ts) from Toitū Te Whenua LINZ open data (CC BY 4.0): NZ Addresses road sections
 * (layer 123109), Topo50 railway centrelines (layer 50319) and tunnel centrelines (layer 50366),
 * reprojected to game XZ with geoToWorld (src/core/auckland.ts). It holds
 *  - every street inside the CBD region (painted by the terrain shader, see cbdStreets.ts): the CBD, and west of it
 *    Herne Bay and Westhaven, whose buildings and trees are measured models (aucklandNeighbourhoods.ts),
 *  - the motorway carriageways of the whole theatre (road ribbons, motorways.ts),
 *  - the main arterials and the streets round the stadiums outside the region (road ribbons),
 *  - the railway lines (kind ROAD_RAIL, ballast-and-track ribbons, width = the formation),
 *  - the CBD region polygon: the area that uses the real streets instead of the procedural grid.
 *    Its border runs along Jervois Rd / Shelly Beach Rd, the SH1 / SH16 carriageways, Stanley St /
 *    Beach Rd and out into the harbour, so the hand-over to the procedural suburbs happens under a motorway, not across a block.
 * One small gzip file (≈ 40 kB), fetched once per page load next to the LINZ terrain. When it is
 * missing the theatre falls back to the hand-traced motorways and the procedural CBD grid.
 *
 * Format (little-endian): 'AKLR' | u32 version | f32 quantum (m) | u32 names | u32 lines | u32 region
 * vertices | names (u8 length + UTF-8) | region vertices | lines: varint name, u8 kind, u8 width
 * (0.5 m units), u8 flags (bit 0 = tunnel), varint vertex count, vertices. Vertices are zig-zag varint
 * deltas (in quanta) from the previous vertex written (the first from the origin).
 */
import roadsUrl from '../terrain/data/auckland-roads.bin?url';
import { fetchMaybeGzip } from '../terrain/theaters/aucklandLinz';

/** Resolved by Vite relative to the bundle (works from the game, the labs and the artifact build). */
export const ROADS_URL: string = roadsUrl;

export const ROAD_STREET = 0;
export const ROAD_MOTORWAY = 1;
export const ROAD_ARTERIAL = 2;
/** Railway lines (Topo50 railway centrelines, baked by tools/linz/railways.ts). */
export const ROAD_RAIL = 3;
export type RoadKind = typeof ROAD_STREET | typeof ROAD_MOTORWAY | typeof ROAD_ARTERIAL | typeof ROAD_RAIL;

export interface RoadLine {
  name: string;
  kind: RoadKind;
  /** Carriageway width, kerb to kerb (m). */
  width: number;
  tunnel: boolean;
  /** Flat [x0, z0, x1, z1, ...] (m, game XZ). */
  pts: Float32Array;
}

export interface RoadData {
  /** CBD region polygon, flat [x0, z0, ...] (m), closed implicitly. */
  region: Float32Array;
  lines: RoadLine[];
}

const MAGIC = 'AKLR';
const VERSION = 1;

let current: RoadData | null = null;
let version = 0;

/** Decoded road data, or null when it has not been (or could not be) loaded. */
export function aucklandRoads(): RoadData | null {
  return current;
}

/** Changes whenever the installed data changes (cache key for derived data). */
export function aucklandRoadsVersion(): number {
  return version;
}

/** Install decompressed bytes (null clears → hand-traced fallback). Throws on malformed data. */
export function setAucklandRoads(bytes: Uint8Array | null): void {
  current = bytes ? decodeRoads(bytes) : null;
  version++;
}

/** Fetch, decompress and install the data; false (fallback kept) on any failure. */
export async function loadAucklandRoads(url = ROADS_URL): Promise<boolean> {
  if (current) return true;
  try {
    setAucklandRoads(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] LINZ Auckland roads unavailable, using the hand-traced roads', err);
    return false;
  }
}

class Writer {
  private buf = new Uint8Array(1 << 16);
  len = 0;
  private grow(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  u8(v: number): void {
    this.grow(1);
    this.buf[this.len++] = v;
  }
  u32(v: number): void {
    this.grow(4);
    new DataView(this.buf.buffer).setUint32(this.len, v, true);
    this.len += 4;
  }
  f32(v: number): void {
    this.grow(4);
    new DataView(this.buf.buffer).setFloat32(this.len, v, true);
    this.len += 4;
  }
  varint(v: number): void {
    do {
      let b = v % 128;
      v = Math.floor(v / 128);
      if (v > 0) b |= 128;
      this.u8(b);
    } while (v > 0);
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const zig = (v: number) => (v < 0 ? -2 * v - 1 : 2 * v);
const unzig = (z: number) => (z % 2 ? -(z + 1) / 2 : z / 2);

/** Encode road data (quantised to `quantum` m). Used by the bake and the tests. */
export function encodeRoads(d: RoadData, quantum = 0.5): Uint8Array {
  const w = new Writer();
  for (const c of MAGIC) w.u8(c.charCodeAt(0));
  w.u32(VERSION);
  w.f32(quantum);
  const names: string[] = [];
  const nameIdx = new Map<string, number>();
  for (const l of d.lines) if (!nameIdx.has(l.name)) nameIdx.set(l.name, names.push(l.name) - 1);
  w.u32(names.length);
  w.u32(d.lines.length);
  w.u32(d.region.length / 2);
  const enc = new TextEncoder();
  for (const n of names) {
    const b = enc.encode(n).subarray(0, 255);
    w.u8(b.length);
    for (const c of b) w.u8(c);
  }
  let px = 0;
  let pz = 0;
  const pts = (a: Float32Array) => {
    for (let i = 0; i < a.length; i += 2) {
      const qx = Math.round(a[i] / quantum);
      const qz = Math.round(a[i + 1] / quantum);
      w.varint(zig(qx - px));
      w.varint(zig(qz - pz));
      px = qx;
      pz = qz;
    }
  };
  pts(d.region);
  for (const l of d.lines) {
    w.varint(nameIdx.get(l.name)!);
    w.u8(l.kind);
    w.u8(Math.max(1, Math.min(255, Math.round(l.width * 2))));
    w.u8(l.tunnel ? 1 : 0);
    w.varint(l.pts.length / 2);
    pts(l.pts);
  }
  return w.bytes();
}

export function decodeRoads(bytes: Uint8Array): RoadData {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('bad LINZ roads header');
  const q = dv.getFloat32(8, true);
  const nNames = dv.getUint32(12, true);
  const nLines = dv.getUint32(16, true);
  const nRegion = dv.getUint32(20, true);
  let o = 24;
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (o >= bytes.length) throw new Error('bad LINZ roads size');
      const b = bytes[o++];
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
  };
  const dec = new TextDecoder();
  const names: string[] = [];
  for (let i = 0; i < nNames; i++) {
    const n = bytes[o++];
    names.push(dec.decode(bytes.subarray(o, o + n)));
    o += n;
  }
  let px = 0;
  let pz = 0;
  const pts = (n: number) => {
    const a = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      px += unzig(varint());
      pz += unzig(varint());
      a[i * 2] = px * q;
      a[i * 2 + 1] = pz * q;
    }
    return a;
  };
  const region = pts(nRegion);
  const lines: RoadLine[] = [];
  for (let i = 0; i < nLines; i++) {
    const name = names[varint()];
    const kind = bytes[o++] as RoadKind;
    const width = bytes[o++] / 2;
    const tunnel = (bytes[o++] & 1) === 1;
    const n = varint();
    lines.push({ name, kind, width, tunnel, pts: pts(n) });
  }
  if (o !== bytes.length) throw new Error('bad LINZ roads size');
  return { region, lines };
}
