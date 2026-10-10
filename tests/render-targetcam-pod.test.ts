import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { POD_ZOOM, POD_ZOOM_DEFAULT, POD_ZOOM_SMALL, isPodTarget, nextPodZoom, podSpan } from '../src/core/pod';
import { OVERCAST_DECK, cloudBase } from '../src/core/weather';
import type { EntityRendererApi } from '../src/core/contracts';
import type { SimWorld, TerrainQuery } from '../src/sim/api';
import { cloudBetween } from '../src/sim/sensors/los';
import { AircraftEntity, GroundTargetEntity, SamSiteEntity } from '../src/sim/entities';
import { computeLayout, makeLayout } from '../src/hud/hmd/layout';
import { fitReadout, pipView, podMask, podReadout, resetPip, resetPodZoom, stepPod, tapPip } from '../src/hud/hmd/pip';
import { TargetCam } from '../src/render/TargetCam';
import { POD_CLEAR_K, POD_RANGE, POD_STANDOFF, TARGET_CAM_FOV, framingDistance, groundLookY, groundMinFraming, makePose, podCamPose, podDistance, podFov, podLookY, targetCamPose } from '../src/render/targetCam/pose';

const noSafe = { top: 0, right: 0, bottom: 0, left: 0 };
const tan30 = Math.tan(Math.PI / 6);
const ZOOM = POD_ZOOM.findIndex((z) => z.name === 'ZOOM');

/** A 0.38 m ground target (the g03 stoat's size) on flat ground at the origin. */
function tiny(): GroundTargetEntity {
  const g = new GroundTargetEntity(5, 'stoat', 'red', { radius: 0.19 });
  g.position.set(0, 0, 0);
  return g;
}

/** Flat terrain at height 0; `blocked` decides the line of sight. */
function flat(blocked = false): TerrainQuery {
  return { size: 10_000, heightAt: () => 0, surfaceHeightAt: () => 0, isWater: () => false, lineOfSight: () => !blocked } as unknown as TerrainQuery;
}

/** Height (px) an upright segment of `len` m at `at` spans in a window `h` px tall, seen from `pose`. */
function spanPx(pose: ReturnType<typeof makePose>, at: Vector3, len: number, h: number, fov = TARGET_CAM_FOV): number {
  const cam = new PerspectiveCamera(fov, 16 / 9, 0.1, 50_000);
  cam.position.copy(pose.position);
  cam.up.copy(pose.up);
  cam.lookAt(pose.look);
  cam.updateMatrixWorld();
  // a segment square to the line of sight, in the vertical plane through it
  const fwd = pose.look.clone().sub(pose.position).normalize();
  const right = new Vector3().crossVectors(fwd, new Vector3(0, 1, 0)).normalize();
  const upS = new Vector3().crossVectors(right, fwd).normalize();
  const a = at.clone().addScaledVector(upS, -len / 2).project(cam);
  const b = at.clone().addScaledVector(upS, len / 2).project(cam);
  return (Math.abs(b.y - a.y) / 2) * h;
}

describe('pod (EOTS) zoom steps', () => {
  it('are WIDE → NARROW → ZOOM, narrowing, and a tap cycles them round', () => {
    expect(POD_ZOOM.map((z) => z.name)).toEqual(['WIDE', 'NARROW', 'ZOOM']);
    for (let i = 1; i < POD_ZOOM.length; i++) expect(POD_ZOOM[i].span).toBeLessThan(POD_ZOOM[i - 1].span);
    expect(nextPodZoom(0)).toBe(1);
    expect(nextPodZoom(2)).toBe(0);
  });

  it('pod view for ground targets and SAM sites; aircraft and ships keep their shots', () => {
    expect(isPodTarget(new SamSiteEntity(1, 'sa6', 'red'))).toBe(true);
    expect(isPodTarget(new GroundTargetEntity(2, 'hangar', 'red'))).toBe(true);
    expect(isPodTarget(new GroundTargetEntity(3, 'suicide_boat', 'red'))).toBe(true);
    expect(isPodTarget(new GroundTargetEntity(4, 'ship', 'red'))).toBe(false);
    expect(isPodTarget(new AircraftEntity(5, 'mig29', 'red'))).toBe(false);
  });
});

