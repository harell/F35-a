/**
 * The lessons g01 Buzz Kill asks for (MissionDef.lessons: t01–t03), sized for a casual player and
 * matched to what the mission needs (playtest r1, 1.4-a, -c, -d, -e, -k, -l): T01 ends at the last ring
 * (no campaign mission flies home), T02 trains on Shaheds as g01 fights them (no MiGs, no crank or
 * PITBULL), T03 is the Immelmann and g01's own gun pass (no loop drill), and the bot flies each one,
 * won, inside the time budget.
 */
import { describe, expect, it } from 'vitest';
import { LOADOUTS } from '../src/core/data';
import type { MissionDef } from '../src/core/contracts';
import { missionById, terrainPadsFor } from '../src/missions';
import { flight, mission } from '../src/missions/content/common';
import { G01, G01_GUN_PASS, G01_HINTS } from '../src/missions/content/irgc';
import { T02_ROW } from '../src/missions/content/training';
import type { Condition } from '../src/missions/schema';
import { SHAHED_SPEED } from '../src/sim/drone/oneWay';
import { harness, shieldPlayer } from './missions-helpers';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { runPlaythrough } from './missions-bot';

const KT = 0.514444;
const FT = 0.3048;
/** The bot's budget for one lesson (s): a few minutes for a casual player (1.4-e). */
const BOT_BUDGET = 200;
/** Longest briefing paragraph (characters): a few lines on an 844 × 390 phone (1.4-k). */
const PARAGRAPH = 330;

const lesson = (id: string): MissionDef => missionById(id)!;
const g01Hint = (id: string): string => G01_HINTS!.find((h) => h.id === id)!.text;
/** Everything the lesson says to the player: briefing, objectives, hints and the triggers' hints and radio calls. */
const words = (m: MissionDef): string =>
  [
    m.subtitle,
    ...m.briefing,
    ...m.script.objectives.map((o) => o.label),
    ...(m.script.hints ?? []).map((h) => h.text),
    ...(m.script.triggers ?? []).flatMap((t) => t.actions.flatMap((a) => (a.kind === 'hint' || a.kind === 'radio' ? [a.text] : []))),
    ...(m.script.opening ?? []).flatMap((a) => (a.kind === 'radio' ? [a.text] : [])),
    m.script.successText ?? '',
  ].join(' ');
/** The first condition of a kind inside `c` (depth first). */
function find<K extends Condition['kind']>(c: Condition, kind: K): Extract<Condition, { kind: K }> | null {
  if (c.kind === kind) return c as Extract<Condition, { kind: K }>;
  if (c.kind === 'all' || c.kind === 'any') {
    for (const x of c.of) {
      const f = find(x, kind);
      if (f) return f;
    }
  }
  if (c.kind === 'not') return find(c.of, kind);
  return null;
}

