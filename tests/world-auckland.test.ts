import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { AKL } from '../src/core/auckland';
import { airfieldFeature } from '../src/core/airfields';
import { MAT_URBAN } from '../src/world/terrain/types';
import { runwayLengthFor } from '../src/world/terrain/features';
import { allFeatures } from '../src/world/scenery/Scenery';
import type { SceneryFeature } from '../src/core/contracts';

// Same features the campaign uses (Whenuapai home base, Waiheke enemy strip, Motutapu depot).
const MISSION: SceneryFeature[] = [
  airfieldFeature('whenuapai'),
  { type: 'airbase', x: 26_500, z: -6200, rotation: 80, size: 0.8 },
  { type: 'industrial', x: 13_300, z: -9800, size: 0.6 },
];
const features = allFeatures('auckland', MISSION);
const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [{ x: 12_900, z: -8600, radius: 150 }] }));
const q = new TerrainQueryImpl(hf);
const at = (id: string) => AKL[id];

describe('Auckland theatre geography', () => {
  it('puts the CBD on land and the harbours in water', () => {
    expect(q.heightAt(0, 0)).toBeGreaterThan(8); // Sky Tower ridge
    expect(q.heightAt(0, 0)).toBeLessThan(120);
    // Waitematā between the bridge abutments, off the CBD waterfront, at the harbour mouth
    const bridgeMid = { x: (at('bridge_s').x + at('bridge_n').x) / 2, z: (at('bridge_s').z + at('bridge_n').z) / 2 };
    expect(q.isWater(bridgeMid.x, bridgeMid.z)).toBe(true);
    expect(q.isWater(300, -1500)).toBe(true);
    expect(q.isWater(5000, -1200)).toBe(true);
    // Manukau harbour, Tāmaki estuary, Hauraki Gulf, Tasman Sea
    expect(q.isWater(-8000, 14_000)).toBe(true);
    expect(q.isWater(11_000, 3500)).toBe(true); // Tāmaki estuary (LINZ coast: water x ≈ 10.3–12 km here)
    expect(q.isWater(20_000, -20_000)).toBe(true);
    expect(q.isWater(-35_000, 0)).toBe(true);
    // Lake Pupuke crater lake
    expect(q.isWater(at('pupuke').x, at('pupuke').z)).toBe(true);
  });

  it('has the islands and cones at roughly the right heights', () => {
    const rg = q.heightAt(at('rangitoto').x, at('rangitoto').z);
    expect(rg).toBeGreaterThan(160);
    expect(rg).toBeLessThan(300);
    const eden = q.heightAt(at('mt_eden').x + 250, at('mt_eden').z); // on the crater rim
    expect(eden).toBeGreaterThan(110);
    expect(q.heightAt(at('one_tree_hill').x, at('one_tree_hill').z)).toBeGreaterThan(120);
    for (const id of ['motutapu', 'waiheke', 'waiheke_w', 'tiritiri', 'devonport', 'takapuna', 'whenuapai', 'akl_airport']) {
      expect(q.heightAt(at(id).x, at(id).z), id).toBeGreaterThan(1);
    }
    // Waitākere ranges are hilly, the Hunua higher still
    let wmax = 0;
    for (let dz = -6000; dz <= 6000; dz += 500) for (let dx = -6000; dx <= 6000; dx += 500) wmax = Math.max(wmax, q.heightAt(at('waitakere').x + dx, at('waitakere').z + dz));
    expect(wmax).toBeGreaterThan(280);
  });

  it('marks the isthmus and North Shore as built-up but not the airport', () => {
    const urbanAt = (x: number, z: number) => {
      const i = Math.round((x - hf.origin) / hf.cell);
      const j = Math.round((z - hf.origin) / hf.cell);
      return hf.mat[j * hf.n + i] === MAT_URBAN;
    };
    expect(urbanAt(1500, 2500)).toBe(true); // Newmarket
    expect(urbanAt(700, -6700)).toBe(true); // Takapuna
    expect(urbanAt(at('akl_airport').x, at('akl_airport').z)).toBe(false);
  });

  it('keeps the flattened airfields level along the runway', () => {
    for (const f of [MISSION[0], features[0]]) {
      const hd = ((f.rotation ?? 0) * Math.PI) / 180;
      const h0 = q.heightAt(f.x, f.z);
      const half = runwayLengthFor(f) / 2;
      for (let v = -half; v <= half; v += half / 4) {
        expect(Math.abs(q.heightAt(f.x + Math.sin(hd) * v, f.z - Math.cos(hd) * v) - h0)).toBeLessThan(1);
      }
    }
  });

  it('Rangitoto masks a low-level ingress from the SA-10 on Motutapu', () => {
    // SAM radar on Motutapu, low jet south-west of Rangitoto: the cone blocks the line of sight
    const sam = new Vector3(12_900, q.surfaceHeightAt(12_900, -8600) + 15, -8600);
    const jet = new Vector3(5600, 60, -4800);
    expect(q.lineOfSight(sam, jet)).toBe(false);
    // …but not once the jet pops up
    expect(q.lineOfSight(sam, jet.clone().setY(1500))).toBe(true);
  });
});
