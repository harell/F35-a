/**
 * F35-A — 3D cockpit (second render pass in 'cockpit' view).
 *
 * Own Scene + near-plane camera (0.02–20 m) at the pilot's eye, oriented like the main camera relative
 * to the airframe (head look, shake and buffet included) so the cockpit is rock-solid against the
 * world. Geometry: glare shield with lip, hood face (the up-front display strip was dropped: unreadable on a phone), the 20x8 in
 * panoramic cockpit display (PCD, one wide CanvasTexture split into tappable portals), instrument
 * panel body, canopy side rails / aft frame, side consoles, and a side-stick + throttle that follow the
 * pilot's inputs, all pitched to the rest head pose (COCKPIT_REST_PITCH below the nose). Over them, the
 * canopy glass (cockpit/canopy.ts: tint, sun glare, the PCD's reflection; one draw call). Lighting
 * follows the mission's time of day (sun direction in the body frame); at night a dim flood light and
 * the displays' glow light the panel.
 *
 * render(): autoClear off → clearDepth → render cockpit → restore (the world stays in the colour
 * buffer, the cockpit always draws on top).
 *
 * Taps: a tap on a PCD portal opens it in the big 2D zoom overlay (cockpit/zoom.ts, drawn by the HUD);
 * while it is open every tap is consumed — on a tab it switches the page, anywhere else it closes.
 */
