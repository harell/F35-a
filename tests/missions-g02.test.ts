/**
 * IRGC campaign mission 2, g02 "Straight Outta Hauraki" (#82): an escort under a clock. The two-hit
 * tanker sails out of the Rangitoto Channel into the Hauraki Gulf; suicide boats reach her about 2
 * minutes in, missile boats reach launch range 3–4 minutes in (a Kowsar can't be shot down), and
 * air-defence boats escort them. Sinking the suicide and missile boats with her afloat wins; two
 * hits sink her and fail the mission.
 *
 * The clocks are checked on the real LINZ coast (the boats steer round land), with the player
 * parked far out of the fight.
 */
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEventMap } from '../src/core/events';
import { DIFFICULTIES, LOADOUTS, WEAPON_INFO } from '../src/core/data';
import type { Difficulty } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import type { SimWorld, TerrainQuery } from '../src/sim/api';
import { isKowsar } from '../src/sim/boats';
import { MUNITIONS } from '../src/sim/weapons/defs';
import { gpsMaxRange } from '../src/sim/weapons/dlz';
import { SAM_DATA } from '../src/sim/sam/samData';
import { CAMPAIGNS, campaignOf, createMissionRunner, missionById, missionGunAmmo, terrainPadsFor, validateMission } from '../src/missions';
import { G02, G02_GROUPS, G02_MISSILE_WAVE_AT, G02_TANKER } from '../src/missions/content/irgcHauraki';
import { drawIntelMap, routeLabel, routeOf } from '../src/ui/screens/intelMap';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { forceDestroy } from '../src/game/forceDestroy';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { runPlaythrough } from './missions-bot';

const DT = 1 / 60;
const DIFFS: Difficulty[] = ['recruit', 'pilot', 'veteran', 'ace'];

let terrain: TerrainQuery | null = null;
/** The real Auckland terrain (LINZ coast) the mission is flown on. */
function realTerrain(): TerrainQuery {
  terrain ??= new TerrainQueryImpl(runSync(generateTerrain({ theater: G02.theater, seed: G02.seed, resolution: 512, features: allFeatures(G02.theater, []), pads: terrainPadsFor(G02) })));
  return terrain;
}

/** g02 on the real coast; the player is parked far out of the fight (unless `park` is false). */
function setup(difficulty: Difficulty = 'pilot') {
  const events = new EventBus();
  const diff = DIFFICULTIES[difficulty];
  const world = createSimWorld({ terrain: realTerrain(), difficulty: diff, events, combat: createCombatSystemSeeded(5) });
  const runner = createMissionRunner(G02, { createAi: createAiBrain, difficulty: diff, events });
  runner.setup(world, G02.recommendedLoadout);
  const p = world.player!;
  const tanker = world.ground.find((g) => g.groupId === G02_TANKER.group)!;
  const group = (id: string) => [...world.ground, ...world.sams].filter((e) => e.groupId === id);
  const record = <K extends keyof GameEventMap>(name: K): (GameEventMap[K] & { t: number })[] => {
    const out: (GameEventMap[K] & { t: number })[] = [];
    events.on(name, (e) => out.push({ ...e, t: world.time }));
    return out;
  };
  /** Run up to `seconds` while the mission runs; `each` returning true stops early. */
  const tick = (seconds: number, each?: () => boolean | void) => {
    for (let i = 0; i < seconds * 60 && runner.state === 'running'; i++) {
      p.position.set(-35_000, 13_000, 35_000);
      p.health = p.maxHealth;
      world.step(DT);
      runner.update(world, DT);
      if (each?.()) return;
    }
  };
  const objective = (id: string) => runner.objectives.find((o) => o.id === id)!;
  return { world, runner, p, tanker, group, record, tick, objective };
}

const water = (w: SimWorld, e: { position: { x: number; z: number } }) => w.terrain.isWater(e.position.x, e.position.z);