describe('pod camera pose', () => {
  it('sits on the line of sight from the jet, looking along it, framing the zoom step (outside the site)', () => {
    const t = new SamSiteEntity(7, 'sa6', 'red');
    t.position.set(200, 30, -400);
    const eye = new Vector3(3000, 2500, 2000);
    for (const step of POD_ZOOM) {
      const pose = podCamPose(t, eye, step.span, makePose());
      expect(pose.look.toArray()).toEqual([200, 30 + podLookY(t), -400]);
      const d = pose.position.distanceTo(pose.look);
      expect(d).toBeCloseTo(Math.max(POD_STANDOFF, podDistance(step.span), t.radius * POD_CLEAR_K), 5);
      // the lens shows the step's span from there
      expect(2 * d * Math.tan((podFov(step.span, d) * Math.PI) / 360)).toBeCloseTo(step.span, 5);
      // on the jet → target line: the camera looks the way the pod does
      const toEye = eye.clone().sub(pose.look).normalize();
      const toCam = pose.position.clone().sub(pose.look).normalize();
      expect(toCam.dot(toEye)).toBeGreaterThan(0.99999);
      expect(pose.up.toArray()).toEqual([0, 1, 0]);
    }
  });

  it('podDistance shows `span` metres top to bottom in the target camera FOV; podFov narrows it further out', () => {
    const d = podDistance(30);
    expect(2 * d * Math.tan((TARGET_CAM_FOV * Math.PI) / 360)).toBeCloseTo(30, 6);
    expect(podFov(30, d)).toBeCloseTo(TARGET_CAM_FOV, 6);
    expect(podFov(30, 4 * d)).toBeLessThan(TARGET_CAM_FOV / 3);
    // the jet closer than the framing distance: never wider than the window's own FOV
    expect(podFov(30, d / 4)).toBe(TARGET_CAM_FOV);
  });

  it('a big target at ZOOM: the camera stays outside it (a hangar is not seen from inside)', () => {
    const h = new GroundTargetEntity(2, 'hangar', 'red', { radius: 12 });
    const pose = podCamPose(h, new Vector3(5000, 1000, 0), POD_ZOOM[ZOOM].span, makePose(), () => 0);
    expect(pose.position.distanceTo(h.position)).toBeGreaterThan(h.radius);
  });

  it('is never further out than the jet, and never under the ground', () => {
    const t = tiny();
    const near = new Vector3(60, 40, 0); // the jet closer than WIDE's framing distance
    const pose = podCamPose(t, near, POD_ZOOM[0].span, makePose(), () => 0);
    expect(pose.position.distanceTo(pose.look)).toBeLessThan(near.distanceTo(pose.look));
    // a grazing line of sight: lifted to the floor
    const low = podCamPose(t, new Vector3(5000, 0.5, 0), POD_ZOOM[ZOOM].span, makePose(), () => 1);
    expect(low.position.y).toBeGreaterThanOrEqual(1.8 - 1e-9);
  });

  it('straight down: a usable up vector', () => {
    const t = tiny();
    const pose = podCamPose(t, new Vector3(0, 3000, 0), 30, makePose());
    expect(Math.abs(pose.up.y)).toBeLessThan(0.01);
  });

  it('a small target ~4 km out at ZOOM: looked down at from up the line of sight, filling a good part of the window (r1 1.2-d)', () => {
    // g03's geometry: the stoat on a 34 m field, the jet 4.2 km west at 450 m
    const t = tiny();
    t.position.set(27867, 34, -6744);
    const eye = new Vector3(27867 - 4200, 450, -6744 + 600);
    const pose = podCamPose(t, eye, POD_ZOOM[ZOOM].span, makePose(), () => 34);
    const d = pose.position.distanceTo(pose.look);
    // the stand-off up the line, not a camera in the grass 3 m from the stoat
    expect(d).toBeCloseTo(POD_STANDOFF, 6);
    expect(pose.position.y - 34).toBeGreaterThan(15);
    // inside the stoat model's draw range (6 km × farScale 0.05 on low quality)
    expect(d).toBeLessThanOrEqual(300);
    const toEye = eye.clone().sub(pose.look).normalize();
    expect(pose.position.clone().sub(pose.look).normalize().dot(toEye)).toBeGreaterThan(0.99999);
    // looked at mid-body (~0.1 m tall), not 0.2 m over the ground
    expect(pose.look.y - 34).toBeLessThan(0.08);
    // the 0.38 m stoat spans over a third of the 82 px window
    const fov = podFov(POD_ZOOM[ZOOM].span, d);
    expect(spanPx(pose, pose.look, 0.38, 82, fov)).toBeGreaterThan(82 / 3);
  });

  it('ZOOM shows a 0.3 m object from 5 km at a readable size in the HMD window', () => {
    const L = computeLayout(makeLayout(), 844, 390, noSafe, tan30, false, { pip: true });
    expect(L.pipH).toBeGreaterThan(54);
    const t = tiny();
    // 5 km out, 1,200 m up (under g03's deck)
    const eye = new Vector3(4850, 1200, 0);
    const pose = podCamPose(t, eye, POD_ZOOM[ZOOM].span, makePose(), () => 0);
    const at = pose.look.clone();
    const fov = podFov(POD_ZOOM[ZOOM].span, pose.position.distanceTo(pose.look));
    const px = spanPx(pose, at, 0.3, L.pipH, fov);
    expect(px).toBeGreaterThanOrEqual(10);
    // …and still ≥ 8 px in the smallest window the layout ever opens (54 px)
    expect(spanPx(pose, at, 0.3, 54, fov)).toBeGreaterThanOrEqual(8);
    // WIDE: the same object is a speck (why ZOOM exists)
    const wide = podCamPose(t, eye, POD_ZOOM[0].span, makePose(), () => 0);
    expect(spanPx(wide, at, 0.3, L.pipH)).toBeLessThan(1);
  });
});

