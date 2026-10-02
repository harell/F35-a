import { describe, expect, it } from 'vitest';
import { Box3, Mesh, Object3D, Vector3 } from 'three';
import type { AircraftType, GroundTargetType, MunitionId, SamType } from '../src/core/types';
import { getAircraftPrototype } from '../src/render/models/aircraft';
import { AIRCRAFT_SPECS, MUNITION_DIMS } from '../src/render/models/specs';
import { munitionGeometry } from '../src/render/models/munitions';
import { getSamPrototype } from '../src/render/models/sams';
import { getGroundPrototype } from '../src/render/models/ground';
import { signedVolume } from '../src/render/models/geom/core';
import { liftingSurface, loftRings } from '../src/render/models/geom/loft';

const AIRCRAFT: AircraftType[] = ['f35a', 'mig29', 'su27', 'su35', 'su57', 'tu22m', 'a50'];

function trianglesOf(root: Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh) n += m.geometry.attributes.position.count / 3;
  });
  return n;
}

/** Vertex with the smallest z of every mesh (world space of the object). */
function noseVertex(root: Object3D): Vector3 {
  root.updateMatrixWorld(true);
  const best = new Vector3(0, 0, Infinity);
  const v = new Vector3();
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const p = m.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      if (v.z < best.z) best.copy(v);
    }
  });
  return best;
}

describe('render aircraft models', () => {
  for (const type of AIRCRAFT) {
    it(`${type}: nose along -Z, tails aft, plausible size and triangle budget`, () => {
      const p = getAircraftPrototype(type);
      const spec = AIRCRAFT_SPECS[type];
      const box = new Box3().setFromObject(p.lod1);
      const size = box.getSize(new Vector3());
      // overall dimensions within ~20% of the real aircraft
      expect(size.z).toBeGreaterThan(spec.length * 0.8);
      expect(size.z).toBeLessThan(spec.length * 1.25);
      expect(size.x).toBeGreaterThan(spec.span * 0.8);
      expect(size.x).toBeLessThan(spec.span * 1.25);
      // nose: the forward-most vertex is on the centreline and in front of the CG
      const nose = noseVertex(p.lod1);
      expect(Math.abs(nose.x)).toBeLessThan(0.3);
      expect(nose.z).toBeLessThan(-spec.length * 0.35);
      // the model is centred roughly on the CG (origin inside the bounding box)
      expect(box.min.z).toBeLessThan(0);
      expect(box.max.z).toBeGreaterThan(0);
      // eye position lies within the fuselage length, forward of the CG
      expect(spec.eye[2]).toBeLessThan(0);
      expect(spec.eye[2]).toBeGreaterThan(box.min.z);
      // triangle budgets (LOD1 is a single merged mesh)
      const tris = trianglesOf(p.lod1);
      expect(tris).toBeGreaterThan(800);
      expect(tris).toBeLessThan(9000);
      // animated parts exist for the drives
      for (const d of p.drives) expect(p.lod0.getObjectByName(`part:${d.part}`)).toBeTruthy();
    });
  }

  it('F-35A is the hero asset: bay doors, stabilators, rudders and store slots', () => {
    const p = getAircraftPrototype('f35a');
    const parts = p.drives.map((d) => d.part);
    for (const n of ['doorOR', 'doorOL', 'doorIR', 'doorIL', 'stabR', 'stabL', 'rudderR', 'rudderL', 'flapR', 'flapL', 'lefR', 'lefL']) expect(parts).toContain(n);
    expect(p.slots.filter((s) => s.internal).length).toBeGreaterThanOrEqual(4);
    expect(p.slots.filter((s) => !s.internal).length).toBeGreaterThanOrEqual(4);
    // engine nozzle is aft of the CG, eye in the canopy
    expect(AIRCRAFT_SPECS.f35a.engines[0].pos[2]).toBeGreaterThan(5);
    expect(AIRCRAFT_SPECS.f35a.eye[1]).toBeGreaterThan(0.8);
  });
});

describe('render munitions', () => {
  for (const id of Object.keys(MUNITION_DIMS) as MunitionId[]) {
    it(`${id}: nose at -Z, sized from reference dimensions`, () => {
      const g = munitionGeometry(id);
      g.computeBoundingBox();
      const b = g.boundingBox!;
      const dims = MUNITION_DIMS[id];
      expect(b.max.z - b.min.z).toBeGreaterThan(dims.length * 0.9);
      expect(b.max.z - b.min.z).toBeLessThan(dims.length * 1.15);
      const nose = noseVertex(new Mesh(g));
      expect(Math.abs(nose.x)).toBeLessThan(dims.diameter);
      expect(Math.abs(nose.y)).toBeLessThan(dims.diameter);
      expect(nose.z).toBeCloseTo(-dims.length / 2, 0);
    });
  }
});

describe('render SAM sites and ground targets', () => {
  const sams: SamType[] = ['sa6', 'sa8', 'sa10', 'sa15', 'sa18', 'zsu23'];
  for (const t of sams) {
    it(`${t}: builds with named animated nodes`, () => {
      const p = getSamPrototype(t, 'green');
      for (const r of p.radars) expect(p.root.getObjectByName(r.name)).toBeTruthy();
      for (const l of p.launchers) if (l.yaw) expect(p.root.getObjectByName(l.yaw)).toBeTruthy();
      expect(trianglesOf(p.root)).toBeLessThan(15000);
    });
  }
  const ground: GroundTargetType[] = ['ewr', 'bunker', 'fuel', 'hangar', 'parked_jet', 'truck', 'tank', 'ship', 'factory', 'bridge'];
  for (const t of ground) {
    it(`${t}: builds within budget`, () => {
      const p = getGroundPrototype(t, 'green');
      const tris = trianglesOf(p.root);
      expect(tris).toBeGreaterThan(10);
      expect(tris).toBeLessThan(12000);
    });
  }
});

describe('render geometry toolkit', () => {
  it('lofted closed shapes and lifting surfaces have outward winding', () => {
    const ring = (r: number) => Array.from({ length: 8 }, (_, j) => [Math.cos((j / 8) * Math.PI * 2) * r, Math.sin((j / 8) * Math.PI * 2) * r]).flat();
    const g = loftRings(
      [
        { z: 0, ring: ring(1) },
        { z: 2, ring: ring(1) },
      ],
      { capStart: true, capEnd: true },
    );
    expect(signedVolume(g)).toBeGreaterThan(0);
    // clockwise rings are auto-corrected
    const cw = loftRings(
      [
        { z: 0, ring: ring(1).map((v, i) => (i % 2 ? -v : v)) },
        { z: 2, ring: ring(1).map((v, i) => (i % 2 ? -v : v)) },
      ],
      { capStart: true, capEnd: true },
    );
    expect(signedVolume(cw)).toBeGreaterThan(0);
    const w = liftingSurface(
      [
        { x: 0, y: 0, zLE: -2, zTE: 2, t: 0.3 },
        { x: 5, y: 0, zLE: 0, zTE: 1, t: 0.1 },
      ],
      { capRoot: true, capTip: true },
    );
    expect(signedVolume(w)).toBeGreaterThan(0);
  });
});
