/**
 * Named superyachts (#145): Koru, A and Aquijo at their real berths (on the LINZ water, alongside the OSM quays), Serene
 * under way on her harbour loop, the per-yacht models built from their shape data, the names on the HUD and in the
 * debrief, and a yacht destroyed by the player counting as a civilian loss, never a kill or a failed sortie.
 */
import { describe, expect, it } from 'vitest';
import { Box3, Mesh, Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { AKL, geoToWorld } from '../src/core/auckland';
import { DIFFICULTIES } from '../src/core/data';
import type { MissionDef } from '../src/core/contracts';
import { SUPERYACHTS, SUPERYACHT_BERTHS, SUPERYACHT_IDS, UNDERWAY_YACHT, inSuperyachtBerth, type SuperyachtId } from '../src/core/superyachts';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { SUPERYACHT_HEALTH, VESSEL_DATA } from '../src/sim/damage/tables';
import { isCivilVessel, isSuperyacht, vesselNoun } from '../src/sim/civil/vessels';
import type { GroundTargetEntity } from '../src/sim/entities';
import { HARBOUR_LANE, PORT_BERTHS, lanePoints } from '../src/missions/runtime/shipping';
import { UNDERWAY_CHANCE, YACHT_LANE, YACHT_SPEED } from '../src/missions/runtime/superyachts';
import { buildInstantMissionSeeded, createMissionRunner, missionById } from '../src/missions';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { civilLossRows } from '../src/ui/screens/debrief';
import { entityLabel, trackLabel } from '../src/hud/hmd/format';
import { pipName } from '../src/hud/hmd/pip';
import { getGroundPrototype } from '../src/render/models/ground';
import { SHIP_DIMS } from '../src/render/visuals/shipMotion';
import { aucklandMapData } from '../src/world/terrain/theaters/auckland';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { distToPath } from '../src/world/scenery/aucklandOsm';
import { inRing, siteLayout } from '../src/world/scenery/aucklandSites';
import { segmentDistance } from '../src/world/terrain/coastline';
import { FlatTerrain } from './combat-helpers';

const DEG = Math.PI / 180;
const DT = 1 / 60;

/** Points round a hull outline (every 5 % of the length on both sides, the bowsprit tip), world XZ. */
function hullOutline(x: number, z: number, headingDeg: number, id: SuperyachtId): [number, number][] {
  const y = SUPERYACHTS[id];
  const fx = Math.sin(headingDeg * DEG);
  const fz = -Math.cos(headingDeg * DEG);
  const pts: [number, number][] = [];
  for (let k = -0.5; k <= 0.5001; k += 0.05)
    for (const w of [-0.5, 0, 0.5]) pts.push([x + fx * y.length * k - fz * y.beam * w, z + fz * y.length * k + fx * y.beam * w]);
  pts.push([x + fx * (y.length / 2 + y.bowsprit), z + fz * (y.length / 2 + y.bowsprit)]);
  return pts;
}

/* ───────────────────────── berths and the harbour loop (real LINZ / OSM data) ───────────────────────── */

describe('superyacht berths and route', () => {
  const map = aucklandMapData();
  const S = siteLayout()!;
  const piers = [...S.piers, ...S.port];
  /** Gap (m) from a point to the nearest quay: the LINZ coast, a pier, pontoon or wharf outline, an open pier way. */
  const quayGap = (x: number, z: number) =>
    Math.min(segmentDistance(map.segments, x, z), ...piers.map((r) => distToPath(r.pts, x, z, true)), ...S.pierLines.map((f) => distToPath(f.pts, x, z, false)));

  it('every berthed yacht lies alongside a real quay: the whole hull on the water, clear of every wharf, its side within 8 m of it', () => {
    expect(SUPERYACHT_BERTHS.length).toBeGreaterThanOrEqual(3);
    for (const b of SUPERYACHT_BERTHS) {
      let gap = Infinity;
      for (const [x, z] of hullOutline(b.x, b.z, b.heading, b.yacht)) {
        expect(map.isLand(x, z), `${b.yacht} @ ${x.toFixed(0)},${z.toFixed(0)}`).toBe(false);
        expect(piers.some((r) => inRing(r, x, z)), `${b.yacht} on a pier @ ${x.toFixed(0)},${z.toFixed(0)}`).toBe(false);
        gap = Math.min(gap, quayGap(x, z));
      }
      expect(gap, b.yacht).toBeLessThan(8);
      expect(gap, b.yacht).toBeGreaterThan(0.5);
    }
  });

  it('Koru on Wynyard Wharf, A at Silo Marina, Aquijo in the Viaduct (the berths the issue names, from OpenStreetMap)', () => {
    const at = (id: SuperyachtId) => SUPERYACHT_BERTHS.find((b) => b.yacht === id)!;
    // Wynyard Wharf (OSM ≈ −36.83766, 174.75937): Koru's side along its east face, her centre within 60 m of that point
    const wynyard = geoToWorld(-36.83766, 174.75937);
    const koru = at('koru');
    expect(Math.hypot(koru.x - wynyard.x, koru.z - wynyard.z)).toBeLessThan(60);
    expect(Math.min(...hullOutline(koru.x, koru.z, koru.heading, 'koru').map(([x, z]) => Math.hypot(x - wynyard.x, z - wynyard.z)))).toBeLessThan(40);
    const ring = (name: string) => S.marinas.find((m) => m.name === name)!;
    expect(inRing(ring('Silo Marina'), at('a').x, at('a').z)).toBe(true);
    expect(inRing(ring('Auckland Central Marina'), at('aquijo').x, at('aquijo').z)).toBe(true);
    expect(Math.hypot(at('aquijo').x - AKL.viaduct.x, at('aquijo').z - AKL.viaduct.z)).toBeLessThan(300);
  });

  it('the berths keep clear of each other and of the moored merchant ships; the marina yachts keep out of them', () => {
    for (let i = 0; i < SUPERYACHT_BERTHS.length; i++) {
      const a = SUPERYACHT_BERTHS[i];
      for (let j = i + 1; j < SUPERYACHT_BERTHS.length; j++) {
        const b = SUPERYACHT_BERTHS[j];
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan((SUPERYACHTS[a.yacht].length + SUPERYACHTS[b.yacht].length) / 2 + 20);
      }
      for (const p of PORT_BERTHS) expect(Math.hypot(a.x - p.x, a.z - p.z)).toBeGreaterThan(300);
      // inSuperyachtBerth (the scenery's marina-yacht filter) covers the hull, not the water off it
      expect(inSuperyachtBerth(a.x, a.z)).toBe(true);
      const across = (a.heading + 90) * DEG;
      expect(inSuperyachtBerth(a.x + Math.sin(across) * (SUPERYACHTS[a.yacht].beam / 2 + 12), a.z - Math.cos(across) * (SUPERYACHTS[a.yacht].beam / 2 + 12), 3)).toBe(false);
    }
  });

  it('the harbour loop: the whole hull on the water in more than 4 m, clear of the berths, the moored ships, the merchant lane and Rangitoto', () => {
    const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features: allFeatures('auckland', []), pads: [] }));
    const q = new TerrainQueryImpl(hf);
    const pts = lanePoints(YACHT_LANE);
    const lane = lanePoints(HARBOUR_LANE);
    expect(pts.length).toBeGreaterThan(300);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      expect(a.distanceTo(b)).toBeLessThan(60);
      const heading = Math.atan2(b.x - a.x, -(b.z - a.z)) / DEG;
      expect(q.heightAt(a.x, a.z), `depth @ ${a.x.toFixed(0)},${a.z.toFixed(0)}`).toBeLessThan(-4);
      for (const [x, z] of hullOutline(a.x, a.z, heading, UNDERWAY_YACHT)) expect(map.isLand(x, z), `loop hull @ ${x.toFixed(0)},${z.toFixed(0)}`).toBe(false);
      for (const p of PORT_BERTHS) expect(Math.hypot(a.x - p.x, a.z - p.z), `moored ship @ ${p.x},${p.z}`).toBeGreaterThan(250);
      for (const p of SUPERYACHT_BERTHS) expect(Math.hypot(a.x - p.x, a.z - p.z)).toBeGreaterThan(200);
      for (const p of lane) expect(a.distanceTo(p)).toBeGreaterThan(250);
      expect(Math.hypot(a.x - AKL.rangitoto.x, a.z - AKL.rangitoto.z)).toBeGreaterThan(2800 + 1000);
    }
    // it heads out toward Rangitoto: the far turn is under North Head, within 1 km of it
    const far = pts.reduce((m, p) => (p.x > m.x ? p : m));
    expect(Math.hypot(far.x - AKL.north_head.x, far.z - AKL.north_head.z)).toBeLessThan(1000);
  }, 120_000);
});

