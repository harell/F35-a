/**
 * Content lint for the phone HUD text budget (i1 critique: "radio capped at 3 lines", "objectives cut
 * mid-word", "hint pills capped at 3 lines"). The HUD no longer truncates: radio calls are PAGED
 * (2 lines per page) and objective labels wrap at word boundaries — these tests guard that every piece
 * of mission text still fits the paging / wrapping budget on the smallest supported phone (667x375)
 * and in the narrower cockpit-view radio band.
 */
import { describe, expect, it } from 'vitest';
import hintsSrc from '../src/missions/runtime/hints.ts?raw';
import weaponsSrc from '../src/hud/hmd/weapons.ts?raw';
import type { MissionDef } from '../src/core/contracts';
import { CAMPAIGNS, TRAINING, missionById } from '../src/missions';
import { RADIO_PAGE_LINES } from '../src/hud/hmd/feeds';
import { CHAR_W } from '../src/hud/dev/fakeCanvas';
import { RADIO_FONT, computeLayout, makeLayout } from '../src/hud/hmd/layout';
import { objectiveLines, wrap } from '../src/hud/hmd/overlays';

/** Every mission the player can fly: the campaigns, training and each Instant Action mode. */
const MISSIONS: MissionDef[] = [
  ...CAMPAIGNS.flatMap((c) => c.missions),
  ...TRAINING,
  ...(['stroll', 'dogfight', 'sam_gauntlet', 'strike', 'defend'] as const).map((mode) => missionById(`ia_${mode}_auckland`)!),
];

const noSafe = { top: 0, right: 0, bottom: 0, left: 0 };
const tan30 = Math.tan(Math.PI / 6);

/** Characters per radio line for a layout (same formula as reserveRadio). */
function radioLinesOf(W: number, H: number, cockpit: boolean): number {
  return computeLayout(makeLayout(), W, H, noSafe, tan30, cockpit).radioLines || RADIO_PAGE_LINES;
}

function radioChars(W: number, H: number, cockpit: boolean): number {
  const L = computeLayout(makeLayout(), W, H, noSafe, tan30, cockpit);
  const cw = RADIO_FONT * L.u * CHAR_W;
  return Math.max(18, Math.floor((Math.max(160 * L.u, L.radioX1 - L.radioX0) - 38 * L.u) / cw));
}

function collect(): { radio: { from: string; text: string; where: string }[]; hints: string[]; objectives: string[] } {
  const radio: { from: string; text: string; where: string }[] = [];
  const hints: string[] = [];
  const objectives: string[] = [];
  const walk = (o: unknown, where: string): void => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      for (const x of o) walk(x, where);
      return;
    }
    const r = o as Record<string, unknown>;
    if (r.kind === 'radio' && typeof r.text === 'string') radio.push({ from: String(r.from ?? 'DARKSTAR'), text: r.text, where });
    if (r.kind === 'hint' && typeof r.text === 'string') hints.push(r.text);
    for (const v of Object.values(r)) walk(v, where);
  };
  for (const m of MISSIONS) {
    walk(m.script, m.id);
    for (const h of m.script.hints ?? []) hints.push(h.text);
    for (const ob of m.script.objectives ?? []) if (ob.label) objectives.push(ob.label);
  }
  // built-in contextual hints (string literals returned by the hint engine)
  for (const m of (hintsSrc as string).matchAll(/return '([^']{12,})'/g)) hints.push(m[1]);
  return { radio, hints, objectives };
}

describe('HUD text budget lint (mission content vs the phone layout)', () => {
  const content = collect();

  it('finds the mission content', () => {
    expect(content.radio.length).toBeGreaterThan(15);
    expect(content.objectives.length).toBeGreaterThan(20);
    expect(content.hints.length).toBeGreaterThan(10);
  });

  it('every scripted radio call fits ≤ 3 subtitle pages (2 lines each) on a 667x375 phone and in the cockpit band', () => {
    for (const [W, H, cockpit] of [
      [667, 375, false],
      [667, 375, true],
      [844, 390, true],
    ] as const) {
      const chars = radioChars(W, H, cockpit);
      for (const r of content.radio) {
        const lines = wrap('[' + r.from.toUpperCase() + '] ' + r.text, chars);
        const pages = Math.ceil(lines.length / radioLinesOf(W, H, cockpit));
        expect(pages, `${r.where} ${W}x${H}${cockpit ? ' cockpit' : ''}: "${r.text}"`).toBeLessThanOrEqual(3);
      }
    }
  });

  it('every hint fits ≤ 2 pages of 3 lines in the top-left column (667x375)', () => {
    const L = computeLayout(makeLayout(), 667, 375, noSafe, tan30, false);
    const chars = Math.max(16, Math.floor((L.colW - 16 * L.u) / (11.5 * L.u * CHAR_W)));
    for (const h of content.hints) {
      const lines = wrap(h, chars);
      expect(Math.ceil(lines.length / 3), `hint "${h}"`).toBeLessThanOrEqual(2);
    }
  });

  it('every scripted hint fits ≤ 2 pages of 2 lines at 844x390, the room the hint box usually has (playtest 2026-10-02, 2.2-d)', () => {
    const L = computeLayout(makeLayout(), 844, 390, noSafe, tan30, false);
    const chars = Math.max(16, Math.floor((L.colW - 16 * L.u - 24 * L.u) / (11.5 * L.u * CHAR_W)));
    for (const h of content.hints) expect(Math.ceil(wrap(h, chars).length / 2), `hint "${h}"`).toBeLessThanOrEqual(2);
  });

  it('the missile-defence hints fit one page (2 lines) at 667x375 (playtest 2026-10-02, 1.3-g)', () => {
    const L = computeLayout(makeLayout(), 667, 375, noSafe, tan30, false);
    const chars = Math.max(16, Math.floor((L.colW - 16 * L.u) / (11.5 * L.u * CHAR_W)));
    const defend = [...(hintsSrc as string).matchAll(/'((?:IR )?MISSILE![^']*)'/g)].map((m) => m[1]);
    // a SAM's round and a fighter's, radar and IR (runtime/hints.ts)
    expect(defend.length).toBe(4);
    for (const h of defend) expect(wrap(h, chars).length, `hint "${h}"`).toBeLessThanOrEqual(2);
  });

  it('the HUD bomb release cue reads what the briefings and hints say to wait for (playtest 1.3-a: IN RNG vs IN RANGE)', () => {
    const cue = /addCue\('(IN R[A-Z ]*)'/.exec(weaponsSrc as string)?.[1];
    expect(cue).toBe('IN RANGE');
    const content = JSON.stringify(MISSIONS.map((m) => [m.briefing, m.script]));
    expect(content).toContain(cue);
    expect(hintsSrc as string).toContain(cue);
    expect(content + hintsSrc).not.toMatch(/IN RNG/);
  });

  it('every objective label shows in full (≤ 3 lines, no ellipsis, never cut mid-word) at 667x375', () => {
    const L = computeLayout(makeLayout(), 667, 375, noSafe, tan30, false);
    const chars = Math.max(14, Math.floor(L.colW / (11 * L.u * CHAR_W)));
    for (const label of content.objectives) {
      const lines = objectiveLines({ label, state: 'active', progress: { done: 0, total: 4 } }, chars);
      const joined = lines.map((l) => l.slice(2).trim()).join(' ');
      expect(joined, label).not.toContain('…');
      expect(joined.replace(/ 0\/4$/, ''), label).toBe(label.toUpperCase().replace(/\s+/g, ' '));
    }
  });
});
