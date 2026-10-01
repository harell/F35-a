/**
 * F-35A variable-area nozzle (B7) and baked ambient occlusion (A3), issue #15.
 */
import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial, PlaneGeometry, Vector3 } from 'three';
import { buildF35, F35_AO, NOZZLE_EXIT_R } from '../src/render/models/aircraft/f35a';
import { nozzleOpening, NOZZLE_IDLE_OPEN, type AircraftPrototype } from '../src/render/models/aircraft/types';
import { getMaterial } from '../src/render/models/materials';
import { AIRCRAFT_SPECS } from '../src/render/models/specs';
import { computeVertexAO } from '../src/render/models/geom/ao';
import { finalize } from '../src/render/models/geom/core';
import { AircraftVisual } from '../src/render/visuals/AircraftVisual';
import { AircraftEntity } from '../src/sim/entities';

const Y_AXIS = 0.03; // nozzle axis height
const proto = buildF35();

function meshes(p: AircraftPrototype, lod: 'lod0' | 'lod1'): Mesh[] {
  const out: Mesh[] = [];
  p[lod].traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}
const tris = (ms: Mesh[]) => ms.reduce((n, m) => n + m.geometry.attributes.position.count / 3, 0);
const nozzleMesh = () => proto.lod0.getObjectByName('part:nozzle') as Mesh;

/** Max radial distance from the nozzle axis among vertices with z > zMin, at morph weight k. */
function exitRadius(g: BufferGeometry, k: number, zMin = 6.8): number {
  const p = g.attributes.position;
  const d = g.morphAttributes.position![0];
  let r = 0;
  for (let i = 0; i < p.count; i++) {
    if (p.getZ(i) + k * d.getZ(i) < zMin) continue;
    r = Math.max(r, Math.hypot(p.getX(i) + k * d.getX(i), p.getY(i) + k * d.getY(i) - Y_AXIS));
  }
  return r;
}

function aircraft(rpm: number, ab: number): AircraftEntity {
  const ac = new AircraftEntity(1, 'f35a', 'blue');
  ac.flight.engineRpm = rpm;
  ac.flight.afterburner = ab;
  return ac;
}
const NEAR = { lod0: 1e9, far: 1e9 };