describe('g02 Straight Outta Hauraki: content', () => {
  it('is the IRGC campaign mission 2, reachable by id (?mission=g02&autostart=1), and valid', () => {
    expect(missionById('g02')).toBe(G02);
    expect(campaignOf('g02')?.id).toBe('irgc');
    const irgc = CAMPAIGNS.find((c) => c.id === 'irgc')!;
    expect(irgc.missions).toContain(G02);
    expect(G02.kind).toBe('campaign');
    expect(G02.index).toBe(2);
    expect(G02.title).toBe('Straight Outta Hauraki');
    expect(G02.theater).toBe('auckland');
    expect(validateMission(G02)).toEqual([]);
  });

  it('is the IRGC campaign finale: winning it plays the campaign ending (playtest 2026-10-02 bc94edd, 1.4-e)', () => {
    const irgc = CAMPAIGNS.find((c) => c.id === 'irgc')!;
    expect(irgc.missions.at(-1)).toBe(G02);
    expect(G02.script.campaignFinale).toBe(true);
    for (const m of irgc.missions.slice(0, -1)) expect(m.script.campaignFinale, m.id).toBeFalsy();
  });

  it('offers only loadouts whose bombs can hit a moving boat (GBU-53/B), recommends all eight, and loads 360 rounds', () => {
    expect(G02.recommendedLoadout).toBe('strike_maritime');
    for (const id of G02.allowedLoadouts) {
      const bombs = LOADOUTS[id].stores.filter((s) => s.weapon === 'gbu31' || s.weapon === 'gbu53');
      expect(bombs.length, id).toBeGreaterThan(0);
      for (const b of bombs) expect(b.weapon, id).toBe('gbu53'); // a GPS-only JDAM misses a moving boat (#65)
      for (const d of DIFFS) expect(missionGunAmmo(G02, d, id), `${id} ${d}`).toBe(360);
    }
  });

  it('air-to-ground only (#136): StormBreakers and an AARGM-ER per air-defence boat, no air-to-air missile', () => {
    expect(G02.allowedLoadouts).toEqual(['strike_maritime']);
    const l = LOADOUTS.strike_maritime;
    expect(l.stores).toEqual([
      { weapon: 'gbu53', count: 8, internal: true },
      { weapon: 'aargm', count: 2, internal: true },
    ]);
    expect(l.role).toBe('ag');
    expect(l.rcsMultiplier).toBe(1);
    for (const id of G02.allowedLoadouts) {
      for (const s of LOADOUTS[id].stores) expect(WEAPON_INFO[s.weapon].kind, `${id} ${s.weapon}`).not.toBe('aam');
    }
    // one anti-radiation missile for each air-defence boat (on every difficulty)
    expect(l.stores.find((s) => s.weapon === 'aargm')!.count).toBeGreaterThanOrEqual(G02.script.sams.filter((s) => s.type === 'ad_boat').length);
    const text = G02.briefing.join(' ');
    expect(text).toMatch(/AARGM-ER/);
    expect(text).toMatch(/no air-to-air missiles/i);
  });

  it('the briefing names the mother ship, the two-hit rule, the early release and the friendly-fire risk', () => {
    const text = G02.briefing.join(' ');
    expect(text).toMatch(/mother ship/i);
    expect(text).toMatch(/two hits sink her/i);
    expect(text).toMatch(/release early/i);
    expect(text).toMatch(/alongside the tanker can hit her/i);
    expect(text).toMatch(/cannot be shot down/i);
  });

  // the first test to build the real terrain (~3.5 s alone, past the 5 s default under load)
  it('every boat and the tanker start on open water, and her route out through the Gulf stays on it (real LINZ coast)', { timeout: 60_000 }, () => {
    const t = realTerrain();
    for (const g of [...G02.script.ground, ...G02.script.sams]) expect(t.isWater(g.x, g.z), g.id).toBe(true);
    const route = [G02_TANKER.start, ...G02_TANKER.path];
    for (let i = 1; i < route.length; i++) {
      for (let k = 0; k <= 20; k++) {
        const x = route[i - 1].x + ((route[i].x - route[i - 1].x) * k) / 20;
        const z = route[i - 1].z + ((route[i].z - route[i - 1].z) * k) / 20;
        expect(t.isWater(x, z), `leg ${i} at ${Math.round(x)},${Math.round(z)}`).toBe(true);
      }
    }
  });

  it('the briefing map marks the tanker as the friendly to protect, not as a strike target', () => {
    const onTanker = G02.intel.filter((m) => Math.hypot(m.x - G02_TANKER.start.x, m.z - G02_TANKER.start.z) < 500);
    expect(onTanker.length).toBeGreaterThan(0);
    expect(onTanker.filter((m) => m.kind === 'target')).toEqual([]);
    expect(onTanker).toContainEqual(expect.objectContaining({ kind: 'friendly', label: G02_TANKER.name }));
    // the boats are still the targets
    expect(G02.intel.filter((m) => m.kind === 'target').map((m) => m.label).sort()).toEqual(['Missile boats', 'Suicide boats']);
  });

  it('the briefing map names each wave once: the boat waypoints keep their number, not a second "MISSILE BOATS" label (#115)', () => {
    const route = routeOf(G02);
    expect(route.map((p) => p.label)).toEqual(['Suicide boats', 'Missile boats']);
    for (const p of route) expect(routeLabel(G02, p), p.label).toBeNull();
    // a waypoint away from any marker of its name keeps its label
    expect(routeLabel(G02, { ...route[0], x: route[0].x - 20_000 })).toBe('SUICIDE BOATS');
    // what the drawn map prints (the playtest's screenshot had both spellings of each wave)
    installPath2D();
    const { canvas, ctx } = makeFakeCanvas(600, 400, 1);
    drawIntelMap(canvas, G02, 600, 400, 1);
    const texts = ctx.texts.map((t) => t.text);
    expect(texts.filter((t) => /missile boats/i.test(t))).toEqual(['Missile boats']);
    expect(texts.filter((t) => /suicide boats/i.test(t))).toEqual(['Suicide boats']);
  });

  it('the start solves nothing: no boat is in StormBreaker reach at t=0, and the missile boats are out of reach even from 20,000 ft', () => {
    const p = G02.player;
    const ad = SAM_DATA.ad_boat;
    const reach = (h: number) => gpsMaxRange(MUNITIONS.gbu53, h, p.speed, 0);
    // from the start height the release point is inside the AD boats' radar SAM: climb, or press in
    expect(p.altitude).toBeLessThan(ad.altMax);
    expect(reach(p.altitude)).toBeLessThan(ad.engageMax);
    for (const g of [...G02.script.ground, ...G02.script.sams]) {
      if (g.group === G02_TANKER.group) continue;
      const d = Math.hypot(g.x - p.x, g.z - p.z);
      expect(d, g.id).toBeGreaterThan(reach(p.altitude) + 5_000);
      if (g.group === G02_GROUPS.missile) expect(d, g.id).toBeGreaterThan(reach(ad.altMax) + 2_000);
    }
  });

  it('the boat mix: 2 air-defence, 3 missile, 3 suicide; Recruit one suicide boat fewer (#115); Veteran adds one; Ace one more, and a two-Kowsar missile boat', { timeout: 60_000 }, () => {
    const want: Record<Difficulty, [number, number, number]> = { recruit: [2, 3, 2], pilot: [3, 3, 2], veteran: [4, 3, 2], ace: [5, 4, 2] };
    const bombs = LOADOUTS[G02.recommendedLoadout].stores.filter((s) => s.weapon === 'gbu53').reduce((n, s) => n + s.count, 0);
    for (const d of DIFFS) {
      const m = setup(d);
      m.tick(G02_MISSILE_WAVE_AT + 1); // the missile wave is in the water
      const n = [m.group(G02_GROUPS.suicide).length, m.group(G02_GROUPS.missile).length, m.group(G02_GROUPS.ad).length];
      expect(n, d).toEqual(want[d]);
      // the boats the mission needs sunk against the eight bombs: three spare on Recruit, two at Pilot, one at Veteran, the gun on Ace
      expect(bombs - n[0] - n[1], d).toBe({ recruit: 3, pilot: 2, veteran: 1, ace: -1 }[d]);
      const kowsars = m.group(G02_GROUPS.missile).map((b) => (b.kind === 'ground' ? (b.boat?.strike?.missiles ?? 0) : 0));
      expect(kowsars.filter((k) => k === 2).length, d).toBe(d === 'ace' ? 1 : 0);
      expect(m.tanker.team).toBe('neutral');
      expect(m.tanker.hitsToSink).toBe(2);
      expect(m.tanker.name).toBe(G02_TANKER.name);
      m.runner.dispose?.();
    }
  });
});

