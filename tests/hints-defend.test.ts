/**
 * The MISSILE! defence prompt follows the shooter (runtime/hints.ts): a SAM's round gets the measured
 * SAM defence (beam it + CMS every 2–3 s; against the boat's heat-seeker a hard turn across it, CMS late),
 * a fighter's missile the older air-to-air advice (not measured against SAMs' numbers).
 */
import { describe, expect, it } from 'vitest';
import { mission, site } from '../src/missions/content/common';
import { harness } from './missions-helpers';
import { FlatTerrain } from './combat-helpers';

describe('the MISSILE! prompt', () => {
  it('a SAM round: "Beam it 90°, CMS every 2–3 s"', () => {
    const def = mission({
      id: 'fx_hint', kind: 'training', index: 9, title: 'x', subtitle: 'x', timeOfDay: 'day', weather: 'clear', briefing: ['x'],
      recommendedLoadout: 'a2a_stealth', allowedLoadouts: ['a2a_stealth'],
      player: { x: 8000, z: -13000, altitude: 2000, heading: 0, speed: 250 },
      script: {
        autoHints: true, awacs: { silent: true }, groups: [], ground: [], waypoints: [], triggers: [],
        sams: [site('boat', 'boats', 'ad_boat', { x: 8000, z: -20000 })],
        objectives: [{ id: 'o', kind: 'survive', seconds: 900, label: 'x', primary: true }],
      },
    });
    const h = harness(def, 'pilot', undefined, new FlatTerrain(0));
    const p = h.world.player!;
    const seen = new Set<string>();
    h.run(30, () => {
      p.health = p.maxHealth;
      if (p.incoming.length && h.runner.hint) seen.add(h.runner.hint);
    });
    expect([...seen]).toContain('MISSILE! Beam it 90°, CMS every 2–3 s');
    expect([...seen].some((t) => /dive/.test(t))).toBe(false);
  });
});