describe('the g01 lessons: what g01 needs, sized for fun', () => {
  it('g01 asks for t01–t03', () => {
    expect(G01.lessons).toEqual(['t01', 't02', 't03']);
  });

  it('each briefing is at most three short paragraphs, without unexplained jargon (1.4-e, 1.4-k)', () => {
    for (const id of G01.lessons!) {
      const m = lesson(id);
      expect(m.briefing.length, id).toBeLessThanOrEqual(3);
      for (const p of m.briefing) expect(p.length, `${id}: "${p}"`).toBeLessThanOrEqual(PARAGRAPH);
      expect(words(m), id).not.toMatch(/PITBULL|\bcrank|TD box|\bBVR\b/i);
    }
  });

  it('T01 ends at the sixth ring: no RTB leg (1.4-a), the bridge bonus stays', () => {
    const m = lesson('t01');
    expect(m.script.objectives.map((o) => o.id)).toEqual(['o_rings', 'o_bridge']);
    expect(m.script.objectives.find((o) => o.id === 'o_bridge')!.primary).toBe(false);
    expect(m.script.objectives.some((o) => o.kind === 'rtb')).toBe(false);
    expect((m.script.waypoints ?? []).some((w) => w.kind === 'rtb')).toBe(false);
    expect(words(m)).not.toMatch(/\bRTB\b|come (on )?home|bring the jet home/i);
  });

  it('T02 trains on Shaheds as g01 fights them (1.4-c): head-on AMRAAM, a row stepped through with FIRE, then the AIM-9X', () => {
    const m = lesson('t02');
    const groups = m.script.groups;
    expect(groups.map((g) => g.id)).toEqual(['drone1', 'row', 'drone3']);
    for (const g of groups) {
      expect(g.type, g.id).toBe('shahed136');
      expect(g.oneWay, g.id).toBeDefined();
    }
    expect(m.allowedLoadouts).toEqual(G01.allowedLoadouts);
    // drill 1 and the row use up the Beast load's AMRAAMs, so drill 3 is the AIM-9X's (as g01's swarm
    // outlasts the AMRAAMs)
    const amraams = LOADOUTS.a2a_beast.stores.reduce((n, s) => n + (s.weapon === 'aim120' ? s.count : 0), 0);
    expect(groups[1].count).toBe(T02_ROW);
    expect(groups[0].count + groups[1].count).toBe(amraams);
    // in Buzz Kill's words: the swarm steps through the box, the AIM-9X needs the tone inside ~2 km
    const hints = m.script.hints!.map((h) => h.text);
    expect(hints).toContain(g01Hint('h_swarm'));
    expect(hints).toContain(g01Hint('h_9x'));
    expect(words(m)).not.toMatch(/MiG|dogfight|knife fight|locks wherever you look/i);
    // no auto hints: they teach the crank and PITBULL
    expect(m.script.autoHints).toBe(false);
  });

  it("T03 is the turn and g01's gun pass (1.4-d): the Immelmann, no loop drill, the gun advice in G01_GUN_PASS's numbers", () => {
    const m = lesson('t03');
    expect(m.title).toBe('Turn and Gun');
    expect(m.script.groups.map((g) => g.id)).toEqual(['imm_drone']);
    const maneuvers = m.script.objectives.flatMap((o) => (o.kind === 'maneuver' ? [o.maneuver] : []));
    expect(maneuvers).toEqual(['immelmann']);
    expect(words(m)).not.toMatch(/\bloop\b/i);
    // the gun pass hints are g01's own (G01_HINTS)
    const hints = m.script.hints!.map((h) => h.text);
    expect(hints).toContain(g01Hint('h_gun'));
    expect(hints).toContain(g01Hint('h_overshoot'));
    // and the briefing quotes G01_GUN_PASS, not "gun it from 600 m"
    const brief = m.briefing.join(' ');
    expect(brief).toContain(`about ${G01_GUN_PASS.approachKt} knots, closing at about ${G01_GUN_PASS.closureKt}`);
    expect(brief).toContain(`about ${G01_GUN_PASS.belowFt} ft below it`);
    expect(brief).toContain(`${G01_GUN_PASS.burstFrom} to ${G01_GUN_PASS.burstTo} m`);
    expect(words(m)).not.toMatch(/(from|at) 600 m/);
  });

  it("T03: the hint for the next drone names its own gate's numbers (1.4-l)", () => {
    const m = lesson('t03');
    const retry = m.script.triggers!.find((t) => t.id === 't_imm_retry')!;
    const speed = find(retry.when, 'player_speed')!;
    const area = find(retry.when, 'area')!;
    const kt = Math.round(speed.above! / KT);
    const ft = Math.round(area.above! / FT);
    const wait = m.script.triggers!.find((t) => t.id === 't_wait')!;
    // the same gate as the retries (shown while it isn't met)
    expect(JSON.stringify(wait.when)).toContain(JSON.stringify(speed));
    expect(JSON.stringify(wait.when)).toContain(JSON.stringify(area));
    const text = wait.actions.flatMap((a) => (a.kind === 'hint' ? [a.text] : [])).join(' ');
    expect(text).toContain(`above ${ft.toLocaleString('en-NZ')} ft`);
    expect(text).toContain(`over ${kt} knots`);
    expect(find(retry.when, 'player_level')).not.toBeNull();
    expect(text).toMatch(/straight and level/);
  });
});