describe('g02: the missile wave comes in on a trigger (#115)', { timeout: 60_000 }, () => {
  it(`the missile boats and their air-defence escort are not in the water before ${G02_MISSILE_WAVE_AT} s, so the opening ripple can't cover them; then they come in, called by Darkstar`, () => {
    const m = setup();
    const radio = m.record('radio');
    m.tick(G02_MISSILE_WAVE_AT - 1);
    expect(m.group(G02_GROUPS.missile)).toEqual([]);
    expect(m.group(G02_GROUPS.ad).length).toBe(1); // the suicide wave's escort only
    expect(m.objective('o_missile').state).toBe('active'); // not won by an empty group
    m.tick(2);
    expect(m.group(G02_GROUPS.missile).length).toBe(3);
    expect(m.group(G02_GROUPS.ad).length).toBe(2);
    const ad2 = m.group(G02_GROUPS.ad).find((b) => b.kind === 'sam' && b.boat?.escortGroup === G02_GROUPS.missile);
    expect(ad2).toBeDefined();
    expect(radio.some((r) => /missile boats in the water/i.test(r.text) && r.t >= G02_MISSILE_WAVE_AT)).toBe(true);
    // they come in about 10 km north of the tanker
    for (const b of m.group(G02_GROUPS.missile)) {
      const d = Math.hypot(b.position.x - m.tanker.position.x, b.position.z - m.tanker.position.z);
      expect(d, `mb ${b.id}`).toBeGreaterThan(9_000);
      expect(d, `mb ${b.id}`).toBeLessThan(11_500);
    }
    m.runner.dispose?.();
  });

  it('the trigger is a time: an untouched suicide wave still meets the missile boats (they come in whatever the player does)', () => {
    const m = setup();
    m.tick(G02_MISSILE_WAVE_AT + 1);
    expect(m.group(G02_GROUPS.suicide).every((b) => b.alive)).toBe(true);
    expect(m.group(G02_GROUPS.missile).length).toBe(3);
    m.runner.dispose?.();
  });
});