import {
  Color,
  DirectionalLight,
  Group,
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
import { PCD, buildCockpit, pcdFrame } from './cockpit/geometry';
import { PcdDisplay } from './cockpit/pcd';
import { pcdZoom } from './cockpit/zoom';
import type { PageId } from './cockpit/pages';
import { COCKPIT_REST_PITCH, TEST_HOOKS } from '../core/data';
import { CanopyGlass } from './cockpit/canopy';
import { DasMask, dasRadius, dasWindow, inDasWindow } from './cockpit/das';
import type { AircraftEntity } from '../sim/entities';
import type { SimWorld } from '../sim/api';

/**
 * Cockpit lighting per time of day (sun azimuth/elevation in degrees, colours sRGB). `glow` is the
 * displays' spill onto the coaming and hood, `flood` the dim panel flood light over the pilot's shoulder
 * (#116: at night the panel is lit by those two, not by the moon), `screen` the PCD's brightness.
 */
export const COCKPIT_LIGHT: Record<TimeOfDay, { az: number; el: number; sun: number; sunI: number; sky: number; ground: number; hemiI: number; glow: number; flood: number; screen: number }> = {
  dawn: { az: 96, el: 7, sun: 0xffb27a, sunI: 2.0, sky: 0x8f9cc8, ground: 0x3a302c, hemiI: 1.1, glow: 0.1, flood: 0.08, screen: 1 },
  day: { az: 20, el: 55, sun: 0xfff3df, sunI: 2.8, sky: 0xbcd3f0, ground: 0x6d6456, hemiI: 1.7, glow: 0, flood: 0, screen: 1 },
  dusk: { az: 262, el: 5, sun: 0xff9a58, sunI: 1.8, sky: 0x7d82b4, ground: 0x2e2626, hemiI: 0.95, glow: 0.1, flood: 0.08, screen: 1 },
  night: { az: 20, el: 38, sun: 0xa8bce8, sunI: 0.12, sky: 0x223458, ground: 0x0c0e14, hemiI: 0.22, glow: 0.42, flood: 0.42, screen: 0.78 },
};

/** Brightness of the PCD's reflection in the canopy (× canopyLook's per-time-of-day factor). */
const CANOPY_REFLECT = 0.25;

const _qInv = new Quaternion();
const _sun = new Vector3();
const _ndc = new Vector2();
const _x = new Vector3(1, 0, 0);
const _z = new Vector3(0, 0, 1);
const _qa = new Quaternion();
const _qb = new Quaternion();
const _tv = new Vector3();
const _qCam = new Quaternion();

export const createCockpit: CreateCockpit = (events, quality) => {
  void events;
  const scene = new Scene();
  scene.name = 'cockpit';
  const camera = new PerspectiveCamera(60, 16 / 9, 0.02, 20);
  // everything built in the eye frame hangs off `body`, pitched to the rest head pose (#116): the panel
  // sits where it always did on screen while the eye looks COCKPIT_REST_PITCH below the jet's nose
  const body = new Group();
  body.name = 'cockpitBody';
  body.rotation.x = -COCKPIT_REST_PITCH;
  scene.add(body);

  // lights
  const hemi = new HemisphereLight(0xbcd3f0, 0x6d6456, 1.5);
  const sun = new DirectionalLight(0xffffff, 2.5);
  sun.position.set(0, 5, -2);
  scene.add(hemi, sun, sun.target);
  const glow = new PointLight(0x5fd0b0, 0, 1.6, 2);
  const fr = pcdFrame({ center: new Vector3(), quat: new Quaternion() });
  glow.position.copy(fr.center).add(new Vector3(0, 0.05, 0.12));
  // panel flood light: over the pilot's shoulder, lighting the coaming, the hood and the consoles
  const flood = new PointLight(0xc8dcff, 0, 2.2, 2);
  flood.position.set(0.18, 0.22, 0.15);
  body.add(glow, flood);

  // materials + meshes
  const shellMat = new MeshLambertMaterial({ vertexColors: true });
  const controlMat = new MeshLambertMaterial({ color: 0x1c1e21 });
  const gripMat = new MeshLambertMaterial({ color: 0x0f1011 });
  const parts = buildCockpit(controlMat, gripMat);
  const shell = new Mesh(parts.shell, shellMat);
  shell.name = 'cockpitShell';
  body.add(shell, parts.stick, parts.throttle);
  const lever = parts.throttle.getObjectByName('lever') as Object3D;

  const pcd = new PcdDisplay(quality);
  const screenMat = new MeshBasicMaterial({ map: pcd.texture, toneMapped: false });
  const screen = new Mesh(new PlaneGeometry(PCD.width, PCD.height), screenMat);
  screen.position.copy(fr.center);
  screen.quaternion.copy(fr.quat);
  screen.name = 'pcd';
  body.add(screen);
  const glass = new CanopyGlass(pcd.texture);
  body.add(glass.mesh);
  // the DAS window's depth-only disc rides on the camera (#116)
  const das = new DasMask();
  scene.add(camera);
  camera.add(das.mesh);

  void loadHudFont(() => pcd.fontsChanged());

  const raycaster = new Raycaster();
  let gSag = 0;
  let wasVisible = false;
  let lightKey = '';
  let fov = 60;
  let aspect = 16 / 9;
  let viewW = 1;
  let viewH = 1;
  const sunWorld = new Vector3(0, 1, 0);
  const tmpColor = new Color();

  /**
   * Open the DAS window when the designated (or locked) target is in view but behind the panel or the
   * PCD: a ray from the eye through it hits the cockpit. Same target filter as the HMD's box.
   */
  function updateDas(world: SimWorld, p: AircraftEntity | null): void {
    dasWindow.active = false;
    if (p && p.alive && !pcdZoom.open) {
      const t = world.getEntity(p.radar.lockedId ?? p.radar.designatedId);
      if (t && t.alive && t.team !== p.team && t.kind !== 'missile' && t.kind !== 'decoy') {
        // the target in the cockpit camera's frame (the eye's offset is nothing at target ranges)
        _tv.copy(t.position).sub(p.position).applyQuaternion(_qInv).applyQuaternion(_qCam.copy(camera.quaternion).invert());
        if (_tv.z < -1) {
          _tv.applyMatrix4(camera.projectionMatrix);
          if (Math.abs(_tv.x) < 1 && Math.abs(_tv.y) < 1) {
            body.updateMatrixWorld();
            _ndc.set(_tv.x, _tv.y);
            raycaster.setFromCamera(_ndc, camera);
            if (raycaster.intersectObjects(dasTargets, false).length > 0) {
              dasWindow.active = true;
              dasWindow.id = t.id;
              dasWindow.x = ((_tv.x + 1) / 2) * viewW;
              dasWindow.y = ((1 - _tv.y) / 2) * viewH;
              dasWindow.r = dasRadius(viewH);
            }
          }
        }
      }
    }
    das.place(camera, viewW, viewH);
  }
  const dasTargets: Object3D[] = [shell, screen];

  function applyLighting(tod: TimeOfDay, weather: Weather): void {
    const key = tod + weather;
    if (key === lightKey) return;
    lightKey = key;
    const L = COCKPIT_LIGHT[tod] ?? COCKPIT_LIGHT.day;
    const overcast = weather === 'overcast' ? 0.45 : weather === 'scattered' ? 0.85 : 1;
    sun.color.copy(tmpColor.setHex(L.sun));
    sun.intensity = L.sunI * overcast;
    hemi.color.setHex(L.sky);
    hemi.groundColor.setHex(L.ground);
    hemi.intensity = L.hemiI * (weather === 'overcast' ? 1.15 : 1);
    glow.intensity = L.glow;
    flood.intensity = L.flood;
    glass.setLook(tod, weather, L.sun, CANOPY_REFLECT);
    const a = L.az * DEG;
    const e = L.el * DEG;
    sunWorld.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
    // displays dimmer at night so they don't glare
    screenMat.color.setScalar(L.screen);
  }

  const api: CockpitApi = {
    visible: false,

    update(ctx: FrameContext, headLocal: Quaternion) {
      if (!api.visible) {
        wasVisible = false;
        dasWindow.active = false;
        if (pcdZoom.open) pcdZoom.close();
        return;
      }
      if (ctx.player && !ctx.player.alive && pcdZoom.open) pcdZoom.close();
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
        glass.setSun(_sun.applyQuaternion(_qa.copy(body.quaternion).invert()));
      }
      if (p) _qInv.copy(p.quaternion).invert();
      updateDas(ctx.world, p);
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
      viewW = Math.max(1, width);
      viewH = Math.max(1, height);
      aspect = Math.max(0.1, width / Math.max(1, height));
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },

    handleTap(nx, ny) {
      if (!api.visible) return false;
      if (pcdZoom.open) {
        const tab = pcdZoom.tabAt(nx * viewW, ny * viewH);
        if (tab >= 0) pcd.setPage(pcdZoom.portal, tab);
        else pcdZoom.close();
        return true;
      }
      // a tap in the DAS window is on the target seen through it (the HUD picks it), not on the panel
      if (inDasWindow(nx * viewW, ny * viewH)) return false;
      _ndc.set(nx * 2 - 1, -(ny * 2 - 1));
      // (matrices are normally refreshed by render(); a tap can come before the first cockpit frame)
      body.updateMatrixWorld();
      raycaster.setFromCamera(_ndc, camera);
      const hit = raycaster.intersectObject(screen, false)[0];
      if (!hit || !hit.uv) return false;
      return pcd.tapUv(hit.uv.x, hit.uv.y);
    },

    dispose() {
      pcdZoom.close();
      scene.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      shellMat.dispose();
      controlMat.dispose();
      gripMat.dispose();
      screenMat.dispose();
      glass.dispose();
      das.dispose();
      dasWindow.active = false;
      pcd.dispose();
      scene.clear();
    },
  };
  if (TEST_HOOKS) {
    const read = (): PcdRead => ({
      pages: pcd.pages(),
      portals: [0, 1, 2].map((i) => [...(pcd.portalPages(i) ?? [])]),
      zoom: pcdZoom.open ? { portal: pcdZoom.portal, page: pcdZoom.page! } : null,
    });
    const hooks: CockpitTestHooks = {
      pcdRead: read,
      pcdPage(portal, page, zoom = false) {
        const i = typeof portal === 'number' ? portal : PCD_PORTAL_NAMES.indexOf(portal);
        const pages = pcd.portalPages(i);
        if (!pages) throw new Error(`no PCD portal ${portal} (0-2 or ${PCD_PORTAL_NAMES.join(', ')})`);
        const index = pages.indexOf(page.toUpperCase() as PageId);
        if (index < 0) throw new Error(`PCD portal ${portal} has no ${page} page (${pages.join(', ')})`);
        pcd.setPage(i, index);
        if (zoom) pcd.openZoom(i);
        return read();
      },
    };
    Object.assign(api, hooks);
  }
  return api;
};

/** PCD portals by name, left to right (the outer ones swap their pages when left-handed). */
const PCD_PORTAL_NAMES = ['left', 'centre', 'right'] as const;

/** The PCD's state (test hooks, `__f35.state().hud.pcd`; #118). */
export interface PcdRead {
  /** The page on show in each portal, left to right. */
  pages: PageId[];
  /** The pages each portal can show. */
  portals: PageId[][];
  /** The zoom overlay (cockpit view): its portal and page; null = closed. */
  zoom: { portal: number; page: PageId } | null;
}

/** Cockpit methods that exist only with the test hooks (#118). */
export interface CockpitTestHooks {
  pcdRead(): PcdRead;
  /**
   * Show `page` (FUEL, ENG, ICAWS…) on `portal` (0-2 or 'left' / 'centre' / 'right'); `zoom` opens it in
   * the zoom overlay too, which only stays open in the cockpit view. Throws on a page the portal lacks.
   */
  pcdPage(portal: number | 'left' | 'centre' | 'right', page: string, zoom?: boolean): PcdRead;
}
