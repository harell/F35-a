/**
 * Skins of the CBD tower kit's best-known towers (core/cbdTowerSkins.ts, world/scenery/towerSkins.ts): each skin names a
 * kit tower and sits on its shaft, the walls are painted by zone and face, every sign lands on a wall, and the signs
 * fall with their tower.
 */
import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import { CBD_TOWER_SKINS, type TowerSkin } from '../src/core/cbdTowerSkins';
import { KIT_TOWERS } from '../src/world/scenery/aucklandBuildings';
import { GeometryBuilder, WIN_BANDS, WIN_CURTAIN } from '../src/world/scenery/GeometryBuilder';
import { addTowerSigns, buildBraces, emptySigns, outerWall, paintedWalls, skinParts, towerSignGeometry } from '../src/world/scenery/towerSkins';
import { ATLAS_H, ATLAS_USED, logoSlot, SIGN_LOGOS } from '../src/world/scenery/towerLogos';
import { CbdCollapseVisual, RUBBLE_HEIGHT } from '../src/world/scenery/cbdCollapse';
import { buildingCollapseTime } from '../src/sim/buildings';

const tower = (n: number) => KIT_TOWERS.find((t) => t.n === n)!;

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

  it('every brace and drawn line lands on its own face of its tower', () => {
    for (const s of CBD_TOWER_SKINS) {
      if (!s.braces?.length && !s.lines?.length) continue;
      const t = tower(s.n);
      const parts = skinParts(t.parts.filter((p) => p.kind !== 'spire') as never, 0);
      for (const ln of [...(s.braces ?? []), ...(s.lines ?? [])]) {
        const only = { ...s, braces: 'node' in ln ? [ln] : [], lines: 'pts' in ln ? [ln] : [] } as TowerSkin;
        const B = new GeometryBuilder();
        buildBraces(B, only, parts, 0);
        expect(B.triangleCount, `${t.name} ${'pts' in ln ? 'line' : 'brace'} on ${ln.face}°`).toBeGreaterThan(0);
        // every beam stands within 7 m of the box face it was drawn on
        const geo = B.build()!;
        const pos = geo.getAttribute('position');
        const k = Math.round(((((ln.face - s.box.face) % 360) + 360) % 360) / 90) % 4;
        const a = ((s.box.face + 90 * k) * Math.PI) / 180;
        const nx = Math.sin(a), nz = -Math.cos(a);
        let far = -Infinity;
        for (const p of parts) for (let i = 0; i < p.ring.length; i += 2) far = Math.max(far, (p.ring[i] - s.box.x) * nx + (p.ring[i + 1] - s.box.z) * nz);
        for (let i = 0; i < pos.count; i++) {
          const out = (pos.getX(i) - s.box.x) * nx + (pos.getZ(i) - s.box.z) * nz;
          expect(out, t.name).toBeGreaterThan(far - 7.5);
        }
      }
    }
  });

  it('bracing is a lattice: per module one straight diagonal each way, every end on an edge of the band or a node', () => {
    // R32-3: members that followed the LiDAR walls broke into loose sticks that missed the face's edges
    let faces = 0;
    for (const s of CBD_TOWER_SKINS) {
      const t = tower(s.n);
      const parts = skinParts(t.parts.filter((p) => p.kind !== 'spire') as never, 0);
      for (const br of s.braces ?? []) {
        const k = Math.round(((((br.face - s.box.face) % 360) + 360) % 360) / 90) % 4;
        const a = ((s.box.face + 90 * k) * Math.PI) / 180;
        const rx = -Math.cos(a), rz = -Math.sin(a);
        // the beams buildBraces draws, as (t across, h up) on the face, their run-on ends trimmed back
        const segs: [number, number, number, number][] = [];
        const rec = {
          beam: (_f: unknown, ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number) => {
            const ta = (ax - s.box.x) * rx + (az - s.box.z) * rz, tb = (bx - s.box.x) * rx + (bz - s.box.z) * rz;
            const e = w / 2 / Math.hypot(tb - ta, by - ay);
            segs.push([ta + (tb - ta) * e, ay - s.dy + (by - ay) * e, tb - (tb - ta) * e, by - s.dy - (by - ay) * e]);
          },
          quad: () => {},
        };
        buildBraces(rec as never, { ...s, braces: [br], lines: [] }, parts, 0);
        const name = `${t.name} brace on ${br.face}° t ${br.t}`;
        const diag = segs.filter(([t0, , t1]) => Math.abs(t1 - t0) > 0.5);
        expect(diag.length, name).toBeGreaterThanOrEqual(4);
        const ts = diag.flatMap(([t0, , t1]) => [t0, t1]);
        const hs = diag.flatMap(([, h0, , h1]) => [h0, h1]);
        const tl = Math.min(...ts), tr = Math.max(...ts), lo = Math.min(...hs), hi = Math.max(...hs);
        // the band keeps its measured width, give or take the kit's corner
        expect(tr - tl, name).toBeGreaterThan(br.t[1] - br.t[0] - 4);
        const onNode = (h: number) => Math.abs(((((h - br.node) % br.module) + br.module + br.module / 2) % br.module) - br.module / 2) < 0.1;
        const modules = new Map<number, number[]>();
        for (const [t0, h0, t1, h1] of diag) {
          // both ends on the band's side edges, or on its top or bottom
          for (const [tt, hh] of [[t0, h0], [t1, h1]]) {
            const edge = Math.abs(tt - tl) < 0.1 || Math.abs(tt - tr) < 0.1 || Math.abs(hh - lo) < 0.1 || Math.abs(hh - hi) < 0.1;
            expect(edge, `${name}: end (${tt.toFixed(1)}, ${hh.toFixed(1)})`).toBe(true);
          }
          // and it spans its module: node to node, or to the band's top or bottom
          expect(onNode(Math.min(h0, h1)) || Math.abs(Math.min(h0, h1) - lo) < 0.1, name).toBe(true);
          expect(onNode(Math.max(h0, h1)) || Math.abs(Math.max(h0, h1) - hi) < 0.1, name).toBe(true);
          const m = Math.floor(((h0 + h1) / 2 - br.node) / br.module);
          modules.set(m, [...(modules.get(m) ?? []), Math.sign((t1 - t0) * (h1 - h0))]);
        }
        // every module has its X: one rising diagonal and one falling
        for (const [m, dirs] of modules) expect(dirs.sort(), `${name} module ${m}`).toEqual([-1, 1]);
        faces++;
      }
    }
    expect(faces).toBeGreaterThan(0);
  });

  it('every sign has a cell in the logo atlas, its night look in the bottom half', () => {
    expect(ATLAS_USED).toBeLessThanOrEqual(ATLAS_H / 2);
    const used = new Set(CBD_TOWER_SKINS.flatMap((s) => (s.signs ?? []).map((g) => g.logo)));
    for (const logo of used) expect(SIGN_LOGOS, logo).toContain(logo);
    const cells = SIGN_LOGOS.map((l) => logoSlot(l));
    for (const c of cells) {
      expect(c.u0).toBeGreaterThanOrEqual(0);
      expect(c.u1).toBeLessThanOrEqual(1);
      // the day look in the top half (v 0.5–1), so its night look 0.5 lower stays inside the texture
      expect(c.v0).toBeGreaterThanOrEqual(0.5);
      expect(c.v1).toBeLessThanOrEqual(1);
      expect((c.u1 - c.u0) / (c.v1 - c.v0) / 2).toBeCloseTo(c.aspect, 0);
    }
    // no two cells overlap
    for (let i = 0; i < cells.length; i++)
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i], b = cells[j];
        expect(a.u1 <= b.u0 || b.u1 <= a.u0 || a.v1 <= b.v0 || b.v1 <= a.v0, `${SIGN_LOGOS[i]} / ${SIGN_LOGOS[j]}`).toBe(true);
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
