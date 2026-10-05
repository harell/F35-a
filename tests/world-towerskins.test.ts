/**
 * Skins of the CBD tower kit's best-known towers (core/cbdTowerSkins.ts, world/scenery/towerSkins.ts): each skin names a
 * kit tower and sits on its shaft, the walls are painted by zone and face, every sign lands on a wall, and the signs
 * fall with their tower.
 */
import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import { CBD_TOWER_SKINS } from '../src/core/cbdTowerSkins';
import { CBD_TOWERS } from '../src/core/cbdTowersData';
import { GeometryBuilder, WIN_BANDS, WIN_CURTAIN } from '../src/world/scenery/GeometryBuilder';
import { addTowerSigns, emptySigns, outerWall, paintedWalls, skinParts, towerSignGeometry } from '../src/world/scenery/towerSkins';
import { CbdCollapseVisual, RUBBLE_HEIGHT } from '../src/world/scenery/cbdCollapse';
import { buildingCollapseTime } from '../src/sim/buildings';

const tower = (n: number) => CBD_TOWERS.find((t) => t.n === n)!;

describe('CBD tower skins', () => {
  it('each skin names a kit tower once, its box centre inside the tower outline', () => {
    expect(new Set(CBD_TOWER_SKINS.map((s) => s.n)).size).toBe(CBD_TOWER_SKINS.length);
    for (const s of CBD_TOWER_SKINS) {
      const t = tower(s.n);
      expect(t, `row ${s.n}`).toBeDefined();
      const o = t.outline;
      let c = false;
      for (let i = 0, j = o.length - 2; i < o.length; j = i, i += 2)
        if (o[i + 1] > s.box.z !== o[j + 1] > s.box.z && s.box.x < ((o[j] - o[i]) * (s.box.z - o[i + 1])) / (o[j + 1] - o[i + 1]) + o[i]) c = !c;
      expect(c, t.name).toBe(true);
    }
  });

  it('paints a box by face and height: the HSBC strip on its north face, bands beside it, nothing missing', () => {
    const s = CBD_TOWER_SKINS.find((k) => k.n === 11)!;
    const { x, z } = s.box;
    // a 40 m square turned like the tower's shaft, 0–90 m over ground 0
    const a = (s.box.face * Math.PI) / 180;
    const nx = Math.sin(a), nz = -Math.cos(a), rx = nz, rz = -nx;
    const ring: number[] = [];
    for (const [u, v] of [[-20, -20], [20, -20], [20, 20], [-20, 20]]) ring.push(x + rx * u + nx * v, z + rz * u + nz * v);
    const B = new GeometryBuilder();
    paintedWalls(B, s, ring, 0, () => 90, 0, { colour: 0xff00ff, win: 0 });
    const geo = B.build()!;
    const pos = geo.getAttribute('position');
    const win = geo.getAttribute('aWin');
    const nrm = geo.getAttribute('normal');
    let strip = 0;
    let area = 0;
    for (let q = 0; q < pos.count; q += 4) {
      const w = Math.hypot(pos.getX(q + 1) - pos.getX(q), pos.getZ(q + 1) - pos.getZ(q));
      const h = pos.getY(q + 3) - pos.getY(q);
      area += w * h;
      const north = nrm.getX(q) * nx + nrm.getZ(q) * nz > 0.9;
      const cx = (pos.getX(q) + pos.getX(q + 1)) / 2, cz = (pos.getZ(q) + pos.getZ(q + 1)) / 2;
      const t = (cx - x) * rx + (cz - z) * rz;
      const y = (pos.getY(q) + pos.getY(q + 3)) / 2;
      if (north && t > -5 && t < 3.5 && y < 87 + s.dy) {
        expect(win.getX(q)).toBe(WIN_CURTAIN);
        strip += w * h;
      } else if (north && y < 87 + s.dy) expect(win.getX(q)).toBe(WIN_BANDS);
    }
    expect(area).toBeCloseTo(4 * 40 * 90, 0);
    expect(strip).toBeCloseTo(8.5 * 90, 0); // (the strip reaches 87 + dy m, over this 90 m box)
  });

  it('every sign stands on a wall of its tower, within 3 m of its box face', () => {
    for (const s of CBD_TOWER_SKINS) {
      const t = tower(s.n);
      const parts = skinParts(t.parts.filter((p) => p.kind !== 'spire') as never, 0);
      for (const sg of s.signs ?? []) {
        const k = Math.round(((((sg.face - s.box.face) % 360) + 360) % 360) / 90) % 4;
        const out = outerWall(s, parts, k, sg.t, sg.h + s.dy);
        expect(out, `${t.name} sign at ${sg.face}°`).not.toBeNull();
      }
      const d = emptySigns();
      addTowerSigns(d, 0, s, parts, 0);
      expect(d.pos.length / 12, t.name).toBe((s.signs ?? []).length);
    }
  });

  it('a tower’s signs come down with it', () => {
    const s = CBD_TOWER_SKINS[0];
    const t = tower(s.n);
    const d = emptySigns();
    addTowerSigns(d, 0, s, skinParts(t.parts.filter((p) => p.kind !== 'spire') as never, 0), 0);
    const signs = towerSignGeometry(d)!;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0, 100, 0]), 3));
    const vis = new CbdCollapseVisual(geo, new Int32Array([0, 2]), new Float32Array([0]), [], null, { geo: signs, ranges: d.ranges });
    const top = 120;
    const world = { time: 0, buildings: { version: 1, collapsed: [0], collapsedAt: new Map([[0, 0]]), geo: { buildings: [{ id: 0, top, ground: 0 }] } } };
    vis.update(world as never);
    world.time = buildingCollapseTime(top) + 1;
    vis.update(world as never);
    const p = signs.getAttribute('position');
    for (let i = 0; i < p.count; i++) expect(p.getY(i)).toBeLessThanOrEqual(RUBBLE_HEIGHT + 1e-3);
  });
});
