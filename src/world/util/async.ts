/**
 * Time-slicing helpers: run CPU-heavy generators in ~20 ms slices, yielding to the event loop so
 * the loading bar keeps animating on phones.
 */

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Drive a progress generator (yields 0..1) with time slicing. */
export async function runSliced<T>(gen: Generator<number, T, void>, onProgress?: (f: number) => void, sliceMs = 22): Promise<T> {
  let start = performance.now();
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    if (performance.now() - start > sliceMs) {
      onProgress?.(r.value);
      await yieldToEventLoop();
      start = performance.now();
    }
  }
}
