/**
 * Test hooks (#118): where the HUD drew its key symbols last frame, recorded by the draw code itself
 * (no re-projection), for `__f35.state().hud`. Every call site is behind `if (TEST_HOOKS)`, so the
 * deployed game neither records nor ships any of this. Fixed slots: no allocation while drawing.
 */

/** A centre cue line (SHOOT, IN RANGE, STEER LEFT, FOX 3…): text centre and whether it showed (blink off = not drawn). */
export interface DrawnCue {
  text: string;
  x: number;
  y: number;
  drawn: boolean;
}

export const drawnLast = {
  /** HUD frame counter (HudState.frame) of the frame these were recorded in. */
  frame: -1,
  /** Gun LCOS pipper centre and ring radius (CSS px), when drawn this frame. */
  pipper: { drawn: false, x: 0, y: 0, r: 0 },
  /** EEGS range bar across the gun funnel at the target's range: its centre, the funnel's width there (CSS px; the bar is drawn at least 22 u long) and the range (m). */
  funnelBar: { drawn: false, x: 0, y: 0, len: 0, range: 0 },
  /**
   * The steering waypoint (mission steering cue): its label, whether its diamond was drawn and where
   * (centre), whether its name was printed beside it and where (text centre), and `next`: the fixed
   * NEXT line names it instead (Hud.ts sets it after drawWaypoint).
   */
  steer: { label: '', diamond: false, x: 0, y: 0, named: false, nameX: 0, nameY: 0, next: false },
  cues: Array.from({ length: 4 }, (): DrawnCue => ({ text: '', x: 0, y: 0, drawn: false })),
  cueCount: 0,
};

/** Start a frame: forget the last one's symbols (a symbol not drawn this frame reads as not drawn). */
export function beginDrawn(frame: number): void {
  drawnLast.frame = frame;
  drawnLast.pipper.drawn = false;
  drawnLast.funnelBar.drawn = false;
  drawnLast.steer.label = '';
  drawnLast.steer.diamond = false;
  drawnLast.steer.named = false;
  drawnLast.steer.next = false;
  drawnLast.cueCount = 0;
}

export function notePipper(x: number, y: number, r: number): void {
  const p = drawnLast.pipper;
  p.drawn = true;
  p.x = x;
  p.y = y;
  p.r = r;
}

export function noteFunnelBar(x: number, y: number, len: number, range: number): void {
  const b = drawnLast.funnelBar;
  b.drawn = true;
  b.x = x;
  b.y = y;
  b.len = len;
  b.range = range;
}

/** The steering waypoint this frame (label), before anything of it is drawn. */
export function noteSteer(label: string): void {
  drawnLast.steer.label = label;
}

export function noteSteerDiamond(x: number, y: number): void {
  const s = drawnLast.steer;
  s.diamond = true;
  s.x = x;
  s.y = y;
}

export function noteSteerName(x: number, y: number): void {
  const s = drawnLast.steer;
  s.named = true;
  s.nameX = x;
  s.nameY = y;
}

export function noteCue(text: string, x: number, y: number, drawn: boolean): void {
  if (drawnLast.cueCount >= drawnLast.cues.length) return;
  const c = drawnLast.cues[drawnLast.cueCount++];
  c.text = text;
  c.x = x;
  c.y = y;
  c.drawn = drawn;
}
