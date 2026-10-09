/**
 * MISSIONS — Instant Action balance (issue #60), on the ids the bot sweep flies
 * (`ia_<mode>_auckland`, seeded from the id, so these numbers reproduce):
 *  - the wingman (Viper 2) can't win Defend or Dogfight for a player who never fires: in Dogfight
 *    it holds fire until the player engages a bandit (a stray gun burst doesn't count), in Defend it
 *    fights the escort and never the strikers;
 *  - balance bands over 6 seeds (BANDS: floors one win under what the sweep measures, ceilings
 *    where playtest r1 found a walkover), every run ending, the Gauntlet's SAMs firing at the jet in
 *    most runs, Pilot's Dogfight and Defend fought under fire and Strike's bomb glide not silent
 *    (playtest r2); the issue's bands are Recruit and Pilot ≥ 75 % (5/6) and Veteran ≥ 25 % (2/6);
 *  - Gauntlet and Strike: the SEAD fit alone (strike_beast lost every run), and a clock on each;
 *  - the enemy-count extremes: Defend at 8 (Beast mode, three bombers below Veteran, 2 escorts at
 *    most) is winnable on Recruit and Pilot; enemyCount 1 is accepted as the easy end.
 * The heavy tests are async and yield after every playthrough: a long synchronous stretch starves
 * vitest's worker RPC (60 s timeout) and fails the run with "Timeout calling onTaskUpdate".
 * Sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=ia_strike_auckland,ia_sam_gauntlet_auckland,ia_dogfight_auckland,ia_defend_auckland --diffs=recruit,pilot,veteran --seeds=6
 */
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus } from '../src/core/events';
import type { Difficulty } from '../src/core/types';
import type { TerrainQuery } from '../src/sim/api';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { buildInstantMissionSeeded, createMissionRunner, missionById, terrainPadsFor } from '../src/missions';
import { DEFEND_BEAST_FROM, IA_GAUNTLET_TIME_LIMIT, IA_STRIKE_TIME_LIMIT } from '../src/missions/content/instant';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { MissionBot, runPlaythrough } from './missions-bot';
import { MAX_DEAD_STRETCH, deadStretchText, longestDeadStretch } from './missions-pacing';
import { makeAiWorld, runFor, v3 } from './ai-helpers';

/** Let vitest's worker answer its RPC between playthroughs (see the header). */
const yieldToVitest = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const terrains = new Map<string, TerrainQuery>();
function terrainFor(id: string): TerrainQuery {
  let t = terrains.get(id);
  if (!t) {
    const def = missionById(id)!;
    t = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
    terrains.set(id, t);
  }
  return t;
}

/**
 * The competent bot flies the mission (navigates, designates, defends), but its triggers are cut:
 * it never fires a missile, a bomb or the gun. `strayBurstAt` (s): one gun burst into empty sky
 * then (10 rounds gone, nothing hit). Returns how the mission ended and who killed what.
 */
function noFireRun(id: string, diff: Difficulty, seed: number, maxT = 600, strayBurstAt = -1) {
  const def = missionById(id)!;
  const events = new EventBus();
  const d = DIFFICULTIES[diff];
  const world = createSimWorld({ terrain: terrainFor(id), difficulty: d, events, combat: createCombatSystemSeeded(seed) });
  const runner = createMissionRunner({ ...def, seed: def.seed + seed * 101 }, { createAi: createAiBrain, difficulty: d, events });
  runner.setup(world, def.recommendedLoadout);
  const p = world.player!;
  const bot = new MissionBot(runner, world, p);
  let playerShots = 0;
  let wingKills = 0;
  let wingStrikerKills = 0;
  events.on('munition:launch', (e) => {
    if (e.shooter === p) playerShots++;
  });
  events.on('destroyed', (e) => {
    const by = world.getEntity(e.attackerId);
    if (e.entity.kind === 'aircraft' && e.entity.team === 'red' && by && by.kind === 'aircraft' && by.team === 'blue' && by !== p) {
      wingKills++;
      if (e.entity.groupId === 'strikers') wingStrikerKills++;
    }
  });
  const dt = 1 / 60;
  for (let i = 0; i < maxT * 60 && runner.state === 'running'; i++) {
    if (i === Math.round(strayBurstAt * 60)) p.gunAmmo -= 10;
    if (i % 3 === 0 && p.alive) bot.update(dt * 3);
    p.input.fireWeapon = false;
    p.input.fireGun = false;
    world.step(dt);
    runner.update(world, dt);
  }
  return { state: runner.state, t: Math.round(world.time), playerShots, wingKills, wingStrikerKills };
}

