/**
 * PCD manager: one wide CanvasTexture (panoramic cockpit display) split into portals.
 *
 *   | [ SMS / FUEL / ENG / ICAWS ] [        TSD / RDR        ] [ RWR / ICAWS / FUEL / ENG ] |
 *
 * (left-handed layout: the RWR portal moves to the left, away from the right-hand throttle cluster.)
 * A dark bezel (PCD_BEZEL) at each outer edge keeps the outer portals inside the free band between
 * the touch clusters: at 844x390 the left-handed FIRE button covered the right edge of the stores
 * page (playtest 2026-10-02, 4.2-f; tests/ui-first-flight.test.ts).
 * Tapping a portal opens it in the large 2D zoom overlay (zoom.ts, drawn by the HUD) where tabs switch
 * its page. The canvas is redrawn at a throttled rate (8–10 Hz, 5 Hz on low quality) and uploaded only
 * then. (The UFD strip was removed in iteration 2: at ~6 CSS px on a phone it was unreadable and only
 * duplicated the HMD.)
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import type { FrameContext } from '../../core/contracts';
import type { QualitySettings } from '../../core/types';
import { Pen } from '../hmd/pen';
import { PAGE_FNS, PC, type PageId, type PcdData } from './pages';
import { PCD } from './geometry';
import { pcdZoom } from './zoom';

interface Portal {
  x: number;
  w: number;
  pages: PageId[];
  index: number;
}

export const PCD_W = 1024;
/** Texture height follows the screen's aspect (no stretched texels). */
export const PCD_H = Math.round((PCD_W * PCD.height) / PCD.width / 2) * 2;
export const TITLE_H = 36;
/** Blank texels at each outer edge of the display (see the header). */
export const PCD_BEZEL = 32;
/** Outer portal width (texels): the SMS / FUEL rows need it all; the centre portal gives up the bezels. */
const SIDE_W = 256;
const CENTRE_W = PCD_W - 2 * PCD_BEZEL - 2 * SIDE_W;
/** Portal spans along the texture (texels), left to right: outer, centre (TSD / RDR), outer. */
export const PCD_PORTALS: readonly { readonly x: number; readonly w: number }[] = [
  { x: PCD_BEZEL, w: SIDE_W },
  { x: PCD_BEZEL + SIDE_W, w: CENTRE_W },
  { x: PCD_BEZEL + SIDE_W + CENTRE_W, w: SIDE_W },
];
/** Inset (texels) of a portal's frame inside its span. */
export const PORTAL_INSET = 4;

const SMS_PAGES: PageId[] = ['SMS', 'FUEL', 'ENG', 'ICAWS'];
const RWR_PAGES: PageId[] = ['RWR', 'ICAWS', 'FUEL', 'ENG'];

export class PcdDisplay {
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  private readonly pen: Pen;
  private readonly portals: Portal[] = [
    { ...PCD_PORTALS[0], pages: SMS_PAGES, index: 0 },
    { ...PCD_PORTALS[1], pages: ['TSD', 'RDR'], index: 0 },
    { ...PCD_PORTALS[2], pages: RWR_PAGES, index: 0 },
  ];
  private leftHanded = false;
  private acc = 1;
  private dirty = true;
  private readonly period: number;
  private readonly data: PcdData = { ctx: null as unknown as FrameContext, p: null as unknown as PcdData['p'], flash: false, zoom: false };
  private lastWarnCount = 0;
  private lastBingo = false;

  constructor(quality: QualitySettings) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = PCD_W;
    this.canvas.height = PCD_H;
    const g = this.canvas.getContext('2d')!;
    this.pen = new Pen(g);
    this.pen.outlineExtra = 0;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    const mips = quality.level !== 'low';
    this.texture.generateMipmaps = mips;
    this.texture.minFilter = mips ? LinearMipmapLinearFilter : LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.anisotropy = quality.level === 'high' ? 4 : 1;
    this.period = quality.level === 'low' ? 0.2 : quality.level === 'medium' ? 0.125 : 0.1;

