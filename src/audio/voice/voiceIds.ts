/**
 * F35-A audio — the list of voice clips (must cover every VoiceId in core/types.ts;
 * the Record<VoiceId, true> below fails to compile if one is missing or misspelt).
 */
import type { VoiceId } from '../../core/types';

const ALL: Record<VoiceId, true> = {
  b_missile: true,
  b_pull_up: true,
  b_altitude: true,
  b_bingo: true,
  b_fuel_low: true,
  b_engine_fire: true,
  b_warning: true,
  b_over_g: true,
  b_aoa: true,
  b_flares_low: true,
  b_chaff_low: true,
  b_hydraulics: true,
  b_speed: true,
  p_fox3: true,
  p_fox2: true,
  p_rifle: true,
  p_magnum: true,
  p_guns: true,
  p_splash: true,
  p_spike: true,
  p_mud_spike: true,
  p_defending: true,
  p_winchester: true,
  p_bingo: true,
  p_copy: true,
  p_engaged: true,
  p_target_destroyed: true,
  a_bandits: true,
  a_new_picture: true,
  a_sam_launch: true,
  a_good_kill: true,
  a_mission_complete: true,
  a_mission_failed: true,
  a_objective_complete: true,
  a_rtb: true,
  a_eject: true,
  a_friendly_down: true,
};

/** Every voice clip id (Betty first so the most important clips decode first). */
export const VOICE_IDS: readonly VoiceId[] = Object.keys(ALL) as VoiceId[];

export type VoiceChannel = 'betty' | 'radio';

/** Betty clips play on the ICAWS channel, pilot/AWACS clips on the radio channel. */
export function voiceChannel(id: VoiceId): VoiceChannel {
  return id.startsWith('b_') ? 'betty' : 'radio';
}

/** URL of a clip relative to the page (Vite `base: './'`). */
export function voiceUrl(id: VoiceId, base = './'): string {
  return `${base}audio/voice/${id}.mp3`;
}
