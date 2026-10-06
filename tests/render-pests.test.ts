import { describe, expect, it } from 'vitest';
import { Box3, Mesh, Vector3 } from 'three';
import { PESTS, pestModel } from '../src/render/models/pests';

/** Edges used by other than exactly two triangles (a closed surface has none, bar the odd ambiguous cell). */
function openEdges(mesh: Mesh): number {
  const idx = mesh.geometry.index!.array;
  const cnt = new Map<number, number>();
  const n = mesh.geometry.attributes.position.count;
  for (let t = 0; t < idx.length; t += 3)
    for (let s = 0; s < 3; s++) {
      const a = idx[t + s];
      const b = idx[t + ((s + 1) % 3)];
      const k = Math.min(a, b) * n + Math.max(a, b);
      cnt.set(k, (cnt.get(k) ?? 0) + 1);
    }
  let bad = 0;
  for (const c of cnt.values()) if (c === 1) bad++;
  return bad;
}

describe('Codex pest models', () => {
  for (const info of PESTS)
    it(`${info.id}: closed, true to scale, standing on the ground, furred`, () => {
      const m = pestModel(info.id, 0.6);
      expect(m.name).toBe(`pest:${info.id}`);
      m.updateMatrixWorld(true);
      const box = new Box3().setFromObject(m);
      const size = box.getSize(new Vector3());
      // head and body length within the model's own length, which adds the tail (or wings and legs)
      expect(size.z).toBeGreaterThan(info.body * 0.85);
      expect(size.z).toBeLessThan(info.body * 2.6);
      expect(box.min.y).toBeGreaterThan(-0.002 * info.body / 0.1);
      expect(box.min.y).toBeLessThan(0.05 * info.body);
      const skin = m.getObjectByName('skin') as Mesh;
      expect(skin).toBeTruthy();
      expect(openEdges(skin)).toBe(0);
      for (const a of skin.geometry.attributes.position.array as Float32Array) expect(Number.isFinite(a)).toBe(true);
      expect(m.getObjectByName('fur')!.children.length).toBeGreaterThan(2);
    });

  it('the wasp has four wings that beat', () => {
    const m = pestModel('wasp', 0.5);
    const hinges: unknown[] = [];
    m.traverse((o) => o.userData.flap && hinges.push(o));
    expect(hinges).toHaveLength(2);
  });
});
