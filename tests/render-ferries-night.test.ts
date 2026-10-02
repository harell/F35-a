/**
 * Polish 5/5 (#61 item 7): the harbour ferries at night. Lit cabin windows (an unlit second instanced
 * mesh on the same instances, night only) and nav lights wide enough to read from a kilometre.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { HarbourFerries } from '../src/render/traffic/HarbourFerries';
import type { SpriteBatch } from '../src/render/effects/SpriteBatch';

/** A sprite batch that records every light (x, y, z, r, g, b, a, size, minPx). */
function recorder(): { batch: SpriteBatch; lights: number[][] } {
  const lights: number[][] = [];
  const batch = { add: (...a: number[]) => (lights.push(a), true) } as unknown as SpriteBatch;
  return { batch, lights };
}

describe('harbour ferries at night (#61)', () => {
  const ferries = new HarbourFerries(13);
  ferries.update(620, null);

  it('light their cabin windows at night only, on the hulls’ own instances', () => {
    expect(ferries.windows.instanceMatrix).toBe(ferries.mesh.instanceMatrix);
    expect(ferries.windows.count).toBe(ferries.count);
    ferries.setNight(false);
    expect(ferries.windows.visible).toBe(false);
    ferries.setNight(true);
    expect(ferries.windows.visible).toBe(true);
    // the glow is warm and bright (unlit material: the colour is what the eye gets)
    const col = ferries.windows.geometry.getAttribute('color');
    expect(col.count).toBeGreaterThan(0);
    for (let i = 0; i < col.count; i++) expect(col.getX(i)).toBeGreaterThan(0.8);
  });

  it('nav lights are at least 3 px wide, so a ferry reads from a kilometre (phone, 60° fov, 390 px high)', () => {
    // a camera 1 km from the first ferry
    const m = ferries.mesh;
    const e = new Float32Array(16);
    m.instanceMatrix.array.slice(0, 16).forEach((v, i) => (e[i] = v));
    const cam = new Vector3(e[12] + 600, 800, e[14]);
    const { batch, lights } = recorder();
    ferries.addLights(batch, cam);
    expect(lights.length).toBeGreaterThan(ferries.count * 2);
    const px = (l: number[]) => {
      const d = Math.hypot(l[0] - cam.x, l[1] - cam.y, l[2] - cam.z);
      const worldPerPx = (2 * Math.tan(Math.PI / 6) * d) / 390;
      return Math.max(l[7] / worldPerPx, l[8]);
    };
    const nav = lights.filter((l) => l[7] >= 2.4);
    expect(nav.length).toBeGreaterThan(0);
    for (const l of nav) expect(px(l)).toBeGreaterThanOrEqual(3);
  });
});
