/**
 * The corridor's streamed tiles as the game ships them (#126): the bundled manifest
 * (src/world/terrain/data/corridor/corridor.json) and each tile's URL (Vite hashes the files; the service worker caches
 * them on first use and never precaches them: public/sw.js ON_DEMAND). See corridorHouses.ts.
 */
import manifestJson from '../terrain/data/corridor/corridor.json';
import { fetchMaybeGzip } from '../terrain/theaters/aucklandLinz';
import { CorridorHouses, type CorridorManifest } from './corridorHouses';

const files = import.meta.glob('../terrain/data/corridor/*.bin', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** Tile key `${i}_${j}` → URL. */
export const CORRIDOR_URLS: ReadonlyMap<string, string> = new Map(
  Object.entries(files).flatMap(([p, url]) => {
    const m = /akl-corridor-(-?\d+)_(-?\d+)\.bin$/.exec(p);
    return m ? [[`${m[1]}_${m[2]}`, url] as [string, string]] : [];
  }),
);

export const CORRIDOR_MANIFEST = manifestJson as unknown as CorridorManifest;

/**
 * Margins (m) past the house scatter's radius: a tile is fetched when its square comes within radius + FETCH_AHEAD of the
 * camera (≈ 6 s ahead at 500 kt, so a tile has usually landed before its houses would be drawn), and dropped past
 * radius + KEEP_PAST.
 */
export const FETCH_AHEAD = 1500;
export const KEEP_PAST = 6000;

/** The corridor's stream for a house scatter of `houseRadius` m, or null when no tiles shipped. */
export function createCorridorHouses(houseRadius: number): CorridorHouses | null {
  if (!CORRIDOR_MANIFEST.tiles?.length || !CORRIDOR_URLS.size) return null;
  return new CorridorHouses(
    CORRIDOR_MANIFEST,
    (i, j) => {
      const url = CORRIDOR_URLS.get(`${i}_${j}`);
      return url ? fetchMaybeGzip(url) : Promise.reject(new Error('no such tile'));
    },
    { fetchRadius: houseRadius + FETCH_AHEAD, keepRadius: houseRadius + KEEP_PAST, maxInFlight: 2 },
  );
}