describe("g01's own hints agree with T02", () => {
  it('the auto hints never tell the player to crank off a Shahed (it never shoots back): SHOOT, fire, done', { timeout: 60_000 }, () => {
    // a Shahed 8 km ahead, head-on, below the jet: the auto hints alone (g01 has autoHints on)
    const def = mission({
      id: 'fx_drone_shot',
      kind: 'campaign',
      index: 1,
      title: 'Drone shot fixture',
      subtitle: 'One Shahed',
      timeOfDay: 'day',
      weather: 'clear',
      briefing: ['Test fixture.'],
      recommendedLoadout: 'a2a_beast',
      allowedLoadouts: ['a2a_beast'],
      player: { x: 0, z: 0, altitude: 1500, heading: 0, speed: 230 },
      script: {
        autoHints: true,
        awacs: { initialPictureAt: -1, pictureInterval: 0 },
        groups: [flight('d', 'shahed136', 1, { x: 0, z: -8_000 }, 300, 180, SHAHED_SPEED, 'bomber', { fixedCount: true, announce: false, oneWay: { targetX: 0, targetZ: 20_000 } })],
        objectives: [{ id: 'o', kind: 'destroy', groups: ['d'], label: 'Shoot it down', primary: true }],
      },
    });
    const h = harness(def);
    const p = h.world.player!;
    h.run(0.2, () => shieldPlayer(h));
    const d = h.world.aircraft.find((a) => a.groupId === 'd')!;
    h.world.combat.designate(p, d.id, h.world);
    const seen: string[] = [];
    const note = () => {
      shieldPlayer(h);
      const t = h.runner.hint;
      if (t && seen[seen.length - 1] !== t) seen.push(t);
    };
    // locked, in the zone: SHOOT
    h.run(15, () => {
      note();
      return /^SHOOT/.test(h.runner.hint ?? '');
    });
    expect(seen.join(' | ')).toMatch(/^.*SHOOT — fire the AMRAAM/);
    p.input.fireWeapon = true;
    h.run(0.1);
    p.input.fireWeapon = false;
    expect(h.world.missiles.some((m) => m.alive && m.shooterId === p.id && m.targetId === d.id)).toBe(true);
    const shot = seen.length;
    h.run(4, note);
    expect(seen.join(' | ')).not.toMatch(/crank|PITBULL/i);
    // the missile in flight: AMRAAM AWAY, and SHOOT no longer invites a second missile (r1 1.2-g)
    expect(seen.slice(shot).join(' | ')).toMatch(/^AMRAAM AWAY/);
    expect(seen.slice(shot).join(' | ')).not.toMatch(/SHOOT/);
  });
});

describe('the g01 lessons, flown by the mission bot', () => {
  const fly = (id: string) => {
    const def = lesson(id);
    const terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
    return [0, 1, 2].map((seed) => runPlaythrough(id, 'pilot', seed, terrain, { maxT: 600, log: true }));
  };

  for (const id of ['t01', 't03']) {
    it(`${id}: won on every seed inside ${BOT_BUDGET} s (1.4-e)`, { timeout: 300_000 }, () => {
      for (const r of fly(id)) {
        expect(r.state, `seed ${r.seed}: ${r.reason}`).toBe('success');
        expect(r.t, `seed ${r.seed}`).toBeLessThanOrEqual(BOT_BUDGET);
      }
    });
  }

  it(`t02: won on every seed inside ${BOT_BUDGET} s, AMRAAMs for the first two drills and the AIM-9X inside ~2 km for the last`, { timeout: 300_000 }, () => {
    for (const r of fly('t02')) {
      const why = `seed ${r.seed}: ${r.launches.map((l) => `${l.weapon}->${l.group}`).join(' ')}`;
      expect(r.state, why).toBe('success');
      expect(r.t, why).toBeLessThanOrEqual(BOT_BUDGET);
      for (const l of r.launches) if (l.group === 'drone1' || l.group === 'row') expect(l.weapon, why).toBe('aim120');
      const last = r.launches.filter((l) => l.group === 'drone3');
      expect(last.length, why).toBeGreaterThan(0);
      for (const l of last) expect(l.weapon, why).toBe('aim9x');
      // the event log reads "LAUNCH aim9x PLAYER -> Drone 7 2.4km"
      const ranges = r.events.flatMap((e) => {
        const m = /LAUNCH aim9x PLAYER -> \S+ \d+ ([\d.]+)km/.exec(e);
        return m ? [Number(m[1])] : [];
      });
      expect(ranges.length, why).toBeGreaterThan(0);
      for (const km of ranges) expect(km, why).toBeLessThanOrEqual(3);
    }
  });
});
