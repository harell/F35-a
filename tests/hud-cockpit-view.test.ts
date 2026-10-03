/**
 * Cockpit view composition (#116, "more city, less panel"): the eye rests COCKPIT_REST_PITCH below the
 * nose and the cockpit pitches with it, so the panel stays put on screen while the horizon rises; a
 * canopy frame and one canopy-glass layer; dim panel lighting at night.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mesh, PerspectiveCamera, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { COCKPIT_REST_PITCH, DEFAULT_SETTINGS, DIFFICULTIES, QUALITY_PRESETS } from '../src/core/data';
import { EventBus } from '../src/core/events';
import type { TimeOfDay } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { COCKPIT_LIGHT, createCockpit } from '../src/hud/Cockpit';
import { canopyLook } from '../src/hud/cockpit/canopy';
import { pcdScreenRect } from '../src/hud/cockpit/geometry';
import { GLARE_LIP_ANGLE, computeLayout, makeLayout } from '../src/hud/hmd/layout';
import { buildMock } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { createCameraRig } from '../src/render/CameraRig';
import { restHead } from '../src/render/camera/cameraMath';
import { FlatTerrain } from './combat-helpers';

installPath2D();
const g = globalThis as unknown as { document?: unknown };
const prevDoc = g.document;
beforeAll(() => {
  // the PCD draws into a canvas: give it a recording one
  g.document = { createElement: () => makeFakeCanvas(1024, 512).canvas };
});
afterAll(() => {
  g.document = prevDoc;
});

const DEG = Math.PI / 180;
const noSafe = { top: 0, right: 0, bottom: 0, left: 0 };

/** A clean F-35A trimmed level at `alt` m and `speed` m/s, heading north. */
function trimmedJet(speed: number, alt = 300) {
  const w = createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(1) });
  const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, alt, 0), heading: 0, speed, loadout: 'clean' });
  for (let i = 0; i < 60; i++) w.step(1 / 60);
  return p;
}

/** Screen y (CSS px) of world point `q` from the pilot's eye with head pose `head` (relative to the body). */
function screenY(p: ReturnType<typeof trimmedJet>, head: Quaternion, q: Vector3, W: number, H: number): number {
  const cam = new PerspectiveCamera(60, W / H, 0.5, 60_000);
  cam.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
  cam.quaternion.copy(p.quaternion).multiply(head);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const v = q.clone().project(cam);
  return ((1 - v.y) / 2) * H;
}

describe('cockpit view: more city over the coaming (#116)', () => {
  for (const [W, H] of [[844, 390], [1280, 720]]) {
    it(`${W}x${H}: level at 300 m and the Stroll's 150 m/s, the water under the Harbour Bridge 2 km ahead shows over the glare shield`, () => {
      const p = trimmedJet(150);
      const lip = computeLayout(makeLayout(), W, H, noSafe, Math.tan(30 * DEG), true, { headPitch: 0 }).cockpitTop;
      // the bridge 2 km ahead, at the water (stricter than its 43 m deck)
      const fwd = new Vector3(p.velocity.x, 0, p.velocity.z).normalize();
      const bridge = p.position.clone().setY(0).addScaledVector(fwd, 2000);
      const after = screenY(p, restHead('cockpit', new Quaternion()), bridge, W, H);
      expect(after, `bridge at ${after.toFixed(0)} px, lip at ${lip.toFixed(0)} px`).toBeLessThan(lip - 0.015 * H);
      // (before #116 the eye looked along the nose and the panel hid it)
      expect(screenY(p, new Quaternion(), bridge, W, H)).toBeGreaterThan(lip);
    });
  }

  it('shows roughly 10–15° below the horizon over the coaming in level flight from 150 to 250 m/s', () => {
    for (const speed of [150, 180, 220, 250]) {
      const p = trimmedJet(speed);
      // the horizon is α below the nose; the lip GLARE_LIP_ANGLE below the view's centre
      const below = (GLARE_LIP_ANGLE + COCKPIT_REST_PITCH - p.flight.alpha) / DEG;
      expect(below, `${speed} m/s: α ${(p.flight.alpha / DEG).toFixed(1)}°`).toBeGreaterThanOrEqual(10);
      expect(below, `${speed} m/s`).toBeLessThanOrEqual(15.5);
    }
  });

  it('keeps the PCD where it was on screen: same rect, still ≥ 60 % in view at 844x390 and 1280x720', () => {
    for (const [W, H] of [[844, 390], [1280, 720]]) {
      const r = pcdScreenRect(60, W, H);
      expect(r.visible, `${W}x${H}`).toBeGreaterThan(0.6);
      const lip = computeLayout(makeLayout(), W, H, noSafe, Math.tan(30 * DEG), true, { headPitch: 0 }).cockpitTop;
      expect(r.top).toBeGreaterThan(lip);
    }
  });

  it('the camera rig rests the cockpit view COCKPIT_REST_PITCH below the nose, the hud view on it', () => {
    for (const [mode, pitch] of [['cockpit', -COCKPIT_REST_PITCH], ['hud', 0]] as const) {
      const mock = buildMock('aa');
      const entities = { getEyeOffset: () => new Vector3(0, 1.02, -3.52) } as unknown as Parameters<typeof createCameraRig>[1];
      const rig = createCameraRig(mock.world, entities, { ...DEFAULT_SETTINGS });
      rig.resize(844, 390);
      rig.setMode(mode);
      const p = mock.player;
      p.flight.alpha = 0; // no buffet
      const ctx = { dt: 1 / 30, time: 0, world: mock.world, player: p, camera: rig.camera, viewMode: mode, focusId: p.id, mission: mock.mission, settings: { ...DEFAULT_SETTINGS }, quality: { ...QUALITY_PRESETS.medium }, paused: false, screen: { width: 844, height: 390, dpr: 1, safe: noSafe } } as FrameContext;
      rig.update(ctx);
      // the camera's forward in the body frame
      const f = new Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion).applyQuaternion(p.quaternion.clone().invert());
      expect(Math.asin(f.y), mode).toBeCloseTo(pitch, 3);
    }
  });
});