describe('Instant Action: the wingman supports, it does not win the mission (issue #60)', () => {
  it('the Dogfight wingman holds fire until the player fires; the Defend one never takes the strikers', () => {
    const dog = missionById('ia_dogfight_auckland')!.script.groups.find((g) => g.role === 'wingman')!;
    expect(dog.orders?.holdFireUntilPlayerFires).toBe(true);
    const def = missionById('ia_defend_auckland')!.script.groups.find((g) => g.role === 'wingman')!;
    expect(def.orders?.ignoreGroups).toContain('strikers');
  });

  it('a holding wingman stays on the wing past a bandit at 14 km and after a stray gun burst, and engages once the player hits the bandit', () => {
    const tw = makeAiWorld('pilot', undefined, 8);
    const w = tw.world;
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 4_000, 0), heading: 0, speed: 240, isPlayer: true, callsign: 'Viper 1', loadout: 'a2a_stealth' });
    const wm = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(80, 4_000, 60), heading: 0, speed: 240, callsign: 'Viper 2', leaderId: p.id, ai: createAiBrain('wingman', { skill: 0.8, seed: 3, orders: { holdFireUntilPlayerFires: true } }) });
    const bandit = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(3_000, 4_000, -14_000), heading: Math.PI, speed: 240, ai: createAiBrain('fighter', { skill: 0.1, seed: 5 }) });
    bandit.stores.forEach((st) => (st.count = 0));
    bandit.gunAmmo = 0;
    runFor(w, 40);
    expect(tw.launches.filter((l) => l.shooter === wm)).toEqual([]);
    expect((wm.ai as unknown as { target: number | null }).target).toBeNull();
    // a gun burst into empty sky: still weapons hold
    p.gunAmmo -= 20;
    runFor(w, 20);
    expect(tw.launches.filter((l) => l.shooter === wm)).toEqual([]);
    expect((wm.ai as unknown as { target: number | null }).target).toBeNull();
    // the player hits the bandit: the fight is on
    bandit.health -= 10;
    runFor(w, 90, () => !bandit.alive);
    expect(tw.launches.some((l) => l.shooter === wm && l.targetId === bandit.id) || !bandit.alive).toBe(true);
  });

  it('an ordered wingman never targets an ignored group', () => {
    const tw = makeAiWorld('pilot', undefined, 8);
    const w = tw.world;
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 4_000, 0), heading: 0, speed: 240, isPlayer: true, callsign: 'Viper 1', loadout: 'a2a_stealth' });
    const wm = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(80, 4_000, 60), heading: 0, speed: 240, callsign: 'Viper 2', leaderId: p.id, ai: createAiBrain('wingman', { skill: 0.8, seed: 3, orders: { ignoreGroups: ['strikers'] } }) });
    const striker = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(3_000, 4_000, -12_000), heading: Math.PI, speed: 240, groupId: 'strikers', ai: createAiBrain('fighter', { skill: 0.1, seed: 5 }) });
    striker.stores.forEach((st) => (st.count = 0));
    striker.gunAmmo = 0;
    runFor(w, 40);
    expect(tw.launches.filter((l) => l.shooter === wm)).toEqual([]);
    expect(striker.alive).toBe(true);
  });

  // The bot flies to the fight (it designates and defends) but never pulls a trigger (in Dogfight
  // it lets off one gun burst into empty sky at 5 s, a stray tap on a phone). Before issue #60
  // Viper 2 won Dogfight on Recruit alone (4 of 6 bot wins had 0 player kills) and Defend (the
  // playtest's 'VIPER 2: SPLASH SU-27'). Defend is only "not won" here, not "failed": with no
  // shot from the player some raids end with strikers that keep their bombs and never attack, and
  // the mission runs on (issue #60 comment 3.2-c, a follow-up).
  for (const id of ['ia_dogfight_auckland', 'ia_defend_auckland']) {
    it(`${id}: a player who never fires${id === 'ia_dogfight_auckland' ? ' (bar one stray gun burst)' : ''} does not win (Recruit and Pilot, 3 seeds each)`, { timeout: 240_000 }, async () => {
      const log: string[] = [];
      for (const diff of (['recruit', 'pilot'] as const)) {
        for (const seed of [0, 1, 2]) {
          const r = noFireRun(id, diff, seed, 600, id === 'ia_dogfight_auckland' ? 5 : -1);
          await yieldToVitest();
          log.push(`${diff} seed ${seed}: ${r.state}@${r.t}s, player shots ${r.playerShots}, wingman kills ${r.wingKills} (strikers ${r.wingStrikerKills})`);
          expect(r.playerShots, log.join('\n')).toBe(0);
          expect(r.state, log.join('\n')).not.toBe('success');
          // Dogfight: weapons hold, not a shot; Defend: the escort is fair game, the strikers never
          if (id === 'ia_dogfight_auckland') expect(r.wingKills, log.join('\n')).toBe(0);
          else expect(r.wingStrikerKills, log.join('\n')).toBe(0);
        }
      }
    });
  }
});

