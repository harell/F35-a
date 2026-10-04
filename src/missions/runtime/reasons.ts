/**
 * F35-A — mission end reasons (shown in the debrief) and helpers.
 */
export const REASONS = {
  success: 'All objectives complete',
  shot: 'Shot down',
  crash: 'Crashed',
  collision: 'Mid-air collision',
  fuel: 'Flamed out — out of fuel',
  ao: 'Left the area of operations',
  time: 'Out of time',
  aborted: 'Mission aborted',
  skytower: 'Destroyed the Sky Tower',
  /** Enemy hits brought the Sky Tower down (sim/landmarks.ts hitLandmark). */
  skytowerLost: 'The Sky Tower fell',
  /** The player flew into the Sky Tower (a 'structure' down reason, #113): no Auto-GCAS tip, it can't see buildings. */
  structure: 'Crashed into the Sky Tower',
  /** The player flew into a CBD skyscraper (a 'building' down reason, #128); the building collapsed. */
  building: 'Crashed into a building',
} as const;

/** The player flew into a named 3D-modelled landmark ("Crashed into Spark Arena"); it collapsed. */
export function crashedInto(name: string): string {
  return `Crashed into ${name}`;
}

/** "the Auckland Museum" → "The Auckland Museum" (a name at the start of a sentence). */
export function sentenceName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const DEATH_WORDS = ['shot down', 'crashed', 'collision', 'out of fuel'];

/** True if a result reason means the player died. */
export function isDeathReason(reason: string): boolean {
  const r = reason.toLowerCase();
  return DEATH_WORDS.some((w) => r.includes(w));
}