describe('canopy (#116)', () => {
  it('adds one draw call: the glass; the frame is merged into the cockpit shell', () => {
    const mock = buildMock('aa');
    const cockpit = createCockpit(mock.events, { ...QUALITY_PRESETS.medium });
    cockpit.visible = true;
    let scene: Scene | null = null;
    const renderer = { autoClear: true, clearDepth() {}, render(s: Scene) { scene = s; } } as unknown as WebGLRenderer;
    cockpit.render(renderer);
    const meshes: Mesh[] = [];
    scene!.traverse((o) => {
      if ((o as Mesh).isMesh) meshes.push(o as Mesh);
    });
    // shell, PCD, stick (shaft, grip, cap, boot), throttle (slot, arm, handle) — as before — plus the glass
    expect(meshes.length).toBe(10);
    expect(meshes.filter((m) => m.name === 'canopyGlass')).toHaveLength(1);
    const glass = meshes.find((m) => m.name === 'canopyGlass')!;
    expect((glass.material as { transparent: boolean; depthWrite: boolean }).transparent).toBe(true);
    expect((glass.material as { depthWrite: boolean }).depthWrite).toBe(false);
    cockpit.dispose();
  });

  it('glares at the sun by day and at a low sun, not at night or under overcast; mirrors the panel most at dawn, dusk and night', () => {
    expect(canopyLook('day', 'clear').glare).toBeGreaterThan(0.9);
    expect(canopyLook('dusk', 'clear').glare).toBeGreaterThan(0.5);
    expect(canopyLook('night', 'clear').glare).toBe(0);
    expect(canopyLook('day', 'overcast').glare).toBeLessThan(0.2);
    for (const tod of ['dawn', 'dusk', 'night'] as TimeOfDay[]) expect(canopyLook(tod, 'clear').reflect).toBeGreaterThan(3 * canopyLook('day', 'clear').reflect);
    // a light tint, never a dark one
    for (const tod of ['dawn', 'day', 'dusk', 'night'] as TimeOfDay[]) expect(canopyLook(tod, 'scattered').tint).toBeLessThanOrEqual(0.04);
  });

  it('lights the panel at night with a dim flood light and the displays\' glow, not the moon', () => {
    const n = COCKPIT_LIGHT.night;
    const d = COCKPIT_LIGHT.day;
    expect(n.flood).toBeGreaterThan(0);
    expect(n.glow).toBeGreaterThan(COCKPIT_LIGHT.dusk.glow);
    expect(d.flood).toBe(0);
    expect(n.hemiI).toBeLessThan(0.3 * d.hemiI);
    expect(n.screen).toBeLessThan(1);
  });
});
