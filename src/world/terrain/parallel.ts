/**
 * Worker pool for terrain generation (phones have 4–8 cores; the base heightfield and colour map
 * are embarrassingly parallel by rows). Falls back to null when Workers are unavailable (node tests,
 * old browsers) — callers then use the time-sliced main-thread path.
 */
import type { SceneryFeature } from '../../core/contracts';
import type { TheaterId } from '../../core/types';
import type { HfView } from './bake';
import type { WorkerJob, WorkerResult } from './worker';

type Pending = { resolve: (r: WorkerResult) => void; reject: (e: Error) => void };

/** Distributes WorkerJob objects (without an id) over a pool, returning the matching results. */
type JobInput = WorkerJob extends infer J ? (J extends { id: number } ? Omit<J, 'id'> : never) : never;

export class TerrainWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private rr = 0;

  private constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResult>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.kind === 'error') p.reject(new Error(e.data.message));
        else p.resolve(e.data);
      };
      w.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'terrain worker failed'));
        this.pending.clear();
      };
      this.workers.push(w);
    }
  }

  /** Create a pool (null when Workers are unavailable or only one core is present). */
  static create(): TerrainWorkerPool | null {
    try {
      if (typeof Worker === 'undefined' || typeof navigator === 'undefined') return null;
      const cores = navigator.hardwareConcurrency || 2;
      const count = Math.max(1, Math.min(4, cores - 1));
      if (count < 2) return null;
      return new TerrainWorkerPool(count);
    } catch {
      return null;
    }
  }

  get size(): number {
    return this.workers.length;
  }

  private run(job: JobInput, transfer: Transferable[] = []): Promise<WorkerResult> {
    const id = this.nextId++;
    const w = this.workers[this.rr++ % this.workers.length];
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ ...job, id } as WorkerJob, transfer);
    });
  }

  /** Base heightfield rows (n × n) → assembled arrays. */
  async generateBase(
    theater: TheaterId,
    seed: number,
    n: number,
    onProgress: (f: number) => void,
  ): Promise<{ data: Float32Array; mat: Uint8Array; aux: Uint8Array }> {
    const data = new Float32Array(n * n);
    const mat = new Uint8Array(n * n);
    const aux = new Uint8Array(n * n);
    const chunks = this.workers.length * 4;
    const rows = Math.ceil(n / chunks);
    let done = 0;
    const jobs: Promise<void>[] = [];
    for (let z0 = 0; z0 < n; z0 += rows) {
      const z1 = Math.min(n, z0 + rows);
      jobs.push(
        this.run({ kind: 'base', theater, seed, n, z0, z1 }).then((r) => {
          if (r.kind !== 'base') return;
          data.set(r.data, r.z0 * n);
          mat.set(r.mat, r.z0 * n);
          aux.set(r.aux, r.z0 * n);
          onProgress(++done / Math.ceil(n / rows));
        }),
      );
    }
    await Promise.all(jobs);
    return { data, mat, aux };
  }

  /**
   * Colour map (m × m RGBA8) from a finished heightfield. Each worker receives ONE copy of the
   * heightfield (reduced to the colour-map resolution), then small row jobs.
   */
  async bakeColor(
    hf: HfView,
    theater: TheaterId,
    seed: number,
    features: SceneryFeature[],
    m: number,
    onProgress: (f: number) => void,
  ): Promise<Uint8Array> {
    const view = reduceView(hf, m);
    await Promise.all(this.workers.map((_w, i) => this.runOn(i, { kind: 'hf', hf: view })));
    const out = new Uint8Array(m * m * 4);
    const chunks = this.workers.length * 3;
    const rows = Math.ceil(m / chunks);
    let done = 0;
    const jobs: Promise<void>[] = [];
    for (let j0 = 0; j0 < m; j0 += rows) {
      const j1 = Math.min(m, j0 + rows);
      jobs.push(
        this.run({ kind: 'color', theater, seed, features, m, j0, j1 }).then((r) => {
          if (r.kind !== 'color') return;
          out.set(r.rgba, r.j0 * m * 4);
          onProgress(++done / Math.ceil(m / rows));
        }),
      );
    }
    await Promise.all(jobs);
    return out;
  }

  /** Install the decompressed LINZ Auckland data (or null) on every worker. */
  async setLinz(bytes: Uint8Array | null): Promise<void> {
    await Promise.all(this.workers.map((_w, i) => this.runOn(i, { kind: 'linz', bytes })));
  }

  /** Auckland coast mask (n × n bytes over `extent`), rows split over the workers. */
  async bakeCoast(seed: number, n: number, extent: number): Promise<Uint8Array> {
    const out = new Uint8Array(n * n);
    const chunks = this.workers.length;
    const rows = Math.ceil(n / chunks);
    const jobs: Promise<void>[] = [];
    for (let j0 = 0; j0 < n; j0 += rows) {
      const j1 = Math.min(n, j0 + rows);
      jobs.push(
        this.run({ kind: 'coast', seed, n, extent, j0, j1 }).then((r) => {
          if (r.kind === 'coast') out.set(r.data, r.j0 * n);
        }),
      );
    }
    await Promise.all(jobs);
    return out;
  }

  private runOn(index: number, job: JobInput): Promise<WorkerResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.workers[index].postMessage({ ...job, id } as WorkerJob);
    });
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.pending.clear();
  }
}

/** Heightfield view sampled down to m × m (the colour map resolution). */
export function reduceView(hf: HfView, m: number): HfView {
  if (hf.n === m) return { n: hf.n, cell: hf.cell, origin: hf.origin, data: hf.data, mat: hf.mat, aux: hf.aux };
  const stride = hf.n / m;
  const data = new Float32Array(m * m);
  const mat = new Uint8Array(m * m);
  const aux = new Uint8Array(m * m);
  for (let j = 0; j < m; j++)
    for (let i = 0; i < m; i++) {
      const k = Math.min(hf.n - 1, j * stride) * hf.n + Math.min(hf.n - 1, i * stride);
      data[j * m + i] = hf.data[k];
      mat[j * m + i] = hf.mat[k];
      aux[j * m + i] = hf.aux[k];
    }
  return { n: m, cell: hf.cell * stride, origin: hf.origin, data, mat, aux };
}
