/**
 * Night glow of the lit ground in the terrain shader (linear emissive, × uNight): the suburbs'
 * street lamps and lit windows (urbanPattern) and the CBD's lit streets (cbdPattern). The numbers
 * are templated into the GLSL, and `cbdNightGlow` is the CBD's formula on the CPU (same terms as the
 * shader's), so a test can average it over the real street map.
 *
 * The CBD (#61 item 6) used to glow only from its lit shopfronts up close and an area-average glow
 * from afar, faded out and in over different ranges: between 3 and 18 m/px (looking at the city
 * from a few hundred metres up) the ground under the towers dropped to about a tenth of the
 * suburbs' glow, a dark disc in the lit city. Now the streets themselves are lit (the lamp posts are
 * buildCBD's fixtures; this is their light on the carriageways and footpaths), every term is
 * weighted by the share of the pixel footprint it covers, and the far constant is the near
 * pattern's measured average, so the glow holds steady at every range and is brighter than the
 * suburbs'.
 */
import { FOOTPATH } from '../scenery/cbdStreets';

export const NIGHT_GLOW = {
  /** Suburbs: area-average street-lamp glow, × (0.6 + 0.8 · block hash) · (0.6 + 0.5 · density). */
  suburbLamps: 0.06,
  /** Warm haze of lit ground beyond ~12 m/px (suburbs: × density; CBD: × 1). */
  haze: 0.03,
  /** CBD: a lamp-lit carriageway or footpath (× the street's share of the footprint). */
  cbdStreet: 0.32,
  /** CBD: shop windows lighting the footpath and the first 2 m of the frontage (about half the frontages). */
  cbdShop: 0.15,
  /** CBD: a floodlit plaza or car park (a fifth of the block-interior patches). */
  cbdPlaza: 0.1,
  /** CBD: the far constant, × (1 − 0.8 · park): the near pattern's average over the real streets. */
  cbdAvg: 0.082,
} as const;

/** Suburbs' far glow at full density with an average block hash (lamps + haze). */
export function suburbFarGlow(): number {
  return NIGHT_GLOW.suburbLamps * 1.0 * 1.1 + NIGHT_GLOW.haze;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Means of the shop and plaza hashes over the 9 m patches (what the hashed terms blend to with range). */
export const CBD_SHOP_LIT = 0.47;
export const CBD_PLAZA_LIT = 0.197;

/**
 * The CBD's night glow (before the light colour and uNight) at kerb distance `kerb` (m, + off the
 * street), park coverage `park`, footprint `mpp` (m / px), and the 9 m patch hash `h` (0–1). With
 * `average` the patch hashes are replaced by their means (what the far glow has to match). Same terms
 * as cbdPattern's night block in terrainShader.ts.
 */
export function cbdNightGlow(kerb: number, park: number, mpp: number, h: number, average = false): number {
  const w = Math.max(mpp, 1);
  const roadCov = clamp01((w * 0.5 - kerb) / w);
  const streetCov = clamp01((w * 0.5 + FOOTPATH - kerb) / w);
  const frontCov = clamp01((w * 0.5 + FOOTPATH + 2 - kerb) / w);
  const pool = 0.7 + 0.45 * (1 - smoothstep(0, 7, -kerb));
  const kerbPool = pool + (1 - pool) * smoothstep(2, 8, mpp);
  const blend = average ? 1 : smoothstep(4, 12, mpp);
  const fract = (x: number) => x - Math.floor(x);
  const shopLit = (fract(h * 5.3) >= 0.5 ? 1 : 0) * (1 - blend) + CBD_SHOP_LIT * blend;
  const plazaLit = (h < 0.45 && fract(h * 7.9) >= 0.5 ? 1 : 0) * (1 - blend) + CBD_PLAZA_LIT * blend;
  const near =
    streetCov * kerbPool * NIGHT_GLOW.cbdStreet +
    ((frontCov - roadCov) * shopLit * NIGHT_GLOW.cbdShop + (1 - frontCov) * plazaLit * NIGHT_GLOW.cbdPlaza) * (1 - park);
  const far = NIGHT_GLOW.cbdAvg * (1 - 0.8 * park);
  return near + (far - near) * smoothstep(24, 60, mpp) + NIGHT_GLOW.haze * smoothstep(4, 12, mpp);
}
