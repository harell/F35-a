/**
 * Ports of Auckland's container stacks as the LINZ 2024 LiDAR found them (CC BY 4.0): every stack 1.8–17 m over the
 * deck inside the OSM port outline, gridded at 1 m in its own orientation, quantised to 2.6 m tiers and merged into
 * blocks of equal tier, each coloured with the 2024 aerial's mean over it (tools/hero/sites/ports_of_auckland.py; blocks
 * under 6 m² dropped, 82 % of the stacked area kept). The cranes and masts are in core/portOfAuckland.ts.
 *
 * src/world/scenery/data/auckland-port.bin (≈ 55 kB gzip), fetched once per page load next to the other Auckland data.
 * Without it the port keeps its procedural stacks (aucklandSites.ts buildRealPort).
 *
 * Format (little-endian): 'AKLP' | u32 version | u32 count | u32 record size (15) | records: i16 x, i16 z (0.1 m, game
 * XZ centre), u16 w, u16 d (cm, along and across the block's axis), u16 angle (axis from +X towards +Z, 0..π as
 * 0..65535), u8 tiers, u8 r, g, b (sRGB), u8 base (0.1 m above the datum, the LiDAR's deck).
 */
import portUrl from './data/auckland-port.bin?url';
import { fetchMaybeGzip } from '../terrain/theaters/aucklandLinz';

export const PORT_URL: string = portUrl;

export interface ContainerStack {
  x: number;
  z: number;
  /** Size along the block's axis and across it (m). */
  w: number;
  d: number;
  /** The axis's angle from +X towards +Z (rad). */
  angle: number;
  tiers: number;
  /** Colour (sRGB 0..255 packed 0xRRGGBB) from the aerial. */
  color: number;
}

const MAGIC = 'AKLP';
const VERSION = 1;

let current: ContainerStack[] | null = null;
let version = 0;

/** Decoded stacks, or null when they have not been (or could not be) loaded. */
export function aucklandPortStacks(): ContainerStack[] | null {
  return current;
}

export function aucklandPortVersion(): number {
  return version;
}

/** Install decompressed bytes (null clears → procedural stacks). Throws on malformed data. */
export function setAucklandPort(bytes: Uint8Array | null): void {
  current = bytes ? decodePort(bytes) : null;
  version++;
}

export async function loadAucklandPort(url = PORT_URL): Promise<boolean> {
  if (current) return true;
  try {
    setAucklandPort(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] Ports of Auckland stacks unavailable, using procedural stacks', err);
    return false;
  }
}

export function decodePort(bytes: Uint8Array): ContainerStack[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('bad port data header');
  const n = dv.getUint32(8, true);
  const size = dv.getUint32(12, true);
  if (size < 15 || 16 + n * size > bytes.length) throw new Error('bad port data size');
  const out: ContainerStack[] = [];
  for (let i = 0, o = 16; i < n; i++, o += size) {
    out.push({
      x: dv.getInt16(o, true) / 10,
      z: dv.getInt16(o + 2, true) / 10,
      w: dv.getUint16(o + 4, true) / 100,
      d: dv.getUint16(o + 6, true) / 100,
      angle: (dv.getUint16(o + 8, true) / 65535) * Math.PI,
      tiers: bytes[o + 10],
      color: (bytes[o + 11] << 16) | (bytes[o + 12] << 8) | bytes[o + 13],
    });
  }
  return out;
}
