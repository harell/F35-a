/**
 * F35-A — app-flow interruption. The app flow (Game: menus → briefing → mission → debrief, and the
 * pause menu's own loop) waits on screens whose promises only settle when the player answers. The
 * `fly()` test hook has to take over from any of those waits without leaving a loop behind that still
 * waits for a screen nobody will answer (#71): `ask()` wraps each wait, `abort()` rejects every pending
 * one with FlowAbort, and `run()` ends a stretch of flow quietly when that happens.
 */

/** Rejects the app flow's pending screen waits when something (the fly() test hook) takes over. */
export class FlowAbort extends Error {
  constructor() {
    super('app flow aborted');
    this.name = 'FlowAbort';
  }
}

export class FlowInterrupt {
  /** Rejecters of the asks still waiting (a Set, so nothing builds up over a long session). */
  private readonly waiting = new Set<(reason: FlowAbort) => void>();

  /** Settles like `wait`, unless abort() comes first: then it rejects with FlowAbort. */
  ask<T>(wait: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.add(reject);
      wait.then(
        (v) => {
          this.waiting.delete(reject);
          resolve(v);
        },
        (err: unknown) => {
          this.waiting.delete(reject);
          reject(err);
        },
      );
    });
  }

  /** Rejects every pending ask(). Later asks wait normally again. */
  abort(): void {
    const all = [...this.waiting];
    this.waiting.clear();
    for (const reject of all) reject(new FlowAbort());
  }

  /** Runs a stretch of flow; resolves false if an abort() ended it, rethrows any other error. */
  async run(stretch: () => Promise<unknown>): Promise<boolean> {
    try {
      await stretch();
      return true;
    } catch (err) {
      if (err instanceof FlowAbort) return false;
      throw err;
    }
  }
}
