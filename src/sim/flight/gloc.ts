/**
 * F35-A — pilot g tolerance and G-LOC (g-induced loss of consciousness). SIM-CORE.
 *
 * Modelled for the human player on a difficulty without convenience assists (DifficultyParams.flightAssist
 * false; none today, since Ace was removed): the jet's
 * FBW still limits it to 9 g, but the pilot is now the weak link. A trained pilot with a g-suit,
 * pressure breathing and the anti-g straining manoeuvre tolerates ~9 g for 10–15 s. The model
 * accumulates a "g stress" S above ONSET_G:
 *     dS/dt = ((n − ONSET_G) / SPAN_G)^1.5 / TOL_TIME     9 g → G-LOC after ≈ 11 s,
 *                                                         8 g ≈ 18 s, 7 g ≈ 40 s, 6 g never
 * and recovers below RECOVER_G (1/RECOVER_TIME per second). At S ≥ 1 the pilot blacks out for
 * GLOC_TIME s (absolute incapacitation: the stick goes neutral, so the FBW unloads to ~1 g and
 * nothing keeps the jet off the ground: Auto-GCAS is a Recruit assist), then regains
 * the stick over RECOVERY_TIME s (relative incapacitation: authority ramps back up).
 *
 * Published as `ac.gloc` (0..1 g stress, exactly 1 while unconscious) for the HUD / camera; the
 * onset emits a 'hud:message' "G-LOC".
 */
import type { AircraftEntity } from '../entities';
import type { FlightEnv } from './env';
import type { AircraftSimState } from './state';

export const GLOC = {
  onsetG: 5.5,
  spanG: 3.5,
  /** Seconds at the full 9 g (ONSET + SPAN) to lose consciousness. */
  tolTime: 11,
  recoverG: 4.5,
  /** Seconds to shed a full g stress below RECOVER_G. */
  recoverTime: 8,
  /** Absolute incapacitation (s). */
  glocTime: 5,
  /** Stick authority ramps back over this time after waking up (s). */
  recoveryTime: 3,
  /** Stress left after waking up (a second G-LOC comes quicker). */
  residual: 0.45,
} as const;

/** Does this aircraft's pilot suffer G-LOC? (human player on the no-assist difficulty) */
export function glocModelled(ac: AircraftEntity, env: FlightEnv): boolean {
  return ac.isPlayer && !ac.ai && !env.difficulty.flightAssist;
}

/**
 * Advance the pilot's g tolerance by dt (once per world step, from the previous step's load
 * factor) and set `st.pilotAuthority` (0..1 multiplier on the stick).
 */
export function updateGloc(ac: AircraftEntity, st: AircraftSimState, env: FlightEnv, dt: number): void {
  if (!ac.alive || !glocModelled(ac, env)) {
    st.gStress = 0;
    st.glocTimer = 0;
    st.glocActive = false;
    st.pilotAuthority = 1;
    if (ac.gloc !== undefined) ac.gloc = 0;
    return;
  }
  const n = ac.flight.gLoad;
  if (st.glocActive) {
    // unconscious, then slowly regaining control
    st.glocTimer -= dt;
    const awake = -st.glocTimer; // seconds since waking up (negative while still out)
    if (awake < 0) st.pilotAuthority = 0;
    else if (awake < GLOC.recoveryTime) st.pilotAuthority = awake / GLOC.recoveryTime;
    else {
      st.pilotAuthority = 1;
      st.glocTimer = 0;
      st.glocActive = false;
    }
    ac.gloc = awake < 0 ? 1 : Math.min(0.99, st.gStress);
    if (awake >= 0) st.gStress = Math.max(0, st.gStress - dt / GLOC.recoverTime);
    return;
  }
  if (n > GLOC.onsetG) {
    const x = Math.min(1.5, (n - GLOC.onsetG) / GLOC.spanG);
    st.gStress += (x * Math.sqrt(x) * dt) / GLOC.tolTime;
  } else if (n < GLOC.recoverG) {
    st.gStress = Math.max(0, st.gStress - dt / GLOC.recoverTime);
  }
  st.pilotAuthority = 1;
  if (st.gStress >= 1) {
    st.gStress = GLOC.residual;
    // the timer runs down through zero (waking up) to −recoveryTime (full control)
    st.glocTimer = GLOC.glocTime;
    st.glocActive = true;
    st.pilotAuthority = 0;
    ac.gloc = 1;
    env.events?.emit('hud:message', { text: 'G-LOC', duration: GLOC.glocTime, tone: 'bad' });
    return;
  }
  ac.gloc = st.gStress;
}
