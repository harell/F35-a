/**
 * F35-A — MissionResult fields the debrief uses that are not (yet) in the core contract.
 * Orchestrator: fold these into MissionResult in src/core/contracts.ts.
 */
import type { MissionResult } from '../../core/contracts';
import type { SightseeingStats } from './sightseeing';
import type { CostSummary } from './costs';

export interface TeamKill {
  /** "Viper 2"… */
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
  /** Civil traffic the player destroyed: airliners + ships. */
  civilianKills?: number;
  /** Of which civil ships (container ships, cruise liners). */
  civilianShipKills?: number;
  /** Of which civil helicopters (rescue, police, sightseeing). */
  civilianHeliKills?: number;
  /** Of which civil trains (AT passenger sets, KiwiRail freight). */
  civilianTrainKills?: number;
  /** Of which named superyachts (#145), by name ("Koru"). */
  civilianYachts?: string[];
  /** Protect objectives with a debrief tally: how many of the group survived ("Fuel tanks saved 7/9"). */
  saved?: { label: string; saved: number; total: number }[];
  /** Free flight: what the sightseer did (tour stops, distance, highest and lowest pass), shown instead of the combat stats. */
  sightseeing?: SightseeingStats;
  /** The sortie's cost against the mission's comparison (MissionScript.costSummary, g03). */
  costSummary?: CostSummary;
};
