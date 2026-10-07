/**
 * The CBD tower skins' signs (core/cbdTowerSkins.ts) as one canvas-drawn atlas: each sign is text in a similar font
 * with a simple stand-in mark, never a logo file or a photo. The atlas is 1024 × 2048: the day look of every sign in
 * the top half and its night look (which letters are lit, in what colour) at the same place in the bottom half, so a
 * sign quad carries one uv and the logo shader (createLogoMaterial) reads the night half 0.5 lower in v. Signs are
 * packed on shelves of ROW px, left to right in table order.
 */
import { CanvasTexture, SRGBColorSpace } from 'three';
import type { SkinLogo } from '../../core/cbdTowerSkins';

export const ATLAS_W = 1024;
/** Day half + night half. */
export const ATLAS_H = 2048;
/** A sign's height in the atlas (px): ~20 px a metre on a 5 m sign, more than a player can resolve. */
const ROW = 96;
/** A pixel's margin round each sign keeps the mips of its neighbours out. */
const PAD = 2;

type Ctx = CanvasRenderingContext2D;
/** Draws one sign with its top-left at (0, 0), w × H px; `night`: the lit look. */
type Draw = (c: Ctx, w: number, H: number, night: boolean) => void;

interface LogoDef {
  /** Width : height. */
  aspect: number;
  draw: Draw;
}

const SANS = '"Helvetica Neue", Arial, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';

/** Text scaled down to fit `room` px, middle-left at (x, y). */
function text(c: Ctx, s: string, x: number, y: number, size: number, room: number, fill: string, weight = 'bold', family = SANS): void {
  c.font = `${weight} ${Math.round(size)}px ${family}`;
  c.fillStyle = fill;
  c.textBaseline = 'middle';
  const tw = c.measureText(s).width;
  c.save();
  c.translate(x, y);
  c.scale(Math.min(1, room / Math.max(1, tw)), 1);
  c.fillText(s, 0, 0);
  c.restore();
}

interface WordOpts {
  /** Day ink. */
  ink: string;
  /** Night ink (default: the day ink, lit). */
  night?: string;
  /** A backing plate behind the letters (day, night). */
  plate?: string;
  plateNight?: string;
  weight?: string;
  family?: string;
  /** Letter height as a share of the row. */
  size?: number;
  /** A stand-in mark left of the letters, `markW` rows wide. */
  mark?: (c: Ctx, x: number, mid: number, H: number, night: boolean) => void;
  markW?: number;
  /** Letter spacing hint: the text is stretched to fill when true. */
  fill?: boolean;
}

/** A sign that is a word (and a mark): most of them. */
function word(s: string, o: WordOpts): Draw {
  return (c, w, H, night) => {
    const mid = H / 2;
    if (o.plate) {
      c.fillStyle = night ? o.plateNight ?? o.plate : o.plate;
      c.fillRect(0, 0, w, H);
    }
    let x = H * 0.06;
    if (o.mark) {
      o.mark(c, x, mid, H, night);
      x += H * (o.markW ?? 1);
    }
    const ink = night ? o.night ?? o.ink : o.ink;
    const room = w - x - H * 0.06;
    const size = H * (o.size ?? 0.78);
    if (o.fill) {
      c.font = `${o.weight ?? 'bold'} ${Math.round(size)}px ${o.family ?? SANS}`;
      const tw = c.measureText(s).width;
      c.save();
      c.translate(x, mid + H * 0.03);
      c.scale(room / Math.max(1, tw), 1);
      c.fillStyle = ink;
      c.textBaseline = 'middle';
      c.fillText(s, 0, 0);
      c.restore();
    } else text(c, s, x, mid + H * 0.03, size, room, ink, o.weight ?? 'bold', o.family ?? SANS);
  };
}

const disc = (fill: string, nightFill = fill, r = 0.36) => (c: Ctx, x: number, mid: number, H: number, night: boolean) => {
  c.fillStyle = night ? nightFill : fill;
  c.beginPath();
  c.arc(x + H * 0.4, mid, H * r, 0, Math.PI * 2);
  c.fill();
};

