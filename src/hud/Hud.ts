/** STUB HUD — to be replaced by the HUD agent. Keeps export `createHud`. */
import type { CreateHud, HudApi } from '../core/contracts';
import { toFeet, toKnots } from '../core/math';

export const createHud: CreateHud = (canvas) => {
  const ctx2d = canvas.getContext('2d')!;
  let visible = true;
  let dpr = 1;
  const hud: HudApi = {
    update(ctx) {
      ctx2d.setTransform(1, 0, 0, 1, 0, 0);
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      if (!visible || !ctx.player) return;
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.fillStyle = '#3f3';
      ctx2d.font = '16px monospace';
      ctx2d.fillText(`SPD ${toKnots(ctx.player.flight.ias).toFixed(0)}  ALT ${toFeet(ctx.player.flight.altitude).toFixed(0)}`, 20, 30);
    },
    resize(w, h, d) { dpr = d; canvas.width = w * d; canvas.height = h * d; canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; },
    setVisible(v) { visible = v; },
    pick() { return null; },
    dispose() {},
  };
  return hud;
};