describe('B7 variable-area nozzle', () => {
  it('schedule: open at idle, closed at MIL, fully open in max AB', () => {
    expect(nozzleOpening(0.63, 0)).toBeCloseTo(NOZZLE_IDLE_OPEN, 5);
    expect(nozzleOpening(1.0, 0)).toBeCloseTo(0, 5);
    expect(nozzleOpening(1.02, 1)).toBeCloseTo(1, 5);
    // windmilling below idle keeps the idle position
    expect(nozzleOpening(0.2, 0)).toBeCloseTo(NOZZLE_IDLE_OPEN, 5);
    let prev = Infinity;
    for (let rpm = 0.63; rpm <= 1.0001; rpm += 0.01) {
      const k = nozzleOpening(rpm, 0);
      expect(k).toBeLessThanOrEqual(prev + 1e-9);
      prev = k;
    }
    prev = -Infinity;
    for (let ab = 0; ab <= 1.0001; ab += 0.05) {
      const k = nozzleOpening(1.02, ab);
      expect(k).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = k;
    }
  });

  it('is its own morphing part, no longer in the static airframe', () => {
    const body = proto.lod0.getObjectByName('body') as Mesh;
    const names = (body.material as MeshStandardMaterial[]).map((m) => m.name);
    expect(names).not.toContain('metal');
    const n = nozzleMesh();
    expect(n).toBeTruthy();
    expect(n.geometry.morphAttributes.position).toHaveLength(1);
    expect(n.geometry.morphAttributes.normal).toHaveLength(1);
    // relative deltas (mergeGeometries drops this flag; the builder must restore it)
    expect(n.geometry.morphTargetsRelative).toBe(true);
    expect(n.morphTargetInfluences).toEqual([0]);
    expect(proto.drives.find((d) => d.part === 'nozzle')?.kind).toBe('nozzle');
  });

  it('exit diameter travels 10–15% with the hinge ring fixed (no gap to the fuselage)', () => {
    const g = nozzleMesh().geometry;
    const closed = exitRadius(g, 0);
    const open = exitRadius(g, 1);
    expect(closed).toBeCloseTo(NOZZLE_EXIT_R.closed, 2);
    expect(open).toBeCloseTo(NOZZLE_EXIT_R.open, 2);
    const travel = (open - closed) / open;
    expect(travel).toBeGreaterThanOrEqual(0.1);
    expect(travel).toBeLessThanOrEqual(0.15);
    // everything at or ahead of the hinge ring (z ≤ 5.9, where the nozzle meets the airframe) is static
    const p = g.attributes.position;
    const d = g.morphAttributes.position![0];
    let checked = 0;
    for (let i = 0; i < p.count; i++) {
      if (p.getZ(i) > 5.9 + 1e-4) continue;
      checked++;
      expect(Math.hypot(d.getX(i), d.getY(i), d.getZ(i))).toBeLessThan(1e-5);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('LOD1 merges the nozzle at its closed pose without morph targets', () => {
    for (const m of meshes(proto, 'lod1')) expect(Object.keys(m.geometry.morphAttributes)).toHaveLength(0);
  });

  it('AircraftVisual drives each instance separately and keeps the flame inside the exit', () => {
    const spec = AIRCRAFT_SPECS.f35a;
    const R = spec.engines[0].radius;
    const cases: [number, number][] = [
      [0.63, 0],
      [1, 0],
      [1.02, 1],
    ];
    const results = cases.map(([rpm, ab]) => {
      const v = new AircraftVisual(proto, spec, false, false);
      v.update(aircraft(rpm, ab), 0, 1 / 60, new Vector3(0, 0, 50), NEAR);
      const n = v.root.getObjectByName('part:nozzle') as Mesh;
      const outer = v.root.getObjectByName('flame:outer') as Mesh;
      const inner = v.root.getObjectByName('flame:interior') as Mesh;
      return { k: n.morphTargetInfluences![0], outerR: outer.visible ? outer.scale.x : 0, innerR: inner.scale.x };
    });
    // first update snaps to the schedule
    expect(results[0].k).toBeCloseTo(NOZZLE_IDLE_OPEN, 5);
    expect(results[1].k).toBeCloseTo(0, 5);
    expect(results[2].k).toBeCloseTo(1, 5);
    // the shared prototype is untouched
    expect(nozzleMesh().morphTargetInfluences).toEqual([0]);
    for (const r of results) {
      const exit = NOZZLE_EXIT_R.closed + (NOZZLE_EXIT_R.open - NOZZLE_EXIT_R.closed) * r.k;
      const liner = exit - 0.015;
      // hot interior (and the plume, when lit) scale with the exit and stay inside the liner
      expect(r.innerR).toBeLessThan(liner);
      expect(r.innerR / exit).toBeCloseTo((R * 0.9) / 0.555, 2);
      if (r.outerR === 0) continue; // idle: no plume
      expect(r.outerR).toBeLessThan(liner);
      expect(r.outerR / exit).toBeCloseTo((R * 0.98) / 0.555, 2);
    }
    expect(results[0].outerR).toBe(0);
    expect(results[2].outerR).toBeGreaterThan(results[1].outerR * 1.1);
  });

  it('follows throttle changes with an actuator lag', () => {
    const v = new AircraftVisual(proto, AIRCRAFT_SPECS.f35a, false, false);
    const ac = aircraft(1, 0);
    const cam = new Vector3(0, 0, 50);
    v.update(ac, 0, 1 / 60, cam, NEAR);
    const n = v.root.getObjectByName('part:nozzle') as Mesh;
    expect(n.morphTargetInfluences![0]).toBeCloseTo(0, 5);
    ac.flight.afterburner = 1;
    ac.flight.engineRpm = 1.02;
    v.update(ac, 1 / 60, 1 / 60, cam, NEAR);
    const k1 = n.morphTargetInfluences![0];
    expect(k1).toBeGreaterThan(0);
    expect(k1).toBeLessThan(0.1);
    for (let i = 0; i < 180; i++) v.update(ac, (i + 2) / 60, 1 / 60, cam, NEAR);
    expect(n.morphTargetInfluences![0]).toBeGreaterThan(0.95);
  });

  it('a distant (LOD1) aircraft sizes its flame for the closed rest pose', () => {
    const v = new AircraftVisual(proto, AIRCRAFT_SPECS.f35a, false, false);
    const far = new AircraftVisual(proto, AIRCRAFT_SPECS.f35a, false, false);
    const ac = aircraft(1.02, 1);
    v.update(ac, 0, 1 / 60, new Vector3(0, 0, 50), NEAR);
    far.update(ac, 0, 1 / 60, new Vector3(0, 0, 50), { lod0: 0, far: 1e9 });
    const outer = (vis: AircraftVisual) => (vis.root.getObjectByName('flame:outer') as Mesh).scale.x;
    expect(outer(far)).toBeLessThan(outer(v));
  });
});

/* ───────────── A3 baked AO ───────────── */

/** Floor (y = 0, x 0..4) meeting a wall at x = 0. */
function corner(): { floor: BufferGeometry; wall: BufferGeometry } {
  const floor = finalize(new PlaneGeometry(4, 1, 16, 1).rotateX(-Math.PI / 2).translate(2, 0, 0));
  const wall = finalize(new PlaneGeometry(6, 2, 1, 1).rotateY(Math.PI / 2).translate(0, 1, 0));
  return { floor, wall };
}

function area(g: BufferGeometry): number {
  const p = g.attributes.position;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  let s = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1).sub(a);
    c.fromBufferAttribute(p, i + 2).sub(a);
    s += b.cross(c).length() / 2;
  }
  return s;
}

describe('A3 AO baker', () => {
  it('darkens near a wall, leaves open ground at 1, and is deterministic', () => {
    const { floor, wall } = corner();
    const run = () => computeVertexAO([floor], [floor, wall], { rays: 32 }).ao[0];
    const a = run();
    expect([...run()]).toEqual([...a]);
    const p = floor.attributes.position;
    const at = (x: number) => {
      for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i) - x) < 1e-3) return a[i];
      throw new Error(`no vertex at x=${x}`);
    };
    expect(at(0.25)).toBeLessThan(0.85);
    expect(at(0.25)).toBeLessThan(at(0.5));
    expect(at(0.5)).toBeLessThan(at(1.5));
    expect(at(3)).toBe(1);
    for (const v of a) expect(v).toBeGreaterThanOrEqual(0.3);
  });

  it('refinement adds vertices along the gradient without changing the shape', () => {
    // coarse floor: one quad 4 m long, so the wall shadow needs the split
    const floor = finalize(new PlaneGeometry(4, 1, 1, 1).rotateX(-Math.PI / 2).translate(2.1, 0, 0));
    const { wall } = corner();
    const color = floor.attributes.color as BufferAttribute;
    const morph = new BufferAttribute(new Float32Array(floor.attributes.position.count * 3).fill(0.5), 3);
    floor.morphAttributes.position = [morph];
    floor.morphTargetsRelative = true;
    const { geos, ao } = computeVertexAO([floor], [floor, wall], { refine: 2, splitLen: 0.5, splitDelta: 0.05 });
    const g = geos[0];
    expect(g).not.toBe(floor);
    expect(g.attributes.position.count).toBeGreaterThan(floor.attributes.position.count);
    expect(area(g)).toBeCloseTo(area(floor), 5);
    expect(g.attributes.color.count).toBe(g.attributes.position.count);
    expect(color.count).toBe(floor.attributes.position.count);
    // morph targets are split alike
    expect(g.morphTargetsRelative).toBe(true);
    expect(g.morphAttributes.position![0].count).toBe(g.attributes.position.count);
    expect(g.morphAttributes.position![0].getX(g.attributes.position.count - 1)).toBeCloseTo(0.5, 6);
    expect(Math.min(...ao[0])).toBeLessThan(Math.max(...ao[0]));
  });
});

