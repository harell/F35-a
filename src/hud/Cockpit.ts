/**
 * F35-A — 3D cockpit (second render pass in 'cockpit' view).
 *
 * Own Scene + near-plane camera (0.02–20 m) at the pilot's eye, oriented like the main camera relative
 * to the airframe (head look, shake and buffet included) so the cockpit is rock-solid against the
 * world. Geometry: glare shield with lip, hood face with the up-front display (UFD), the 20x8 in
 * panoramic cockpit display (PCD, one wide CanvasTexture split into tappable portals), instrument
 * panel body, canopy rails / rear bow, side consoles, and a side-stick + throttle that follow the
 * pilot's inputs. Lighting follows the mission's time of day (sun direction in the body frame), with a
 * soft display glow at night.
 *
 * render(): autoClear off → clearDepth → render cockpit → restore (the world stays in the colour
 * buffer, the cockpit always draws on top).
 */
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  type Object3D,
} from 'three';
import type { CockpitApi, CreateCockpit, FrameContext } from '../core/contracts';
import type { TimeOfDay, Weather } from '../core/types';
import { DEG } from '../core/math';
import { loadHudFont } from './font';
import { PCD, UFD, UFD_POS, buildCockpit, pcdFrame } from './cockpit/geometry';
import { PcdDisplay } from './cockpit/pcd';

/** Cockpit lighting per time of day (sun azimuth/elevation in degrees, colours sRGB). */
const LIGHT: Record<TimeOfDay, { az: number; el: number; sun: number; sunI: number; sky: number; ground: number; hemiI: number; glow: number }> = {
  dawn: { az: 96, el: 7, sun: 0xffb27a, sunI: 2.0, sky: 0x8f9cc8, ground: 0x3a302c, hemiI: 1.1, glow: 0.02 },
  day: { az: 20, el: 55, sun: 0xfff3df, sunI: 2.8, sky: 0xbcd3f0, ground: 0x6d6456, hemiI: 1.7, glow: 0 },
  dusk: { az: 262, el: 5, sun: 0xff9a58, sunI: 1.8, sky: 0x7d82b4, ground: 0x2e2626, hemiI: 0.95, glow: 0.03 },
  night: { az: 20, el: 38, sun: 0xa8bce8, sunI: 0.25, sky: 0x223458, ground: 0x0c0e14, hemiI: 0.4, glow: 0.07 },
};

const _qInv = new Quaternion();
const _sun = new Vector3();
const _ndc = new Vector2();
const _x = new Vector3(1, 0, 0);
const _z = new Vector3(0, 0, 1);
const _qa = new Quaternion();
const _qb = new Quaternion();

