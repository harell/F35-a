/**
 * DEV / TEST ONLY — a recording CanvasRenderingContext2D stand-in so the real HUD (createHud) and PCD
 * pages can run in node (vitest) and tests can assert WHERE text and symbols were drawn (overlaps,
 * zones, truncation). Records fillText calls (in CSS px, font size parsed from the font string) and
 * arcs; everything else is a no-op. Not imported by the game.
 */

export interface TextRec {
  text: string;
  x: number;
  y: number;
  /** Font size in CSS px (after the current transform's scale). */
  size: number;
  align: string;
  baseline: string;
  color: string;
  alpha: number;
}

export interface ArcRec {
  x: number;
  y: number;
  r: number;
  dashed: boolean;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Approximate glyph advance of B612 Mono / monospace (fraction of the font size). */
export const CHAR_W = 0.6;

export class FakeContext2D {
  texts: TextRec[] = [];
  arcs: ArcRec[] = [];
  images = 0;
  font = '10px monospace';
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  lineWidth = 1;
  textAlign = 'start';
  textBaseline = 'alphabetic';
  globalAlpha = 1;
  lineJoin = 'miter';
  lineCap = 'butt';
  private tf = [1, 0, 0, 1, 0, 0];
  private stack: number[][] = [];
  private dash: number[] = [];
  /** Device pixel ratio the HUD uses (texts are reported in CSS px). */
  constructor(public dpr = 1) {}

  reset(): void {
    this.texts.length = 0;
    this.arcs.length = 0;
    this.images = 0;
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.tf = [a, b, c, d, e, f];
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const [A, B, C, D, E, F] = this.tf;
    this.tf = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
  }
  getTransform() {
    return { a: this.tf[0], b: this.tf[1], c: this.tf[2], d: this.tf[3], e: this.tf[4], f: this.tf[5] };
  }
  save(): void {
    this.stack.push([...this.tf, this.globalAlpha]);
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) {
      this.tf = s.slice(0, 6);
      this.globalAlpha = s[6];
    }
  }
  private map(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.tf;
    return [(a * x + c * y + e) / this.dpr, (b * x + d * y + f) / this.dpr];
  }
  private scale(): number {
    return Math.hypot(this.tf[0], this.tf[1]) / this.dpr;
  }
  fontPx(): number {
    const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
    return m ? parseFloat(m[1]) : 10;
  }
  measureText(s: string) {
    return { width: s.length * this.fontPx() * CHAR_W };
  }
  fillText(s: string, x: number, y: number): void {
    const [X, Y] = this.map(x, y);
    this.texts.push({
      text: s,
      x: X,
      y: Y,
      size: this.fontPx() * this.scale(),
      align: this.textAlign,
      baseline: this.textBaseline,
      color: String(this.fillStyle),
      alpha: this.globalAlpha,
    });
  }
  strokeText(): void {}
  arc(x: number, y: number, r: number): void {
    const [X, Y] = this.map(x, y);
    this.arcs.push({ x: X, y: Y, r: r * this.scale(), dashed: this.dash.length > 0 });
  }
  setLineDash(d: number[]): void {
    this.dash = d;
  }
  clearRect(): void {}
  fillRect(): void {}
  strokeRect(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arcTo(): void {}
  ellipse(): void {}
  rect(): void {}
  closePath(): void {}
  stroke(): void {}
  fill(): void {}
  clip(): void {}
  drawImage(): void {
    this.images++;
  }
  createRadialGradient() {
    return { addColorStop() {} };
  }
  createLinearGradient() {
    return { addColorStop() {} };
  }
}

/** A canvas-like object whose 2D context records into a FakeContext2D. */
export function makeFakeCanvas(width: number, height: number, dpr = 1): { canvas: HTMLCanvasElement; ctx: FakeContext2D } {
  const ctx = new FakeContext2D(dpr);
  const canvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {} as Record<string, string>,
    getContext: () => ctx,
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, ctx };
}

/** Approximate CSS-px bounding box of a recorded text. */
export function textBox(t: TextRec): Box {
  const w = t.text.length * t.size * CHAR_W;
  const h = t.size;
  let x0 = t.x;
  if (t.align === 'center') x0 = t.x - w / 2;
  else if (t.align === 'right' || t.align === 'end') x0 = t.x - w;
  let y0 = t.y - h / 2;
  if (t.baseline === 'top') y0 = t.y;
  else if (t.baseline === 'bottom' || t.baseline === 'alphabetic') y0 = t.y - h;
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

export function overlaps(a: Box, b: Box, pad = 0): boolean {
  return a.x0 < b.x1 - pad && b.x0 < a.x1 - pad && a.y0 < b.y1 - pad && b.y0 < a.y1 - pad;
}

/** Minimal Path2D stand-in for node (the tactical map builds its coastline as Path2D). */
export function installPath2D(): void {
  const g = globalThis as unknown as { Path2D?: unknown };
  if (g.Path2D) return;
  g.Path2D = class {
    moveTo(): void {}
    lineTo(): void {}
    closePath(): void {}
    arc(): void {}
    ellipse(): void {}
    rect(): void {}
  };
}
