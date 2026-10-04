/**
 * App-flow interruption (#71): the fly() test hook takes over from whatever screen the app flow (or
 * the pause menu's loop) is waiting on. A wait that is never answered must not keep a loop alive.
 */
import { describe, expect, it } from 'vitest';
import { FlowAbort, FlowInterrupt } from '../src/game/flow';

/** A screen whose answer the test gives by hand (or never). */
function screen<T>() {
  let answer!: (v: T) => void;
  const shown = new Promise<T>((r) => (answer = r));
  return { shown, answer };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('FlowInterrupt', () => {
  it('ask() settles with the screen answer when nothing takes over', async () => {
    const flow = new FlowInterrupt();
    const menu = screen<'campaign' | 'settings'>();
    const asked = flow.ask(menu.shown);
    menu.answer('campaign');
    await expect(asked).resolves.toBe('campaign');
  });

  it('abort() rejects every pending ask() with FlowAbort, even screens nobody answers', async () => {
    const flow = new FlowInterrupt();
    const mainMenu = flow.ask(screen<string>().shown);
    const pauseMenu = flow.ask(screen<string>().shown);
    flow.abort();
    await expect(mainMenu).rejects.toBeInstanceOf(FlowAbort);
    await expect(pauseMenu).rejects.toBeInstanceOf(FlowAbort);
  });

  it('asks made after an abort() wait normally again', async () => {
    const flow = new FlowInterrupt();
    flow.abort();
    const debrief = screen<'next' | 'menu'>();
    const asked = flow.ask(debrief.shown);
    let settled = false;
    void asked.then(
      () => (settled = true),
      () => (settled = true),
    );
    await tick();
    expect(settled).toBe(false);
    debrief.answer('menu');
    await expect(asked).resolves.toBe('menu');
  });

  it('abort() with nothing waiting is harmless (no unhandled rejection)', async () => {
    const flow = new FlowInterrupt();
    flow.abort();
    flow.abort();
    await tick();
    const s = screen<number>();
    const asked = flow.ask(s.shown);
    s.answer(3);
    await expect(asked).resolves.toBe(3);
  });

  it('run() ends a stretch quietly on abort, finishes it otherwise, and rethrows real errors', async () => {
    const flow = new FlowInterrupt();
    const steps: string[] = [];
    const stretch = flow.run(async () => {
      steps.push('menu shown');
      await flow.ask(screen<string>().shown); // never answered
      steps.push('after menu'); // must not run
    });
    await tick();
    flow.abort();
    await expect(stretch).resolves.toBe(false);
    expect(steps).toEqual(['menu shown']);

    await expect(flow.run(async () => steps.push('done'))).resolves.toBe(true);
    await expect(
      flow.run(async () => {
        throw new Error('real bug');
      }),
    ).rejects.toThrow('real bug');
  });

  it('a menu loop that is taken over goes round once more instead of waiting forever (the fly() hand-over)', async () => {
    // a model of Game.mainMenu(): each round flies a pending mission or waits on the main menu
    const flow = new FlowInterrupt();
    const log: string[] = [];
    let pending: string | null = null;
    let menu = screen<string>();
    const round = () =>
      flow.run(async () => {
        if (pending) {
          log.push(`fly ${pending}`);
          pending = null;
          return;
        }
        log.push('main menu');
        log.push(`chose ${await flow.ask(menu.shown)}`);
      });
    const loop = (async () => {
      for (let i = 0; i < 3; i++) await round();
    })();
    await tick();
    pending = 'g02'; // fly('g02') from the main menu
    menu = screen<string>(); // the menu shown after that flight
    flow.abort();
    await tick();
    menu.answer('credits');
    await loop;
    expect(log).toEqual(['main menu', 'fly g02', 'main menu', 'chose credits']);
  });
});
