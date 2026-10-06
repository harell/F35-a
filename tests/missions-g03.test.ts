/**
 * IRGC campaign mission 3, g03 "Stoat of Emergency" (#196, #197): through the Waiheke air defences to
 * one small target on the Onetangi dunes.
 *
 * The layout's promise is "no free route": the straight line crosses several threat rings, each
 * detour has its own threat and still ends inside the airstrip SA-6's ring, even the wide way round
 * Waiheke crosses rings (there is no clock to rule it out), and the target can't be found from above
 * the cloud. These are checked on the
 * real LINZ coast; the bot's route probes (#198) measure the same thing in flight.
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES, LOADOUTS, WEAPON_INFO } from '../src/core/data';
import { OVERCAST_DECK, cloudBase } from '../src/core/weather';
import type { Difficulty } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import type { TerrainQuery } from '../src/sim/api';
import { SAM_DATA } from '../src/sim/sam/samData';
import { rcsRangeFactor } from '../src/sim/sensors/signatures';
import { CAMPAIGNS, campaignOf, createMissionRunner, missionById, terrainPadsFor, validateMission } from '../src/missions';
import { G03, G03_BOATS, G03_GROUPS, G03_ISLAND_CUE, G03_NEST, G03_REVEAL, G03_SITES, G03_STOAT } from '../src/missions/content/irgcWaiheke';
import type { XZ } from '../src/missions/schema';
import { forceDestroy } from '../src/game/forceDestroy';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';

const DT = 1 / 60;
const PILOT = DIFFICULTIES.pilot;
/** A clean F-35A's head-on RCS (m², sensors/signatures.ts). */
const F35_RCS = 0.001;

let terrain: TerrainQuery | null = null;
function realTerrain(): TerrainQuery {
  terrain ??= new TerrainQueryImpl(runSync(generateTerrain({ theater: G03.theater, seed: G03.seed, resolution: 512, features: allFeatures(G03.theater, G03.features), pads: terrainPadsFor(G03) })));
  return terrain;
}

/**
 * Where a site sees a clean F-35 at Pilot (m): its radar against the jet's head-on RCS, or its close-in
 * cue, whichever is longer; a gun site's engagement range. The rings the "no free route" rules count.
 */
function ring(s: (typeof G03.script.sams)[number]): number {
  const d = SAM_DATA[s.type];
  const k = PILOT.samRangeScale;
  if (d.gun) return d.engageMax * k;
  const radar = d.detectRange * rcsRangeFactor(F35_RCS) * k;
  const cue = s.closeCue ?? d.closeCue;
  return Math.max(radar, cue ? cue.range * k : 0);
}

/** Closest distance (m) from point p to the polyline. */
function distToPath(p: XZ, path: XZ[]): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z));
  }
  return best;
}

/** Closest distance (m) between a site (fixed, or a patrolling boat anywhere on its route) and a flight path. */
function siteToPath(s: (typeof G03.script.sams)[number], path: XZ[]): number {
  if (!s.path) return distToPath(s, path);
  let best = Infinity;
  for (let i = 1; i < s.path.length; i++) {
    for (let k = 0; k <= 20; k++) {
      const a = s.path[i - 1];
      const b = s.path[i];
      best = Math.min(best, distToPath({ x: a.x + ((b.x - a.x) * k) / 20, z: a.z + ((b.z - a.z) * k) / 20 }, path));
    }
  }
  return best;
}

const length = (path: XZ[]) => path.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - path[i].x, p.z - path[i].z), 0);
/** The threat rings a flight path crosses (site ids). */
const crossed = (path: XZ[]) => G03.script.sams.filter((s) => siteToPath(s, path) < ring(s)).map((s) => s.id);

const START: XZ = { x: G03.player.x, z: G03.player.z };
/** The routes a player could try (m): the straight line and each way round. */
const ROUTES: Record<string, XZ[]> = {
  straight: [START, G03_NEST],
  // round the north of Rangitoto and Motutapu, then down onto Onetangi from the Gulf
  north: [START, { x: 5_000, z: -11_000 }, { x: 20_000, z: -13_000 }, G03_NEST],
  // down the Tāmaki Strait, then north across the island
  south: [START, { x: 12_000, z: 3_000 }, { x: 26_000, z: 3_000 }, G03_NEST],
  // the wide way: the strait, round Waiheke's east end (inside the AO) and back west along its north coast
  wide: [START, { x: 12_000, z: 3_000 }, { x: 36_500, z: 3_000 }, { x: 36_500, z: -9_000 }, G03_NEST],
};

