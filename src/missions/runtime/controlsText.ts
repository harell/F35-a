/**
 * F35-A — instructional text that follows the player's control settings (i2 review: "Left thumb
 * THROTTLE, right thumb STICK" was wrong for left-handed layouts and meaningless for tilt).
 * Mission/UI strings use the tokens {controls}, {throttleThumb} and {stickThumb}.
 */
import { loadSettings } from '../../core/settings';
import type { Settings } from '../../core/types';

type ControlPrefs = Pick<Settings, 'controlScheme' | 'leftHanded'>;

/** The current saved settings (defaults when storage is unavailable, e.g. node tests). */
export function currentControlPrefs(): ControlPrefs {
  try {
    const s = loadSettings();
    return { controlScheme: s.controlScheme, leftHanded: !!s.leftHanded };
  } catch {
    return { controlScheme: 'stick', leftHanded: false };
  }
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
