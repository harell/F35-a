/**
 * F35-A — MissionResult fields the debrief uses that are not (yet) in the core contract.
 * Orchestrator: fold these into MissionResult in src/core/contracts.ts.
 */
import type { MissionResult } from '../../core/contracts';

export interface TeamKill {
  /** "Viper 2", "Weasel 1"… */
  callsign: string;
  kills: number;
  /** In the player's own flight (these count against the player's share in the grade). */
  flight: boolean;
}

export type MissionResultExt = MissionResult & {
  /** Hostiles killed by friendly AI aircraft, most first. */
  teamKills?: TeamKill[];
  /** Player kills / (player kills + own-flight kills), 0..1. */
  playerShare?: number;
  /** Civil airliners the player shot down. */
  civilianKills?: number;
  /** The player brought the Sky Tower down this sortie (fall heading, rad): progress keeps the ruin. */
  skyTowerDown?: { fallHeading: number };
};
