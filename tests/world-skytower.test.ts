/**
 * The Sky Tower model (issue #16): shape from the OSM profile (heights ±2 m, radii ±1 m against
 * the issue's table), its own meshes and lights, the collapse driven by the sim landmark, and the
 * ruin. Issue #75: every scene builds it standing (it is never down for good), and an enemy hit
 * leaves the meshes standing (the damage is fire and smoke, drawn by the effects).
 */
import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, PointsMaterial, Vector3, type Mesh } from 'three';
import { AKL } from '../src/core/auckland';
import { COLLAPSE, SKY_TOWER_BANDS, SKY_TOWER_HEIGHT, SKY_TOWER_LEGS, headingDir } from '../src/core/skyTower';
import { createSkyTower, destroyLandmark, hitLandmark } from '../src/sim/landmarks';
import { EventBus } from '../src/core/events';
import type { SimWorld } from '../src/sim/api';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { SkyTowerVisual, buildSkyTowerRuins, buildTowerSection, skyTowerGround } from '../src/world/scenery/skyTower';

/** The issue's OSM table: [y0, y1, r] per part (r = mean radius about the axis). */
const OSM_TABLE: [string, number, number, number][] = [
  ['shaft', 0, 182, 6.1],
  ['collar', 35, 45, 7.7],
  ['service level', 154, 159, 9.5],
  ['metal levels', 159, 179, 10.4],
  ['fire refuge', 165, 172, 10.6],
  ['SkyBar', 179, 183, 11.7],
  ['Main Observation Level', 183, 187, 13.6],
  ['Orbit 360° Dining', 187, 194, 16.6],
  ['The Sugar Club', 194, 198, 15.8],
  ['upper pod', 198, 242, 10.8],
  ['Sky Deck', 220, 224, 6.5],
  ['mast', 182, 290, 2.1],
  ['mast', 290, 310, 1.3],
  ['mast tip', 310, 328, 0.6],
];

const GROUND = 30;
const height = () => GROUND + 2; // skyTowerGround subtracts 2 (the scenery's sink)

function vertices(b: GeometryBuilder): Vector3[] {
  const g = b.build()!;
  const p = g.getAttribute('position');
  const out: Vector3[] = [];
  for (let i = 0; i < p.count; i++) out.push(new Vector3(p.getX(i), p.getY(i), p.getZ(i)));
  return out;
}

