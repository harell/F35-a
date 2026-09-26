/**
 * Pen — thin Canvas2D helper for crisp, legible HMD symbology.
 *
 *  - Works in CSS pixels (the caller sets the DPR transform once per frame).
 *  - Every stroke/glyph is drawn twice: a wider dark outline, then the colour on top. That keeps the
 *    green symbology legible over bright sky, snow and sun glare on a phone.
 *  - Caches canvas state (font, colours, widths, alignment) to avoid redundant style parsing, and caches
 *    monospace character widths so boxes can be sized without measureText().
 */
import { HUD_FONT_FAMILY } from '../font';

export type Align = 'left' | 'center' | 'right';
export type Baseline = 'top' | 'middle' | 'bottom' | 'alphabetic';

const DASH: number[] = [7, 5];
const DOT: number[] = [2, 4];
const SOLID: number[] = [];

export class Pen {
  /** Outline colour (set from the palette each frame). */
  outline = 'rgba(0,0,0,0.6)';
  /** Extra outline width (CSS px) added to each stroke. */
  outlineExtra = 2.2;
  /** Global scale for font sizes (tablets get bigger symbology). */
  fontScale = 1;

  private font = '';
  private fill = '';
  private strokeC = '';
  private lw = -1;
  private align: CanvasTextAlign = 'start';
  private base: CanvasTextBaseline = 'alphabetic';
  private dash: number[] = SOLID;
  private readonly fontCache = new Map<number, string>();
  private readonly charW = new Map<number, number>();

  constructor(readonly g: CanvasRenderingContext2D) {
    g.lineJoin = 'round';
    g.lineCap = 'round';
  }

  /** Forget cached state (after the canvas was resized — resizing resets the context state). */
  reset(): void {
    this.font = '';
    this.fill = '';
    this.strokeC = '';
    this.lw = -1;
    this.align = 'start';
    this.base = 'alphabetic';
    this.dash = SOLID;
    this.g.lineJoin = 'round';
    this.g.lineCap = 'round';
  }

  /** Call after the web font finished loading (glyph metrics changed). */
  fontsChanged(): void {
    this.charW.clear();
    this.font = '';
  }

  /* ───────────── state ───────────── */

  setFont(size: number): void {
    const px = Math.round(size * this.fontScale * 2) / 2;
    let f = this.fontCache.get(px);
    if (!f) this.fontCache.set(px, (f = `bold ${px}px ${HUD_FONT_FAMILY}`));
    if (f !== this.font) {
      this.g.font = f;
      this.font = f;
    }
  }

  setFill(c: string): void {
    if (c !== this.fill) {
      this.g.fillStyle = c;
      this.fill = c;
    }
  }

  setStroke(c: string): void {
    if (c !== this.strokeC) {
      this.g.strokeStyle = c;
      this.strokeC = c;
    }
  }

  setWidth(w: number): void {
    if (w !== this.lw) {
      this.g.lineWidth = w;
      this.lw = w;
    }
  }

  setAlign(a: Align, b: Baseline = 'middle'): void {
    const ca: CanvasTextAlign = a;
    if (ca !== this.align) {
      this.g.textAlign = ca;
      this.align = ca;
    }
    if (b !== this.base) {
      this.g.textBaseline = b;
      this.base = b;
    }
  }

  /** 'solid' | 'dash' | 'dot' line style. */
  setDash(kind: 'solid' | 'dash' | 'dot'): void {
    const d = kind === 'dash' ? DASH : kind === 'dot' ? DOT : SOLID;
    if (d !== this.dash) {
      this.g.setLineDash(d);
      this.dash = d;
    }
  }

  /** Width (CSS px) of one monospace character at `size`. */
  charWidth(size: number): number {
    const px = Math.round(size * this.fontScale * 2) / 2;
    let w = this.charW.get(px);
    if (w === undefined) {
      this.setFont(size);
      w = this.g.measureText('0000000000').width / 10;
      this.charW.set(px, w);
    }
    return w;
  }

  /** Approximate text width (monospace) — no measureText per frame. */
  textWidth(s: string, size: number): number {
    return s.length * this.charWidth(size);
  }

  /* ───────────── strokes ───────────── */

  /** Stroke the current path with the outline then the colour. */
  strokeGlow(color: string, width = 1.6): void {
    const g = this.g;
    if (this.outlineExtra > 0) {
      this.setStroke(this.outline);
      this.setWidth(width + this.outlineExtra);
      g.stroke();
    }
    this.setStroke(color);
    this.setWidth(width);
    g.stroke();
  }

