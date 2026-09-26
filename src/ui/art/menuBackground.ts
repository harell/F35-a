/**
 * F35-A UI art — animated "tactical display" menu background: the Auckland chart in AWACS colours,
 * a slow drift, a rotating radar sweep that paints hostile/friendly blips over the Hauraki Gulf,
 * and range rings. Cheap: the chart is pre-rendered once per resize into an offscreen canvas; each
 * frame (capped at 30 fps, paused when hidden) blits it and draws a handful of shapes.
 */
import { CHART_LABELS, drawAucklandChart, type ChartView } from './aucklandChart';

interface Blip {
  x: number;
  z: number;
  vx: number;
  vz: number;
  hostile: boolean;
  /** Seconds since last painted by the sweep. */
  age: number;
}

const SWEEP_CENTRE = { x: 6, z: -8 }; // km — AWACS picture centred on the Gulf approaches
const SWEEP_PERIOD = 6; // s per revolution
const SWEEP_STEPS = 10;
/** Pre-built fill styles for the fading sweep trail (no per-frame string building). */
const SWEEP_FILLS = Array.from({ length: SWEEP_STEPS }, (_, i) => `rgba(95,227,255,${(0.075 * (1 - i / SWEEP_STEPS)).toFixed(3)})`);

export class MenuBackground {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private chart: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private view: ChartView = { scale: 10, x0: -30, z0: -30 };
  private running = false;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private t = 0;
  private readonly blips: Blip[] = [];

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ui-bg-canvas';
    parent.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;
    // a few groups: bandits in the Gulf heading for the city, friendlies from Whenuapai
    const seeds: [number, number, number, number, boolean][] = [
      [24, -20, -0.09, 0.06, true],
      [26, -17, -0.09, 0.06, true],
      [33, -6, -0.12, -0.01, true],
      [15, -26, -0.05, 0.08, true],
      [-10, -7, 0.1, -0.03, false],
      [-9, -8.2, 0.1, -0.03, false],
      [4, -14, 0.02, -0.08, false],
    ];
    for (const [x, z, vx, vz, hostile] of seeds) this.blips.push({ x, z, vx, vz, hostile, age: 99 });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.acc += dt;
      if (this.acc < 1 / 30) return;
      const step = this.acc;
      this.acc = 0;
      if (document.hidden) return;
      this.frame(step);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private resize(): boolean {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr && this.chart) return false;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    // show ~70 km across the long side, centred between the city and the Gulf; a margin for the drift
    const pxPerKm = Math.max(w, h * 1.6) / 62;
    const margin = 60;
    const cw = Math.round((w + margin * 2) * dpr);
    const ch = Math.round((h + margin * 2) * dpr);
    const chart = document.createElement('canvas');
    chart.width = cw;
    chart.height = ch;
    const cg = chart.getContext('2d') as CanvasRenderingContext2D;
    const scale = pxPerKm * dpr;
    const cx = 2;
    const cz = -6;
    this.view = { scale, x0: cx - cw / 2 / scale, z0: cz - ch / 2 / scale };
    const ok = drawAucklandChart(cg, cw, ch, this.view, {
      land: '#0a1820',
      water: '#03080c',
      coast: 'rgba(95,227,255,0.55)',
      coastWidth: Math.max(1, 0.9 * dpr),
      relief: 'rgba(120,200,220,0.07)',
      urban: 'rgba(95,227,255,0.035)',
    });
    if (!ok) {
      cg.fillStyle = '#060c12';
      cg.fillRect(0, 0, cw, ch);
    }
    // 5 km grid
    cg.strokeStyle = 'rgba(95,227,255,0.07)';
    cg.lineWidth = 1;
    cg.beginPath();
    const kmStep = 5;
    const gx0 = Math.ceil(this.view.x0 / kmStep) * kmStep;
    const gz0 = Math.ceil(this.view.z0 / kmStep) * kmStep;
    for (let x = gx0; (x - this.view.x0) * scale < cw; x += kmStep) {
      const px = Math.round((x - this.view.x0) * scale) + 0.5;
      cg.moveTo(px, 0);
      cg.lineTo(px, ch);
    }
    for (let z = gz0; (z - this.view.z0) * scale < ch; z += kmStep) {
      const pz = Math.round((z - this.view.z0) * scale) + 0.5;
      cg.moveTo(0, pz);
      cg.lineTo(cw, pz);
    }
    cg.stroke();
    // labels
    if (ok) {
      cg.textAlign = 'center';
      cg.textBaseline = 'middle';
      for (const l of CHART_LABELS) {
        const px = (l.x - this.view.x0) * scale;
        const pz = (l.z - this.view.z0) * scale;
        cg.font = `${l.kind === 'sea' ? 600 : 700} ${Math.round((l.kind === 'sea' ? 11 : 9) * dpr)}px ui-monospace, 'SF Mono', Menlo, Consolas, monospace`;
        cg.fillStyle = l.kind === 'sea' ? 'rgba(95,227,255,0.22)' : 'rgba(180,230,245,0.28)';
        cg.fillText(l.text.split('').join(String.fromCharCode(8202)), px, pz);
      }
    }
    // range rings around the sweep centre
    const sx = (SWEEP_CENTRE.x - this.view.x0) * scale;
    const sz = (SWEEP_CENTRE.z - this.view.z0) * scale;
    cg.strokeStyle = 'rgba(95,227,255,0.12)';
    cg.setLineDash([2 * dpr, 6 * dpr]);
    for (let r = 10; r <= 40; r += 10) {
      cg.beginPath();
      cg.arc(sx, sz, r * scale, 0, Math.PI * 2);
      cg.stroke();
    }
    cg.setLineDash([]);
    this.chart = chart;
    return true;
  }

  private frame(dt: number): void {
    this.resize();
    const g = this.g;
    const dpr = this.dpr;
    this.t += dt;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const chart = this.chart;
    if (!chart) return;
    // slow Lissajous drift within the margin
    const m = 60 * dpr;
    const ox = -m + Math.sin(this.t * 0.05) * m * 0.8;
    const oy = -m + Math.cos(this.t * 0.037) * m * 0.8;
    g.drawImage(chart, ox, oy);

    const v = this.view;
    const toX = (x: number) => (x - v.x0) * v.scale + ox;
    const toY = (z: number) => (z - v.z0) * v.scale + oy;
    const cx = toX(SWEEP_CENTRE.x);
    const cy = toY(SWEEP_CENTRE.z);
    const ang = ((this.t % SWEEP_PERIOD) / SWEEP_PERIOD) * Math.PI * 2 - Math.PI / 2;
    const R = Math.hypot(W, H);

    // sweep wedge (fading trail)
    const trail = 0.55;
    const steps = SWEEP_STEPS;
    for (let i = 0; i < steps; i++) {
      const a0 = ang - (trail * (i + 1)) / steps;
      const a1 = ang - (trail * i) / steps;
      g.fillStyle = SWEEP_FILLS[i];
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, R, a0, a1);
      g.closePath();
      g.fill();
    }
    g.strokeStyle = 'rgba(140,240,255,0.35)';
    g.lineWidth = 1.2 * dpr;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
    g.stroke();

    // blips: move, get painted when the sweep passes, fade afterwards
    for (const b of this.blips) {
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      if (b.x < -40 || b.x > 45 || b.z < -40 || b.z > 30) {
        // respawn at the far side
        b.x = b.hostile ? 30 + Math.random() * 8 : -12 + Math.random() * 3;
        b.z = b.hostile ? -24 + Math.random() * 16 : -8 + Math.random() * 3;
      }
      const ba = Math.atan2(b.z - SWEEP_CENTRE.z, b.x - SWEEP_CENTRE.x);
      let d = ang - ba;
      d = ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      if (d < dt * ((Math.PI * 2) / SWEEP_PERIOD) * 1.5) b.age = 0;
      else b.age += dt;
      const a = Math.max(0, 1 - b.age / (SWEEP_PERIOD * 0.9));
      if (a <= 0.02) continue;
      const px = toX(b.x);
      const py = toY(b.z);
      const s = 4.5 * dpr;
      g.globalAlpha = a;
      g.strokeStyle = b.hostile ? '#ff5a4a' : '#5fe3ff';
      g.fillStyle = b.hostile ? 'rgba(255,90,74,0.25)' : 'rgba(95,227,255,0.25)';
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      if (b.hostile) {
        g.moveTo(px, py - s);
        g.lineTo(px + s, py);
        g.lineTo(px, py + s);
        g.lineTo(px - s, py);
      } else {
        g.arc(px, py, s * 0.8, Math.PI, 0);
        g.lineTo(px + s * 0.8, py + s * 0.5);
        g.lineTo(px - s * 0.8, py + s * 0.5);
      }
      g.closePath();
      g.fill();
      g.stroke();
      // velocity leader
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + b.vx * 40 * v.scale, py + b.vz * 40 * v.scale);
      g.stroke();
      g.globalAlpha = 1;
    }
  }

  dispose(): void {
    this.stop();
    this.canvas.remove();
    this.chart = null;
  }
}