describe('Sky Tower model', () => {
  it('matches the OSM table (heights ±2 m, radii ±1 m)', () => {
    for (const [name, y0, y1, r] of OSM_TABLE) {
      const band = SKY_TOWER_BANDS.find((b) => b.name === name && Math.abs(b.y0 - y0) <= 2 && b.r0 > 0 && Math.abs(b.r0 - r) <= 1);
      expect(band, `${name} ${y0}-${y1}`).toBeTruthy();
      // a split band (metal levels around the refuge) still spans the table's heights
      const span = SKY_TOWER_BANDS.filter((b) => b.name === name && b.y0 >= y0 - 2 && b.y1 <= y1 + 2);
      expect(Math.min(...span.map((b) => b.y0))).toBeCloseTo(y0, 0);
      expect(Math.max(...span.map((b) => b.y1))).toBeCloseTo(y1, 0);
    }
    expect(SKY_TOWER_HEIGHT).toBe(328);
    // the upper pod is a cone (OSM roof:shape=pyramidal, roof:height=44)
    const pod = SKY_TOWER_BANDS.find((b) => b.name === 'upper pod')!;
    expect(pod.r1).toBe(0);
    expect(pod.y1 - pod.y0).toBe(44);
  });

  it('builds to the profile: 328 m tall, widest at the pod, 8 sloped legs', () => {
    const b = new GeometryBuilder();
    buildTowerSection(b, 0, SKY_TOWER_HEIGHT, 0);
    const v = vertices(b);
    expect(Math.max(...v.map((p) => p.y))).toBeCloseTo(328, 3);
    expect(Math.min(...v.map((p) => p.y))).toBeCloseTo(0, 3);
    const r = (p: Vector3) => Math.hypot(p.x, p.z);
    expect(Math.max(...v.map(r))).toBeCloseTo(20.1, 3); // SkyWalk ring
    // nothing pokes out beyond the band covering its height
    const maxR = (y: number) => {
      let m = y <= SKY_TOWER_LEGS.height ? SKY_TOWER_LEGS.rOut : 0;
      for (const band of SKY_TOWER_BANDS) if (y >= band.y0 - 1e-3 && y <= band.y1 + 1e-3) m = Math.max(m, band.r0 + ((band.r1 - band.r0) * (y - band.y0)) / (band.y1 - band.y0));
      return m;
    };
    for (const p of v) expect(r(p)).toBeLessThanOrEqual(maxR(p.y) + 0.05);
    // the 8 buttress legs reach the ground at r 7.8, every 45°
    const feet = v.filter((p) => p.y < 0.01 && r(p) > 7.5);
    const dirs = new Set(feet.map((p) => Math.round(((Math.atan2(p.x, -p.z) * 180) / Math.PI + 360) % 360 / 45) % 8));
    expect(dirs.size).toBe(8);
  });

  it('the three pieces (stump, upper section, mast) add up to the whole', () => {
    const whole = new GeometryBuilder();
    buildTowerSection(whole, 0, SKY_TOWER_HEIGHT, 0);
    const parts = [new GeometryBuilder(), new GeometryBuilder(), new GeometryBuilder()];
    buildTowerSection(parts[0], 0, COLLAPSE.breakHeight, 0);
    buildTowerSection(parts[1], COLLAPSE.breakHeight, COLLAPSE.mastSnapHeight, COLLAPSE.breakHeight);
    buildTowerSection(parts[2], COLLAPSE.mastSnapHeight, SKY_TOWER_HEIGHT, COLLAPSE.mastSnapHeight);
    const upper = vertices(parts[1]);
    expect(Math.min(...upper.map((p) => p.y))).toBeCloseTo(0, 3); // origin at the break
    expect(Math.max(...vertices(parts[2]).map((p) => p.y))).toBeCloseTo(SKY_TOWER_HEIGHT - COLLAPSE.mastSnapHeight, 3);
    // cut ends get caps: a few more triangles than the whole, never fewer
    const sum = parts.reduce((n, p) => n + p.triangleCount, 0);
    expect(sum).toBeGreaterThanOrEqual(whole.triangleCount);
    expect(sum).toBeLessThan(whole.triangleCount * 1.3);
  });
});

function fakeWorld(time: number, landmarks = [createSkyTower(GROUND)]): SimWorld {
  return { time, landmarks } as unknown as SimWorld;
}