describe('A3 F-35A baked AO', () => {
  const body = proto.lod0.getObjectByName('body') as Mesh;
  const groups = body.geometry.groups;
  const mats = body.material as MeshStandardMaterial[];
  const groupOf = (name: string) => groups.find((g) => mats[g.materialIndex!].name === name)!;

  /** Mean / min of the skin AO (skin vertex colours are white × AO) for vertices matching f. */
  function skinAO(f: (v: Vector3, n: Vector3) => boolean): { mean: number; min: number; n: number } {
    const g = groupOf('f35.skin');
    const p = body.geometry.attributes.position;
    const nrm = body.geometry.attributes.normal;
    const c = body.geometry.attributes.color;
    const v = new Vector3();
    const nv = new Vector3();
    let s = 0;
    let n = 0;
    let min = 1;
    for (let i = g.start; i < g.start + g.count; i++) {
      v.fromBufferAttribute(p, i);
      nv.fromBufferAttribute(nrm, i);
      if (!f(v, nv)) continue;
      s += c.getX(i);
      min = Math.min(min, c.getX(i));
      n++;
    }
    return { mean: s / Math.max(1, n), min, n };
  }

  it('the skin material shows vertex colours (where the AO lives)', () => {
    expect((getMaterial('f35.skin') as MeshStandardMaterial).vertexColors).toBe(true);
  });

  it('wing roots, canopy sill and intakes are darker than open surfaces; nothing below the floor', () => {
    // outer wing upper surface: nothing nearby above it
    const open = skinAO((v, n) => Math.abs(v.x) > 3.5 && n.y > 0.8);
    const root = skinAO((v) => Math.abs(v.x) > 1.55 && Math.abs(v.x) < 2.2 && v.y > -0.1 && v.y < 0.3 && v.z > 0 && v.z < 3.5);
    const sill = skinAO((v) => Math.abs(v.x) > 0.45 && Math.abs(v.x) < 0.75 && v.y > 0.6 && v.y < 1.0 && v.z > -4.5 && v.z < -2);
    const intake = skinAO((v) => Math.abs(v.x) > 0.6 && Math.abs(v.x) < 1.35 && v.y < 0.05 && v.y > -0.8 && v.z > -3.2 && v.z < -1.5);
    expect({ open: open.n > 5, root: root.n > 5, sill: sill.n > 5, intake: intake.n > 5 }).toEqual({ open: true, root: true, sill: true, intake: true });
    expect(open.mean).toBeGreaterThan(0.95);
    expect(root.mean).toBeLessThan(open.mean - 0.1);
    expect(sill.mean).toBeLessThan(open.mean - 0.1);
    expect(intake.mean).toBeLessThan(open.mean - 0.1);
    expect(skinAO(() => true).min).toBeGreaterThanOrEqual(F35_AO.floor - 1e-6);
  });

  it('the weapons bay ceiling is occluded (baked as if the doors were open)', () => {
    const g = groupOf('darkStd');
    const p = body.geometry.attributes.position;
    const c = body.geometry.attributes.color;
    const base = new Color(0xc4c8cb).r; // ceiling tint (linear)
    const v = new Vector3();
    let s = 0;
    let n = 0;
    for (let i = g.start; i < g.start + g.count; i++) {
      v.fromBufferAttribute(p, i);
      // underside of the ceiling plate (spans the bay: z ≈ −0.2..3.6)
      if (Math.abs(v.y - (-0.27 - 0.0155)) > 0.003 || Math.abs(v.x) > 0.95 || v.z < -0.3 || v.z > 3.7) continue;
      s += c.getX(i) / base;
      n++;
    }
    expect(n).toBeGreaterThan(0);
    expect(s / n).toBeLessThan(0.8);
  });

  it('bay doors carry no baked AO; hinged surfaces only get it in their rest pose', () => {
    for (const name of ['doorOR', 'doorIR', 'doorOL', 'doorIL']) {
      const c = (proto.lod0.getObjectByName(`part:${name}`) as Mesh).geometry.attributes.color;
      for (let i = 0; i < c.count; i++) expect(c.getX(i)).toBe(1);
    }
    // a flaperon's root sits against the fuselage at any deflection: darker than its tip
    const flap = (proto.lod0.getObjectByName('part:flapR') as Mesh).geometry.attributes.color;
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < flap.count; i++) {
      lo = Math.min(lo, flap.getX(i));
      hi = Math.max(hi, flap.getX(i));
    }
    expect(hi).toBe(1);
    expect(lo).toBeLessThan(1);
    expect(lo).toBeGreaterThanOrEqual(F35_AO.floor - 1e-6);
  });

  it('triangle budget: LOD1 unchanged by the bake, LOD0 within ~12%', () => {
    const saved = F35_AO.refine;
    F35_AO.refine = 0;
    let coarse: AircraftPrototype;
    try {
      coarse = buildF35();
    } finally {
      F35_AO.refine = saved;
    }
    expect(tris(meshes(proto, 'lod1'))).toBe(tris(meshes(coarse, 'lod1')));
    expect(proto.triangles).toBeLessThanOrEqual(coarse.triangles * 1.12);
  });
});
