/**
 * The briefing shows the threats of the difficulty being flown (playtest r2 2.1-b): on Pilot, g03
 * listed '2× SA-6 · 20 km' and 'SA-15 · 12 km' and mapped the Veteran-only airstrip SA-6 and the Tor
 * by Motuihe, so every way in looked covered; g02 mapped Veteran's third AD boat.
 */
import { describe, expect, it } from 'vitest';
import type { Difficulty } from '../src/core/types';
import { intelFor, missionById } from '../src/missions';
import { difficultyAtLeast } from '../src/missions/runtime/state';
import { knownThreats } from '../src/ui/screens/briefing';

const chips = (id: string, d: Difficulty) => knownThreats(intelFor(missionById(id)!, d)).map((t) => t.text);
const sams = (id: string, d: Difficulty) => intelFor(missionById(id)!, d).filter((i) => i.kind === 'sam').length;

describe('briefing intel follows the difficulty (playtest r2 2.1-b)', () => {
  it('g03 on Pilot lists one SA-6 and no SA-15; Veteran adds the Rakino SA-6 (no Tor since playtest r2, 2.3-a)', () => {
    const pilot = chips('g03', 'pilot');
    expect(pilot.filter((t) => t.includes('SA-6'))).toEqual([expect.stringMatching(/^SA-6 · \d+ km$/)]);
    expect(pilot.some((t) => t.includes('SA-15'))).toBe(false);
    expect(chips('g03', 'recruit')).toEqual(pilot);
    const vet = chips('g03', 'veteran');
    expect(vet.some((t) => /^2× SA-6 · /.test(t))).toBe(true);
    expect(vet.some((t) => t.startsWith('SA-15'))).toBe(false);
    expect(sams('g03', 'veteran') - sams('g03', 'pilot')).toBe(1);
  });

  it('g02 maps the third AD boat on Veteran only', () => {
    expect(sams('g02', 'veteran') - sams('g02', 'pilot')).toBe(1);
  });

  // playtest r3.1 (R31-7): Pilot listed 'AD · 12 km' though the wave-2 escort (ad2) comes later and
  // the harbour picket (ad_h) is there from the start
  it('g02 lists every AD boat of the difficulty, the wave-2 escort as a later one', () => {
    const g02 = missionById('g02')!;
    const boats = (d: Difficulty) => g02.script.sams.filter((x) => x.type === 'ad_boat' && difficultyAtLeast(d, x.minDifficulty)).length;
    for (const d of ['recruit', 'pilot', 'veteran'] as const) {
      expect(sams('g02', d), d).toBe(boats(d));
      const c = chips('g02', d).filter((t) => t.includes('AD'));
      expect(c, d).toContain('AD · 12 km · later');
      const now = c.find((t) => !t.endsWith('later'))!;
      expect(Number(now.match(/^(\d+)× /)?.[1] ?? 1), `${d}: ${JSON.stringify(c)}`).toBe(boats(d) - 1);
    }
    expect(intelFor(g02, 'pilot').filter((i) => i.later).map((i) => i.kind)).toEqual(['sam']);
  });

  it('a training lesson briefs its fixed Pilot whatever the setting', () => {
    expect(intelFor(missionById('t06')!, 'veteran')).toEqual(intelFor(missionById('t06')!, 'pilot'));
  });
});
