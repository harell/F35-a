/**
 * PCD zoom overlay (cockpit view): the tapped portal's page drawn large and crisp on the HMD canvas,
 * with page tabs along the bottom (tap a tab = switch page, tap anywhere else = close; the taps are
 * handled by Cockpit.handleTap through the shared zoom state).
 *
 * The page is rendered by the same page renderers as the PCD texture, into an offscreen canvas at
 * device resolution at ~10 Hz (no per-frame page redraw / string building), and blitted every frame.
 * Without a DOM (unit tests) it draws straight onto the HUD canvas.
 */
import { PAGE_FNS, PC, type PageId, type PcdData } from '../cockpit/pages';
import { MAX_ZOOM_TABS, pcdZoom } from '../cockpit/zoom';
import type { HudFrame } from './frame';
import { Pen } from './pen';

/** Logical page size (texture px) used for the zoomed page. */
export const ZOOM_PAGE_H = 318;
export const ZOOM_TAB_H = 42;
const WIDE: Partial<Record<PageId, true>> = { TSD: true, RDR: true };
export function zoomPageWidth(page: PageId): number {
  return WIDE[page] ? 504 : 380;
}

const data: PcdData = { ctx: null as unknown as PcdData['ctx'], p: null as unknown as PcdData['p'], flash: false, zoom: true };
let off: HTMLCanvasElement | null = null;
let offPen: Pen | null = null;
let directPen: Pen | null = null;
let offPage = '';
let offW = 0;
let offH = 0;
let offAcc = 99;
const REDRAW = 0.1;

function offscreen(): Pen | null {
  if (offPen) return offPen;
  if (typeof document === 'undefined') return null;
  off = document.createElement('canvas');
  const g = off.getContext('2d');
  if (!g) return null;
  offPen = new Pen(g);
  offPen.outlineExtra = 0;
  return offPen;
}

/** Draws the overlay when a portal is zoomed (cockpit view). Returns true when drawn. */
export function drawPcdZoom(f: HudFrame): boolean {
  if (!pcdZoom.open) return false;
  const page = pcdZoom.page;
  if (!page || !f.cockpit || f.mode !== 'hmd') return false;
  const { pen, L, ctx } = f;
  const u = L.u;
  const g = pen.g;
  pcdZoom.age += ctx.paused ? 0 : ctx.dt;
  // fit into the free band between the touch clusters, below the radio / above the thumbs
  const ax0 = Math.max(L.left, L.ctlLeft + 6 * u);
  const ax1 = Math.min(L.right, L.ctlRight - 6 * u);
  const ay0 = L.warnY - 14 * u;
  const ay1 = L.bottom - 2;
  // an empty header strip on top: the critical warning line (PULL UP / MISSILE) sits over it
  const header = L.warnY + 14 * u - ay0;
  const lw = zoomPageWidth(page);
  const lh = ZOOM_PAGE_H + ZOOM_TAB_H;
  const k = Math.max(0.3, Math.min((ax1 - ax0) / lw, (ay1 - ay0 - header) / lh));
  const w = lw * k;
  const h = header + lh * k;
  const x = (ax0 + ax1) / 2 - w / 2;
  const y = ay0;
  const r = pcdZoom.rect;
  r.x = x;
  r.y = y;
  r.w = w;
  r.h = h;
  const py = y + header;
  const ph = ZOOM_PAGE_H * k;

  // frame
  pen.setFill('rgba(3,7,10,0.94)');
  pen.roundRect(x - 3 * u, y - 3 * u, w + 6 * u, h + 6 * u, 6 * u);
  g.fill();
  pen.begin();
  pen.rect(x, py, w, h - header);
  pen.strokePlain(PC.frame, 2);

  // page content
  data.ctx = ctx;
  data.p = f.p;
  data.flash = Math.floor(f.st.clock / 0.4) % 2 === 0;
  const dpr = pen.dpr;
  const op = offscreen();
  if (op && off) {
    const cw = Math.max(1, Math.round(w * dpr));
    const chh = Math.max(1, Math.round(ph * dpr));
    offAcc += ctx.dt;
    if (page !== offPage || cw !== offW || chh !== offH || offAcc >= REDRAW) {
      if (off.width !== cw || off.height !== chh) {
        off.width = cw;
        off.height = chh;
        op.reset();
      }
      offPage = page;
      offW = cw;
      offH = chh;
      offAcc = 0;
      const og = op.g;
      og.setTransform(1, 0, 0, 1, 0, 0);
      og.fillStyle = PC.portal;
      og.fillRect(0, 0, cw, chh);
      og.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
      op.reset();
      try {
        PAGE_FNS[page](op, 0, 0, lw, ZOOM_PAGE_H, data);
      } catch (err) {
        console.warn('[hud] zoom page failed', page, err);
      }
      og.setTransform(1, 0, 0, 1, 0, 0);
    }
    g.drawImage(off, x, py, w, ph);
  } else {
    // no DOM: draw directly
    if (!directPen || directPen.g !== g) {
      directPen = new Pen(g);
      directPen.outlineExtra = 0;
    }
    g.save();
    g.beginPath();
    g.rect(x, py, w, ph);
    g.clip();
    g.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * py);
    directPen.reset();
    try {
      PAGE_FNS[page](directPen, 0, 0, lw, ZOOM_PAGE_H, data);
    } catch (err) {
      console.warn('[hud] zoom page failed', page, err);
    }
    g.restore();
    pen.reset();
    pen.baseTransform();
  }

  // tabs (the portal's pages) along the bottom — big thumb targets — and a close tab at the end
  const n = Math.min(MAX_ZOOM_TABS, pcdZoom.pages.length);
  const ty = py + ph;
  const th = y + h - ty;
  const closeW = Math.min(46 * u, w * 0.14);
  const tw = (w - closeW) / Math.max(1, n);
  pcdZoom.tabCount = n;
  for (let i = 0; i < n; i++) {
    const t = pcdZoom.tabs[i];
    t.x = x + i * tw;
    t.y = ty;
    t.w = tw;
    t.h = th;
    const active = i === pcdZoom.index;
    pen.setFill(active ? '#12303f' : PC.titleBg);
    g.fillRect(t.x + 1, t.y + 1, t.w - 2, t.h - 2);
    pen.begin();
    pen.rect(t.x + 1, t.y + 1, t.w - 2, t.h - 2);
    pen.strokePlain(active ? PC.cyan : PC.frame, active ? 2 : 1);
    pen.setFont(Math.min(15, Math.max(11, 13 * k)) / (pen.fontScale || 1));
    pen.setAlign('center', 'middle');
    pen.setFill(active ? PC.cyan : PC.label);
    g.fillText(pcdZoom.pages[i], t.x + t.w / 2, t.y + t.h / 2 + 0.5);
  }
  // close tab (any tap outside the page tabs closes)
  const cx = x + w - closeW / 2;
  const cy = ty + th / 2;
  pen.setFill(PC.titleBg);
  g.fillRect(x + w - closeW + 1, ty + 1, closeW - 2, th - 2);
  pen.begin();
  pen.line(cx - 6 * u, cy - 6 * u, cx + 6 * u, cy + 6 * u);
  pen.line(cx - 6 * u, cy + 6 * u, cx + 6 * u, cy - 6 * u);
  pen.strokePlain(PC.label, 2.2);
  f.occ.add(x - 3 * u, y - 3 * u, x + w + 3 * u, y + h + 3 * u);
  return true;
}
