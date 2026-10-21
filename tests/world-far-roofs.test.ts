/**
 * Far LOD for the corridor's real houses (#278): past the house scatter's reach the terrain paints its lots from the
 * loaded tiles' roofs (corridorHouses.ts RoofGrid), as many built as the real roof share and in the real roofs' colour,
 * instead of the procedural lot mosaic.
 */
import { describe, expect, it } from 'vitest';
import MANIFEST from '../src/world/terrain/data/corridor/corridor.json';
import { CORRIDOR_TILE, CorridorHouses, decodeCorridorTile, LOT_ROOF_SHARE, ROOF_CELL, RoofGrid, tileName, type CorridorManifest } from '../src/world/scenery/corridorHouses';
import { terrainFragmentShader } from '../src/world/terrain/terrainShader';

interface Fs {
  readFileSync(p: URL): Uint8Array;
}
interface Zlib {
  gunzipSync(b: Uint8Array): Uint8Array;
}
const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as Fs;
const zlib = (await import(/* @vite-ignore */ 'node:zlib' as string)) as Zlib;

const M = MANIFEST as unknown as CorridorManifest;
const rawOf = (i: number, j: number) => new Uint8Array(zlib.gunzipSync(new Uint8Array(fs.readFileSync(new URL(`../src/world/terrain/data/corridor/${tileName(i, j)}`, import.meta.url)))));
/** The corridor's densest tile (Mt Eden and Epsom, ≈ 6,100 houses), and a point in it (game XZ, m). */
const TI = -1;
const TJ = 2;
const SPOT = [-1024, 5120] as const;

function stream(): CorridorHouses {
  return new CorridorHouses(M, (i, j) => Promise.resolve(rawOf(i, j)), { fetchRadius: 3000, keepRadius: 8000 });
}

describe('the far field paints the real roofs (#278)', () => {
  it("bakes each 64 m cell's roof share and area-weighted colour from the tile's houses", () => {
    const { houses } = decodeCorridorTile(rawOf(TI, TJ), M.palette);
    const x0 = TI * CORRIDOR_TILE;
    const z0 = TJ * CORRIDOR_TILE;
    const g = new RoofGrid(x0, z0, x0 + CORRIDOR_TILE, z0 + CORRIDOR_TILE);
    g.fill(houses, x0, z0, CORRIDOR_TILE);
    expect(g.cols).toBe(CORRIDOR_TILE / ROOF_CELL);
    // the roof area comes back from the shares (to the byte's rounding)
    let area = 0;
    for (let k = 0; k < houses.count; k++) area += houses.w[k] * houses.d[k];
    let back = 0;
    let built = 0;
    for (let c = 0; c < g.cols * g.rows; c++) {
      back += (g.data[c * 4 + 3] / 255) * ROOF_CELL * ROOF_CELL;
      if (g.data[c * 4 + 3]) built++;
    }
    expect(Math.abs(back - area) / area).toBeLessThan(0.02);
    // a suburb: most cells hold roofs, ≈ 12–45 % of the ground under them on average where built
    expect(built / (g.cols * g.rows)).toBeGreaterThan(0.8);
    const mean = back / (built * ROOF_CELL * ROOF_CELL);
    expect(mean).toBeGreaterThan(0.12);
    expect(mean).toBeLessThan(0.45);
    // one cell checked by hand (the first house's): its houses' area-weighted colour
    const cx = houses.x[0];
    const cz = houses.z[0];
    const ci = Math.floor((cx - x0) / ROOF_CELL);
    const cj = Math.floor((cz - z0) / ROOF_CELL);
    let a = 0;
    const rgb = [0, 0, 0];
    for (let k = 0; k < houses.count; k++) {
      if (Math.floor((houses.x[k] - x0) / ROOF_CELL) !== ci || Math.floor((houses.z[k] - z0) / ROOF_CELL) !== cj) continue;
      const w = houses.w[k] * houses.d[k];
      a += w;
      rgb[0] += ((houses.color[k] >> 16) & 255) * w;
      rgb[1] += ((houses.color[k] >> 8) & 255) * w;
      rgb[2] += (houses.color[k] & 255) * w;
    }
    expect(a).toBeGreaterThan(0);
    const got = g.at(cx, cz);
    expect(got.share).toBeCloseTo(a / ROOF_CELL ** 2, 2);
    expect((got.color >> 16) & 255).toBe(Math.round(rgb[0] / a));
    expect((got.color >> 8) & 255).toBe(Math.round(rgb[1] / a));
    expect(got.color & 255).toBe(Math.round(rgb[2] / a));
  });

  it('follows the stream: a tile fills its cells when it loads and clears them when it is dropped', () => {
    const s = stream();
    expect(s.roofs.at(...SPOT).share).toBe(0);
    const t = s.install(TI, TJ, rawOf(TI, TJ));
    expect(s.roofs.at(...SPOT).share).toBeGreaterThan(0);
    // the cells the terrain re-uploads span the tile's rows
    const [c0, c1] = s.roofCells(t);
    const g = s.roofs;
    expect(c0).toBe(((t.z0 - g.z0) / g.cell) * g.cols);
    expect(c1 - c0).toBe((CORRIDOR_TILE / g.cell) * g.cols);
    // dropped once the camera is far away (keepRadius): its cells are empty again
    s.update(SPOT[0] + 30000, SPOT[1]);
    expect(s.tiles.size).toBe(0);
    expect(s.roofs.at(...SPOT).share).toBe(0);
    expect(g.data.some((v) => v !== 0)).toBe(false);
  });

  it('fits the mask texture: its cells run on across rows of at most 2048 texels down, as the shader reads them', () => {
    const g = stream().roofs;
    // TerrainRenderer.installSiteMasks: the width that keeps the house mask's and the roofs' rows within 2048
    const houseRows = Math.ceil(Math.round((M.bounds[3] - M.bounds[1]) / M.cell) / 4);
    const houseW = Math.ceil(Math.round((M.bounds[2] - M.bounds[0]) / M.cell) / 8);
    const W = Math.max(houseW, Math.ceil((g.cols * g.rows) / (2048 - houseRows)));
    expect(houseRows + Math.ceil((g.cols * g.rows) / W)).toBeLessThanOrEqual(2048);
    // the shader's index arithmetic (realRoofs) lands on every cell's own texel, in float32
    const f = Math.fround;
    for (let c = 0; c < g.cols * g.rows; c += 997) {
      const gx = c % g.cols;
      const gy = Math.floor(c / g.cols);
      const idx = f(f(gy * g.cols) + gx);
      const r = Math.floor(f(f(idx + 0.5) / W));
      expect(r * W + (idx - r * W)).toBe(c);
      expect(idx - r * W).toBeLessThan(W);
    }
    expect(terrainFragmentShader).toContain('vec4 realRoofs(vec2 wp)');
  });

  it("builds lots in proportion to the real roof share, at the shader's average roof per lot", () => {
    // urbanPattern's lot roof is 0.32 … 0.48 of a built lot, uniformly: LOT_ROOF_SHARE on average
    expect(LOT_ROOF_SHARE).toBeCloseTo(0.32 + 0.16 * 0.5, 6);
    expect(terrainFragmentShader).toContain('float lotRoof = built * mix(0.32 + 0.16 * fract(lh * 2.9), 0.62, apt);');
    expect(terrainFragmentShader).toContain(`built = step(lh, rr.a * ${(1 / LOT_ROOF_SHARE).toFixed(3)})`);
  });
});