describe('Sky Tower visual', () => {
  const mat = new MeshBasicMaterial();
  const lightsMat = new PointsMaterial();

  it('is its own group of meshes with its own lights and pod reflections', () => {
    const v = new SkyTowerVisual(mat, lightsMat, height);
    expect(v.group.name).toBe('akl-skytower');
    const names: string[] = [];
    v.group.traverse((o) => names.push(o.name));
    expect(names).toEqual(expect.arrayContaining(['akl-skytower-base', 'akl-skytower-upper', 'akl-skytower-mast', 'akl-skytower-lights']));
    expect(v.reflectionSources.length).toBeGreaterThan(0);
    expect(v.state).toBe('standing');
    // daytime: no lights at all
    const day = new SkyTowerVisual(mat, null, height);
    day.group.traverse((o) => expect(o.name).not.toBe('akl-skytower-lights'));
  });

  it('follows the sim: lights out on the break, topples, then the ruin under the dust', () => {
    const v = new SkyTowerVisual(mat, lightsMat, height);
    const reflections = { visible: true };
    v.setReflections(reflections as never);
    const lm = createSkyTower(GROUND);
    const world = fakeWorld(10, [lm]);
    v.update(world);
    expect(v.state).toBe('standing');
    // hit from the east → falls west
    destroyLandmark(lm, new EventBus(), 10, new Vector3(AKL.skytower.x + 15, GROUND + 190, AKL.skytower.z), 1, 'aim120');
    const find = (n: string) => {
      let m: Mesh | null = null;
      v.group.traverse((o) => {
        if (o.name === n) m = o as Mesh;
      });
      return m as unknown as Mesh;
    };
    (world as { time: number }).time = 10 + COLLAPSE.impactAt * 0.8;
    v.update(world);
    expect(v.state).toBe('falling');
    expect(find('akl-skytower-lights').visible).toBe(false);
    expect(reflections.visible).toBe(false);
    const upper = find('akl-skytower-upper');
    upper.updateMatrixWorld(true);
    const top = new Vector3(0, 100, 0).applyMatrix4(upper.matrixWorld);
    expect(top.x).toBeLessThan(AKL.skytower.x - 40); // leaning west
    expect(Math.abs(top.z - AKL.skytower.z)).toBeLessThan(1);
    (world as { time: number }).time = 10 + COLLAPSE.ruinsAt + 0.1;
    v.update(world);
    expect(v.state).toBe('ruin');
    expect(find('akl-skytower-upper').visible).toBe(false);
    expect(find('akl-skytower-ruin')).toBeTruthy();
  });

  it('a damaged tower (one enemy hit) stays standing with its lights on; the second hit topples it', () => {
    const v = new SkyTowerVisual(mat, lightsMat, height);
    const lm = createSkyTower(GROUND);
    const world = fakeWorld(10, [lm]);
    const events = new EventBus();
    hitLandmark(lm, events, 10);
    (world as { time: number }).time = 30;
    v.update(world);
    expect(v.state).toBe('standing');
    let lights: Mesh | null = null;
    v.group.traverse((o) => {
      if (o.name === 'akl-skytower-lights') lights = o as Mesh;
    });
    expect((lights as unknown as Mesh).visible).toBe(true);
    hitLandmark(lm, events, 30);
    (world as { time: number }).time = 30 + COLLAPSE.impactAt * 0.5;
    v.update(world);
    expect(v.state).toBe('falling');
  });

  it('a new scene always builds the tower standing, with no ruin (never destroyed for good)', () => {
    const v = new SkyTowerVisual(mat, lightsMat, height);
    expect(v.state).toBe('standing');
    const names: string[] = [];
    v.group.traverse((o) => names.push(o.name));
    expect(names).not.toContain('akl-skytower-ruin');
    expect(names).toContain('akl-skytower-upper');
  });

  it('the ruin: a stump below the break and rubble out along the fall line', () => {
    const heading = (200 * Math.PI) / 180;
    const b = new GeometryBuilder();
    buildSkyTowerRuins(b, height, heading);
    const v = vertices(b);
    const g = skyTowerGround(height);
    const [ux, uz] = headingDir(heading);
    const along = (p: Vector3) => (p.x - AKL.skytower.x) * ux + (p.z - AKL.skytower.z) * uz;
    expect(Math.max(...v.map((p) => p.y - g))).toBeLessThan(COLLAPSE.breakHeight + 6);
    expect(Math.max(...v.map((p) => p.y - g))).toBeGreaterThan(COLLAPSE.breakHeight - 10);
    expect(Math.max(...v.map(along))).toBeGreaterThan(250); // the mast lies ~280 m out
    expect(Math.min(...v.map(along))).toBeGreaterThan(-40);
    // deterministic
    const b2 = new GeometryBuilder();
    buildSkyTowerRuins(b2, height, heading);
    expect(b2.triangleCount).toBe(b.triangleCount);
  });
});
