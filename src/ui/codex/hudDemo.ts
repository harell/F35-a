/**
 * F35-A UI — Codex warning demos: a small 2D HMD mock-up that shows each warning or cue the way it
 * appears in flight (warning band chips, radar-warning edge symbols, missile ring, PULL UP cross…).
 * Colours follow hud/hmd/palette.ts; positions are schematic, not the live HUD layout.
 */

const C = { hud: '#46ff78', warn: '#ffc02e', red: '#ff3b30', ir: '#ff8a1c', good: '#b4ffc8' };

type SymState = 'search' | 'track' | 'launch';
interface Chip {
  t: string;
  c: string;
  arrow?: number;
  blink?: boolean;
}

/** Draw one frame of the demo for a warning entry id at time t (s). */
export function drawWarningDemo(c: CanvasRenderingContext2D, W: number, H: number, t: number, id: string): void {
  const k = W / 720;
  const font = (s: number, bold = false) => `${bold ? 700 : 400} ${Math.round(s * k)}px 'B612 HMD', ui-monospace, monospace`;
  const cx = W / 2;
  const cy = H * 0.56;
  const blink = (hz: number) => Math.floor(t * hz * 2) % 2 === 0;

  // sky, ground, horizon and pitch ladder
  let pitch = 0;
  let roll = Math.sin(t * 0.4) * 0.05;
  if (id === 'pullup') pitch = -0.25 + Math.min(0.2, (t % 4) * 0.02);
  if (id === 'gcas') {
    pitch = -0.1 + ((t % 5) / 5) * 0.25;
    roll = 0;
  }
  c.save();
  c.fillStyle = '#071521';
  c.fillRect(0, 0, W, H);
  c.translate(cx, cy);
  c.rotate(roll);
  const hy = pitch * H * 1.6;
  const sky = c.createLinearGradient(0, -H, 0, hy);
  sky.addColorStop(0, '#0b2236');
  sky.addColorStop(1, '#2b4d63');
  c.fillStyle = sky;
  c.fillRect(-W, -H * 2, W * 2, H * 2 + hy);
  c.fillStyle = '#1d2a22';
  c.fillRect(-W, hy, W * 2, H * 2);
  c.strokeStyle = C.hud;
  c.fillStyle = C.hud;
  c.lineWidth = 1.6 * k;
  c.globalAlpha = 0.9;
  c.beginPath();
  c.moveTo(-W * 0.45, hy);
  c.lineTo(-W * 0.08, hy);
  c.moveTo(W * 0.08, hy);
  c.lineTo(W * 0.45, hy);
  c.stroke();
  c.font = font(11);
  for (let p = -20; p <= 20; p += 10) {
    if (!p) continue;
    const y = hy - p * H * 0.018;
    c.beginPath();
    if (p < 0) c.setLineDash([6 * k, 5 * k]);
    c.moveTo(-W * 0.16, y);
    c.lineTo(-W * 0.06, y);
    c.moveTo(W * 0.06, y);
    c.lineTo(W * 0.16, y);
    c.stroke();
    c.setLineDash([]);
    c.fillText(String(Math.abs(p)), W * 0.17, y + 4 * k);
  }
  c.restore();

  // flight path marker, heading, speed / altitude boxes, weapon block
  c.strokeStyle = C.hud;
  c.fillStyle = C.hud;
  c.lineWidth = 1.8 * k;
  c.beginPath();
  c.arc(cx, cy, 8 * k, 0, Math.PI * 2);
  c.moveTo(cx - 8 * k, cy);
  c.lineTo(cx - 22 * k, cy);
  c.moveTo(cx + 8 * k, cy);
  c.lineTo(cx + 22 * k, cy);
  c.moveTo(cx, cy - 8 * k);
  c.lineTo(cx, cy - 16 * k);
  c.stroke();
  c.font = font(12);
  c.textAlign = 'center';
  const hd = 274 + Math.sin(t * 0.3) * 3;
  for (let i = -3; i <= 3; i++) {
    const x = cx + i * 48 * k - ((hd % 10) / 10) * 48 * k;
    c.beginPath();
    c.moveTo(x, H * 0.2);
    c.lineTo(x, H * 0.2 + 8 * k);
    c.stroke();
  }
  c.fillText(String(Math.round(hd)).padStart(3, '0'), cx, H * 0.2 + 24 * k);
  const spd = id === 'stall' ? 118 : id === 'speed' ? 135 : 452;
  const alt = id === 'altitude' ? Math.max(90, 480 - (t % 6) * 70) : id === 'pullup' ? Math.max(60, 900 - (t % 4) * 200) : 12500;
  c.font = font(15, true);
  c.textAlign = 'left';
  c.strokeRect(W * 0.12, cy - 14 * k, 70 * k, 26 * k);
  c.fillText(String(spd), W * 0.12 + 10 * k, cy + 6 * k);
  c.strokeRect(W * 0.78, cy - 14 * k, 84 * k, 26 * k);
  c.fillText(String(Math.round(alt)), W * 0.78 + 10 * k, cy + 6 * k);
  c.font = font(11);
  c.fillText('KT', W * 0.12, cy + 30 * k);
  c.fillText('FT', W * 0.78, cy + 30 * k);
  const g = id === 'overg' ? 9.3 + Math.sin(t * 3) * 0.3 : 1 + Math.abs(Math.sin(t * 0.5)) * 0.4;
  c.fillStyle = id === 'overg' ? C.red : C.hud;
  c.fillText(`${g.toFixed(1)} G`, W * 0.12, cy + 52 * k);
  c.fillStyle = C.hud;
  c.font = font(12, true);
  c.fillText('A-A', W * 0.04, H * 0.78);
  c.fillText('AMRAAM 4', W * 0.04, H * 0.78 + 17 * k);
  c.fillStyle = id === 'cmlow' ? C.warn : C.hud;
  c.fillText(id === 'cmlow' ? 'FL 3  CH 4' : 'FL 24  CH 24', W * 0.04, H * 0.78 + 34 * k);
  c.fillStyle = id === 'fuel' ? C.warn : C.hud;
  c.fillText(id === 'fuel' ? 'FUEL 14%' : 'FUEL 62%', W * 0.78, H * 0.78 + 34 * k);

  const ea = W * 0.44;
  const eb = H * 0.4;
  const sym = (s: string, deg: number, state: SymState) => {
    const a = ((deg - 90) * Math.PI) / 180;
    const x = cx + Math.cos(a) * ea;
    const y = cy + Math.sin(a) * eb;
    c.save();
    c.font = font(14, true);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    if (state === 'search') {
      c.globalAlpha = 0.5;
      c.fillStyle = C.hud;
      c.fillText(s, x, y);
    } else if (state === 'track') {
      c.strokeStyle = C.warn;
      c.fillStyle = C.warn;
      c.lineWidth = 2 * k;
      c.beginPath();
      c.moveTo(x, y - 17 * k);
      c.lineTo(x + 17 * k, y);
      c.lineTo(x, y + 17 * k);
      c.lineTo(x - 17 * k, y);
      c.closePath();
      c.stroke();
      c.fillText(s, x, y + 1);
    } else if (blink(3)) {
      c.strokeStyle = C.red;
      c.fillStyle = C.red;
      c.lineWidth = 2.4 * k;
      c.beginPath();
      c.arc(x, y, 17 * k, 0, Math.PI * 2);
      c.stroke();
      c.fillText(s, x, y + 1);
    }
    c.strokeStyle = state === 'search' ? 'rgba(70,255,120,.5)' : state === 'launch' ? C.red : C.warn;
    c.lineWidth = 1.6 * k;
    c.beginPath();
    c.moveTo(x + Math.cos(a) * 19 * k, y + Math.sin(a) * 19 * k);
    c.lineTo(x + Math.cos(a) * 24 * k, y + Math.sin(a) * 24 * k);
    c.stroke();
    c.restore();
  };
  const row1 = (txt: string, col: string, bl: boolean, big = false, box = false) => {
    if (bl && !blink(2)) return;
    c.save();
    c.font = font(big ? 44 : 20, true);
    c.textAlign = 'center';
    c.fillStyle = col;
    const y = big ? cy - H * 0.18 : H * 0.09;
    if (box) {
      const w = c.measureText(txt).width + 24 * k;
      c.strokeStyle = col;
      c.lineWidth = 2 * k;
      c.strokeRect(cx - w / 2, y - 20 * k, w, 28 * k);
    }
    c.fillText(txt, cx, y);
    c.restore();
  };
  const chips = (list: Chip[]) => {
    c.save();
    c.font = font(13, true);
    c.textBaseline = 'middle';
    const ws = list.map((l) => c.measureText(l.t).width + (l.arrow !== undefined ? 34 : 20) * k);
    const tot = ws.reduce((a, b) => a + b, 0) + (list.length - 1) * 8 * k;
    let x = cx - tot / 2;
    const y = H * 0.145;
    list.forEach((l, i) => {
      if (!(l.blink && !blink(3))) {
        c.fillStyle = l.c;
        c.fillRect(x, y - 11 * k, ws[i], 22 * k);
        c.fillStyle = l.c === C.warn ? '#1d1400' : '#fff';
        c.fillText(l.t, x + 10 * k, y + 1);
        if (l.arrow !== undefined) {
          c.save();
          c.translate(x + ws[i] - 14 * k, y);
          c.rotate((l.arrow * Math.PI) / 180);
          c.beginPath();
          c.moveTo(0, -7 * k);
          c.lineTo(5 * k, 3 * k);
          c.lineTo(-5 * k, 3 * k);
          c.closePath();
          c.fill();
          c.restore();
        }
      }
      x += ws[i] + 8 * k;
    });
    c.restore();
  };
  const caption = (txt: string) => {
    c.save();
    c.font = font(12);
    c.textAlign = 'center';
    const tw = c.measureText(txt).width + 16 * k;
    c.fillStyle = 'rgba(3,7,11,.72)';
    c.fillRect(cx - tw / 2, H * 0.96 - 15 * k, tw, 21 * k);
    c.fillStyle = 'rgba(219,232,242,.9)';
    c.fillText(txt, cx, H * 0.96);
    c.restore();
  };
  const ring = (tti: number, ir: boolean, bear: number) => {
    c.save();
    const R = 46 * k;
    c.strokeStyle = C.red;
    c.lineWidth = 2.2 * k;
    c.setLineDash([8 * k, 6 * k]);
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    const a = ((bear - 90) * Math.PI) / 180;
    const col = ir ? C.ir : C.red;
    c.fillStyle = col;
    c.strokeStyle = col;
    c.translate(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    c.rotate(a + Math.PI / 2);
    c.beginPath();
    c.moveTo(0, -14 * k);
    c.lineTo(8 * k, 2 * k);
    c.lineTo(-8 * k, 2 * k);
    c.closePath();
    c.fill();
    const n = tti < 4 ? 3 : tti < 9 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      c.beginPath();
      c.moveTo(-7 * k, 10 * k + i * 7 * k);
      c.lineTo(0, 5 * k + i * 7 * k);
      c.lineTo(7 * k, 10 * k + i * 7 * k);
      c.stroke();
    }
    c.restore();
    c.save();
    c.font = font(13, true);
    c.fillStyle = C.red;
    c.textAlign = 'center';
    c.fillText(`${Math.ceil(tti)}s`, cx, cy + R + 20 * k);
    c.restore();
  };

  if (['spike', 'mud', 'launch', 'missile', 'silent', 'defeated'].includes(id)) sym('29', -150, 'search');
  switch (id) {
    case 'spike':
      sym('29', 48, 'track');
      chips([{ t: 'SPIKE 29', c: C.warn, arrow: 48 }]);
      caption('Fighter radar locked on, front right');
      break;
    case 'mud':
      sym('6', -38, 'track');
      chips([{ t: 'MUD SPIKE 6', c: C.warn, arrow: -38 }]);
      caption('SAM radar tracking you, front left');
      break;
    case 'launch':
      sym('15', 22, 'launch');
      chips([{ t: 'MUD SPIKE 15', c: C.red, arrow: 22, blink: true }]);
      caption('DARKSTAR: “SAM launch, SAM launch!”');
      break;
    case 'missile': {
      const tti = 9 - (t % 9);
      row1(`MISSILE  ${Math.ceil(tti)}s`, C.red, tti < 5);
      ring(tti, false, 140);
      sym('35', 140, 'launch');
      chips([{ t: 'SPIKE 35', c: C.red, arrow: 140, blink: true }]);
      caption('Radar missile from behind right');
      break;
    }
    case 'defeated': {
      const tt = t % 5;
      if (tt < 3) {
        const tti = 6 - tt * 1.6;
        row1(`MISSILE  ${Math.ceil(tti)}s`, C.red, false);
        ring(tti, true, -120);
      } else {
        row1('MISSILE DEFEATED', C.good, false, false, true);
      }
      caption(tt < 3 ? 'Heat-seeker (orange arrow). Flares out, breaking…' : 'Missile defeated');
      break;
    }
    case 'silent': {
      const tt = t % 7;
      sym('35', 30, 'search');
      if (tt < 3.5) caption('Fighter missile in midcourse: no warning at all');
      else {
        sym('M', 30, 'launch');
        const tti = Math.max(1, 6 - (tt - 3.5) * 1.4);
        row1(`MISSILE  ${Math.ceil(tti)}s`, C.red, false);
        ring(tti, false, 30);
        caption('Its seeker switches on 8 km out. Now you know.');
      }
      break;
    }
    case 'pullup':
      if (blink(2)) {
        c.save();
        c.strokeStyle = C.red;
        c.lineWidth = 5 * k;
        c.beginPath();
        c.moveTo(cx - 120 * k, cy - 80 * k);
        c.lineTo(cx + 120 * k, cy + 80 * k);
        c.moveTo(cx + 120 * k, cy - 80 * k);
        c.lineTo(cx - 120 * k, cy + 80 * k);
        c.stroke();
        c.restore();
      }
      row1('PULL UP', C.red, true, true);
      break;
    case 'gcas': {
      const p = (t % 2.5) / 2.5;
      const off = (1 - p) * 120 * k + 14 * k;
      c.save();
      c.strokeStyle = C.warn;
      c.lineWidth = 2.4 * k;
      for (const s of [-1, 1]) {
        c.beginPath();
        c.moveTo(cx + s * off, cy - 14 * k);
        c.lineTo(cx + s * (off - 14 * k), cy);
        c.lineTo(cx + s * off, cy + 14 * k);
        c.stroke();
      }
      c.restore();
      row1('AUTO GCAS', C.warn, false);
      caption('Fly-up in progress. Hands off.');
      break;
    }
    case 'altitude':
      row1('ALTITUDE', C.red, false);
      break;
    case 'stall':
      row1('STALL', C.red, true);
      break;
    case 'speed':
      row1(Math.floor(t / 3) % 2 ? 'AOA' : 'SPEED', C.warn, true);
      break;
    case 'overg':
      row1('OVER-G', C.red, false);
      break;
    case 'fuel':
      chips([{ t: 'BINGO', c: C.warn }, { t: 'FUEL LOW', c: C.warn }]);
      break;
    case 'damage':
      row1('ENGINE FIRE', C.red, false);
      chips([{ t: 'DAMAGE', c: C.warn }, { t: 'HYDRAULICS', c: C.warn }]);
      c.save();
      c.font = font(12, true);
      c.fillStyle = C.warn;
      c.fillText('AIRFRAME 42%  ENG HYD FIRE', W * 0.78 - 60 * k, H * 0.78);
      c.restore();
      break;
    case 'cmlow':
      chips([{ t: 'FLARES LOW', c: 'rgba(242,255,246,.18)' }, { t: 'CHAFF LOW', c: 'rgba(242,255,246,.18)' }]);
      break;
    case 'lock': {
      const p = Math.min(1, (t % 4) / 1.5);
      const bx = cx + 60 * k * (1 - p) + 30 * k;
      const by = cy - 60 * k;
      c.save();
      c.strokeStyle = C.hud;
      c.lineWidth = 2 * k;
      c.strokeRect(bx - 14 * k, by - 14 * k, 28 * k, 28 * k);
      c.beginPath();
      c.arc(bx, by, 26 * k, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      c.stroke();
      c.font = font(13, true);
      c.fillStyle = C.hud;
      c.textAlign = 'center';
      c.fillText(p < 1 ? 'LOCKING' : 'LOCK', bx, by + 46 * k);
      c.restore();
      break;
    }
    case 'cues': {
      const seq = ['SHOOT', 'IN RANGE', 'REL 3', 'REL 2', 'REL 1', 'BOMB AWAY', 'CCIP', 'PICKLE'];
      const s = seq[Math.floor(t / 1.1) % seq.length];
      c.save();
      c.font = font(18, true);
      c.fillStyle = C.hud;
      c.textAlign = 'center';
      if (s !== 'SHOOT' || blink(2)) c.fillText(s, cx, cy + H * 0.2);
      c.restore();
      break;
    }
    case 'denied': {
      const seq = ['NO LOCK', 'OUT OF RANGE', 'MIN RANGE', 'NO SEEKER', 'NO TARGET', 'WINCHESTER'];
      if (blink(2)) {
        c.save();
        c.font = font(13, true);
        c.fillStyle = C.warn;
        c.fillText(seq[Math.floor(t / 1.8) % seq.length], W * 0.04, H * 0.78 - 18 * k);
        c.restore();
      }
      break;
    }
    case 'overshoot': {
      const r = 34 * k + Math.sin(t * 2) * 4 * k;
      c.save();
      c.strokeStyle = C.hud;
      c.lineWidth = 2 * k;
      c.strokeRect(cx - r, cy - 90 * k - r / 2, r * 2, r);
      c.font = font(18, true);
      c.fillStyle = C.warn;
      c.textAlign = 'center';
      c.fillText('OVERSHOOT', cx, cy + H * 0.2);
      c.restore();
      break;
    }
    case 'rwrsym':
      sym('6', -40, 'track');
      sym('15', 70, 'launch');
      sym('A', -80, 'search');
      sym('29', 160, 'track');
      sym('57', -130, 'search');
      sym('B', -170, 'search');
      sym('35', 30, 'search');
      caption('Dim: searching · Amber diamond: tracking you · Red circle: missile guided at you');
      break;
  }
}