const IA_IDS = ['ia_strike_auckland', 'ia_sam_gauntlet_auckland', 'ia_dogfight_auckland', 'ia_defend_auckland'];

/**
 * Bot wins over seeds 0..5, as the sweep counts them (bot-sweep.ts --seeds=6), the runs in which a
 * SAM fired at the jet, those with two or more enemy rounds at it, those in which it was hit, and the
 * longest dead stretch of any run (tests/missions-pacing.ts). Every run has to end: Strike on Veteran used to circle out of bombs until the
 * sweep gave up (4 of 6), Defend on Pilot once (playtest r1, 1.3-h and 1.3-i).
 */
async function wins(id: string, diff: Difficulty): Promise<{ won: number; samShot: number; underFire: number; hit: number; dead: number; log: string }> {
  const log: string[] = [];
  let won = 0;
  let samShot = 0;
  let underFire = 0;
  let hit = 0;
  let dead = 0;
  for (let seed = 0; seed < 6; seed++) {
    const r = runPlaythrough(id, diff, seed, terrainFor(id), { maxT: 900, log: true });
    await yieldToVitest();
    if (r.state === 'success') won++;
    const shots = r.events.filter((e) => / LAUNCH \S+ sam -> Viper 1 /.test(e)).length;
    if (shots > 0) samShot++;
    // every enemy round at the jet, SAM or air-to-air
    const rounds = r.events.filter((e) => / LAUNCH \S+ (?!PLAYER ).+ -> Viper 1 /.test(e)).length;
    if (rounds >= 2) underFire++;
    // hit: health below 100 % in a 5 s state line, or shot down
    const hurt = !r.alive || r.events.some((e) => Number(/ BOT .* hp=(\d+)/.exec(e)?.[1] ?? 100) < 100);
    if (hurt) hit++;
    const quiet = longestDeadStretch(r.events, r.t);
    dead = Math.max(dead, quiet.length);
    log.push(`${id} ${diff} seed ${seed}: ${r.state}@${Math.round(r.t)}s ${r.reason ?? ''}, ${shots} SAM rounds and ${rounds} in all at the jet${hurt ? ', hit' : ''}, longest silence ${deadStretchText(quiet)}`);
    expect(r.state, log.join('\n')).not.toBe('running');
  }
  return { won, samShot, underFire, hit, dead, log: log.join('\n') };
}

/**
 * Bands [min, max] of wins in 6 per difficulty: the measured numbers less one seed for the floors (the
 * issue's bands are Recruit and Pilot ≥ 5/6, Veteran ≥ 2/6), and a ceiling where playtest r1 found a
 * walkover (Gauntlet Recruit and Pilot 12/12 with no SAM at the jet on Recruit, Defend Veteran 6/6
 * above Pilot's 5/6). Measured after r1: Strike 6/6/2, Gauntlet 6/3/4 (12 seeds: Pilot 7, Veteran 5;
 * two of Pilot's losses a Winchester jet extending low from the CAP until it hit the sea), Dogfight
 * 6/6/4, Defend 6/6/3. After r2 (the Gauntlet's clock and its CAP pair a notch down, one more
 * bandit and bomber on Pilot): Strike 6/6/4, Gauntlet 6/5/2, Dogfight 6/6/4, Defend 6/6/3.
 */
