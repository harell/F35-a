/**
 * STUB CameraRig — to be replaced by the MODELS agent. Keeps export `createCameraRig`.
 */
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { CameraRigApi, CreateCameraRig } from '../core/contracts';
import type { CameraMode } from '../core/types';

export const createCameraRig: CreateCameraRig = (world, entities, settings) => {
  const camera = new PerspectiveCamera(settings.fov, 16 / 9, 0.5, 60_000);
  let mode: CameraMode = 'chase';
  const headLocal = new Quaternion();
  const rig: CameraRigApi = {
    camera,
    get mode() { return mode; },
    get focusId() { return world.player?.id ?? null; },
    headLocal,
    setMode(m) { mode = m; },
    nextMode() { mode = mode === 'chase' ? 'cockpit' : 'chase'; return mode; },
    look() {},
    resetLook() {},
    shake() {},
    update() {
      const p = world.player;
      if (!p) return;
      if (mode === 'cockpit' || mode === 'hud') {
        camera.position.copy(entities.getEyeOffset(p.type)).applyQuaternion(p.quaternion).add(p.position);
        camera.quaternion.copy(p.quaternion);
      } else {
        const off = new Vector3(0, 6, 28).applyQuaternion(p.quaternion);
        camera.position.copy(p.position).add(off);
        camera.quaternion.copy(p.quaternion);
      }
    },
    resize(w, h) { camera.aspect = w / h; camera.updateProjectionMatrix(); },
    dispose() {},
  };
  return rig;
};
