import { describe, expect, it } from 'vitest';
import type { CampaignProgress, MissionDef } from '../src/core/contracts';
import { LOADOUTS } from '../src/core/data';
import { placeStores } from '../src/ui/art/storesDiagram';
import { formatPercent, formatScore, formatTime, gradeTone, missionState, niceScaleLength, stealthRating, storeLines, suggestedMissionIndex } from '../src/ui/format';
import { fitIntelView, intelBounds } from '../src/ui/screens/intelMap';
import { CAMPAIGNS, PLAYABLE_CAMPAIGNS, TRAINING } from '../src/missions';

/** The first playable campaign's missions (the IRGC campaign: g01–g03). */
const CAMPAIGN = PLAYABLE_CAMPAIGNS[0].missions;

describe('formatting', () => {
  it('formats times', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(59.9)).toBe('0:59');
    expect(formatTime(367.4)).toBe('6:07');
    expect(formatTime(3723)).toBe('1:02:03');
    expect(formatTime(-5)).toBe('0:00');
  });

  it('formats scores and percentages', () => {
    expect(formatScore(0)).toBe('0');
    expect(formatScore(12345.6)).toBe('12,346');
    expect(formatScore(1234567)).toBe('1,234,567');
    expect(formatScore(-1500)).toBe('-1,500');
    expect(formatPercent(0.778)).toBe('78%');
    expect(formatPercent(NaN)).toBe('—');
    expect(formatPercent(3)).toBe('100%');
  });

  it('grade tones', () => {
    expect(gradeTone('S')).toBe('gold');
    expect(gradeTone('A')).toBe('good');
    expect(gradeTone('F')).toBe('bad');
  });

  it('nice scale-bar lengths', () => {
    expect(niceScaleLength(100, 100)).toBe(10_000);
    expect(niceScaleLength(35, 100)).toBe(5_000);
    expect(niceScaleLength(12, 100)).toBe(1_000);
  });
});

describe('loadouts', () => {
  it('stealth rating: clean is best, beast mode is poor, monotonic in RCS', () => {
    expect(stealthRating(1)).toBe(1);
    expect(stealthRating(1.2)).toBeGreaterThan(0.9);
    expect(stealthRating(40)).toBeLessThan(0.35);
    expect(stealthRating(60)).toBeLessThan(stealthRating(40));
    expect(stealthRating(1e9)).toBeGreaterThanOrEqual(0.05);
  });

  it('store lines merge weapons and keep bay/pylon apart', () => {
    const lines = storeLines(LOADOUTS.a2a_beast, { aim120: 'AIM-120D', aim9x: 'AIM-9X' });
    expect(lines).toEqual([
      { text: '4× AIM-120D', internal: true },
      { text: '2× AIM-120D', internal: false },
      { text: '2× AIM-9X', internal: false },
    ]);
  });

  it('store diagrams are symmetric and show every store pair', () => {
    for (const l of Object.values(LOADOUTS)) {
      const placed = placeStores(l);
      const pairs = l.stores.reduce((n, s) => n + Math.ceil(s.count / 2), 0);
      expect(placed.length, l.id).toBe(pairs * 2);
      const sum = placed.reduce((a, p) => a + p.x, 0);
      expect(Math.abs(sum), l.id).toBeLessThan(1e-9);
      // internal stores stay inside the fuselage, external ones out on the wings
      for (const p of placed) {
        if (p.internal) expect(Math.abs(p.x), l.id).toBeLessThan(1.4);
        else expect(Math.abs(p.x), l.id).toBeGreaterThan(2);
      }
    }
  });
});

describe('mission cards', () => {
  // first sortie: g01 open, g02 locked; after a g01 win: g01 done, g02 open
  const fresh: CampaignProgress = {
    unlocked: ['g01'],
    best: {},
    totals: { missions: 0, airKills: 0, groundKills: 0, deaths: 0 },
  };
  const progress: CampaignProgress = {
    unlocked: ['g01', 'g02'],
    best: { g01: { score: 1000, grade: 'B', difficulty: 'pilot' } },
    totals: { missions: 1, airKills: 2, groundKills: 0, deaths: 0 },
  };

  it('locked / open / done states', () => {
    expect(CAMPAIGN.map((m) => m.id)).toEqual(['g01', 'g02', 'g03']);
    expect(missionState(CAMPAIGN[0], fresh)).toBe('open');
    expect(missionState(CAMPAIGN[1], fresh)).toBe('locked');
    expect(missionState(CAMPAIGN[0], progress)).toBe('done');
    expect(missionState(CAMPAIGN[1], progress)).toBe('open');
    // training is always open
    expect(missionState(TRAINING[0], fresh)).toBe('open');
  });

  it('suggests the first open mission', () => {
    expect(suggestedMissionIndex(CAMPAIGN, fresh)).toBe(0);
    expect(suggestedMissionIndex(CAMPAIGN, progress)).toBe(1);
    const all: CampaignProgress = { ...progress, unlocked: CAMPAIGN.map((m) => m.id), best: Object.fromEntries(CAMPAIGN.map((m) => [m.id, { score: 1, grade: 'A' as const, difficulty: 'pilot' as const }])) };
    expect(suggestedMissionIndex(CAMPAIGN, all)).toBe(CAMPAIGN.length - 1);
  });
});

describe('intel map framing', () => {
  const missions: MissionDef[] = [...CAMPAIGNS.flatMap((c) => c.missions), ...TRAINING];

  it('contains the start, every waypoint and every marker', () => {
    for (const m of missions) {
      const b = intelBounds(m);
      const inB = (x: number, z: number) => x >= b.minX - 1 && x <= b.maxX + 1 && z >= b.minZ - 1 && z <= b.maxZ + 1;
      expect(inB(m.player.x, m.player.z), m.id).toBe(true);
      for (const i of m.intel) expect(inB(i.x, i.z), `${m.id} ${i.label}`).toBe(true);
      expect(b.maxX - b.minX).toBeGreaterThanOrEqual(24_000);
    }
  });

  it('fits the bounds into the canvas keeping the aspect ratio', () => {
    const b = { minX: -10_000, maxX: 30_000, minZ: -5_000, maxZ: 5_000 };
    const v = fitIntelView(b, 400, 300, 0.1);
    const px = (x: number) => (x - v.x0) * v.scale;
    const pz = (z: number) => (z - v.z0) * v.scale;
    expect(px(b.minX)).toBeGreaterThan(0);
    expect(px(b.maxX)).toBeLessThan(400);
    expect(pz(b.minZ)).toBeGreaterThan(0);
    expect(pz(b.maxZ)).toBeLessThan(300);
    // centred
    expect((px(b.minX) + px(b.maxX)) / 2).toBeCloseTo(200);
    expect((pz(b.minZ) + pz(b.maxZ)) / 2).toBeCloseTo(150);
  });
});