const BANDS: Record<string, Record<Difficulty, [number, number]>> = {
  ia_strike_auckland: { recruit: [5, 6], pilot: [5, 6], veteran: [3, 6] },
  ia_sam_gauntlet_auckland: { recruit: [5, 6], pilot: [4, 5], veteran: [1, 5] },
  ia_dogfight_auckland: { recruit: [5, 6], pilot: [5, 6], veteran: [3, 6] },
  ia_defend_auckland: { recruit: [5, 6], pilot: [5, 6], veteran: [2, 5] },
};

/**
 * Pilot runs (of 6) with two or more enemy rounds at the jet, and with the jet hit: the measured
 * numbers less one (playtest r2, 2.3-e: Dogfight 6 and 3, Defend 0 and 2, where a bomber's or the
 * escort's one round tells; before it Dogfight 1 and 0, Defend 0 and 0).
 */
const PILOT_UNDER_FIRE: Record<string, { underFire: number; hit: number }> = {
  ia_dogfight_auckland: { underFire: 5, hit: 2 },
  ia_defend_auckland: { underFire: 0, hit: 1 },
};

describe('Instant Action balance bands over 6 seeds (issue #60, playtest r1 and r2; before r1 Strike 5/2/0, Gauntlet 2/4/0, Dogfight 6/5/0)', () => {
  for (const id of IA_IDS) {
    const b = BANDS[id];
    it(`${id}: Recruit ${b.recruit.join('-')}/6, Pilot ${b.pilot.join('-')}/6, Veteran ${b.veteran.join('-')}/6, every run ends`, { timeout: 300_000 }, async () => {
      const shot: Partial<Record<Difficulty, number>> = {};
      for (const diff of ['recruit', 'pilot', 'veteran'] as const) {
        const r = await wins(id, diff);
        expect(r.won, r.log).toBeGreaterThanOrEqual(b[diff][0]);
        expect(r.won, r.log).toBeLessThanOrEqual(b[diff][1]);
        shot[diff] = r.samShot;
        // Pilot is fought under fire (playtest r2, 2.3-e: Dogfight and Defend were won untouched)
        const fire = PILOT_UNDER_FIRE[id];
        if (diff === 'pilot' && fire) {
          expect(r.underFire, r.log).toBeGreaterThanOrEqual(fire.underFire);
          expect(r.hit, r.log).toBeGreaterThanOrEqual(fire.hit);
        }
        // Strike's glide isn't silent (playtest r2, 2.3-e: 106-127 s in 17 of 18 runs)
        if (id === 'ia_strike_auckland' && diff !== 'veteran') expect(r.dead, r.log).toBeLessThanOrEqual(MAX_DEAD_STRETCH);
      }
      // the Gauntlet is flown through SAMs: one fires at the jet in most runs (r1: none on Recruit, 6 of 6)
      if (id === 'ia_sam_gauntlet_auckland') {
        expect(shot.recruit, JSON.stringify(shot)).toBeGreaterThanOrEqual(4);
        expect(shot.pilot, JSON.stringify(shot)).toBeGreaterThanOrEqual(4);
      }
    });
  }
  it("'mixed' flies no Su-35 / Su-57 on any difficulty (their R-77s decided every Veteran run, then every Ace run, since removed)", () => {
    for (const id of IA_IDS) {
      for (const g of missionById(id)!.script.groups) {
        if (g.team !== 'red') continue;
        expect(['mig29', 'su27'], `${id} ${g.id}`).toContain(g.type);
      }
    }
  });
  it('Strike: the SA-6 is off the run-in (east of the field), the SEAD fit carries a bomb per parked jet, and a clock ends a stalled sortie', () => {
    const def = missionById('ia_strike_auckland')!;
    const sa6 = def.script.sams.find((s) => s.type === 'sa6')!;
    const jets = def.script.ground.filter((g) => g.group === 'parked');
    const eastmost = Math.max(...jets.map((j) => j.x));
    expect(sa6.x).toBeGreaterThan(eastmost);
    expect(def.recommendedLoadout).toBe('sead_stealth');
    // the bot's wins take 205-335 s: the par leaves room for a second look
    expect(def.script.parTime).toBeGreaterThanOrEqual(600);
    // playtest r1 (1.3-h): Veteran's Tor shoots the glide bombs down, and a jet out of bombs with a
    // parked jet left circled until the sweep gave up (4 of 6 runs); the clock, over twice the slowest
    // win, ends it, and the briefing says how long
    expect(def.timeLimit).toBe(IA_STRIKE_TIME_LIMIT);
    expect(IA_STRIKE_TIME_LIMIT).toBeGreaterThanOrEqual(2 * 335);
    expect(def.briefing.join(' ')).toContain(`${IA_STRIKE_TIME_LIMIT / 60} minutes`);
  });
  it('Gauntlet and Strike offer the SEAD fit alone: no loadout that loses every run', () => {
    // playtest r2 (2.3-b): strike_beast (no AARGM, 60× the RCS) lost 0/12 on Pilot and Veteran in each,
    // shot down by the SA-6s or out of time; sead_precision, with no AMRAAM for the CAP, lost too
    for (const id of ['ia_sam_gauntlet_auckland', 'ia_strike_auckland']) {
      const def = missionById(id)!;
      expect(def.allowedLoadouts, id).toEqual(['sead_stealth']);
      expect(def.recommendedLoadout, id).toBe('sead_stealth');
    }
  });
  it('Gauntlet: a clock ends a stalled sortie (the briefing says how long), and the CAP pair flies a notch below the difficulty', () => {
    // playtest r2 (2.3-c): a Pilot jet Winchester after the CAP extended for 493 s with its bombs aboard,
    // and a parked jet hung the sweep at 900 s; the bot's slowest win takes 559 s
    const def = missionById('ia_sam_gauntlet_auckland')!;
    expect(def.timeLimit).toBe(IA_GAUNTLET_TIME_LIMIT);
    expect(IA_GAUNTLET_TIME_LIMIT).toBeGreaterThanOrEqual(1.25 * 559);
    expect(def.briefing.join(' ')).toContain(`${IA_GAUNTLET_TIME_LIMIT / 60} minutes`);
    // the pair at full skill decided Pilot's losses; one jet alone left Pilot untouched
    const cap = def.script.groups.find((g) => g.id === 'cap')!;
    expect(cap.count).toBe(2);
    expect(cap.countFor).toEqual({ recruit: 1 });
    expect(cap.skillOffset).toBeLessThan(0);
  });
  it('Pilot meets part of Veteran\'s threat: one more Dogfight bandit and Defend bomber than before', () => {
    // playtest r2 (2.3-e): Pilot Dogfight and Defend were won in every run with the jet untouched, at
    // Veteran's numbers (Dogfight) or below them (Defend)
    const spawned = (id: string, diff: Difficulty, group: (g: string) => boolean) => {
      const def = missionById(id)!;
      const tw = makeAiWorld(diff);
      createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES[diff], events: tw.events }).setup(tw.world, def.recommendedLoadout);
      return tw.world.aircraft.filter((a) => a.team === 'red' && group(a.groupId ?? '')).length;
    };
    const bandits = (g: string) => g.startsWith('bandits');
    expect(spawned('ia_dogfight_auckland', 'recruit', bandits)).toBe(3);
    expect(spawned('ia_dogfight_auckland', 'pilot', bandits)).toBe(5);
    expect(spawned('ia_dogfight_auckland', 'veteran', bandits)).toBe(4);
    const strikers = (g: string) => g === 'strikers';
    expect(spawned('ia_defend_auckland', 'recruit', strikers)).toBe(2);
    expect(spawned('ia_defend_auckland', 'pilot', strikers)).toBe(3);
    expect(spawned('ia_defend_auckland', 'veteran', strikers)).toBe(3);
  });
});

