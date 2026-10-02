/**
 * F35-A — "DARKSTAR" AWACS controller: initial picture, pop-up groups, threat calls,
 * periodic picture updates and "picture clean", in BRAA or bullseye format.
 *
 *   "Viper 1, Darkstar, single group, two bandits, BRAA 045, 40 miles, angels 25, hot."
 *   "Viper 1, Darkstar, pop-up group, four Backfires, bullseye 030, 22 miles, angels 30, track southwest."
 */
import { FEET_PER_M, NM, RAD, wrapPi } from '../../core/math';
import type { AircraftEntity } from '../../sim/entities';
import { aircraftNoun, countWord, groupNoun } from './names';
import { aliveCount, type GroupRt, type MissionState } from './state';

export type Aspect = 'hot' | 'flanking' | 'beaming' | 'cold';

/** Three-digit bearing string, 0 = north, clockwise ("045", "360"→"360" never: 0 → "360"). */
export function bearingText(fromX: number, fromZ: number, toX: number, toZ: number): string {
  let deg = Math.round(Math.atan2(toX - fromX, -(toZ - fromZ)) * RAD);
  deg = ((deg % 360) + 360) % 360;
  if (deg === 0) deg = 360;
  return String(deg).padStart(3, '0');
}

/** Aspect of a group moving along heading `h` (rad) relative to a viewer. */
export function aspectOf(groupX: number, groupZ: number, heading: number, viewerX: number, viewerZ: number): Aspect {
  const toViewer = Math.atan2(viewerX - groupX, -(viewerZ - groupZ));
  const off = Math.abs(wrapPi(heading - toViewer)) * RAD;
  if (off <= 35) return 'hot';
  if (off <= 70) return 'flanking';
  if (off <= 115) return 'beaming';
  return 'cold';
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
/** 8-point compass word for a heading (rad). */
export function compassWord(heading: number): string {
  const deg = ((heading * RAD) % 360 + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

/** "angels 25" (thousands of feet), "angels 1" minimum. */
export function angels(altitudeM: number): string {
  return `angels ${Math.max(1, Math.round((altitudeM * FEET_PER_M) / 1000))}`;
}

export interface GroupPicture {
  count: number;
  x: number;
  z: number;
  altitude: number;
  heading: number;
  noun: string;
}

/** Centroid / count / mean heading of a group's live members (null if none alive). Pass `out` to reuse an object. */
export function groupPicture(g: GroupRt, out?: GroupPicture): GroupPicture | null {
  let n = 0;
  let x = 0;
  let z = 0;
  let y = 0;
  let vx = 0;
  let vz = 0;
  for (const m of g.members) {
    if (!m.alive) continue;
    n++;
    x += m.position.x;
    z += m.position.z;
    y += m.position.y;
    vx += m.velocity.x;
    vz += m.velocity.z;
  }
  if (n === 0) return null;
  const def = g.air;
  const type = def?.type ?? 'mig29';
  const pic = out ?? { count: 0, x: 0, z: 0, altitude: 0, heading: 0, noun: '' };
  pic.count = n;
  pic.x = x / n;
  pic.z = z / n;
  pic.altitude = y / n;
  pic.heading = Math.atan2(vx, -vz);
  pic.noun = def?.noun ? groupNoun(def.noun, n) : aircraftNoun(type, n);
  return pic;
}

/** Scratch picture for the per-evaluation threat checks. */
const _pic: GroupPicture = { count: 0, x: 0, z: 0, altitude: 0, heading: 0, noun: '' };

/** "two bandits, BRAA 045, 40 miles, angels 25, hot" relative to the player. */
export function braaText(pic: GroupPicture, player: AircraftEntity): string {
  const px = player.position.x;
  const pz = player.position.z;
  const range = Math.max(1, Math.round(Math.hypot(pic.x - px, pic.z - pz) / NM));
  const asp = aspectOf(pic.x, pic.z, pic.heading, px, pz);
  return `${countWord(pic.count)} ${pic.noun}, BRAA ${bearingText(px, pz, pic.x, pic.z)}, ${range} miles, ${angels(pic.altitude)}, ${asp}`;
}

/** "two bandits, bullseye 045, 22 miles, angels 25, track southwest". */
export function bullseyeText(pic: GroupPicture, bull: { x: number; z: number }): string {
  const range = Math.max(1, Math.round(Math.hypot(pic.x - bull.x, pic.z - bull.z) / NM));
  return `${countWord(pic.count)} ${pic.noun}, bullseye ${bearingText(bull.x, bull.z, pic.x, pic.z)}, ${range} miles, ${angels(pic.altitude)}, track ${compassWord(pic.heading)}`;
}

const THREAT_RANGE = 10 * NM;
const DEFAULT_BULLSEYE = { x: 0, z: 0, name: 'Tower' };

export class AwacsController {
  private lastPicture = -999;
  private initialDone = false;
  private cleanCalled = false;
  private sawAir = false;
  private readonly redAir: GroupRt[] = [];

  constructor(private readonly s: MissionState) {}

  private get cfg() {
    return this.s.script.awacs ?? {};
  }

  private describe(pic: GroupPicture): string {
    const cfg = this.cfg;
    const p = this.s.player;
    if (cfg.style === 'bullseye' || !p) return bullseyeText(pic, cfg.bullseye ?? DEFAULT_BULLSEYE);
    return braaText(pic, p);
  }

  private collect(): GroupRt[] {
    const out = this.redAir;
    out.length = 0;
    for (const g of this.s.groups.values()) {
      if (g.team !== 'red' || !g.air || g.spawnedAt < 0) continue;
      if (aliveCount(g) > 0) out.push(g);
    }
    return out;
  }

  /** Full picture call ("new picture, two groups" + one line per group). */
  callPicture(initial = false): void {
    const s = this.s;
    const groups = this.collect();
    this.lastPicture = s.time;
    const who = `${s.callsign}, ${s.awacsSpoken}`;
    if (groups.length === 0) {
      if (initial) s.radio.push({ from: s.awacsCallsign, text: `${who}, picture clean.`, priority: 1 });
      return;
    }
    for (const g of groups) g.announced = true;
    if (groups.length === 1) {
      const pic = groupPicture(groups[0])!;
      s.radio.push({ from: s.awacsCallsign, text: `${who}, single group, ${this.describe(pic)}.`, voice: 'a_bandits', priority: 2 });
      return;
    }
    s.radio.push({ from: s.awacsCallsign, text: `${who}, new picture, ${countWord(groups.length)} groups.`, voice: 'a_new_picture', priority: 2 });
    // nearest first
    const p = s.player;
    const pics = groups.map((g) => groupPicture(g)!).filter(Boolean);
    if (p) pics.sort((a, b) => Math.hypot(a.x - p.position.x, a.z - p.position.z) - Math.hypot(b.x - p.position.x, b.z - p.position.z));
    const labels = ['Lead group', 'Trail group', 'Third group', 'Fourth group'];
    pics.slice(0, 4).forEach((pic, i) => {
      s.radio.push({ from: s.awacsCallsign, text: `${labels[i]}, ${this.describe(pic)}.`, priority: 1 });
    });
  }

  private nearestRange(groups: GroupRt[], p: AircraftEntity): number {
    let best = Infinity;
    for (const g of groups) {
      for (const m of g.members) {
        if (!m.alive) continue;
        const d = Math.hypot(m.position.x - p.position.x, m.position.z - p.position.z);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /** Called at the runner's evaluation rate. */
  update(): void {
    const s = this.s;
    const cfg = this.cfg;
    if (cfg.silent || s.state !== 'running') return;
    const t = s.time;
    const initialAt = cfg.initialPictureAt ?? 4;
    if (!this.initialDone && initialAt >= 0 && t >= initialAt) {
      this.initialDone = true;
      this.callPicture(true);
    }
    const groups = this.collect();
    if (groups.length > 0) this.sawAir = true;
    const p = s.player;

    for (const g of groups) {
      // pop-up groups spawned after the initial picture
      if (!g.announced && this.initialDone && g.air?.announce !== false) {
        g.announced = true;
        const pic = groupPicture(g);
        if (pic) s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}, pop-up group, ${this.describe(pic)}.`, voice: 'a_bandits', priority: 2 });
        this.lastPicture = t;
      }
      // threat call: hot group inside 10 nm
      if (!g.threatCalled && p && p.alive) {
        const pic = groupPicture(g, _pic);
        if (pic && Math.hypot(pic.x - p.position.x, pic.z - p.position.z) < THREAT_RANGE && aspectOf(pic.x, pic.z, pic.heading, p.position.x, p.position.z) === 'hot') {
          g.threatCalled = true;
          s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, threat, ${braaText(pic, p)}!`, voice: 'a_bandits', priority: 2 });
          this.lastPicture = t;
        }
      }
    }

    const interval = cfg.pictureInterval ?? 100;
    if (interval > 0 && groups.length > 0 && this.initialDone && t - this.lastPicture >= interval) {
      // no picture calls in the middle of a merge: the pilot is busy and the threat call covers it
      if (p && this.nearestRange(groups, p) < THREAT_RANGE) this.lastPicture = t - interval * 0.5;
      else this.callPicture();
    }

    if (this.sawAir && groups.length === 0 && s.pendingAir.every((g) => g.team !== 'red') && !this.cleanCalled && !s.script.survival) {
      this.cleanCalled = true;
      s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}, picture clean.`, priority: 1 });
    }
  }
}