describe('g02: the clocks and the outcome (real sim, real coast)', { timeout: 60_000 }, () => {
  it('untouched: the suicide wave hits her at about 2 minutes and the second ram sinks her: mission failed', () => {
    const m = setup();
    const hits = m.record('vessel:hit');
    let wet = true;
    m.tick(300, () => {
      for (const b of [...m.group(G02_GROUPS.suicide), ...m.group(G02_GROUPS.missile), ...m.group(G02_GROUPS.ad)]) if (b.alive && !water(m.world, b)) wet = false;
    });
    expect(wet).toBe(true); // no boat ever crossed the coast
    expect(hits.length).toBe(2);
    expect(hits[0].weapon).toBe('collision'); // a suicide boat's ram
    expect(hits[0].t).toBeGreaterThan(105);
    expect(hits[0].t).toBeLessThan(135);
    expect(hits[1].hits).toBe(2);
    expect(m.tanker.alive).toBe(false);
    expect(m.objective('o_tanker').state).toBe('failed');
    expect(m.runner.state).toBe('failed');
    expect(m.runner.result(m.world).success).toBe(false);
    m.runner.dispose?.();
  });

  it('untouched missile boats (the suicide boats sunk at the start): in range and counting down at about 3.5 minutes, launching before 4', () => {
    const m = setup();
    for (const b of m.group(G02_GROUPS.suicide)) forceDestroy(m.world, b, m.p.id);
    const launches = m.record('munition:launch');
    const hits = m.record('vessel:hit');
    let countdownAt = -1;
    m.tick(300, () => {
      if (countdownAt < 0 && m.group(G02_GROUPS.missile).some((b) => b.kind === 'ground' && (b.boat?.strike?.timer ?? -1) >= 0)) countdownAt = m.world.time;
    });
    const kowsars = launches.filter((l) => isKowsar(l.missile));
    expect(countdownAt).toBeGreaterThan(165);
    expect(countdownAt).toBeLessThan(225);
    expect(kowsars.length).toBeGreaterThanOrEqual(2);
    expect(kowsars[0].t).toBeGreaterThan(180);
    expect(kowsars[0].t).toBeLessThan(240);
    // two Kowsar hits sink her: the mission fails
    expect(hits.filter((h) => h.weapon === 'kowsar').length).toBe(2);
    expect(m.tanker.alive).toBe(false);
    expect(m.runner.state).toBe('failed');
    m.runner.dispose?.();
  });

  it('killing every boat wins, the escorts included (with the tanker never hit)', () => {
    const m = setup();
    m.tick(G02_MISSILE_WAVE_AT + 1);
    for (const id of [G02_GROUPS.ad, G02_GROUPS.suicide, G02_GROUPS.missile]) for (const b of m.group(id)) forceDestroy(m.world, b, m.p.id);
    m.tick(5);
    expect(m.tanker.alive).toBe(true);
    expect(m.tanker.hits).toBe(0);
    for (const o of ['o_suicide', 'o_missile', 'o_ad', 'o_tanker']) expect(m.objective(o).state, o).toBe('complete');
    expect(m.runner.state).toBe('success');
    m.runner.dispose?.();
  });

  it('the air-defence boats are a bonus: sinking the suicide and missile boats with her afloat (even hit once) wins', () => {
    const m = setup();
    m.tick(G02_MISSILE_WAVE_AT + 1);
    m.world.applyDamage(m.tanker, 300, null, 'kowsar');
    for (const id of [G02_GROUPS.suicide, G02_GROUPS.missile]) for (const b of m.group(id)) forceDestroy(m.world, b, m.p.id);
    m.tick(5);
    expect(m.tanker.alive).toBe(true);
    expect(m.tanker.hits).toBe(1);
    expect(m.objective('o_ad').primary).toBe(false);
    expect(m.objective('o_ad').state).toBe('active');
    expect(m.runner.state).toBe('success');
    m.runner.dispose?.();
  });

  it('a missile boat sunk just after its launch does not give the win while its Kowsar is in the air: the hit lands first', () => {
    const m = setup();
    for (const b of m.group(G02_GROUPS.suicide)) forceDestroy(m.world, b, m.p.id);
    const launches = m.record('munition:launch');
    let sunkAt = -1;
    m.tick(300, () => {
      if (launches.some((l) => isKowsar(l.missile))) {
        // the first launch: sink every missile boat at once, its Kowsar flies on
        for (const b of m.group(G02_GROUPS.missile)) if (b.alive) forceDestroy(m.world, b, m.p.id);
        sunkAt = m.world.time;
        return true;
      }
    });
    expect(sunkAt).toBeGreaterThan(0);
    m.tick(1);
    expect(m.objective('o_missile').state).toBe('complete');
    expect(m.runner.state).toBe('running'); // not won yet: a Kowsar is still flying at her
    m.tick(60);
    expect(m.tanker.hits).toBe(1);
    expect(m.tanker.alive).toBe(true);
    expect(m.runner.state).toBe('success');
    m.runner.dispose?.();
  });
});