/* ───────────────────────── shape data and models ───────────────────────── */

describe('superyacht models', () => {
  it('each yacht is her own vessel class, her hull volume and model sized from her shape data', () => {
    expect(SUPERYACHT_IDS.sort()).toEqual(['a', 'aquijo', 'koru', 'serene']);
    for (const id of SUPERYACHT_IDS) {
      const y = SUPERYACHTS[id];
      expect(VESSEL_DATA[id]).toEqual({ length: y.length, beam: y.beam, height: y.height, health: SUPERYACHT_HEALTH });
      expect(SHIP_DIMS[id].funnel).toBeNull();
      expect(vesselNoun(id)).toBe('yacht');
      const p = getGroundPrototype('ship', 'green', id);
      expect(p.spinners).toEqual([]);
      expect(p.wreck).toBe('ship');
      const meshes: Mesh[] = [];
      p.root.traverse((o) => o instanceof Mesh && meshes.push(o));
      expect(meshes).toHaveLength(1); // one draw call
      const tris = meshes[0].geometry.attributes.position.count / 3;
      expect(tris, id).toBeLessThan(3_000);
      const bb = new Box3().setFromObject(p.root);
      const size = bb.getSize(new Vector3());
      expect(size.z, id).toBeGreaterThan(y.length - 1);
      expect(size.z, id).toBeLessThan(y.length + y.bowsprit + 2);
      expect(size.x, id).toBeGreaterThan(y.beam * 0.95);
      expect(size.x, id).toBeLessThan(y.beam * 1.1);
      expect(bb.max.y, id).toBeGreaterThan(y.air - 1.5);
      expect(bb.max.y, id).toBeLessThan(y.air + 2.5);
      // night: navigation lights, lit windows and the underwater lights along both sides
      expect(p.lights.filter((l) => l.kind === 'way').length).toBeGreaterThanOrEqual(3);
      expect(p.lights.filter((l) => l.kind === 'deck' && l.color === 0x38c8ff).length).toBeGreaterThanOrEqual(10);
      expect(p.lights.filter((l) => l.kind === 'deck' && l.color !== 0x38c8ff).length).toBeGreaterThanOrEqual(6);
    }
  });

  it('A has her reverse bow (the waterline reaches past the deck), Koru her clipper bow and bowsprit; the sailing yachts carry their masts', () => {
    const extent = (id: SuperyachtId, y0: number, y1: number) => {
      const p = getGroundPrototype('ship', 'green', id);
      const pos = (p.root.children.find((o) => o instanceof Mesh) as Mesh).geometry.attributes.position;
      let min = Infinity;
      for (let i = 0; i < pos.count; i++) if (pos.getY(i) >= y0 && pos.getY(i) <= y1) min = Math.min(min, pos.getZ(i));
      return min;
    };
    // bow at -Z: A's forefoot (just above the waterline) is further forward than her deck edge
    expect(extent('a', 0, 1)).toBeLessThan(extent('a', 5, 9) - 5);
    expect(extent('koru', 0, 1)).toBeGreaterThan(extent('koru', 5, 9) + 4);
    expect(extent('koru', 6, 10)).toBeLessThan(-SUPERYACHTS.koru.length / 2 - 10); // the bowsprit
    expect(SUPERYACHTS.koru.masts).toHaveLength(3);
    expect(SUPERYACHTS.aquijo.masts).toHaveLength(2);
    expect(SUPERYACHTS.serene.masts).toHaveLength(0);
    expect(SUPERYACHTS.a.tumble).toBeLessThan(0.9);
  });
});

