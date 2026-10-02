/**
 * F35-A — instructional text that follows the player's control settings (i2 review: "Left thumb
 * THROTTLE, right thumb STICK" was wrong for left-handed layouts and meaningless for tilt).
 * Mission/UI strings use the tokens {controls}, {throttleThumb} and {stickThumb}.
 *
 * The text follows the scheme the player is actually flying, not only the saved one: when tilt is
 * chosen but no orientation data arrives, Input falls back to the touch stick, and Game reports that
 * here every frame (followActiveScheme), so the hints describe the stick from then on (playtest
 * 2026-10-02, 4.2-b).
 */
import { loadSettings } from '../../core/settings';
import type { ControlScheme, Settings } from '../../core/types';

type ControlPrefs = Pick<Settings, 'controlScheme' | 'leftHanded'>;

/** The toast shown when tilt steering falls back to the touch stick. */
export const TILT_UNAVAILABLE_TOAST = 'Tilt unavailable, using the stick';

/** The scheme Input is flying when it differs from the saved one (null = the saved scheme). */
let activeOverride: ControlScheme | null = null;
let overrideVersion = 0;

/**
 * Game calls this with the saved scheme and the one Input is actually flying (InputApi.activeScheme).
 * Returns the toast to show when tilt has just fallen back to the stick, else null.
 */
export function followActiveScheme(saved: ControlScheme, active: ControlScheme): string | null {
  const override = active !== saved ? active : null;
  if (override === activeOverride) return null;
  activeOverride = override;
  overrideVersion++;
  return saved === 'tilt' && override === 'stick' ? TILT_UNAVAILABLE_TOAST : null;
}

/** Bumped whenever the live scheme changes (texts formatted before it are stale). */
export function controlPrefsVersion(): number {
  return overrideVersion;
}

/** These prefs with the scheme Input is actually flying. */
export function withActiveScheme(p: ControlPrefs): ControlPrefs {
  return activeOverride && activeOverride !== p.controlScheme ? { controlScheme: activeOverride, leftHanded: p.leftHanded } : p;
}

/** The saved control settings (defaults when storage is unavailable, e.g. node tests). */
export function savedControlPrefs(): ControlPrefs {
  try {
    const s = loadSettings();
    return { controlScheme: s.controlScheme, leftHanded: !!s.leftHanded };
  } catch {
    return { controlScheme: 'stick', leftHanded: false };
  }
}

/** The current control prefs: the saved settings, with the scheme Input is actually flying. */
export function currentControlPrefs(): ControlPrefs {
  return withActiveScheme(savedControlPrefs());
}

/** Fill {controls} / {throttleThumb} / {stickThumb} for these control prefs. */
export function formatControls(text: string, p: ControlPrefs): string {
  if (text.indexOf('{') < 0) return text;
  const throttle = p.leftHanded ? 'right' : 'left';
  const stick = p.leftHanded ? 'left' : 'right';
  const tilt = p.controlScheme === 'tilt';
  const controls = tilt ? `Tilt the phone to fly, ${throttle} thumb THROTTLE` : `${cap(throttle)} thumb THROTTLE, ${stick} thumb STICK`;
  return text
    .replace(/\{controls\}/g, controls)
    .replace(/\{throttleThumb\}/g, throttle)
    .replace(/\{stickThumb\}/g, tilt ? 'tilting the phone' : `${stick} thumb`);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
