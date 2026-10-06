/**
 * The Auckland Domain (Pukekawa), the park round the War Memorial Museum, measured from the LINZ 2024 LiDAR and aerial
 * and OpenStreetMap (tools/hero/sites/auckland_domain.py, baked by tools/hero/sites/domain_bake.py into
 * data/auckland-domain.bin; the format is in the bake's header). It is the base layer under the museum (core/museum.ts),
 * whose outline it keeps clear.
 *
 * Per park: its outline (the procedural street grid and houses stop on it: aucklandSites.ts siteRings), its buildings
 * (OSM outlines with their LiDAR roofs and the aerial's roof colour; the Wintergarden's Temperate and Tropical Houses
 * as barrel vaults) and every tree, one crown per LiDAR tree (TreeSource grows them in place of its own inside the park:
 * the aerial square otherwise keeps every tree off it). Without the file the Domain is what the terrain makes it: grass.
 * Sources: LINZ 2024 LiDAR and aerial (CC BY 4.0); © OpenStreetMap contributors (ODbL).
 */
import domainUrl from './data/auckland-domain.bin?url';
import { fetchMaybeGzip } from '../terrain/theaters/aucklandLinz';

export const DOMAIN_URL: string = domainUrl;

export interface DomainBuilding {
  /** 0 = a flat roof at `h`; 1 = a glasshouse: `ring` is its rectangle (first edge along the vault), eave `h`, ridge `ridge`. */
  kind: 0 | 1;
  /** Outline, flat [x0, z0, ...] (game m). */
  ring: Float32Array;
  /** Roof (or eave) height over the lowest ground in the outline (m). */
  h: number;
  /** A glasshouse's ridge over that ground (m); 0 for a flat roof. */
  ridge: number;
  /** Roof colour from the aerial (sRGB 0xRRGGBB). */
  roof: number;
}

export interface DomainTree {
  x: number;
  z: number;
  /** Height of its top over the ground (m). */
  h: number;
  /** Crown radius (m). */
  r: number;
  /** Crown base as a share of the height. */
  base: number;
  /** The aerial's colour over the crown (sRGB 0xRRGGBB). */
  colour: number;
}

export interface AucklandDomain {
  /** The park's outline, flat [x0, z0, ...] (game m). */
  park: Float32Array;
  buildings: DomainBuilding[];
  trees: DomainTree[];
}

const MAGIC = 'AKLD';
const VERSION = 1;

let current: AucklandDomain | null = null;

/** The decoded Domain, or null when it has not been (or could not be) loaded. */
export function aucklandDomain(): AucklandDomain | null {
  return current;
}

/** Install decompressed bytes (null clears). Throws on malformed data. */
export function setAucklandDomain(bytes: Uint8Array | null): void {
  current = bytes ? decodeDomain(bytes) : null;
}

export async function loadAucklandDomain(url = DOMAIN_URL): Promise<boolean> {
  if (current) return true;
  try {
    setAucklandDomain(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] Auckland Domain unavailable, the park stays grass', err);
    return false;
  }
}

export function decodeDomain(bytes: Uint8Array): AucklandDomain {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('bad Domain data header');
  const nPark = dv.getUint32(8, true);
  const nBuild = dv.getUint32(12, true);
  const nTrees = dv.getUint32(16, true);
  let o = 20;
  const xz = (n: number) => {
    if (o + n * 4 > bytes.length) throw new Error('bad Domain data size');
    const r = new Float32Array(n * 2);
    for (let i = 0; i < n * 2; i++, o += 2) r[i] = dv.getInt16(o, true) / 10;
    return r;
  };
  const park = xz(nPark);
  const buildings: DomainBuilding[] = [];
  for (let i = 0; i < nBuild; i++) {
    if (o + 2 > bytes.length) throw new Error('bad Domain data size');
    const kind = bytes[o] as 0 | 1;
    const n = bytes[o + 1];
    o += 2;
    const ring = xz(n);
    if (o + 7 > bytes.length) throw new Error('bad Domain data size');
    const a = dv.getUint16(o, true) / 100;
    const b = dv.getUint16(o + 2, true) / 100;
    const roof = (bytes[o + 4] << 16) | (bytes[o + 5] << 8) | bytes[o + 6];
    o += 7;
    buildings.push({ kind, ring, h: a, ridge: b, roof });
  }
  if (o + nTrees * 10 > bytes.length) throw new Error('bad Domain data size');
  const trees: DomainTree[] = [];
  for (let i = 0; i < nTrees; i++, o += 10) {
    trees.push({
      x: dv.getInt16(o, true) / 10,
      z: dv.getInt16(o + 2, true) / 10,
      h: bytes[o + 4] / 4,
      r: bytes[o + 5] / 10,
      base: bytes[o + 6] / 255,
      colour: (bytes[o + 7] << 16) | (bytes[o + 8] << 8) | bytes[o + 9],
    });
  }
  return { park, buildings, trees };
}
