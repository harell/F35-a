/**
 * Canvas-drawn runway texture (browser only): asphalt with tyre marks, edge lines, centre-line
 * dashes, threshold "piano keys", runway designators, touchdown-zone and aiming-point markings.
 * The texture spans the full runway: u across (width), v along (0 = threshold A, 1 = threshold B).
 */
import { CanvasTexture, LinearMipmapLinearFilter, SRGBColorSpace, ClampToEdgeWrapping } from 'three';
import { mulberry32 } from '../../core/math';

export function runwayDesignators(headingDeg: number): [string, string] {
  const a = Math.round((((headingDeg % 360) + 360) % 360) / 10) || 36;
  const b = ((a + 18 - 1) % 36) + 1;
  const fmt = (n: number) => String(n).padStart(2, '0');
  return [fmt(a), fmt(b)];
}

/**
 * @param lengthM runway length (m)  @param widthM width (m)
 * @param names designators [threshold A, threshold B]
 * Mesh mapping (flipY): v = 1 at threshold A (canvas top), v = 0 at B; u = 0 on the right of a pilot
 * landing at A, u = 1 on the left.
 */
export function createRunwayTexture(lengthM: number, widthM: number, names: [string, string]): CanvasTexture {
  const W = 256;
  const H = 4096;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const px = W / widthM; // pixels per metre across
  const py = H / lengthM; // pixels per metre along
  const rnd = mulberry32(77);

  // Asphalt base + grain
  g.fillStyle = '#34363a';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) {
    const v = 40 + rnd() * 30;
    g.fillStyle = `rgba(${v},${v},${v + 3},0.35)`;
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 3, 1 + rnd() * 8);
  }
  // Rubber deposits in the touchdown zones (both ends)
  for (const end of [0, 1]) {
    for (let i = 0; i < 260; i++) {
      const along = (150 + rnd() * 700) * py;
      const y = end === 0 ? along : H - along;
      const x = W / 2 + (rnd() - 0.5) * W * 0.45;
      g.fillStyle = `rgba(12,12,14,${0.12 + rnd() * 0.18})`;
      g.fillRect(x, y, 2 + rnd() * 5, 30 + rnd() * 90);
    }
  }
  g.fillStyle = '#e9e9e4';
  // Edge lines
  const edge = Math.max(2, 0.9 * px);
  g.fillRect(1.5 * px, 0, edge, H);
  g.fillRect(W - 1.5 * px - edge, 0, edge, H);
  // Centre line: 36 m dash / 24 m gap, skipping the markings at the ends
  const clw = Math.max(2, 0.9 * px);
  for (let v = 120; v < lengthM - 120; v += 60) g.fillRect(W / 2 - clw / 2, v * py, clw, 36 * py);

  const drawEnd = (end: 0 | 1, name: string) => {
    g.save();
    if (end === 1) {
      g.translate(W, H);
      g.rotate(Math.PI);
    }
    // Threshold piano keys (16 stripes, 30 m long, 6 m from the end)
    const stripes = 16;
    const sw = (widthM - 6) / (stripes * 2 - 1);
    for (let i = 0; i < stripes; i++) {
      const x = (3 + i * 2 * sw) * px;
      g.fillRect(x, 6 * py, sw * px, 30 * py);
    }
    // Designator, readable by a pilot approaching this end (canvas top = threshold A; the text is
    // rotated 180° so its top points down the runway). Stretched along the runway: 18 m tall glyphs.
    g.save();
    const F = Math.round(10 * px);
    g.translate(W / 2, 52 * py);
    g.rotate(Math.PI);
    g.scale(1, (18 * py) / (0.72 * F));
    g.font = `bold ${F}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, 0, 0);
    g.restore();
    // Aiming point (two big blocks at 300 m) and touchdown zone bars
    const ab = 9 * px;
    g.fillRect(W / 2 - 9 * px - ab, 300 * py, ab, 45 * py);
    g.fillRect(W / 2 + 9 * px, 300 * py, ab, 45 * py);
    for (const d of [150, 450, 600]) {
      const bars = d === 150 ? 3 : d === 450 ? 2 : 1;
      for (let b = 0; b < bars; b++) {
        const off = (9 + b * 3) * px;
        g.fillRect(W / 2 - off - 1.8 * px, d * py, 1.8 * px, 22 * py);
        g.fillRect(W / 2 + off, d * py, 1.8 * px, 22 * py);
      }
    }
    g.restore();
  };
  drawEnd(0, names[0]);
  drawEnd(1, names[1]);

  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}