/* ───────────────────────── in a sortie ───────────────────────── */

describe('superyachts in missions', () => {
  function setup(def: MissionDef, civilTraffic?: boolean) {
    const events = new EventBus();
    const world = createSimWorld({ terrain: new FlatTerrain(-20), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
    const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events, civilTraffic } as Parameters<typeof createMissionRunner>[1]);
    runner.setup(world, def.recommendedLoadout);
    const radio: string[] = [];
    const hud: string[] = [];
    events.on('radio', (e) => radio.push(e.text));
    events.on('hud:message', (e) => hud.push(e.text));
    const tick = (seconds: number) => {
      for (let i = 0; i < seconds * 60 && runner.state === 'running'; i++) {
        world.step(DT);
        runner.update(world, DT);
      }
    };
    const yachts = () => world.ground.filter((g) => isSuperyacht(g));
    return { world, runner, radio, hud, tick, yachts };
  }
  const stroll = (seed: number) =>
    buildInstantMissionSeeded({ mode: 'stroll', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 1 }, seed);

  it('spawns Koru, A and Aquijo at their berths: neutral, unknown to the intel picture, moored, named', () => {
    const m = setup(missionById('g01')!);
    const ys = m.yachts();
    expect(ys.length).toBeGreaterThanOrEqual(3);
    expect(ys.length).toBeLessThanOrEqual(4);
    for (const b of SUPERYACHT_BERTHS) {
      const y = ys.find((e) => e.vessel === b.yacht)!;
      expect(y, b.yacht).toBeDefined();
      expect(Math.hypot(y.position.x - b.x, y.position.z - b.z)).toBeLessThan(0.01);
      expect(y.name).toBe(SUPERYACHTS[b.yacht].name);
      expect(y.team).toBe('neutral');
      expect(isCivilVessel(y)).toBe(true);
      expect(y.known).toBe(false);
      expect(y.speed).toBe(0);
      expect(y.anchored).toBe(false);
      expect(y.health).toBe(SUPERYACHT_HEALTH);
      expect(y.hitsToSink).toBe(1);
      expect(m.world.hostilesOf('blue')).not.toContain(y);
      expect(m.world.hostilesOf('red')).not.toContain(y);
    }
    m.tick(30);
    for (const b of SUPERYACHT_BERTHS) {
      const y = ys.find((e) => e.vessel === b.yacht)!;
      expect(Math.hypot(y.position.x - b.x, y.position.z - b.z)).toBeLessThan(0.01); // still at her berth
    }
    m.runner.dispose?.();
    const off = setup(missionById('g01')!, false);
    expect(off.yachts()).toHaveLength(0);
    off.runner.dispose?.();
  });

  it('Serene sails her harbour loop at 10 kn in the stroll (always), about half the combat sorties', () => {
    const pts = lanePoints(YACHT_LANE);
    for (const seed of [1, 2, 3]) {
      const m = setup(stroll(seed));
      const s = m.yachts().find((y) => y.vessel === UNDERWAY_YACHT)!;
      expect(s).toBeDefined();
      expect(s.path).toBeTruthy();
      expect(pts.some((p) => p.distanceTo(s.position) < 1)).toBe(true);
      const p0 = s.position.clone();
      m.tick(60);
      expect(s.alive).toBe(true);
      expect(s.velocity.length()).toBeCloseTo(YACHT_SPEED, 3);
      expect(s.position.distanceTo(p0)).toBeGreaterThan(YACHT_SPEED * 60 * 0.9);
      // still on the loop (within a waypoint step of it)
      expect(Math.min(...pts.map((p) => p.distanceTo(s.position)))).toBeLessThan(30);
      m.runner.dispose?.();
    }
    let under = 0;
    const N = 24;
    for (let seed = 1; seed <= N; seed++) {
      const m = setup({ ...missionById('g01')!, seed });
      if (m.yachts().some((y) => y.path)) under++;
      m.runner.dispose?.();
    }
    expect(under / N).toBeGreaterThan(UNDERWAY_CHANCE - 0.3);
    expect(under / N).toBeLessThan(UNDERWAY_CHANCE + 0.3);
  });

  it('named on the designated box, the TSD and the pod window ("KORU"); the undesignated boxes still say CIV', () => {
    const m = setup(missionById('g01')!);
    const koru = m.yachts().find((y) => y.vessel === 'koru')!;
    expect(trackLabel(koru)).toBe('KORU');
    expect(pipName(koru)).toBe('KORU');
    expect(entityLabel(koru)).toBe('CIV');
    const a = m.yachts().find((y) => y.vessel === 'a')!;
    expect(trackLabel(a)).toBe('A');
    m.runner.dispose?.();
  });

  it('the player sinks Koru: CIVILIAN YACHT DESTROYED, check fire naming her, no kill, a civilian loss in the debrief, the sortie goes on', () => {
    const m = setup(missionById('g01')!);
    m.tick(1);
    const p = m.world.player!;
    const koru: GroundTargetEntity = m.yachts().find((y) => y.vessel === 'koru')!;
    m.world.applyDamage(koru, 1, p.id, 'gbu53'); // any bomb hit sinks her
    m.tick(6);
    expect(koru.alive).toBe(false);
    expect(m.hud).toContain('CIVILIAN YACHT DESTROYED');
    expect(m.hud).not.toContain('CIVILIAN SHIP DESTROYED');
    expect(m.radio.some((t) => /check fire/i.test(t) && t.includes('civilian yacht Koru'))).toBe(true);
    expect(p.kills).toBe(0);
    expect(m.runner.state).toBe('running');
    const r = m.runner.result(m.world) as MissionResultExt;
    expect(r.kills.ground).toBe(0);
    expect(r.civilianKills).toBe(1);
    expect(r.civilianShipKills ?? 0).toBe(0);
    expect(r.civilianYachts).toEqual(['Koru']);
    expect(civilLossRows(r)).toEqual([['skull', 'Superyacht sunk', 'Koru']]);
    m.runner.dispose?.();
  });

  it('a held gun pass sinks one too; one lost to somebody else is reported, not counted against the player', () => {
    const m = setup(missionById('g01')!);
    m.tick(1);
    const p = m.world.player!;
    const [a, b] = m.yachts();
    m.world.applyDamage(a, 1_300, p.id, 'gun');
    m.world.applyDamage(b, 50, null, 'gbu31');
    m.tick(3);
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
    expect(m.hud).toContain(`${b.name.toUpperCase()} SUNK`);
    const r = m.runner.result(m.world) as MissionResultExt;
    expect(r.civilianKills).toBe(1);
    expect(r.civilianYachts).toEqual([a.name]);
    m.runner.dispose?.();
  });

  it('two yachts lost: one debrief row naming both, after the other civil losses', () => {
    expect(civilLossRows({ civilianKills: 3, civilianShipKills: 1, civilianYachts: ['Koru', 'Aquijo'] } as MissionResultExt)).toEqual([
      ['skull', 'Civil ships destroyed', '1'],
      ['skull', 'Superyachts sunk', 'Koru, Aquijo'],
    ]);
  });
});
