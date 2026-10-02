/**
 * HUD and menu readability at 844×390 (issue #62, polish 4/5 of epic #84):
 *  - Defend: the strikers carry a STRK tag on every display (contacts, target box, TSD, tactical map),
 *    the escort doesn't, and the primary objective counts the strikers left ("STRIKERS n").
 */
import { describe, expect, it } from 'vitest';
import type { MissionDef } from '../src/core/contracts';
import { buildInstantMissionSeeded } from '../src/missions';
import { entityLabel, trackLabel, trackShort } from '../src/hud/hmd/format';
import { objectiveLines } from '../src/hud/hmd/overlays';
import { harness, killGroup } from './missions-helpers';

const defend = (enemyCount = 6): MissionDef =>
  buildInstantMissionSeeded({ mode: 'defend', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'su27', enemyCount }, 62);

describe('Defend: the strikers can be told from the escort', () => {
  it('tags the strikers STRK and leaves the escort untagged, even when both fly the Su-27', () => {
    const h = harness(defend());
    const strikers = h.world.aircraft.filter((a) => a.groupId === 'strikers');
    const escort = h.world.aircraft.filter((a) => a.groupId === 'escort');
    expect(strikers.length).toBeGreaterThanOrEqual(2);
    expect(escort.length).toBeGreaterThanOrEqual(1);
    for (const s of strikers) {
      expect(s.hudTag).toBe('STRK');
      expect(trackLabel(s)).toBe(entityLabel(s) + ' STRK');
      expect(trackShort(s)).toBe('STRK');
    }
    for (const e of escort) {
      expect(e.hudTag).toBeUndefined();
      expect(trackLabel(e)).toBe(entityLabel(e));
      expect(trackShort(e)).not.toBe('STRK');
    }
    // the same label string every frame (no per-frame allocation)
    expect(trackLabel(strikers[0])).toBe(trackLabel(strikers[1]));
  });

  it('counts the strikers left on the primary objective line', () => {
    const h = harness(defend());
    h.runner.update(h.world, 0.1);
    const o = h.runner.objectives.find((x) => x.id === 'o_tanks')!;
    const strikers = h.world.aircraft.filter((a) => a.groupId === 'strikers');
    expect(o.primary).toBe(true);
    expect(o.threat).toEqual({ label: 'Strikers', left: strikers.length });
    const before = objectiveLines(o, 30);
    expect(before.join(' ')).toContain('STRIKERS ' + strikers.length);
    // one striker splashed: the count drops
    h.world.applyDamage(strikers[0], 1e6, h.world.player!.id, 'aim120');
    h.runner.update(h.world, 0.1);
    expect(o.threat?.left).toBe(strikers.length - 1);
    expect(objectiveLines(o, 30).join(' ')).toContain('STRIKERS ' + (strikers.length - 1));
    // the escort doesn't count
    killGroup(h, 'escort');
    h.runner.update(h.world, 0.1);
    expect(o.threat?.left).toBe(strikers.length - 1);
  });

  it('shows the count only while the objective is active', () => {
    const lines = objectiveLines({ label: 'Keep the tanks standing', state: 'complete', progress: { done: 9, total: 9 }, threat: { label: 'Strikers', left: 0 } }, 30);
    expect(lines.join(' ')).not.toContain('STRIKERS');
  });
});