function setup(difficulty: Difficulty = 'pilot') {
  const events = new EventBus();
  const diff = DIFFICULTIES[difficulty];
  const world = createSimWorld({ terrain: realTerrain(), difficulty: diff, events, combat: createCombatSystemSeeded(5) });
  const runner = createMissionRunner(G03, { createAi: createAiBrain, difficulty: diff, events });
  runner.setup(world, G03.recommendedLoadout);
  const p = world.player!;
  /** Run up to `seconds` with the player pinned at `at` (m, altitude MSL), unhurt. */
  const tick = (seconds: number, at: { x: number; y: number; z: number }) => {
    for (let i = 0; i < seconds * 60 && runner.state === 'running'; i++) {
      p.position.set(at.x, at.y, at.z);
      p.velocity.set(0, 0, 0);
      p.health = p.maxHealth;
      world.step(DT);
      runner.update(world, DT);
    }
  };
  const targets = () => world.ground.filter((g) => g.groupId === G03_GROUPS.target);
  return { world, runner, p, tick, targets };
}

describe('g03 Stoat of Emergency: content', () => {
  it('is the IRGC campaign mission 3, reachable by id (?mission=g03&autostart=1), valid, and not the finale', () => {
    expect(missionById('g03')).toBe(G03);
    expect(campaignOf('g03')?.id).toBe('irgc');
    const irgc = CAMPAIGNS.find((c) => c.id === 'irgc')!;
    expect(irgc.missions[2]).toBe(G03);
    expect(G03.index).toBe(3);
    expect(G03.title).toBe('Stoat of Emergency');
    expect(validateMission(G03)).toEqual([]);
    // the campaign is still being built: no ending yet
    expect(G03.script.campaignFinale).toBeFalsy();
  });

  it('flies the Precision SEAD loadout: two AARGM-ERs and two StormBreakers, no air-to-air missile', () => {
    expect(G03.allowedLoadouts).toEqual(['sead_precision']);
    const l = LOADOUTS.sead_precision;
    expect(l.stores).toEqual([
      { weapon: 'aargm', count: 2, internal: true },
      { weapon: 'gbu53', count: 2, internal: true },
    ]);
    expect(l.rcsMultiplier).toBe(1);
    for (const s of l.stores) expect(WEAPON_INFO[s.weapon].kind).not.toBe('aam');
    // two anti-radiation missiles can't clear the radars: the player has to choose
    const radars = G03.script.sams.filter((s) => SAM_DATA[s.type].radar).length;
    expect(radars).toBe(7);
    expect(radars).toBeGreaterThan(l.stores.find((s) => s.weapon === 'aargm')!.count * 3);
  });

  it('is overcast with the deck the rest of the game draws, and starts on a 0.55 fuel state with no clock', () => {
    expect(G03.weather).toBe('overcast');
    expect(cloudBase(G03.weather)).toBe(OVERCAST_DECK.altitude);
    expect(G03_REVEAL.below).toBe(OVERCAST_DECK.altitude);
    expect(G03.player.fuel).toBe(0.55);
    expect(G03.timeLimit).toBeUndefined();
  });
});

