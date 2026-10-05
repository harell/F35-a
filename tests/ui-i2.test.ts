/**
 * UX i2 regressions (reviewer critiques):
 *  - touch targets ≥ 44×44 CSS px on 667×375 / 844×390 (pause was 46×38, RDR 58×38);
 *  - instructional text follows handedness and control scheme;
 *  - player-centric grading: an A/S needs the player's own share of the flight's kills;
 *  - 'Untouchable' is not awarded when a friendly was lost;
 *  - retries vary (salted AI seed + hostile spawn jitter), attempt 0 is the designed mission.
 */
import { describe, expect, it } from 'vitest';
import { computeTouchLayout } from '../src/input/touch/layout';
import { formatControls } from '../src/missions/runtime/controlsText';
import { computeScore, contributionCap, type ScoreInput } from '../src/missions/runtime/scoring';
import { attemptSeed, jitter, nextAttempt, setAttemptVariation } from '../src/missions/runtime/variation';
import { sameFlight } from '../src/missions/runtime/callouts';
import { groupSkill } from '../src/missions/runtime/spawner';
import { CAMPAIGNS, TRAINING, missionById } from '../src/missions';
import { flight } from '../src/missions/content/common';
import { DIFFICULTIES } from '../src/core/data';

const NO_SAFE = { top: 0, right: 0, bottom: 0, left: 0 };
const NOTCH = { top: 0, right: 47, bottom: 21, left: 47 };

describe('i2: touch targets ≥ 44 px', () => {
  for (const [W, H] of [
    [667, 375],
    [844, 390],
    [568, 320],
    [932, 430],
  ] as const) {
    for (const safe of [NO_SAFE, NOTCH]) {
      for (const leftHanded of [false, true]) {
        it(`${W}×${H}${safe === NOTCH ? ' notch' : ''}${leftHanded ? ' left' : ''}: every button ≥ 44×44`, () => {
          const L = computeTouchLayout(W, H, safe, { leftHanded });
          for (const [id, r] of Object.entries(L.buttons)) {
            expect(r.w, `${id} width`).toBeGreaterThanOrEqual(44);
            expect(r.h, `${id} height`).toBeGreaterThanOrEqual(44);
          }
        });
      }
    }
  }
});

describe('i2: handedness / scheme-aware instructions', () => {
  it('right-handed stick, left-handed stick and tilt read differently and correctly', () => {
    const t = '{controls}. Climb';
    expect(formatControls(t, { controlScheme: 'stick', leftHanded: false })).toBe('Left thumb THROTTLE, right thumb STICK. Climb');
    expect(formatControls(t, { controlScheme: 'stick', leftHanded: true })).toBe('Right thumb THROTTLE, left thumb STICK. Climb');
    expect(formatControls(t, { controlScheme: 'tilt', leftHanded: false })).toBe('Tilt the phone to fly, left thumb THROTTLE. Climb');
    expect(formatControls(t, { controlScheme: 'tilt', leftHanded: true })).toBe('Tilt the phone to fly, right thumb THROTTLE. Climb');
  });
  it('no campaign or training hint hard-codes a thumb (playtest 2026-10-02, 1.4-d: T01 said RIGHT THUMB = STICK)', () => {
    for (const m of [...CAMPAIGNS.flatMap((c) => c.missions), ...TRAINING]) {
      const texts = [...(m.script.hints ?? []).map((h) => h.text), ...(m.script.triggers ?? []).flatMap((t) => t.actions.flatMap((a) => (a.kind === 'hint' ? [a.text] : [])))];
      for (const t of texts) expect(t, `${m.id}: "${t}"`).not.toMatch(/\b(left|right) thumb\b/i);
    }
  });
  it('T01 names the thumbs through tokens, not a hard-coded "Left thumb THROTTLE"', () => {
    const t01 = missionById('t01')!;
    for (const h of t01.script.hints ?? []) expect(h.text).not.toMatch(/Left thumb THROTTLE/);
    expect(t01.script.hints?.some((h) => /\{(controls|stickThumb|throttleThumb)\}/.test(h.text))).toBe(true);
  });
});

const base: ScoreInput = {
  success: true,
  time: 250,
  parTime: 480,
  kills: { air: 1, sam: 0, ground: 0 },
  enemiesSpawned: 4,
  objectiveBonus: 500,
  primaryDone: 1,
  primaryTotal: 1,
  secondaryDone: 0,
  secondaryTotal: 0,
  shotsFired: 2,
  hits: 1,
  damageTaken: 0,
  friendlyLosses: 0,
  bonus: 0,
  scoreMultiplier: 1,
};

