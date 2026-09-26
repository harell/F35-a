/**
 * F35-A — environment handed to the flight model each step.
 */
import type { EventBus } from '../../core/events';
import type { DifficultyParams } from '../../core/types';
import type { TerrainQuery } from '../api';

export interface FlightEnv {
  terrain: TerrainQuery;
  difficulty: DifficultyParams;
  /** Event bus for 'transonic' and Auto-GCAS 'hud:message' (null in isolated tests). */
  events: EventBus | null;
  /** Sim time (s). */
  time: number;
}

/** Sub-step rate of the flight model (Hz). */
export const FM_RATE_HZ = 120;
