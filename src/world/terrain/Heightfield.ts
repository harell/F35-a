/**
 * Square heightfield sampled at the corners of a regular grid.
 *
 *   sample (ix, iz) lives at world (origin + ix·cell, origin + iz·cell), index = iz·n + ix
 *   the grid spans [origin, origin + (n-1)·cell] on both X and Z; queries outside are clamped
 *   to the edge samples (the generator fades the border into a smooth "outside" profile, so
 *   clamping extends the world as ocean / low plains forever).
 *
 * Pure data + math (no three.js / DOM) so it can be unit-tested in node.
 */

export class Heightfield {
  /** Samples per side (power of two). */
  readonly n: number;
  /** Grid spacing (m). */
  readonly cell: number;
  /** World coordinate of sample 0 on both axes (m). */
  readonly origin: number;
  /** n·cell (m). */
  readonly extent: number;
  /** Heights (m MSL), row-major (z rows). */
  readonly data: Float32Array;
  /** Per-sample material hint written by the generator (see MAT_* in generate.ts). */
  readonly mat: Uint8Array;
  /** Per-sample auxiliary 0..255 parameter (dune sand, forest density, ...). */
  readonly aux: Uint8Array;

  private readonly inv: number;
  private readonly max: number;

  constructor(n: number, extent: number) {
    this.n = n;
    this.extent = extent;
    this.cell = extent / n;
    this.origin = -extent / 2;
    this.inv = 1 / this.cell;
    this.max = n - 1;
    this.data = new Float32Array(n * n);
    this.mat = new Uint8Array(n * n);
    this.aux = new Uint8Array(n * n);
  }

  /** World X/Z of grid index i. */
  pos(i: number): number {
    return this.origin + i * this.cell;
  }

  /** Clamped sample access. */
  sample(ix: number, iz: number): number {
    const m = this.max;
    if (ix < 0) ix = 0;
    else if (ix > m) ix = m;
    if (iz < 0) iz = 0;
    else if (iz > m) iz = m;
    return this.data[iz * this.n + ix];
  }

  /** Bilinear height at a world position (m MSL). */
  heightAt(x: number, z: number): number {
    let gx = (x - this.origin) * this.inv;
    let gz = (z - this.origin) * this.inv;
    const m = this.max;
    if (gx < 0) gx = 0;
    else if (gx > m) gx = m;
    if (gz < 0) gz = 0;
    else if (gz > m) gz = m;
    let ix = gx | 0;
    let iz = gz | 0;
    if (ix >= m) ix = m - 1;
    if (iz >= m) iz = m - 1;
    const fx = gx - ix;
    const fz = gz - iz;
    const d = this.data;
    const i0 = iz * this.n + ix;
    const h00 = d[i0];
    const h10 = d[i0 + 1];
    const h01 = d[i0 + this.n];
    const h11 = d[i0 + this.n + 1];
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fz;
  }

  /**
   * Height of the rendered triangle mesh (finest LOD) at a world position. Quads are split along
   * the (ix+1, iz) → (ix, iz+1) diagonal, exactly like the GPU grid. Use this to seat scenery so
   * nothing floats above or sinks into the visible ground.
   */
  meshHeightAt(x: number, z: number): number {
    let gx = (x - this.origin) * this.inv;
    let gz = (z - this.origin) * this.inv;
    const m = this.max;
    if (gx < 0) gx = 0;
    else if (gx > m) gx = m;
    if (gz < 0) gz = 0;
    else if (gz > m) gz = m;
    let ix = gx | 0;
    let iz = gz | 0;
    if (ix >= m) ix = m - 1;
    if (iz >= m) iz = m - 1;
    const fx = gx - ix;
    const fz = gz - iz;
    const d = this.data;
    const i0 = iz * this.n + ix;
    const h10 = d[i0 + 1];
    const h01 = d[i0 + this.n];
    if (fx + fz <= 1) {
      const h00 = d[i0];
      return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    }
    const h11 = d[i0 + this.n + 1];
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  /** Terrain gradient (dh/dx, dh/dz) by central differences on the grid (for slopes/normals). */
  slopeAt(x: number, z: number): number {
    const e = this.cell;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.sqrt(dx * dx + dz * dz);
  }

  /** Grid-space gradient magnitude at a sample (fast, used by bakers). */
  sampleSlope(ix: number, iz: number): number {
    const dx = (this.sample(ix + 1, iz) - this.sample(ix - 1, iz)) / (2 * this.cell);
    const dz = (this.sample(ix, iz + 1) - this.sample(ix, iz - 1)) / (2 * this.cell);
    return Math.sqrt(dx * dx + dz * dz);
  }
}
