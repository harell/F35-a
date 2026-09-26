/**
 * Terrain generation worker: computes bands of the theatre base heightfield and of the colour map
 * off the main thread. Generators (coarse fields, the Auckland map raster) are cached per worker.
 */
import { createTheaterGenerator, generateBaseRows } from './generate';
import { bakeColorRows, type HfView } from './bake';
import type { Anchor, TheaterGenerator } from './types';
import type { TheaterId } from '../../core/types';
import type { SceneryFeature } from '../../core/contracts';

export type WorkerJob =
  | { id: number; kind: 'base'; theater: TheaterId; seed: number; anchors: Anchor[]; n: number; z0: number; z1: number }
  | { id: number; kind: 'hf'; hf: HfView }
  | { id: number; kind: 'color'; theater: TheaterId; seed: number; features: SceneryFeature[]; m: number; j0: number; j1: number };

export type WorkerResult =
  | { id: number; kind: 'base'; z0: number; z1: number; data: Float32Array; mat: Uint8Array; aux: Uint8Array }
  | { id: number; kind: 'color'; j0: number; j1: number; rgba: Uint8Array }
  | { id: number; kind: 'ok' }
  | { id: number; kind: 'error'; message: string };

interface WorkerScope {
  onmessage: ((e: { data: WorkerJob }) => void) | null;
  postMessage(msg: WorkerResult, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let cacheKey = '';
let cached: TheaterGenerator | null = null;
let hfView: HfView | null = null;

scope.onmessage = (e) => {
  const job = e.data;
  try {
    if (job.kind === 'base') {
      const key = `${job.theater}|${job.seed}|${JSON.stringify(job.anchors)}`;
      if (key !== cacheKey || !cached) {
        cached = createTheaterGenerator({ theater: job.theater, seed: job.seed }, job.anchors);
        cacheKey = key;
      }
      const rows = job.z1 - job.z0;
      const data = new Float32Array(rows * job.n);
      const mat = new Uint8Array(rows * job.n);
      const aux = new Uint8Array(rows * job.n);
      generateBaseRows(cached, job.n, job.z0, job.z1, data, mat, aux);
      scope.postMessage({ id: job.id, kind: 'base', z0: job.z0, z1: job.z1, data, mat, aux }, [data.buffer, mat.buffer, aux.buffer]);
    } else if (job.kind === 'hf') {
      hfView = job.hf;
      scope.postMessage({ id: job.id, kind: 'ok' });
    } else {
      if (!hfView) throw new Error('no heightfield');
      const rgba = new Uint8Array((job.j1 - job.j0) * job.m * 4);
      bakeColorRows(hfView, { theater: job.theater, seed: job.seed, features: job.features }, job.m, job.j0, job.j1, rgba);
      scope.postMessage({ id: job.id, kind: 'color', j0: job.j0, j1: job.j1, rgba }, [rgba.buffer]);
    }
  } catch (err) {
    scope.postMessage({ id: job.id, kind: 'error', message: String((err as Error)?.message ?? err) });
  }
};
