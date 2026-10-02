/**
 * MISSIONS — pacing (#59): no campaign mission goes quiet for more than 90 s. A dead stretch is mission
 * time with no radio call, HUD message, launch, kill or objective change (tests/missions-pacing.ts),
 * read from the bot's event log.
 * Measure any mission: npx vite-node tools/playtest/bot-sweep.ts -- --missions=<ids> --diffs=pilot --seeds=1 --log
 */
import { describe, expect, it } from 'vitest';
import { deadStretchText, deadStretches, longestDeadStretch, pacingEventTimes } from './missions-pacing';

describe('pacing: dead stretches in the bot event log (#59)', () => {
  const log = [
    '  0 OBJ o_a active',
    '  3 RADIO DARKSTAR: Viper 1, Darkstar. Picture clean.',
    '  5 BOT NAV pos=(0.0,0.0)km alt=6000',
    ' 10 RED Fulcrum 1:cap@40km/4m',
    ' 40 LAUNCH aim120 PLAYER -> Fulcrum 1 30.0km',
    ' 40 RADIO Viper 1: Fox Three',
    ' 75 DESTROYED Fulcrum 1 by PLAYER',
    ' 75 HUD SPLASH MIG-29',
    '100 MSL gbu39->2@3km v200 y4000',
    '150 BOT HOLD pos=(1.0,1.0)km alt=500',
    '200 OBJ o_a complete',
  ];

  it('counts radio, HUD messages, launches, kills and objective changes; the bot state lines do not break a stretch', () => {
    expect(pacingEventTimes(log)).toEqual([0, 3, 40, 40, 75, 75, 200]);
    expect(longestDeadStretch(log, 200)).toEqual({ from: 75, to: 200, length: 125 });
  });

  it('a silent opening and a silent tail are stretches too, and the list is longest first', () => {
    const quiet = log.slice(2); // no OBJ at 0, no radio at 3
    expect(deadStretches(quiet, 330).map((d) => [d.from, d.to])).toEqual([
      [200, 330],
      [75, 200],
      [0, 40],
      [40, 75],
    ]);
    expect(longestDeadStretch([], 95)).toEqual({ from: 0, to: 95, length: 95 });
    expect(longestDeadStretch([], 0).length).toBe(0);
    expect(deadStretchText(longestDeadStretch(log, 200))).toBe('125 s (75–200)');
  });
});
