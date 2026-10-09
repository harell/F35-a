/**
 * The briefing shows the threats of the difficulty being flown (playtest r2 2.1-b): on Pilot, g03
 * listed '2× SA-6 · 20 km' and 'SA-15 · 12 km' and mapped the Veteran-only airstrip SA-6 and the Tor
 * by Motuihe, so every way in looked covered; g02 mapped Veteran's third AD boat.
 */
import { describe, expect, it } from 'vitest';
import type { Difficulty } from '../src/core/types';
import { intelFor, missionById } from '../src/missions';
import { knownThreats } from '../src/ui/screens/briefing';

const chips = (id: string, d: Difficulty) => knownThreats(intelFor(missionById(id)!, d)).map((t) => t.text);
const sams = (id: string, d: Difficulty) => intelFor(missionById(id)!, d).filter((i) => i.kind === 'sam').length;

describe('briefing intel follows the difficulty (playtest r2 2.1-b)', () => {
  it('g03 on Pilot lists one SA-6 and no SA-15; Veteran adds the airstrip SA-6 and the Tor', () => {
    const pilot = chips('g03', 'pilot');
    expect(pilot.filter((t) => t.includes('SA-6'))).toEqual([expect.stringMatching(/^SA-6 · \d+ km$/)]);
    expect(pilot.some((t) => t.includes('SA-15'))).toBe(false);
    expect(chips('g03', 'recruit')).toEqual(pilot);
    const vet = chips('g03', 'veteran');
    expect(vet.some((t) => /^2× SA-6 · /.test(t))).toBe(true);
    expect(vet.some((t) => t.startsWith('SA-15'))).toBe(true);
    expect(sams('g03', 'veteran') - sams('g03', 'pilot')).toBe(2);
  });

  it('g02 maps the third AD boat on Veteran only', () => {
    expect(sams('g02', 'veteran') - sams('g02', 'pilot')).toBe(1);
  });

  it('a training lesson briefs its fixed Pilot whatever the setting', () => {
    expect(intelFor(missionById('t06')!, 'veteran')).toEqual(intelFor(missionById('t06')!, 'pilot'));
  });
});
