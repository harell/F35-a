/**
 * Cockpit PCD zoom, end to end in node: the real createCockpit() (three.js raycast against the PCD
 * mesh) + the real HUD overlay on recording canvases. Reproduces the i1 critique "cockpit-view PCD is
 * mostly off-screen / too small to read": tapping the visible part of the PCD must open a large,
 * readable page with tabs; tabs switch pages; any other tap closes it. Left-handed mode moves the RWR
 * away from the right-hand throttle cluster.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion } from 'three';
import { restHead } from '../src/render/camera/cameraMath';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import { createCockpit } from '../src/hud/Cockpit';
import { createHud } from '../src/hud/Hud';
import { buildMock } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { pcdScreenRect } from '../src/hud/cockpit/geometry';
import { pcdZoom } from '../src/hud/cockpit/zoom';

installPath2D();
const g = globalThis as unknown as { document?: unknown };
const prevDoc = g.document;
/** Every canvas created through the document stub (PCD texture, UFD, the HUD's zoom offscreen). */
const created: ReturnType<typeof makeFakeCanvas>['ctx'][] = [];
beforeAll(() => {
  // PcdDisplay / the zoom overlay draw into canvases: give them recording ones
  g.document = {
    createElement: () => {
      const c = makeFakeCanvas(1024, 512);
      created.push(c.ctx);
      return c.canvas;
    },
  };
});
afterAll(() => {
  g.document = prevDoc;
});

function setup(leftHanded = false) {
  const W = 844;
  const H = 390;
  const mock = buildMock('aa');
  const cockpit = createCockpit(mock.events, { ...QUALITY_PRESETS.medium });
  cockpit.resize(W, H);
  cockpit.visible = true;
  const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
  const hud = createHud(canvas, mock.events);
  hud.resize(W, H, 1);
  const p = mock.player;
  const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
  camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
  camera.quaternion.copy(p.quaternion).multiply(restHead('cockpit', new Quaternion()));
  camera.updateMatrixWorld();
  const ctx: FrameContext = {
    dt: 1 / 30,
    time: 1,
    world: mock.world,
    player: p,
    camera,
    viewMode: 'cockpit',
    focusId: p.id,
    mission: mock.mission,
    settings: { ...DEFAULT_SETTINGS, leftHanded },
    quality: { ...QUALITY_PRESETS.medium },
    paused: false,
    screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  };
  const frame = () => {
    fake.reset();
    for (const c of created) c.reset();
    cockpit.update(ctx, new Quaternion());
    hud.update(ctx);
    // HUD canvas + the zoom overlay's offscreen canvas (the last one created)
    return [...fake.texts, ...(created.length ? created[created.length - 1].texts : [])];
  };
  const rect = pcdScreenRect(60, W, H);
  const tap = (x: number, y: number) => cockpit.handleTap(x / W, y / H);
  return { cockpit, hud, frame, rect, tap, W, H };
}

describe('cockpit PCD tap → zoom overlay', () => {
  it('opens the tapped portal large and readable, tabs switch the page, a tap elsewhere closes', () => {
    pcdZoom.close();
    const s = setup();
    s.frame();
    // tap on the visible upper part of the LEFT portal
    const y = s.rect.top + 30;
    expect(s.tap(s.rect.left + (s.rect.right - s.rect.left) * 0.12, y)).toBe(true);
    expect(pcdZoom.open).toBe(true);
    expect(pcdZoom.page).toBe('SMS');
    let texts = s.frame();
    // SMS page, drawn big: weapon name ≥ 20 CSS px (it was ~12 px on the 3D panel)
    const name = texts.find((t) => t.text === 'AIM-120D');
    expect(name).toBeTruthy();
    expect(name!.size).toBeGreaterThanOrEqual(20);
    expect(pcdZoom.tabCount).toBe(4);
    // tap the FUEL tab
    const t = pcdZoom.tabs[1];
    expect(s.tap(t.x + t.w / 2, t.y + t.h / 2)).toBe(true);
    expect(pcdZoom.page).toBe('FUEL');
    texts = s.frame();
    expect(texts.some((x) => x.text === 'TOTAL LB')).toBe(true);
    // the HUD swallows taps while it is open (no accidental designation)
    expect(s.hud.pick(s.W / 2, s.H / 2)).toBeNull();
    // any other tap closes it
    expect(s.tap(s.W / 2, 30)).toBe(true);
    expect(pcdZoom.open).toBe(false);
    // the centre portal opens the TSD
    expect(s.tap(s.W / 2, y)).toBe(true);
    expect(pcdZoom.page).toBe('TSD');
    // leaving the cockpit view closes it
    s.cockpit.visible = false;
    s.frame();
    expect(pcdZoom.open).toBe(false);
  });

  it('left-handed: the RWR page moves to the left portal (the throttle cluster covers the right one)', () => {
    pcdZoom.close();
    const s = setup(true);
    s.frame();
    expect(s.tap(s.rect.left + (s.rect.right - s.rect.left) * 0.12, s.rect.top + 30)).toBe(true);
    expect(pcdZoom.page).toBe('RWR');
    pcdZoom.close();
  });
});
