/**
 * A protected asset lost: when the mission fails within ASSET_LOSS_WINDOW s of a friendly or civil loss
 * (the escorted tanker sunk, a defended group's last member), that entity's shot takes the target
 * camera's slot over everything for ASSET_LOSS_HOLD s, so the player sees how it was lost (Hud.ts,
 * pip.ts stepPip `asset`). The Sky Tower's collapse already has its own shot (pipLandmarkFocus) and
 * takes the same precedence.
 */

/** A loss this recent (s) before a failed 'mission:end' is the asset the mission failed on. */
export const ASSET_LOSS_WINDOW = 4;
/** The asset's shot stays up this long (s): past the failed mission's end delay (Game END_DELAY_FAILED). */
export const ASSET_LOSS_HOLD = 8;