describe('Instant Action: enemy-count extremes (issue #60, playtest round 4)', () => {
  const defend = (enemyCount: number) => buildInstantMissionSeeded({ mode: 'defend', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount }, 1234);
  it('Defend at 8: four strikers, at most two escorts, and Vipers 2 and 3 on the wing', () => {
    const g = defend(8).script.groups;
    expect(g.find((x) => x.id === 'strikers')!.count).toBe(4);
    // three of them below Veteran (Pilot at 8: 4/6 with four, 5/6 with three)
    expect(g.find((x) => x.id === 'strikers')!.countFor).toEqual({ recruit: 3, pilot: 3 });
    // a smaller raid sends one bomber more on Pilot and Veteran (playtest r1, 1.3-i: Veteran won 6/6 with
    // two; r2, 2.3-e: so did Pilot, the jet hit once in 8 runs)
    expect(defend(6).script.groups.find((x) => x.id === 'strikers')!.countFor).toEqual({ pilot: 4, veteran: 4 });
    expect(defend(4).script.groups.find((x) => x.id === 'strikers')!.countFor).toEqual({ pilot: 3, veteran: 3 });
    expect(g.find((x) => x.id === 'escort')!.count).toBeLessThanOrEqual(2);
    expect(g.find((x) => x.role === 'wingman')!.count).toBe(2);
    expect(defend(4).script.groups.find((x) => x.role === 'wingman')!.count).toBe(1);
    // from 4 enemies (the default raid) Beast mode is the recommended fit: the stealth fit's 4 AMRAAMs
    // went Winchester with a striker left (playtest r1, 1.3-i: one Pilot sortie hung, one took 846 s)
    expect(DEFEND_BEAST_FROM).toBe(4);
    expect(defend(8).recommendedLoadout).toBe('a2a_beast');
    expect(defend(4).recommendedLoadout).toBe('a2a_beast');
    expect(defend(3).recommendedLoadout).toBe('a2a_stealth');
    expect(defend(8).allowedLoadouts).toContain('a2a_stealth');
  });
  it('the Defend escort spawns at most two jets on every difficulty', () => {
    for (const diff of ['recruit', 'pilot', 'veteran'] as const) {
      for (const n of [4, 6, 8]) {
        const def = defend(n);
        const tw = makeAiWorld(diff);
        createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES[diff], events: tw.events }).setup(tw.world, def.recommendedLoadout);
        const escorts = tw.world.aircraft.filter((a) => a.groupId === 'escort').length;
        expect(escorts, `${diff} at ${n}`).toBeGreaterThan(0);
        expect(escorts, `${diff} at ${n}`).toBeLessThanOrEqual(2);
      }
    }
  });
  // Measured with Beast mode (the recommended fit from 6 then, from 4 now) and three bombers below Veteran: Recruit
  // 3/3, Pilot 3/3 here and 5/6 over seeds 0-5 (0/3 with the stealth fit and four bombers:
  // Winchester with a striker left, gunned down on the way home). Floors one win under.
  it('Defend at 8 is winnable on Recruit (≥ 2/3; was 1/2) and Pilot (≥ 2/3; was 0/2)', { timeout: 300_000 }, async () => {
    const def = defend(8);
    const terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
    for (const [diff, need] of [['recruit', 2], ['pilot', 2]] as const) {
      const log: string[] = [];
      let won = 0;
      for (const seed of [0, 1, 2]) {
        const r = runPlaythrough(def, diff, seed, terrain, { maxT: 900 });
        await yieldToVitest();
        if (r.state === 'success') won++;
        log.push(`${diff} seed ${seed}: ${r.state}@${Math.round(r.t)}s ${r.reason ?? ''}`);
      }
      expect(won, log.join('\n')).toBeGreaterThanOrEqual(need);
    }
  });
  // enemyCount 1 is accepted as the easy end of the slider (round 4 found both modes 'empty'):
  // Defend is 2 strikers with no escort and no wingman (the bot wins in 96-98 s on Recruit and
  // Pilot); the Gauntlet is 2 sites short of the depot, no CAP, and the bot now wins it in ~240 s,
  // inside its 420 s par (was 625-653 s), with an SA-6 shot at it on Pilot.
  it('enemyCount 1: Defend is 2 strikers alone, the Gauntlet 2 sites, and the Gauntlet is flown inside its par time on Pilot', { timeout: 120_000 }, async () => {
    const d1 = defend(1).script.groups;
    expect(d1.find((x) => x.id === 'strikers')!.count).toBe(2);
    expect(d1.some((x) => x.id === 'escort' || x.role === 'wingman')).toBe(false);
    const g = buildInstantMissionSeeded({ mode: 'sam_gauntlet', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 1 }, 1234);
    expect(g.script.sams.length).toBe(2);
    expect(g.script.groups.filter((x) => x.team === 'red')).toEqual([]);
    const terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater: g.theater, seed: g.seed, resolution: 512, features: allFeatures(g.theater, []), pads: terrainPadsFor(g) })));
    const r = runPlaythrough(g, 'pilot', 0, terrain, { maxT: 900 });
    await yieldToVitest();
    expect(r.state, r.reason).toBe('success');
    expect(r.t).toBeLessThanOrEqual(g.script.parTime!);
  });
});