    this.clear();
  }

  /** Force a redraw on the next update (e.g. the cockpit became visible again). */
  markDirty(): void {
    this.dirty = true;
  }

  /** Font finished loading: glyph metrics changed. */
  fontsChanged(): void {
    this.pen.fontsChanged();
    this.dirty = true;
  }

  /** Portal index under texture u (0..1), or -1. */
  portalAt(u: number): number {
    const x = u * PCD_W;
    for (let i = 0; i < this.portals.length; i++) {
      const p = this.portals[i];
      if (x >= p.x && x < p.x + p.w) return i;
    }
    return -1;
  }

  /** Tap at PCD texture uv (0..1, v up): opens that portal in the zoom overlay. */
  tapUv(u: number, v: number): boolean {
    if (v < 0 || v > 1) return false;
    const i = this.portalAt(u);
    if (i < 0) return false;
    this.openZoom(i);
    return true;
  }

  /** Show portal `i` in the big 2D overlay (the HUD draws it). */
  openZoom(i: number): void {
    const p = this.portals[i];
    if (!p) return;
    pcdZoom.openPortal(i, p.pages, p.index);
  }

  /** Select a page of a portal (zoom tabs). */
  setPage(portal: number, index: number): void {
    const p = this.portals[portal];
    if (!p) return;
    p.index = Math.max(0, Math.min(p.pages.length - 1, index));
    this.dirty = true;
    if (pcdZoom.portal === portal) {
      pcdZoom.pages = p.pages;
      pcdZoom.index = p.index;
    }
  }

  /** Cycle a portal's page (legacy tap behaviour; keyboard / tests). */
  cyclePage(portal: number): void {
    const p = this.portals[portal];
    if (p) this.setPage(portal, (p.index + 1) % p.pages.length);
  }

  /** Left-handed layout: RWR on the left portal (the throttle cluster covers the right one). */
  setLeftHanded(lh: boolean): void {
    if (lh === this.leftHanded) return;
    this.leftHanded = lh;
    const a = this.portals[0];
    const b = this.portals[2];
    const pa = a.pages;
    const ia = a.index;
    a.pages = b.pages;
    a.index = b.index;
    b.pages = pa;
    b.index = ia;
    if (pcdZoom.portal === 0 || pcdZoom.portal === 2) pcdZoom.close();
    this.dirty = true;
  }

  /** Current page ids (for tests / debugging). */
  pages(): PageId[] {
    return this.portals.map((p) => p.pages[p.index]);
  }

  update(ctx: FrameContext, dt: number): void {
    const p = ctx.player;
    if (!p || !ctx.world) return;
    this.setLeftHanded(!!ctx.settings?.leftHanded);
    this.acc += dt;
    // new warnings: jump the RWR portal to ICAWS once so the pilot sees it
    const wc = p.warnings.size;
    if (wc > this.lastWarnCount && (p.warnings.has('engine_fire') || p.warnings.has('hydraulics') || p.warnings.has('engine_fail'))) {
      const i = this.portals[0].pages === RWR_PAGES ? 0 : 2;
      this.setPage(i, this.portals[i].pages.indexOf('ICAWS'));
    }
    this.lastWarnCount = wc;
    // bingo: the RWR portal jumps to FUEL once (playtest 1.2-h: the fuel state was a tap away)
    const bingo = p.warnings.has('bingo');
    if (bingo && !this.lastBingo) {
      const i = this.portals[0].pages === RWR_PAGES ? 0 : 2;
      this.setPage(i, this.portals[i].pages.indexOf('FUEL'));
    }
    this.lastBingo = bingo;
    if (!this.dirty && this.acc < this.period) return;
    this.acc = 0;
    this.dirty = false;
    this.data.ctx = ctx;
    this.data.p = p;
    this.data.flash = Math.floor(performance.now() / 400) % 2 === 0;
    this.drawAll();
    this.texture.needsUpdate = true;
  }

  private clear(): void {
    const g = this.pen.g;
    g.fillStyle = PC.bg;
    g.fillRect(0, 0, PCD_W, PCD_H);
    this.pen.reset();
  }

  private drawAll(): void {
    const pen = this.pen;
    const g = pen.g;
    pen.setFill(PC.bg);
    g.fillRect(0, 0, PCD_W, PCD_H);
    for (const portal of this.portals) {
      const x = portal.x + PORTAL_INSET;
      const w = portal.w - 2 * PORTAL_INSET;
      const page = portal.pages[portal.index];
      // portal frame + title bar
      pen.setFill(PC.portal);
      g.fillRect(x, 4, w, PCD_H - 8);
      pen.setFill(PC.titleBg);
      g.fillRect(x, 4, w, TITLE_H);
      pen.begin();
      pen.rect(x, 4, w, PCD_H - 8);
      pen.strokePlain(PC.frame, 3);
      pen.text(page, x + 12, 4 + TITLE_H / 2 + 1, PC.title, 28, 'left');
      // page dots + zoom hint (tap to open)
      const n = portal.pages.length;
      for (let i = 0; i < n; i++) {
        pen.begin();
        pen.circle(x + w - 14 - (n - 1 - i) * 17, 4 + TITLE_H / 2, 5.5);
        if (i === portal.index) pen.fillPlain(PC.cyan);
        else pen.strokePlain(PC.dim, 2);
      }
      // magnifier glyph: tap to zoom
      const mx = x + w - 30 - (n - 1) * 17 - 16;
      const my = 4 + TITLE_H / 2;
      pen.begin();
      pen.circle(mx, my - 2, 7);
      pen.line(mx + 5, my + 3, mx + 10, my + 9);
      pen.strokePlain(PC.label, 2.5);
      // page content (clipped to the portal body)
      const cy = 4 + TITLE_H;
      const ch = PCD_H - 8 - TITLE_H;
      g.save();
      g.beginPath();
      g.rect(x, cy, w, ch);
      g.clip();
      pen.reset();
      try {
        PAGE_FNS[page](pen, x, cy, w, ch, this.data);
      } catch (err) {
        console.warn('[pcd] page failed', page, err);
      }
      g.restore();
      pen.reset();
    }
  }

  dispose(): void {
    this.texture.dispose();
  }
}
