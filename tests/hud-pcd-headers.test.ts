/**
 * PCD header rows (playtest 1.2-e / 1.2-f):
 *  - RWR: "n EMIT" and the flashing LAUNCH shared one row and ran together ("2 EMITLAUNCH"), LAUNCH
 *    clipped at the portal edge;
 *  - TSD: with a long target name, "BULL nnn/n" and "TGT FUEL DEPOT" collided on one row.
 * No two header readouts overlap and each stays inside its portal.
 */
import { describe, expect, it } from 'vitest';
import { installPath2D, makeFakeCanvas, overlaps, textBox, type TextRec } from '../src/hud/dev/fakeCanvas';
import { buildMock } from '../src/hud/dev/mockWorld';
import { Pen } from '../src/hud/hmd/pen';
import { PCD_CORNER, drawRwrPage, drawTsdPage, type PcdData } from '../src/hud/cockpit/pages';
import { PCD_H, PCD_PORTALS, PCD_W, PORTAL_INSET, TITLE_H } from '../src/hud/cockpit/pcd';
import type { FrameContext } from '../src/core/contracts';

installPath2D();

function page(fn: typeof drawRwrPage, portal: number, scene: 'threat' | 'ag', setup?: (m: ReturnType<typeof buildMock>) => void): { texts: TextRec[]; x: number; w: number } {
  const mock = buildMock(scene);
  setup?.(mock);
  const { canvas, ctx: fake } = makeFakeCanvas(PCD_W, PCD_H, 1);
  const pen = new Pen(canvas.getContext('2d') as CanvasRenderingContext2D);
  const x = PCD_PORTALS[portal].x + PORTAL_INSET;
  const w = PCD_PORTALS[portal].w - 2 * PORTAL_INSET;
  const ctx = { world: mock.world, player: mock.player, mission: mock.mission } as unknown as FrameContext;
  const d: PcdData = { ctx, p: mock.player, flash: true };
  fn(pen, x, 4 + TITLE_H, w, PCD_H - 8 - TITLE_H, d);
  return { texts: fake.texts.slice(), x, w };
}

/** Header readouts: inside the portal, and two on one row keep two ems apart (else they read as one line). */
function headerClash(texts: TextRec[], x: number, w: number, re: RegExp): string[] {
  const hdr = texts.filter((t) => re.test(t.text));
  const bad: string[] = [];
  for (let i = 0; i < hdr.length; i++) {
    const a = textBox(hdr[i]);
    if (a.x0 < x - 0.5 || a.x1 > x + w + 0.5) bad.push(`"${hdr[i].text}" outside the portal (${a.x0 | 0}..${a.x1 | 0} vs ${x}..${x + w})`);
    for (let j = i + 1; j < hdr.length; j++) {
      const b = textBox(hdr[j]);
      const sameRow = a.y0 < b.y1 + 2 && b.y0 < a.y1 + 2;
      const gap = Math.max(b.x0 - a.x1, a.x0 - b.x1);
      if (sameRow && gap < 2 * PCD_CORNER) bad.push(`"${hdr[i].text}" x "${hdr[j].text}" (gap ${gap | 0})`);
    }
  }
  return bad;
}

describe('PCD header rows', () => {
  it('RWR (1.2-e): "n EMIT" and LAUNCH never run together, LAUNCH stays inside the portal', () => {
    for (const portal of [0, 2]) {
      const { texts, x, w } = page(drawRwrPage, portal, 'threat');
      expect(texts.some((t) => t.text === 'LAUNCH')).toBe(true);
      const bad = headerClash(texts, x, w, /EMIT$|^LAUNCH$|^EMCON$/);
      expect(bad, bad.join('\n')).toEqual([]);
    }
  });

  it('TSD (1.2-f): "BULL nnn/n" and a long "TGT FUEL DEPOT" never collide', () => {
    {
      const portal = 1; // (the TSD lives in the centre portal)
      const { texts, x, w } = page(drawTsdPage, portal, 'ag', (m) => {
        const depot = m.world.ground.find((g) => g.type === 'fuel')!;
        m.player.radar.lockedId = null;
        m.player.radar.designatedId = depot.id;
        // far from bullseye: a long "BULL 214/22"
        m.player.position.set(-30_000, 3_000, 30_000);
      });
      expect(texts.some((t) => /^TGT FUEL DEPOT/.test(t.text))).toBe(true);
      const bad = headerClash(texts, x, w, /^(BULL|TGT|LOCK|HDG) |\d NM$/);
      expect(bad, bad.join('\n')).toEqual([]);
    }
  });
});