describe('g03: the layout on the real LINZ coast', () => {
  it('every fixed site is on land, and every boat starts and patrols on open water', { timeout: 60_000 }, () => {
    const t = realTerrain();
    for (const s of G03.script.sams) {
      if (s.type === 'ad_boat') {
        expect(t.isWater(s.x, s.z), s.id).toBe(true);
        const path = s.path!;
        for (let i = 1; i <= path.length; i++) {
          const a = path[i - 1];
          const b = path[i % path.length];
          for (let k = 0; k <= 20; k++) {
            const x = a.x + ((b.x - a.x) * k) / 20;
            const z = a.z + ((b.z - a.z) * k) / 20;
            expect(t.isWater(x, z), `${s.id} at ${Math.round(x)},${Math.round(z)}`).toBe(true);
          }
        }
      } else expect(t.isWater(s.x, s.z), s.id).toBe(false);
    }
    expect(t.isWater(G03_NEST.x, G03_NEST.z), 'nest').toBe(false);
  });

  it('the Tor covers the Motuihe SA-6 with its point defence', () => {
    const pd = SAM_DATA.sa15.pointDefense!;
    const d = Math.hypot(G03_SITES.motuiheSa6.x - G03_SITES.motuiheTor.x, G03_SITES.motuiheSa6.z - G03_SITES.motuiheTor.z);
    expect(d).toBeLessThan(pd.protect);
  });

  it('the end of every route is defended: the nest is inside the airstrip SA-6 ring and the ZSU reach', () => {
    const strip = G03.script.sams.find((s) => s.id === 'strip_sa6')!;
    const zsu = G03.script.sams.find((s) => s.id === 'ridge_zsu')!;
    expect(Math.hypot(strip.x - G03_NEST.x, strip.z - G03_NEST.z)).toBeLessThan(ring(strip));
    expect(Math.hypot(zsu.x - G03_NEST.x, zsu.z - G03_NEST.z)).toBeLessThan(ring(zsu));
    expect(strip.closeCue).toEqual(G03_ISLAND_CUE);
  });

  it('the straight line crosses at least two threat rings', () => {
    const c = crossed(ROUTES.straight);
    expect(c.length).toBeGreaterThanOrEqual(2);
    expect(c).toEqual(expect.arrayContaining(['mot_sa6', 'strip_sa6']));
  });

  it('each detour meets a boat and still ends in the airstrip ring', () => {
    expect(crossed(ROUTES.north)).toEqual(expect.arrayContaining(['ad_n1', 'strip_sa6']));
    expect(crossed(ROUTES.south)).toEqual(expect.arrayContaining(['ad_s', 'strip_sa6']));
    // and none of them is shorter than the straight line by enough to matter
    for (const r of ['north', 'south']) expect(length(ROUTES[r]), r).toBeGreaterThan(length(ROUTES.straight));
  });

  it('the wide way round Waiheke is no free route either: with no clock, its rings close it', () => {
    expect(crossed(ROUTES.wide)).toEqual(expect.arrayContaining(['ad_s', 'ad_n2', 'strip_sa6', 'ridge_zsu']));
    // and it is the long way: more than half as far again as the straight line
    expect(length(ROUTES.wide)).toBeGreaterThan(1.5 * length(ROUTES.straight));
    // the wide route stays inside the area of operations (±38 km)
    for (const p of ROUTES.wide) expect(Math.max(Math.abs(p.x), Math.abs(p.z))).toBeLessThan(38_000);
  });

  it('the boats patrol slowly enough to stay on their stretch of water', () => {
    expect(G03_BOATS.speed).toBeLessThanOrEqual(12);
    for (const s of G03.script.sams.filter((x) => x.type === 'ad_boat')) expect(s.loop, s.id).toBe(true);
  });
});

describe('g03: the target and the cloud', () => {
  it('the target is not revealed above the cloud, even straight over the nest', { timeout: 60_000 }, () => {
    const m = setup();
    m.tick(3, { x: G03_NEST.x, y: OVERCAST_DECK.altitude + 400, z: G03_NEST.z });
    expect(m.targets()).toEqual([]);
    m.runner.dispose?.();
  });

  it('nor from below the cloud outside the reveal radius', { timeout: 60_000 }, () => {
    const m = setup();
    m.tick(3, { x: G03_NEST.x - G03_REVEAL.radius - 1_000, y: 900, z: G03_NEST.z });
    expect(m.targets()).toEqual([]);
    m.runner.dispose?.();
  });

  it('a jet under the cloud within the radius reveals it; killing it wins', { timeout: 60_000 }, () => {
    const m = setup();
    m.tick(2, { x: G03_NEST.x - 4_000, y: 1_200, z: G03_NEST.z });
    const t = m.targets();
    expect(t).toHaveLength(1);
    expect(t[0].type).toBe('stoat');
    // on its dune line, short of the nest
    expect(Math.hypot(t[0].position.x - G03_NEST.x, t[0].position.z - G03_NEST.z)).toBeLessThan(600);
    forceDestroy(m.world, t[0], m.p.id);
    m.tick(2, { x: G03_NEST.x - 4_000, y: 1_200, z: G03_NEST.z });
    expect(m.runner.state).toBe('success');
    m.runner.dispose?.();
  });

  it('the stoat stays at its bait station, and waiting does not end the sortie', { timeout: 60_000 }, () => {
    const m = setup();
    // under the cloud near the nest from the start (revealed at once), unhurt, for six minutes
    m.tick(360, { x: G03_NEST.x - 4_000, y: 1_200, z: G03_NEST.z });
    expect(m.runner.state).toBe('running');
    const [t] = m.targets();
    expect(t.alive).toBe(true);
    expect(Math.hypot(t.position.x - G03_STOAT.station.x, t.position.z - G03_STOAT.station.z)).toBeLessThan(0.5);
    m.runner.dispose?.();
  });
});
