/**
 * Tactical map in free flight (issue #113, playtest 2.2-2): at the 10 km scale the tour's stop names
 * are placed around their markers, so the crowded central sights (Sky Tower, Museum, Mt Eden, Mission
 * Bay, One Tree Hill) keep their names instead of 4–5 of the 11 fitting.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import type { FrameContext, Waypoint } from '../src/core/contracts';
import { AKL } from '../src/core/auckland';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import { createHud } from '../src/hud/Hud';
import { buildMock } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas, overlaps, textBox } from '../src/hud/dev/fakeCanvas';
import { strollTour } from '../src/missions/content/instant';
import { Occupancy } from '../src/hud/hmd/occupancy';
import { LABEL_SLOTS, freeLabelSlot } from '../src/hud/hmd/tacmap';

installPath2D();

function tourMap(at: { x: number; z: number }, current: number, W = 844, H = 390) {
  const mock = buildMock('nav');
  const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
  const hud = createHud(canvas, mock.events);
  hud.resize(W, H, 1);
  hud.setVisible(false);
  const p = mock.player;
  p.position.set(at.x, 600, at.z);
  // free flight: nothing hostile on the map, no contacts
  const w = mock.world as unknown as { aircraft: unknown[]; sams: unknown[]; ground: unknown[]; missiles: unknown[] };
  w.aircraft.splice(0, w.aircraft.length, p);
  w.sams.length = w.ground.length = w.missiles.length = 0;
  p.radar.contacts.length = 0;
  p.radar.designatedId = p.radar.lockedId = null;
  p.incoming.length = 0;
  const wps: Waypoint[] = strollTour().map((w) => ({ id: w.id, label: w.label, kind: w.kind, radius: w.radius ?? 1500, position: new Vector3(w.x, w.altitude ?? 600, w.z) }));
  const m = mock.mission as unknown as { def: Record<string, unknown>; waypoints: Waypoint[]; currentWaypoint: Waypoint | null; objectives: unknown[]; hint: string | null };
  m.def = { ...m.def, script: { freeFlight: true } };
  m.waypoints = wps;
  m.currentWaypoint = wps[current];
  m.objectives = [];
  m.hint = null;
  const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
  camera.position.copy(p.position).add(new Vector3(0, 4.5, 20));
  camera.updateMatrixWorld();
  const ctx: FrameContext = {
    dt: 1 / 30,
    time: 0,
    world: mock.world,
    player: p,
    camera,
    viewMode: 'tactical',
    focusId: p.id,
    mission: mock.mission,
    settings: { ...DEFAULT_SETTINGS },
    quality: { ...QUALITY_PRESETS.medium },
    paused: false,
    screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  };
  // past the legend's 5 s on entry
  for (let i = 0; i < 200; i++) {
    fake.reset();
    ctx.time += 1 / 30;
    hud.update(ctx);
  }
  const stops = new Set(wps.map((w) => w.label.toUpperCase()));
  const texts = fake.texts.filter((t) => stops.has(t.text.toUpperCase()));
  return { texts, names: [...new Set(texts.map((t) => t.text.toUpperCase()))] };
}

describe('tactical map: the tour stop names at 10 km (2.2-2)', () => {
  // (before #113: 6, 3 and 2 of the 11 names here; the Museum and Eden Park never showed)
  for (const [where, at, cur, must] of [
    ['over the Domain, steering to the Sky Tower', AKL.domain, 1, ['SKY TOWER', 'MUSEUM', 'MT EDEN', 'EDEN PARK', 'ONE TREE HILL', 'MISSION BAY']],
    ['over Mt Eden, steering to One Tree Hill', AKL.mt_eden, 8, ['ONE TREE HILL', 'AIRPORT', 'WHENUAPAI', 'SKY TOWER', 'MT EDEN', 'EDEN PARK']],
    ['over the CBD, steering to the Harbour Bridge', AKL.cbd, 0, ['HARBOUR BRIDGE', 'SKY TOWER', 'NORTH HEAD', 'MUSEUM', 'MT EDEN', 'MISSION BAY']],
  ] as const) {
    it(`names at least 9 of the 11 stops ${where}`, () => {
      const { texts, names } = tourMap(at, cur);
      expect(names.length).toBeGreaterThanOrEqual(9);
      for (const s of must) expect(names, s).toContain(s);
      // no two stop names overlap
      for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) expect(overlaps(textBox(texts[i]), textBox(texts[j])), `${texts[i].text} / ${texts[j].text}`).toBe(false);
    });
  }

  it('a name takes the first free slot round its marker, and none when all are taken', () => {
    const occ = new Occupancy(16);
    expect(freeLabelSlot(occ, 40, 100, 100, 1)?.y).toBe(100 + LABEL_SLOTS[0].dy);
    occ.add(60, 80, 140, 92); // above taken
    const below = freeLabelSlot(occ, 40, 100, 100, 1)!;
    expect([below.x, below.y, below.align]).toEqual([100, 113, 'center']);
    occ.add(0, 0, 200, 200);
    expect(freeLabelSlot(occ, 40, 100, 100, 1)).toBeNull();
  });
});
