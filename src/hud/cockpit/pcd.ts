/**
 * PCD manager: one wide CanvasTexture (20x8 in panoramic cockpit display) split into portals.
 *
 *   [ SMS / FUEL / ENG / ICAWS ] [        TSD / RDR        ] [ RWR / ICAWS / FUEL / ENG ]
 *
 * Tapping a portal cycles its page. The canvas is redrawn at a throttled rate (8–10 Hz, 5 Hz on low
 * quality) and uploaded only then. The UFD (small up-front strip under the glare shield) shares the
 * redraw cadence.
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import type { FrameContext } from '../../core/contracts';
import type { QualitySettings } from '../../core/types';
import { RAD, toNm } from '../../core/math';
import { Pen } from '../hmd/pen';
import { WEAPON_HUD, WEAPON_IS_AG, mmss } from '../hmd/format';
import { PAGE_FNS, PC, type PageId, type PcdData } from './pages';

interface Portal {
  x: number;
  w: number;
  pages: PageId[];
  index: number;
}

export const PCD_W = 1024;
export const PCD_H = 410;
const TITLE_H = 38;

export class PcdDisplay {
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly ufdCanvas: HTMLCanvasElement;
  readonly ufdTexture: CanvasTexture;
  private readonly pen: Pen;
  private readonly ufdPen: Pen;
  private readonly portals: Portal[] = [
    { x: 0, w: 256, pages: ['SMS', 'FUEL', 'ENG', 'ICAWS'], index: 0 },
    { x: 256, w: 512, pages: ['TSD', 'RDR'], index: 0 },
    { x: 768, w: 256, pages: ['RWR', 'ICAWS', 'FUEL', 'ENG'], index: 0 },
  ];
  private acc = 1;
  private dirty = true;
  private readonly period: number;
  private readonly data: PcdData = { ctx: null as unknown as FrameContext, p: null as unknown as PcdData['p'], flash: false };
  private lastWarnCount = 0;

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

    this.ufdCanvas = document.createElement('canvas');
    this.ufdCanvas.width = 512;
    this.ufdCanvas.height = 72;
    this.ufdPen = new Pen(this.ufdCanvas.getContext('2d')!);
    this.ufdPen.outlineExtra = 0;
    this.ufdTexture = new CanvasTexture(this.ufdCanvas);
    this.ufdTexture.colorSpace = SRGBColorSpace;
    this.ufdTexture.generateMipmaps = false;
    this.ufdTexture.minFilter = LinearFilter;
    this.clear();
  }

  /** Force a redraw on the next update (e.g. the cockpit became visible again). */
  markDirty(): void {
    this.dirty = true;
  }

  /** Font finished loading: glyph metrics changed. */
  fontsChanged(): void {
    this.pen.fontsChanged();
    this.ufdPen.fontsChanged();
    this.dirty = true;
  }

  /** Tap at PCD texture uv (0..1, v up). Cycles the portal's page. */
  tapUv(u: number, v: number): boolean {
    const x = u * PCD_W;
    for (const p of this.portals) {
      if (x >= p.x && x < p.x + p.w) {
        p.index = (p.index + 1) % p.pages.length;
        this.dirty = true;
        return true;
      }
    }
    return v >= 0 && v <= 1;
  }

  /** Current page ids (for tests / debugging). */
  pages(): PageId[] {
    return this.portals.map((p) => p.pages[p.index]);
  }

  update(ctx: FrameContext, dt: number): void {
    const p = ctx.player;
    if (!p || !ctx.world) return;
    this.acc += dt;
    // new warnings: jump the right portal to ICAWS once so the pilot sees it
    const wc = p.warnings.size;
    if (wc > this.lastWarnCount && (p.warnings.has('engine_fire') || p.warnings.has('hydraulics') || p.warnings.has('engine_fail'))) {
      const right = this.portals[2];
      right.index = right.pages.indexOf('ICAWS');
      this.dirty = true;
    }
    this.lastWarnCount = wc;
    if (!this.dirty && this.acc < this.period) return;
    this.acc = 0;
    this.dirty = false;
    this.data.ctx = ctx;
    this.data.p = p;
    this.data.flash = Math.floor(performance.now() / 400) % 2 === 0;
    this.drawAll();
    this.drawUfd(ctx);
    this.texture.needsUpdate = true;
    this.ufdTexture.needsUpdate = true;
  }

  private clear(): void {
    const g = this.pen.g;
    g.fillStyle = PC.bg;
    g.fillRect(0, 0, PCD_W, PCD_H);
    this.pen.reset();
    const u = this.ufdPen.g;
    u.fillStyle = '#020405';
    u.fillRect(0, 0, 512, 72);
    this.ufdPen.reset();
  }

  private drawAll(): void {
    const pen = this.pen;
    const g = pen.g;
    pen.setFill(PC.bg);
    g.fillRect(0, 0, PCD_W, PCD_H);
    for (const portal of this.portals) {
      const x = portal.x + 4;
      const w = portal.w - 8;
      const page = portal.pages[portal.index];
      // portal frame + title bar
      pen.setFill(PC.portal);
      g.fillRect(x, 4, w, PCD_H - 8);
      pen.setFill(PC.titleBg);
      g.fillRect(x, 4, w, TITLE_H);
      pen.begin();
      pen.rect(x, 4, w, PCD_H - 8);
      pen.strokePlain(PC.frame, 3);
      pen.text(page, x + 12, 4 + TITLE_H / 2 + 1, PC.title, 26, 'left');
      // page dots (tap to cycle)
      const n = portal.pages.length;
      for (let i = 0; i < n; i++) {
        pen.begin();
        pen.circle(x + w - 14 - (n - 1 - i) * 16, 4 + TITLE_H / 2, 5);
        if (i === portal.index) pen.fillPlain(PC.cyan);
        else pen.strokePlain(PC.dim, 2);
      }
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

  private drawUfd(ctx: FrameContext): void {
    const pen = this.ufdPen;
    const g = pen.g;
    const p = ctx.player!;
    pen.setFill('#020405');
    g.fillRect(0, 0, 512, 72);
    const w = p.selectedWeapon;
    const mode = WEAPON_IS_AG[w] ? 'A-G' : 'A-A';
    pen.text(mode, 12, 37, PC.green, 32, 'left');
    const wp = ctx.mission?.currentWaypoint;
    if (wp) {
      const dx = wp.position.x - p.position.x;
      const dz = wp.position.z - p.position.z;
      let b = Math.atan2(dx, -dz) * RAD;
      if (b < 0) b += 360;
      const name = (wp.label || wp.id || 'WP').toUpperCase().slice(0, 8).trim();
      const s = name + ' ' + String(Math.round(b) % 360).padStart(3, '0') + '/' + toNm(Math.hypot(dx, dz)).toFixed(0);
      pen.text(s, 96, 37, PC.cyan, 28, 'left');
    } else {
      pen.text(WEAPON_HUD[w], 96, 37, PC.value, 28, 'left');
    }
    // separator + mission clock
    pen.setFill(PC.frame);
    g.fillRect(398, 14, 3, 44);
    pen.text(mmss(ctx.time), 500, 37, PC.value, 30, 'right');
  }

  dispose(): void {
    this.texture.dispose();
    this.ufdTexture.dispose();
  }
}
