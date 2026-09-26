/**
 * F35-A — AI pilots. Public entry point: `createAiBrain(role, { skill, task?, seed? })`.
 *
 * Module map:
 *   index.ts                 factory (role → brain)
 *   skill.ts                 difficulty × spawn skill → reaction, g, aim, tactics knobs
 *   geom.ts                  allocation-free geometry (intercepts, aspect, CPA…)
 *   radio.ts                 rate-limited wingman radio calls
 *   pilot/Autopilot.ts       low-level flight controller (lift-vector steering, throttle PI)
 *   pilot/safety.ts          terrain / sea floor, recovery, stall, mid-air, map-edge protection
 *   pilot/formation.ts       formation slots and station keeping
 *   brain/Brain.ts           base class: tick, state label, countermeasure pulses, navigation
 *   brain/context.ts         per-tick context shared by the tactical helpers
 *   brain/awareness.ts       what the pilot knows (sensors, datalink/GCI, eyeballs, MAWS)
 *   brain/defense.ts         missile defence (notch, drag, flares/chaff, last-ditch break)
 *   brain/weapons.ts         shot doctrine, IR shots, gun tracking, missile support
 *   brain/bfm.ts             dogfight manoeuvring + energy / hard-deck rules
 *   brain/strike.ts          air-to-ground attack runs (friendly strike packages)
 *   brain/FighterBrain.ts    fighter / interceptor / CAP / escort / friendly wingman
 *   brain/BomberBrain.ts     bomber + AWACS
 *
 * aiState labels: PATROL ROUTE FORM ESCORT RTB EGRESS INTERCEPT BVR CRANK MERGE BFM GUNS
 * DEFENSIVE NOTCH EXTEND BUGOUT STRIKE (fighters); ROUTE FORM ATTACK JINK DEFENSIVE RTB PATROL
 * (bombers); ORBIT FLEE DEFENSIVE (AWACS); 'PULL UP' while the terrain recovery has control.
 *
 * AI controls aircraft only through `ac.input` (stick, throttle, triggers, flares, chaff) and
 * world.combat (designate / select / fire) — the same physics and release rules as the player.
 */
import type { AiBrain, CreateAiBrain } from '../sim/api';
import { FighterBrain, FIGHTER_CONFIGS } from './brain/FighterBrain';
import { AwacsBrain, BomberBrain } from './brain/BomberBrain';

export const createAiBrain: CreateAiBrain = (role, opts) => {
  const o = { skill: opts?.skill ?? 0.5, task: opts?.task, seed: opts?.seed };
  let brain: AiBrain;
  switch (role) {
    case 'bomber':
      brain = new BomberBrain(o);
      break;
    case 'awacs':
      brain = new AwacsBrain(o);
      break;
    case 'fighter':
    case 'interceptor':
    case 'cap':
    case 'escort':
    case 'wingman':
      brain = new FighterBrain(role, o, FIGHTER_CONFIGS[role]);
      break;
    default:
      brain = new FighterBrain('fighter', o, FIGHTER_CONFIGS.fighter);
  }
  return brain;
};

export { FighterBrain, FIGHTER_CONFIGS, ENGAGED_STATES } from './brain/FighterBrain';
export { BomberBrain, AwacsBrain } from './brain/BomberBrain';
export { Autopilot, gammaForAltitude, type FlightIntent } from './pilot/Autopilot';
export { FormationKeeper, SLOT_FINGERTIP, SLOT_FIGHTING_WING, SLOT_ESCORT, type FormationSlot } from './pilot/formation';
export { deriveSkill, type PilotSkill } from './skill';