export const createCockpit: CreateCockpit = (events, quality) => {
  void events;
  const scene = new Scene();
  scene.name = 'cockpit';
  const camera = new PerspectiveCamera(60, 16 / 9, 0.02, 20);

  // lights
  const hemi = new HemisphereLight(0xbcd3f0, 0x6d6456, 1.5);
  const sun = new DirectionalLight(0xffffff, 2.5);
  sun.position.set(0, 5, -2);
  scene.add(hemi, sun, sun.target);
  const glow = new PointLight(0x5fd0b0, 0, 1.6, 2);
  const fr = pcdFrame({ center: new Vector3(), quat: new Quaternion() });
  glow.position.copy(fr.center).add(new Vector3(0, 0.05, 0.12));
  scene.add(glow);

  // materials + meshes
  const shellMat = new MeshLambertMaterial({ vertexColors: true });
  const controlMat = new MeshLambertMaterial({ color: 0x1c1e21 });
  const gripMat = new MeshLambertMaterial({ color: 0x0f1011 });
  const parts = buildCockpit(controlMat, gripMat);
  const shell = new Mesh(parts.shell, shellMat);
  shell.name = 'cockpitShell';
  scene.add(shell, parts.stick, parts.throttle);
  const lever = parts.throttle.getObjectByName('lever') as Object3D;

  const pcd = new PcdDisplay(quality);
  const screenMat = new MeshBasicMaterial({ map: pcd.texture, toneMapped: false });
  const screen = new Mesh(new PlaneGeometry(PCD.width, PCD.height), screenMat);
  screen.position.copy(fr.center);
  screen.quaternion.copy(fr.quat);
  screen.name = 'pcd';
  scene.add(screen);
  const ufdMat = new MeshBasicMaterial({ map: pcd.ufdTexture, toneMapped: false });
  const ufd = new Mesh(new PlaneGeometry(UFD.width, UFD.height), ufdMat);
  ufd.position.copy(UFD_POS);
  ufd.rotation.x = 0.12;
  scene.add(ufd);

  void loadHudFont(() => pcd.fontsChanged());

  const raycaster = new Raycaster();
  let gSag = 0;
  let wasVisible = false;
  let lightKey = '';
  let fov = 60;
  let aspect = 16 / 9;
  const sunWorld = new Vector3(0, 1, 0);
  const tmpColor = new Color();

  function applyLighting(tod: TimeOfDay, weather: Weather): void {
    const key = tod + weather;
    if (key === lightKey) return;
    lightKey = key;
    const L = LIGHT[tod] ?? LIGHT.day;
    const overcast = weather === 'overcast' ? 0.45 : weather === 'scattered' ? 0.85 : 1;
    sun.color.copy(tmpColor.setHex(L.sun));
    sun.intensity = L.sunI * overcast;
    hemi.color.setHex(L.sky);
    hemi.groundColor.setHex(L.ground);
    hemi.intensity = L.hemiI * (weather === 'overcast' ? 1.15 : 1);
    glow.intensity = L.glow;
    const a = L.az * DEG;
    const e = L.el * DEG;
    sunWorld.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
    // displays a touch dimmer at night so they don't glare
    const dim = tod === 'night' ? 0.82 : 1;
    screenMat.color.setScalar(dim);
    ufdMat.color.setScalar(dim);
  }

  const api: CockpitApi = {
    visible: false,

    update(ctx: FrameContext, headLocal: Quaternion) {
      if (!api.visible) {
        wasVisible = false;
        return;
      }
      if (!wasVisible) {
        wasVisible = true;
        pcd.markDirty();
      }
      const p = ctx.player;
      const main = ctx.camera;
      if (main && (main.fov !== fov || main.aspect !== aspect)) {
        fov = main.fov;
        aspect = main.aspect;
        camera.fov = fov;
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
      }
      // head orientation relative to the airframe — taken from the main camera so shake / buffet match
      if (p && main) {
        _qInv.copy(p.quaternion).invert();
        camera.quaternion.copy(_qInv).multiply(main.quaternion);
      } else {
        camera.quaternion.copy(headLocal);
      }
      const dt = ctx.paused ? 0 : ctx.dt;
      // G pushes the head down (the cockpit rises in view) — kept subtle so hard turns don't hide the view
      const g = p ? p.flight.gLoad : 1;
      const target = Math.max(-0.03, Math.min(0.045, (g - 1) * 0.0055));
      gSag += (target - gSag) * (1 - Math.exp(-6 * dt));
      camera.position.set(0, -gSag, 0);
      camera.updateMatrixWorld();

      if (p) {
        // side-stick: aft stick tilts the grip toward the pilot, right stick to the right
        _qa.setFromAxisAngle(_x, p.input.pitch * 0.2);
        _qb.setFromAxisAngle(_z, -p.input.roll * 0.18);
        parts.stick.quaternion.copy(parts.stickBase).multiply(_qa).multiply(_qb);
        // throttle lever slides forward with power
        lever.position.z = 0.03 - p.input.throttle * 0.15;
        lever.rotation.x = -p.input.throttle * 0.25;
        // sun in the body frame
        const def = ctx.mission?.def;
        applyLighting(def?.timeOfDay ?? 'day', def?.weather ?? 'clear');
        _sun.copy(sunWorld).applyQuaternion(_qInv);
        sun.position.copy(_sun).multiplyScalar(5);
      }
      pcd.update(ctx, ctx.dt);
    },

    render(renderer) {
      if (!api.visible) return;
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(scene, camera);
      renderer.autoClear = auto;
    },

    resize(width, height) {
      aspect = Math.max(0.1, width / Math.max(1, height));
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },

    handleTap(nx, ny) {
      if (!api.visible) return false;
      _ndc.set(nx * 2 - 1, -(ny * 2 - 1));
      raycaster.setFromCamera(_ndc, camera);
      const hit = raycaster.intersectObject(screen, false)[0];
      if (!hit || !hit.uv) return false;
      return pcd.tapUv(hit.uv.x, hit.uv.y);
    },

    dispose() {
      scene.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      shellMat.dispose();
      controlMat.dispose();
      gripMat.dispose();
      screenMat.dispose();
      ufdMat.dispose();
      pcd.dispose();
      scene.clear();
    },
  };
  return api;
};