describe('ZOOM on an animal (playtest r2 F6)', () => {
  it('closes to half a metre on a target under a metre across; every other step and target as before', () => {
    expect(POD_ZOOM_SMALL).toBe(0.5);
    expect(podSpan(ZOOM, tiny().radius)).toBe(POD_ZOOM_SMALL);
    expect(podSpan(ZOOM, 9)).toBe(POD_ZOOM[ZOOM].span);
    for (let i = 0; i < POD_ZOOM.length; i++) if (i !== ZOOM) expect(podSpan(i, tiny().radius)).toBe(POD_ZOOM[i].span);
  });

  it("g03's stoat ~4 km out fills about half the 82 px window at ZOOM (it was a 10 x 20 px blob)", () => {
    const t = tiny();
    t.position.set(27867, 34, -6744);
    const eye = new Vector3(27867 - 4200, 450, -6744 + 600);
    const span = podSpan(ZOOM, t.radius);
    const pose = podCamPose(t, eye, span, makePose(), () => 34);
    const fov = podFov(span, pose.position.distanceTo(pose.look));
    // the 0.38 m animal against the window's height (its length lies across the wider window)
    const px = spanPx(pose, pose.look, 0.38, 82, fov);
    expect(px).toBeGreaterThan(82 * 0.6);
    expect(px).toBeLessThan(82);
  });
});

describe('size-aware framing of small ground targets', () => {
  it('a sub-metre target is framed far closer than the 16 m minimum, big ones as before', () => {
    expect(groundMinFraming(12)).toBe(16);
    expect(groundMinFraming(0.19)).toBeLessThan(3);
    const g = tiny();
    expect(framingDistance(g)).toBeLessThan(4);
    expect(framingDistance(new GroundTargetEntity(1, 'hangar', 'red', { radius: 12 }))).toBeCloseTo(26.4, 6);
    expect(framingDistance(new GroundTargetEntity(1, 'fuel', 'red', { radius: 4 }))).toBe(16);
  });

  it('the orbit looks at the small target, not 1.5 m over it', () => {
    expect(groundLookY(0.19)).toBeCloseTo(0.19, 6);
    expect(groundLookY(4)).toBe(1.5);
    expect(groundLookY(100)).toBe(12);
    const g = tiny();
    const pose = targetCamPose(g, 0, makePose(), () => 0);
    expect(pose.look.y).toBeLessThan(0.5);
    // the 0.38 m target spans a good part of the frame
    expect(spanPx(pose, pose.look, 0.38, 82)).toBeGreaterThan(5);
  });
});

