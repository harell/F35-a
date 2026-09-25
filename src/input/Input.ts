/**
 * STUB input (keyboard only) — to be replaced by the UI/INPUT agent. Keeps export `createInput`.
 */
import type { CreateInput, InputApi, InputCommand } from '../core/contracts';
import { neutralControls } from '../core/types';

export const createInput: CreateInput = (_root, _settings) => {
  const controls = neutralControls();
  const keys = new Set<string>();
  const handlers = new Map<InputCommand, Set<() => void>>();
  const fire = (c: InputCommand) => handlers.get(c)?.forEach((f) => f());
  const down = (e: KeyboardEvent) => {
    keys.add(e.code);
    if (e.code === 'KeyC') fire('camera');
    if (e.code === 'Escape' || e.code === 'KeyP') fire('pause');
    if (e.code === 'KeyQ') fire('cycleWeapon');
    if (e.code === 'KeyT') fire('cycleTarget');
  };
  const up = (e: KeyboardEvent) => keys.delete(e.code);
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  const api: InputApi = {
    controls,
    update(dt) {
      controls.pitch = (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0);
      controls.roll = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
      if (keys.has('KeyW')) controls.throttle = Math.min(1, controls.throttle + dt * 0.5);
      if (keys.has('KeyS')) controls.throttle = Math.max(0, controls.throttle - dt * 0.5);
      controls.fireGun = keys.has('Space');
      controls.fireWeapon = keys.has('Enter');
    },
    on(cmd, fn) {
      let s = handlers.get(cmd);
      if (!s) handlers.set(cmd, (s = new Set()));
      s.add(fn);
      return () => s!.delete(fn);
    },
    consumeLook: () => ({ yaw: 0, pitch: 0 }),
    consumeTaps: () => [],
    setEnabled() {},
    setThrottle(v) { controls.throttle = v; },
    applySettings() {},
    requestMotionPermission: async () => false,
    recenterTilt() {},
    dispose() { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); },
  };
  return api;
};
