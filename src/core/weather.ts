/**
 * F35-A — weather facts shared by the sim, missions, HUD and renderer (pure, no three.js).
 */
import type { Weather } from './types';

/** Overcast: base of the stratus deck (m MSL) and its coverage (0..1). */
export const OVERCAST_DECK = { altitude: 1800, cover: 0.985 } as const;

/** Base of the cloud deck that hides the ground (m MSL), or null when the weather has none. */
export function cloudBase(weather: Weather): number | null {
  return weather === 'overcast' ? OVERCAST_DECK.altitude : null;
}