const LOGOS: Record<SkinLogo, LogoDef> = {
  hsbc: {
    // a red and white hexagon (two red wedges each side of a white bow tie), black letters; at night the hexagon is
    // lit and the letters are white
    aspect: 3.3,
    draw: (c, w, H, night) => {
      const mid = H / 2;
      const r = H * 0.42;
      const hx = H * 0.55;
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.moveTo(hx - r * 1.3, mid);
      c.lineTo(hx - r * 0.65, mid - r);
      c.lineTo(hx + r * 0.65, mid - r);
      c.lineTo(hx + r * 1.3, mid);
      c.lineTo(hx + r * 0.65, mid + r);
      c.lineTo(hx - r * 0.65, mid + r);
      c.closePath();
      c.fill();
      c.fillStyle = '#db0011';
      for (const s of [-1, 1]) {
        c.beginPath();
        c.moveTo(hx + s * r * 1.3, mid);
        c.lineTo(hx + s * r * 0.65, mid - r);
        c.lineTo(hx, mid);
        c.lineTo(hx + s * r * 0.65, mid + r);
        c.closePath();
        c.fill();
        c.beginPath();
        c.moveTo(hx - r * 0.65, mid + s * r);
        c.lineTo(hx + r * 0.65, mid + s * r);
        c.lineTo(hx, mid);
        c.closePath();
        c.fill();
      }
      text(c, 'HSBC', H * 1.25, mid + H * 0.03, H * 0.62, w - H * 1.35, night ? '#f2f2f2' : '#1a1a1a');
    },
  },
  anz: {
    // white letters and a round figure mark, for the blue crown box (lit white at night)
    aspect: 2.8,
    draw: (c, w, H) => {
      const mid = H / 2;
      text(c, 'ANZ', H * 0.08, mid + H * 0.03, H * 0.8, w - H * 1.1, '#ffffff', '900');
      const mx = w - H * 0.55;
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(mx, mid - H * 0.2, H * 0.13, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.ellipse(mx, mid + H * 0.17, H * 0.3, H * 0.2, 0, Math.PI, 0);
      c.fill();
    },
  },
  vero: {
    // lower-case red letters and a tick (lit red at night)
    aspect: 3.2,
    draw: (c, w, H) => {
      const mid = H / 2;
      text(c, 'vero', H * 0.05, mid, H * 0.95, w - H * 0.7, '#d8436f', '600');
      c.strokeStyle = '#d8436f';
      c.lineWidth = H * 0.08;
      c.beginPath();
      c.moveTo(w - H * 0.55, mid - H * 0.25);
      c.lineTo(w - H * 0.38, mid + H * 0.2);
      c.lineTo(w - H * 0.12, mid - H * 0.4);
      c.stroke();
    },
  },
  pwc: {
    // stacked warm blocks over pale letters (both lit at night)
    aspect: 1.6,
    draw: (c, w, H) => {
      const cols = ['#ffb600', '#eb8c00', '#e0301e', '#d93954'];
      cols.forEach((col, i) => {
        c.fillStyle = col;
        c.fillRect(w * (0.42 + i * 0.07), H * (0.06 + i * 0.07), w * 0.36, H * 0.13);
      });
      text(c, 'pwc', w * 0.08, H * 0.7, H * 0.5, w * 0.84, '#f4f4f2');
    },
  },
  qbe: {
    // a blue disc and white letters, for the dark crown (lit at night)
    aspect: 3.4,
    draw: word('QBE', { ink: '#ffffff', weight: '900', size: 0.75, mark: disc('#2e9be6'), markW: 0.95 }),
  },
  waitemata: {
    // the station's name in white beside a yellow roundel with a dark train front (a stand-in for the transport mark),
    // over the Glasshouse's canopy
    aspect: 5,
    draw: (c, w, H) => {
      const mid = H / 2;
      const r = H * 0.36;
      const cx = H * 0.45;
      c.fillStyle = '#ffd200';
      c.beginPath();
      c.arc(cx, mid, r, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#1d1d1b';
      c.fillRect(cx - r * 0.42, mid - r * 0.55, r * 0.84, r * 0.85);
      c.fillRect(cx - r * 0.5, mid + r * 0.42, r * 0.22, r * 0.2);
      c.fillRect(cx + r * 0.28, mid + r * 0.42, r * 0.22, r * 0.2);
      c.fillStyle = '#ffd200';
      c.fillRect(cx - r * 0.3, mid - r * 0.42, r * 0.6, r * 0.32);
      text(c, 'Waitematā', H * 1.0, mid + H * 0.03, H * 0.62, w - H * 1.05, '#ffffff', '600');
    },
  },
  voco: {
    // the hotel's lower-case name in charcoal on the pale crown panels; lit white at night (guessed)
    aspect: 2.6,
    draw: word('voco', { ink: '#3a3a3c', night: '#f4f4f0', weight: '500', size: 0.9, fill: true }),
  },
  hiexpress: {
    // a green panel with the name in white over the step between the two volumes (lit at night)
    aspect: 2.2,
    draw: (c, w, H) => {
      c.fillStyle = '#1f8a3b';
      c.fillRect(0, 0, w, H);
      text(c, 'Holiday Inn', w * 0.07, H * 0.34, H * 0.36, w * 0.86, '#ffffff', 'bold');
      text(c, 'EXPRESS', w * 0.07, H * 0.72, H * 0.3, w * 0.86, '#ffffff', 'bold');
    },
  },
  sap: {
    // white letters on a blue panel cut on a slant at its right (lit at night)
    aspect: 2,
    draw: (c, w, H) => {
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#2fa7e8');
      g.addColorStop(1, '#0a5fb4');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(w, 0);
      c.lineTo(w * 0.62, H);
      c.lineTo(0, H);
      c.closePath();
      c.fill();
      text(c, 'SAP', w * 0.06, H * 0.53, H * 0.66, w * 0.56, '#ffffff', 'bold');
    },
  },
  aon: {
    // silver-white capitals on the dark crown glass (lit white at night)
    aspect: 2.6,
    draw: word('AON', { ink: '#dde5ec', night: '#f4f6f8', weight: '900', size: 0.9, fill: true }),
  },
  huawei: {
    // the red petal mark and the name in red (lit red at night)
    aspect: 3.4,
    draw: word('HUAWEI', {
      ink: '#d7262f',
      weight: 'bold',
      size: 0.62,
      markW: 0.95,
      mark: (c, x, mid, H) => {
        c.fillStyle = '#e1262f';
        for (let i = 0; i < 8; i++) {
          const a = Math.PI * (0.06 + (0.88 * i) / 7);
          c.save();
          c.translate(x + H * 0.42, mid + H * 0.22);
          c.rotate(-a + Math.PI / 2);
          c.beginPath();
          c.ellipse(0, -H * 0.24, H * 0.07, H * 0.24, 0, 0, Math.PI * 2);
          c.fill();
          c.restore();
        }
      },
    }),
  },
  deloitte: {
    // the white name and its green dot on the dark glass (lit at night)
    aspect: 4.2,
    draw: (c, w, H) => {
      text(c, 'Deloitte', H * 0.05, H * 0.5, H * 0.82, w - H * 0.45, '#ffffff', 'bold');
      c.fillStyle = '#86bc25';
      c.beginPath();
      c.arc(w - H * 0.2, H * 0.72, H * 0.11, 0, Math.PI * 2);
      c.fill();
    },
  },
  rydges: {
    // dark capitals on a white panel (the panel lit at night)
    aspect: 4,
    draw: word('RYDGES', { ink: '#2d2a28', plate: '#f2f1ed', plateNight: '#fffdf4', weight: 'bold', size: 0.66, fill: true }),
  },
  skycity: {
    // a dark disc with the white "sky" of SkyCity, at the top of the lift tower (lit at night)
    aspect: 1,
    draw: (c, w, H) => {
      c.fillStyle = '#1e2430';
      c.beginPath();
      c.arc(w / 2, H / 2, H * 0.47, 0, Math.PI * 2);
      c.fill();
      text(c, 'sky', w * 0.2, H * 0.5, H * 0.42, w * 0.6, '#ffffff', 'bold');
    },
  },
  aa: {
    // the yellow AA square with black letters (lit at night)
    aspect: 1,
    draw: (c, w, H) => {
      c.fillStyle = '#ffd400';
      c.fillRect(w * 0.04, H * 0.04, w * 0.92, H * 0.92);
      text(c, 'AA', w * 0.16, H * 0.54, H * 0.6, w * 0.68, '#111111', '900');
    },
  },
  aut: {
    // pale capitals on the blue-glass rooftop box (lit white at night)
    aspect: 2.4,
    draw: word('AUT', { ink: '#e9eef4', night: '#ffffff', weight: '900', size: 0.88, fill: true }),
  },
  jarden: {
    // navy capitals and a ring on the white crown screen (lit at night)
    aspect: 4.6,
    draw: word('JARDEN', {
      ink: '#14284b',
      weight: 'bold',
      size: 0.66,
      fill: true,
      markW: 0.9,
      mark: (c, x, mid, H) => {
        c.strokeStyle = '#14284b';
        c.lineWidth = H * 0.1;
        c.beginPath();
        c.arc(x + H * 0.36, mid, H * 0.26, 0, Math.PI * 2);
        c.stroke();
      },
    }),
  },
  nzx: {
    // white capitals on the blue crown band with the blue and white chevrons of the X (lit at night)
    aspect: 3.4,
    draw: (c, w, H) => {
      c.fillStyle = '#1f3f8a';
      c.fillRect(0, 0, w, H);
      text(c, 'NZX', H * 0.15, H * 0.53, H * 0.74, w * 0.6, '#ffffff', '900');
      for (const [i, col] of ['#2aa0e6', '#ffffff'].entries()) {
        c.fillStyle = col;
        c.beginPath();
        const x0 = w * (0.7 + i * 0.12);
        c.moveTo(x0, H * 0.12);
        c.lineTo(x0 + H * 0.28, H * 0.5);
        c.lineTo(x0, H * 0.88);
        c.lineTo(x0 + H * 0.14, H * 0.88);
        c.lineTo(x0 + H * 0.42, H * 0.5);
        c.lineTo(x0 + H * 0.14, H * 0.12);
        c.closePath();
        c.fill();
      }
    },
  },
  so: {
    // the hotel's "SO/" in charcoal at the top of its white panel (lit white at night, guessed)
    aspect: 1.8,
    draw: word('SO/', { ink: '#2a2a2c', night: '#f6f6f2', weight: '300', size: 0.86, fill: true }),
  },
  quaywest: {
    // spaced serif capitals in deep red on the white wave crown (lit red at night, guessed)
    aspect: 5.5,
    draw: word('QUAY WEST', { ink: '#8e1b1f', night: '#e0373a', weight: '600', family: SERIF, size: 0.8, fill: true }),
  },
};

/** A sign's place in the atlas: uv of its day look (v up; its night look is 0.5 lower) and its width : height. */
export interface AtlasSlot {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  aspect: number;
}

interface Placed {
  x: number;
  y: number;
  w: number;
}

/** Shelf-packs every sign into the day half: left to right, a new shelf when one is full. */
function pack(): Map<SkinLogo, Placed> {
  const out = new Map<SkinLogo, Placed>();
  let x = 0;
  let y = 0;
  for (const [k, d] of Object.entries(LOGOS) as [SkinLogo, LogoDef][]) {
    const w = Math.min(ATLAS_W, Math.round(ROW * d.aspect));
    if (x + w > ATLAS_W) {
      x = 0;
      y += ROW;
    }
    out.set(k, { x, y, w });
    x += w;
  }
  return out;
}

const PLACED = pack();

/** How far down the day half the shelves reach (px): must stay within ATLAS_H / 2. */
export const ATLAS_USED = Math.max(...[...PLACED.values()].map((p) => p.y + ROW));

export const SIGN_LOGOS = Object.keys(LOGOS) as SkinLogo[];

export function logoSlot(logo: SkinLogo): AtlasSlot {
  const p = PLACED.get(logo)!;
  return {
    u0: (p.x + PAD) / ATLAS_W,
    u1: (p.x + p.w - PAD) / ATLAS_W,
    v0: 1 - (p.y + ROW - PAD) / ATLAS_H,
    v1: 1 - (p.y + PAD) / ATLAS_H,
    aspect: LOGOS[logo].aspect,
  };
}

/** Draws every sign's day look into the top half of the canvas and its night look into the bottom half. */
export function drawTowerLogos(canvas: HTMLCanvasElement): void {
  const c = canvas.getContext('2d')!;
  c.clearRect(0, 0, canvas.width, canvas.height);
  for (const [k, p] of PLACED) {
    for (const night of [false, true]) {
      c.save();
      c.beginPath();
      c.rect(p.x + PAD, p.y + PAD + (night ? ATLAS_H / 2 : 0), p.w - 2 * PAD, ROW - 2 * PAD);
      c.clip();
      // (drawn a margin in, so the clip keeps every sign inside its own cell)
      c.translate(p.x + PAD, p.y + PAD + (night ? ATLAS_H / 2 : 0));
      LOGOS[k].draw(c, p.w - 2 * PAD, ROW - 2 * PAD, night);
      c.restore();
    }
  }
}

/** The logo atlas texture (browser only). */
export function createTowerLogoTexture(anisotropy: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  drawTowerLogos(canvas);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}