  /** Stroke without outline (for large translucent shapes). */
  strokePlain(color: string, width = 1.5): void {
    this.setStroke(color);
    this.setWidth(width);
    this.g.stroke();
  }

  fillPlain(color: string): void {
    this.setFill(color);
    this.g.fill();
  }

  begin(): void {
    this.g.beginPath();
  }

  line(x0: number, y0: number, x1: number, y1: number): void {
    this.g.moveTo(x0, y0);
    this.g.lineTo(x1, y1);
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.g.rect(x, y, w, h);
  }

  circle(x: number, y: number, r: number): void {
    this.g.moveTo(x + r, y);
    this.g.arc(x, y, r, 0, Math.PI * 2);
  }

  arc(x: number, y: number, r: number, a0: number, a1: number): void {
    this.g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
    this.g.arc(x, y, r, a0, a1);
  }

  /** Diamond of half-size r. */
  diamond(x: number, y: number, r: number): void {
    const g = this.g;
    g.moveTo(x, y - r);
    g.lineTo(x + r, y);
    g.lineTo(x, y + r);
    g.lineTo(x - r, y);
    g.closePath();
  }

  /** Triangle pointing along (dx, dy) with tip at (x, y). */
  arrow(x: number, y: number, dx: number, dy: number, len: number, half: number): void {
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const bx = x - ux * len;
    const by = y - uy * len;
    const g = this.g;
    g.moveTo(x, y);
    g.lineTo(bx - uy * half, by + ux * half);
    g.lineTo(bx + uy * half, by - ux * half);
    g.closePath();
  }

  /** Box outline (with dark translucent fill behind for legibility). */
  box(x: number, y: number, w: number, h: number, color: string, width = 1.5, back: string | null = null): void {
    if (back) {
      this.setFill(back);
      this.g.fillRect(x, y, w, h);
    }
    this.begin();
    this.g.rect(x, y, w, h);
    this.strokeGlow(color, width);
  }

  /* ───────────── text ───────────── */

  /** Outlined text. */
  text(s: string, x: number, y: number, color: string, size = 13, align: Align = 'center', baseline: Baseline = 'middle'): void {
    this.setFont(size);
    this.setAlign(align, baseline);
    const g = this.g;
    if (this.outlineExtra > 0) {
      this.setStroke(this.outline);
      this.setWidth(Math.max(2.5, size * this.fontScale * 0.24));
      g.strokeText(s, x, y);
    }
    this.setFill(color);
    g.fillText(s, x, y);
  }

  /** Text on a translucent pill (subtitles, hints). Returns the pill width. */
  pillText(s: string, x: number, y: number, color: string, size: number, back: string, align: Align = 'center', padX = 8, padY = 4): number {
    const w = this.textWidth(s, size) + padX * 2;
    const h = size * this.fontScale + padY * 2;
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    this.setFill(back);
    this.roundRect(left, y - h / 2, w, h, Math.min(8, h / 2));
    this.g.fill();
    this.setFont(size);
    this.setAlign(align === 'center' ? 'center' : align, 'middle');
    this.setFill(color);
    this.g.fillText(s, align === 'center' ? x : align === 'right' ? x - padX : x + padX, y + 0.5);
    return w;
  }

  roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const g = this.g;
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h - r);
    g.arcTo(x + w, y + h, x + w - r, y + h, r);
    g.lineTo(x + r, y + h);
    g.arcTo(x, y + h, x, y + h - r, r);
    g.lineTo(x, y + r);
    g.arcTo(x, y, x + r, y, r);
    g.closePath();
  }

  /** Rotated outlined text (pitch ladder numbers). Uses explicit transforms (no save/restore, which
   *  would silently desync the cached style state). */
  textRotated(s: string, x: number, y: number, angle: number, color: string, size: number, align: Align = 'center'): void {
    if (Math.abs(angle) < 0.01) {
      this.text(s, x, y, color, size, align);
      return;
    }
    const d = this.dpr;
    const c = Math.cos(angle) * d;
    const n = Math.sin(angle) * d;
    this.g.setTransform(c, n, -n, c, x * d, y * d);
    this.text(s, 0, 0, color, size, align);
    this.baseTransform();
  }

  /** Device pixel ratio of the canvas (set by the owner on resize). */
  dpr = 1;

  /** Restore the CSS-pixel transform. */
  baseTransform(): void {
    this.g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Clip to a region: run `fn` with a clip, then restore and resync the cached state. */
  clipped(path: () => void, fn: () => void): void {
    const g = this.g;
    g.save();
    g.beginPath();
    path();
    g.clip();
    fn();
    g.restore();
    this.reset();
  }
}