describe('pod line of sight', () => {
  it('the overcast deck is the only cloud base, and masks only across it', () => {
    expect(cloudBase('overcast')).toBe(OVERCAST_DECK.altitude);
    expect(cloudBase('scattered')).toBeNull();
    expect(cloudBase('clear')).toBeNull();
    const base = cloudBase('overcast');
    expect(cloudBetween(2500, 5, base)).toBe(true);
    expect(cloudBetween(5, 2500, base)).toBe(true);
    expect(cloudBetween(1200, 5, base)).toBe(false);
    expect(cloudBetween(9000, 5, null)).toBe(false);
  });

  it('podMask: CLOUD above the deck, TERRAIN behind a ridge, clear otherwise', () => {
    const tgt = new Vector3(0, 1.5, 0);
    expect(podMask(new Vector3(4000, 1200, 0), tgt, flat(), 1800)).toBe('');
    expect(podMask(new Vector3(4000, 2500, 0), tgt, flat(), 1800)).toBe('CLOUD');
    expect(podMask(new Vector3(4000, 2500, 0), tgt, flat(), null)).toBe('');
    expect(podMask(new Vector3(4000, 1200, 0), tgt, flat(true), null)).toBe('TERRAIN');
  });

  it('stepPod: pod state for a SAM site, MASKED above the deck, none for an aircraft', () => {
    resetPip();
    resetPodZoom();
    const sam = new SamSiteEntity(3, 'sa15', 'red');
    stepPod(sam, new Vector3(4000, 1200, 0), flat(), 1800, 1 / 60);
    expect(pipView.pod).toBe(true);
    expect(pipView.mask).toBe('');
    expect(pipView.zoom).toBe(POD_ZOOM_DEFAULT);
    // the jet climbs through the deck: masked at the next check (not every frame)
    stepPod(sam, new Vector3(4000, 2500, 0), flat(), 1800, 1 / 60);
    expect(pipView.mask).toBe('');
    stepPod(sam, new Vector3(4000, 2500, 0), flat(), 1800, 0.3);
    expect(pipView.mask).toBe('CLOUD');
    stepPod(new AircraftEntity(4, 'su35', 'red'), new Vector3(), flat(), 1800, 1 / 60);
    expect(pipView.pod).toBe(false);
    expect(pipView.mask).toBe('');
  });

  it('a tap inside the open pod window steps the zoom; outside it or on the cinematic shot it does not', () => {
    resetPip();
    resetPodZoom();
    Object.assign(pipView, { vx: 600, vy: 10, vw: 146, vh: 82 });
    stepPod(new SamSiteEntity(3, 'sa6', 'red'), new Vector3(4000, 1200, 0), flat(), null, 1 / 60);
    expect(tapPip(10, 10)).toBe(false);
    expect(tapPip(650, 50)).toBe(true);
    expect(POD_ZOOM[pipView.zoom].name).toBe('ZOOM');
    expect(tapPip(650, 50)).toBe(true);
    expect(POD_ZOOM[pipView.zoom].name).toBe('WIDE');
    stepPod(new AircraftEntity(4, 'su35', 'red'), new Vector3(), flat(), null, 1 / 60);
    expect(tapPip(650, 50)).toBe(false);
    resetPip();
  });

  it('the TGT readout names the target as the PCD does', () => {
    expect(podReadout(new SamSiteEntity(3, 'sa6', 'red'), false)).toBe('TGT SA-6');
    expect(podReadout(new SamSiteEntity(3, 'sa6', 'red'), true)).toBe('LOCK SA-6');
  });

  it('a long readout shrinks, then drops whole words, never cuts one in half (#282 F11)', () => {
    const pen = { textWidth: (s: string, size: number) => s.length * size * 0.6 }; // monospace, as Pen
    const out = { text: '', size: 0 };
    const text = 'TGT SUICIDE BOAT'; // 16 chars: 96 px at 10, 76.8 px at 8
    fitReadout(text, 100, pen, out);
    expect(out).toEqual({ text, size: 10 });
    fitReadout(text, 80, pen, out);
    expect(out).toEqual({ text, size: 8 });
    fitReadout(text, 70, pen, out);
    expect(out).toEqual({ text: 'TGT SUICIDE', size: 8 });
    fitReadout(text, 10, pen, out);
    expect(out).toEqual({ text: 'TGT', size: 8 });
  });
});

