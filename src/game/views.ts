/**
 * F35-A — the view a sortie starts in and returns to (after the padlock or missile camera).
 *
 * Free flight (A Stroll in the Park, #113) starts in chase view: at sightseeing heights the cockpit's
 * coaming and PCD hide the city below the horizon. A view the player picks during a free flight
 * (cockpit, HUD or chase) is kept for the next free flight in the same game session.
 */
import type { CameraMode, Settings } from '../core/types';

export type HomeView = Settings['defaultView'];

/** The views a player can pick as the one to fly in. */
export function isHomeView(mode: CameraMode): mode is HomeView {
  return mode === 'cockpit' || mode === 'hud' || mode === 'chase';
}

/** A sortie's home view: free flight's (chase, or the one the player picked in one), else the settings' default. */
export function sortieHomeView(freeFlight: boolean, defaultView: HomeView, picked: HomeView | null): HomeView {
  return freeFlight ? (picked ?? 'chase') : defaultView;
}