describe('i2: player-centric grading', () => {
  it("the reviewer's c02 case (player 1 of 4 kills, Viper 2 the other 3) is no longer an A", () => {
    const solo = computeScore({ ...base, kills: { air: 4, sam: 0, ground: 0 }, shotsFired: 4, hits: 4 });
    const carried = computeScore({ ...base, flightKills: 3 });
    expect(['S', 'A']).toContain(solo.grade);
    expect(carried.playerShare).toBeCloseTo(0.25);
    expect(['S', 'A']).not.toContain(carried.grade);
    expect(carried.rating).toBeLessThan(solo.rating);
  });
  it('S/A need ≥ 50 % of the flight kills; < 25 % caps at C', () => {
    expect(contributionCap(1)).toBe('S');
    expect(contributionCap(0.5)).toBe('S');
    expect(contributionCap(0.4)).toBe('B');
    expect(contributionCap(0.2)).toBe('C');
    const half = computeScore({ ...base, kills: { air: 2, sam: 0, ground: 0 }, flightKills: 2, shotsFired: 2, hits: 2 });
    expect(half.playerShare).toBe(0.5);
    expect(['S', 'A']).toContain(half.grade);
    const tiny = computeScore({ ...base, kills: { air: 1, sam: 0, ground: 0 }, flightKills: 5, shotsFired: 1, hits: 1 });
    expect(['C', 'D', 'F']).toContain(tiny.grade);
  });
  it('no flight kills → share 1 and the old grading', () => {
    expect(computeScore(base).playerShare).toBe(1);
  });
  it('"Viper 2" is in the player\'s flight, "Weasel 1" / "Hammer 3" are not', () => {
    expect(sameFlight('Viper 2', 'Viper 1')).toBe(true);
    expect(sameFlight('Weasel 1', 'Viper 1')).toBe(false);
    expect(sameFlight('Hammer 3', 'Viper 1')).toBe(false);
  });
  it('the fighting-wing wingman is generous only on Recruit; strike-package friendlies stay competent', () => {
    const dogfight = missionById('ia_dogfight_auckland')!;
    const wing = dogfight.script.groups.find((g) => g.role === 'wingman')!;
    expect(groupSkill(wing, DIFFICULTIES.recruit.aiSkill)).toBeGreaterThan(groupSkill(wing, DIFFICULTIES.pilot.aiSkill));
    expect(groupSkill(wing, DIFFICULTIES.veteran.aiSkill)).toBeLessThanOrEqual(0.6);
    // a strike-package friendly (no shipped mission has one now): a blue flight that is not the wingman
    const weasel = flight('weasel', 'f35a', 2, { x: 0, z: 0 }, 5000, 0, 230, 'fighter', { team: 'blue', callsign: 'Weasel' });
    expect(groupSkill(weasel, DIFFICULTIES.pilot.aiSkill)).toBeGreaterThanOrEqual(0.75);
  });
});

describe('i2: retries vary', () => {
  it('attempt 0 is the designed mission, retries get new seeds; off in node unless enabled', () => {
    setAttemptVariation(false);
    expect(nextAttempt('g01')).toBe(0);
    expect(nextAttempt('g01')).toBe(0);
    setAttemptVariation(true);
    expect(nextAttempt('g01')).toBe(0);
    expect(nextAttempt('g01')).toBe(1);
    expect(nextAttempt('g01')).toBe(2);
    expect(nextAttempt('g02')).toBe(0);
    setAttemptVariation(false);
    const s = missionById('g01')!.seed;
    expect(attemptSeed(s, 0)).toBe(s);
    expect(new Set([0, 1, 2, 3].map((n) => attemptSeed(s, n))).size).toBe(4);
  });
  it('spawn jitter is bounded, deterministic and varies with the seed', () => {
    const vals = new Set<number>();
    for (let seed = 1; seed < 200; seed++) {
      const j = jitter(seed, 3);
      expect(j).toBeGreaterThanOrEqual(-1);
      expect(j).toBeLessThan(1);
      expect(jitter(seed, 3)).toBe(j);
      vals.add(Math.round(j * 10));
    }
    expect(vals.size).toBeGreaterThan(10);
  });
});