describe('TargetCam pod pass', () => {
  function setup() {
    let renders = 0;
    const renderer = {
      getSize: (v: { set: (x: number, y: number) => unknown }) => v.set(844, 390),
      shadowMap: { autoUpdate: true },
      setScissorTest: () => {},
      setScissor: () => {},
      setViewport: () => {},
      autoClear: true,
      info: { autoReset: true, render: { calls: 0, triangles: 0 } },
      render: () => {
        renders++;
      },
    } as unknown as WebGLRenderer;
    const sam = new SamSiteEntity(9, 'sa6', 'red');
    sam.position.set(0, 10, 0);
    const player = new AircraftEntity(1, 'f35a', 'blue');
    player.position.set(5000, 1500, 0);
    const world = {
      time: 1,
      player,
      getEntity: (id: number) => (id === sam.id ? sam : null),
      terrain: { surfaceHeightAt: () => 0, isWater: () => false },
    } as unknown as SimWorld;
    const cam = new TargetCam(world, {} as EntityRendererApi);
    return { cam, renderer, sam, player, renders: () => renders };
  }
  const rect = (o: object) => ({ targetId: 9, vx: 600, vy: 10, vw: 146, vh: 82, h: 82, ...o });

  it('renders the pod shot on the line of sight at the zoom step', () => {
    const { cam, renderer, sam, player, renders } = setup();
    expect(cam.render(renderer, new Scene(), rect({ pod: true, zoom: 2 }), 30_000)).toBe(true);
    expect(renders()).toBe(1);
    expect(cam.lastPod).toBe('ZOOM');
    expect(cam.lastTargetId).toBe(9);
    const look = sam.position.clone().setY(sam.position.y + podLookY(sam));
    const d = cam.camera.position.distanceTo(look);
    expect(d).toBeCloseTo(Math.max(POD_STANDOFF, podDistance(POD_ZOOM[2].span), sam.radius * POD_CLEAR_K), 3);
    // the narrow lens: ZOOM's span top to bottom from out there
    expect(2 * d * Math.tan((cam.camera.fov * Math.PI) / 360)).toBeCloseTo(POD_ZOOM[2].span, 3);
    const toEye = player.position.clone().sub(look).normalize();
    expect(cam.camera.position.clone().sub(look).normalize().dot(toEye)).toBeGreaterThan(0.9999);
  });

  it('the pod pass ends POD_RANGE past the target, whatever the quality (the orbit keeps the main far plane)', () => {
    const { cam, renderer, sam } = setup();
    for (const zoom of [0, 1, 2]) {
      cam.render(renderer, new Scene(), rect({ pod: true, zoom }), 30_000);
      const d = cam.camera.position.distanceTo(sam.position);
      expect(cam.camera.far, `zoom ${zoom}`).toBeLessThanOrEqual(d + POD_RANGE + 1);
      // low quality's longer range is cut to the pod's too
      cam.render(renderer, new Scene(), rect({ pod: true, zoom }), 30_000, 8_000);
      expect(cam.camera.far, `zoom ${zoom} low`).toBeLessThanOrEqual(d + POD_RANGE + 1);
    }
    cam.render(renderer, new Scene(), rect({}), 30_000);
    expect(cam.camera.far).toBe(30_000);
  });

  it('masked: nothing is rendered (no cost) and the pass says MASKED', () => {
    const { cam, renderer, renders } = setup();
    expect(cam.render(renderer, new Scene(), rect({ pod: true, zoom: 1, mask: 'CLOUD' }), 30_000)).toBe(false);
    expect(renders()).toBe(0);
    expect(cam.lastPod).toBe('MASKED');
    expect(cam.lastTargetId).toBeNull();
  });

  it('without the pod flag the SAM site keeps the cinematic orbit', () => {
    const { cam, renderer, sam } = setup();
    expect(cam.render(renderer, new Scene(), rect({}), 30_000)).toBe(true);
    expect(cam.lastPod).toBeNull();
    expect(cam.camera.position.distanceTo(sam.position)).toBeLessThan(40);
  });
});
