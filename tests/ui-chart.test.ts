/**
 * Menu / briefing chart (src/ui/art/aucklandChart.ts): draws the real LINZ coastline when it is loaded
 * (the same rings as the terrain), falls back to the hand-traced map without it, and the LINZ data is
 * prefetched without blocking start-up and fetched only once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartData, chartVersion, drawAucklandChart, prefetchChartData } from '../src/ui/art/aucklandChart';
import { aucklandLinz, linzIsLand, loadAucklandLinz, setAucklandLinz } from '../src/world/terrain/theaters/aucklandLinz';
import { LINZ_BYTES, LINZ_GZ } from './linz-setup';

/** Records path commands and fills (canvas px). */
class RecCtx {
  moves = 0;
  lines = 0;
  fills: (string | undefined)[] = [];
  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  lineWidth = 1;
  lineJoin = 'miter';
  globalAlpha = 1;
  save(): void {}
  restore(): void {}
  fillRect(): void {}
  beginPath(): void {}
  closePath(): void {}
  rect(): void {}
  ellipse(): void {}
  arc(): void {}
  stroke(): void {}
  moveTo(): void {
    this.moves++;
  }
  lineTo(): void {
    this.lines++;
  }
  fill(rule?: string): void {
    this.fills.push(rule);
  }
  createRadialGradient() {
    return { addColorStop() {} };
  }
}

const STYLE = { land: '#111', water: '#000', coast: '#0ff', coastWidth: 1, relief: '#222', urban: '#333' };
const VIEW = { scale: 10, x0: -40, z0: -40 };
const draw = () => {
  const g = new RecCtx();
  const ok = drawAucklandChart(g as unknown as CanvasRenderingContext2D, 800, 800, VIEW, STYLE);
  return { ok, g };
};

afterEach(() => {
  if (!aucklandLinz()) setAucklandLinz(LINZ_BYTES);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Auckland chart coastline', () => {
  it('uses the LINZ rings (same coastline as the terrain) when the data is loaded', () => {
    const d = chartData()!;
    const linz = aucklandLinz()!;
    expect(d.coast).not.toBeNull();
    expect(d.coast!.length).toBe(linz.rings.length);
    // ring vertices in km = terrain ring vertices in m / 1000
    for (const r of [0, linz.rings.length >> 1, linz.rings.length - 1]) {
      expect(d.coast![r].length).toBe(linz.rings[r].length);
      expect(d.coast![r][0]).toBeCloseTo(linz.rings[r][0] / 1000, 5);
      expect(d.coast![r][1]).toBeCloseTo(linz.rings[r][1] / 1000, 5);
    }
    // a land point and a water point classify the same way as the terrain's own test
    expect(linzIsLand(linz, 0, 2000)).toBe(true); // Auckland isthmus
    expect(linzIsLand(linz, 20000, -15000)).toBe(false); // Hauraki Gulf
  });

  it('fills the water even–odd against the LINZ rings', () => {
    const { ok, g } = draw();
    expect(ok).toBe(true);
    expect(g.fills).toContain('evenodd');
    expect(g.moves).toBeGreaterThanOrEqual(chartData()!.coast!.filter((r) => r.length >= 6).length);
  });

  it('thins sub-pixel vertices at small scales', () => {
    const total = aucklandLinz()!.rings.reduce((n, r) => n + r.length / 2, 0);
    const { g } = draw();
    expect(g.lines).toBeLessThan(total);
  });

  it('falls back to the hand-traced chart without the data, and switches when it arrives', () => {
    setAucklandLinz(null);
    const v0 = chartVersion();
    expect(chartData()!.coast).toBeNull();
    const { ok, g } = draw();
    expect(ok).toBe(true);
    expect(g.fills).not.toContain('evenodd');
    setAucklandLinz(LINZ_BYTES);
    expect(chartVersion()).not.toBe(v0);
    expect(chartData()!.coast).not.toBeNull();
  });
});

describe('LINZ prefetch', () => {
  it('shares one fetch between concurrent loads (app-start prefetch + mission start)', async () => {
    setAucklandLinz(null);
    const fetchMock = vi.fn(async () => new Response(LINZ_GZ.slice()));
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([loadAucklandLinz('x.bin'), loadAucklandLinz('x.bin')]);
    expect(a && b).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(aucklandLinz()).not.toBeNull();
    expect(await loadAucklandLinz('x.bin')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed load and keeps the fallback meanwhile', async () => {
    setAucklandLinz(null);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadAucklandLinz('x.bin')).toBe(false);
    expect(aucklandLinz()).toBeNull();
    expect(await loadAucklandLinz('x.bin')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits for the first contentful paint, then an idle moment, before fetching', async () => {
    setAucklandLinz(null);
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(LINZ_GZ.slice()));
    vi.stubGlobal('fetch', fetchMock);
    const idle: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => idle.push(cb));
    let onPaint: ((list: { getEntriesByName(n: string): unknown[] }) => void) | null = null;
    class FakeObserver {
      static supportedEntryTypes = ['paint'];
      constructor(cb: typeof onPaint) {
        onPaint = cb;
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    prefetchChartData();
    expect(fetchMock).not.toHaveBeenCalled();
    onPaint!({ getEntriesByName: () => [] }); // first-paint only: not yet
    expect(idle.length).toBe(0);
    onPaint!({ getEntriesByName: (n) => (n === 'first-contentful-paint' ? [{}] : []) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(idle.length).toBe(1);
    idle[0]();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000); // the fallback timer doesn't start a second load
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    expect(await loadAucklandLinz()).toBe(true); // joins the prefetch in flight
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a timer without paint timing', () => {
    setAucklandLinz(null);
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(LINZ_GZ.slice()));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('PerformanceObserver', undefined);
    prefetchChartData(3000);
    vi.advanceTimersByTime(2999);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