describe('g02: the competent bot (tests/missions-bot.ts)', () => {
  it('wins on Recruit in two passes: one StormBreaker per suicide boat first, then, once they are in the water, one per missile boat', { timeout: 120_000 }, () => {
    const n = 2;
    for (const seed of [0, 1]) {
      // no rearming (#63): the bot never goes home for more bombs
      const r = runPlaythrough('g02', 'recruit', seed, realTerrain(), { maxT: 400 });
      const tag = `recruit seed ${seed}`;
      expect(r.state, `${tag}: ${r.reason}`).toBe('success');
      const bombs = r.launches.filter((l) => l.weapon === 'gbu53');
      // suicide boats first (the 2-minute clock), one bomb each, and released early (nothing is in reach at t=0)
      const first = bombs.slice(0, n);
      expect(first.map((l) => l.group), tag).toEqual(Array(n).fill(G02_GROUPS.suicide));
      expect(new Set(first.map((l) => l.targetId)).size, tag).toBe(n);
      expect(first[0].t, tag).toBeGreaterThan(10);
      expect(first[n - 1].t, tag).toBeLessThan(45);
      // then one bomb on each missile boat: a second pass, after they came in (#115)
      const next = bombs.slice(n, n + 3);
      expect(next.map((l) => l.group), tag).toEqual([G02_GROUPS.missile, G02_GROUPS.missile, G02_GROUPS.missile]);
      expect(new Set(next.map((l) => l.targetId)).size, tag).toBe(3);
      expect(next[0].t, tag).toBeGreaterThan(G02_MISSILE_WAVE_AT);
      // every boat sunk before the first Kowsar (launch ~3.9 minutes in), the tanker never hit
      expect(r.t, tag).toBeLessThan(235);
      expect(r.objectives, tag).toContain('P:o_tanker=complete');
    }
  });

  // Pilot is the baseline of the AD boats' harassment (DifficultyParams.adBoatHarass): the bay opening for a
  // stand-off release cues the boat, which fires past its missile's envelope. The first ripple still goes
  // out whole (the bot finishes it before breaking), but the pass is no longer free: the bot has to defend.
  it('Pilot: the AD boat answers the stand-off ripple with a SAM launch, and the ripple still goes out whole', { timeout: 120_000 }, () => {
    for (const seed of [0, 1]) {
      const r = runPlaythrough('g02', 'pilot', seed, realTerrain(), { maxT: 400, log: true });
      const tag = `pilot seed ${seed}`;
      const bombs = r.launches.filter((l) => l.weapon === 'gbu53');
      const first = bombs.slice(0, 3);
      expect(first.map((l) => l.group), tag).toEqual(Array(3).fill(G02_GROUPS.suicide));
      expect(first[2].t, tag).toBeLessThan(45);
      const sam = r.events.filter((e) => /LAUNCH m_9m330 sam/.test(e)).map((e) => Number(e.trim().split(/\s+/)[0]));
      expect(sam.length, tag).toBeGreaterThan(0);
      // the cue is the open bay of the release, not the jet merely being there
      expect(sam[0], tag).toBeGreaterThan(first[0].t - 5);
      expect(sam[0], tag).toBeLessThan(first[0].t + 10);
    }
  });

  it('only Pilot harasses: no AD boat fires at a stand-off ripple on Recruit, Veteran or Ace', { timeout: 120_000 }, () => {
    expect(DIFFS.filter((d) => DIFFICULTIES[d].adBoatHarass)).toEqual(['pilot']);
    for (const diff of ['recruit', 'veteran', 'ace'] as const) {
      const r = runPlaythrough('g02', diff, 0, realTerrain(), { maxT: 400, log: true });
      const early = r.events.filter((e) => /LAUNCH m_9m330 sam/.test(e)).map((e) => Number(e.trim().split(/\s+/)[0])).filter((t) => t < 45);
      expect(early, `${diff}: no SAM launch in the opening ripple`).toEqual([]);
    }
  });
});
