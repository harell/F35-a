/**
 * F35-A — enemy fighters that bug out (Winchester, damaged, bingo) or run home to their RTB orbit
 * are "driven off": they count as defeated for 'destroy' objectives (reduced bonus) so a mission
 * never stalls on a MiG hiding at home.
 *
 *  - a hostile fighter / interceptor / CAP / escort whose AI state is BUGOUT / RTB / EGRESS is
 *    "withdrawing"; DARKSTAR calls it once ("bandit bugging out … splash him for the bonus");
 *  - it is credited as driven off after WITHDRAW_CREDIT s of continuous withdrawal, or at once
 *    when it is WITHDRAW_RANGE away from the player or outside the AO;
 *  - a fighter out of missiles for WINCHESTER_CREDIT s (hostile pilots keep fighting with the
 *    gun rather than go home) is credited too: it is no longer a threat to the city or the package,
 *    and a gun-only bandit that refuses to die can never stall an objective;
 *  - a fighter that has already fought the player (came inside ENGAGE_RANGE, or had a player
 *    missile fired at it) and then keeps beyond DISENGAGE_RANGE for DISENGAGE_CREDIT s — running
 *    a stern chase the player can't win — is credited too;
 *  - a strike jet on a ground-attack task with bombs left is never withdrawing: its EGRESS between
 *    passes sets up the next run (a Defend raid used to be "driven off" after its first pass when
 *    the player parked 25 km away, winning with no shot fired);
 *  - none of this credits anything until the player has joined the air fight (an air-to-air launch or
 *    a gun kill): a player holding over the start while bandits spent their missiles on someone else
 *    and went home used to win c02 with no shot fired (playtest 2026-10-02 bc94edd, 1.3-b);
 *  - the credit sticks (it may still be shot down for the full bonus);
 *  - when one live bandit is left on an active primary 'destroy' objective, DARKSTAR gives a
 *    BRAA call on it every LAST_BANDIT_INTERVAL s so the player can find it.
 */
import { WEAPON_INFO } from '../../core/data';
import type { AircraftEntity } from '../../sim/entities';
import { braaText, type GroupPicture } from './awacs';
import { aircraftHudName, aircraftNoun } from './names';
import type { MissionState } from './state';

export const WITHDRAW_CREDIT = 45;
export const WITHDRAW_RANGE = 25_000;
export const WINCHESTER_CREDIT = 90;
export const ENGAGE_RANGE = 12_000;
export const DISENGAGE_RANGE = 15_000;
export const DISENGAGE_CREDIT = 120;
const LAST_BANDIT_INTERVAL = 60;
const FIGHTER_ROLES = new Set(['fighter', 'interceptor', 'cap', 'escort']);
const WITHDRAW_STATES = new Set(['BUGOUT', 'RTB', 'EGRESS']);
const DEFAULT_AO = 38_000;

const _pic: GroupPicture = { count: 1, x: 0, z: 0, altitude: 0, heading: 0, noun: '' };

function pictureOf(ac: AircraftEntity): GroupPicture {
  _pic.count = 1;
  _pic.x = ac.position.x;
  _pic.z = ac.position.z;
  _pic.altitude = ac.position.y;
  _pic.heading = Math.atan2(ac.velocity.x, -ac.velocity.z);
  _pic.noun = aircraftNoun(ac.type, 1);
  return _pic;
}

export class WithdrawalMonitor {
  private lastCall = -999;
  private lastBraa = -999;
  /** Sim time each hostile fighter was first seen with no missiles left. */
  private readonly winchesterSince = new Map<number, number>();
  /** Hostile fighters that have fought the player (came close / were shot at). */
  private readonly engaged = new Set<number>();
  /** Sim time an engaged fighter last came back inside DISENGAGE_RANGE (keeps away since then). */
  private readonly farSince = new Map<number, number>();

  constructor(private readonly s: MissionState) {}

  /** Is this aircraft eligible to be driven off (hostile fighter-type AI)? */
  private eligible(ac: AircraftEntity): boolean {
    const s = this.s;
    const g = ac.groupId ? s.groups.get(ac.groupId) : undefined;
    if (!g || !g.air || g.team === 'blue' || !s.player || ac.team === s.player.team) return false;
    // one-way drones fly their route to the end, whatever role the group names
    if (g.air.oneWay) return false;
    return FIGHTER_ROLES.has(g.air.role);
  }

  update(): void {
    const s = this.s;
    const p = s.player;
    if (s.state !== 'running' || !p) return;
    const t = s.time;
    const half = s.script.aoHalfSize ?? DEFAULT_AO;
    for (const ac of s.world.aircraft) {
      if (!ac.alive || s.withdrawn.has(ac.id) || !this.eligible(ac)) continue;
      if (this.onStrike(ac)) {
        s.withdrawSince.delete(ac.id);
        continue;
      }
      // out of missiles (gun only) for a long time: no longer a threat worth an objective
      let missiles = 0;
      for (const st of ac.stores) missiles += st.count;
      if (missiles === 0 && ac.stores.length > 0) {
        const w0 = this.winchesterSince.get(ac.id) ?? t;
        this.winchesterSince.set(ac.id, w0);
        if (t - w0 >= WINCHESTER_CREDIT) {
          this.credit(ac, true);
          continue;
        }
      }
      // fought the player, then keeps its distance for a long time: out of the fight
      const range0 = p.alive ? Math.hypot(ac.position.x - p.position.x, ac.position.z - p.position.z) : 0;
      if (range0 < ENGAGE_RANGE || this.shotAtByPlayer(ac.id)) this.engaged.add(ac.id);
      if (this.engaged.has(ac.id) && p.alive) {
        if (range0 < DISENGAGE_RANGE || this.fightingFriendly(ac)) this.farSince.delete(ac.id);
        else {
          const f0 = this.farSince.get(ac.id) ?? t;
          this.farSince.set(ac.id, f0);
          if (t - f0 >= DISENGAGE_CREDIT) {
            this.credit(ac);
            continue;
          }
        }
      }
      if (!WITHDRAW_STATES.has(ac.aiState)) {
        s.withdrawSince.delete(ac.id);
        continue;
      }
      let since = s.withdrawSince.get(ac.id);
      if (since === undefined) {
        since = t;
        s.withdrawSince.set(ac.id, t);
        this.callBugout(ac);
      }
      const range = p.alive ? Math.hypot(ac.position.x - p.position.x, ac.position.z - p.position.z) : Infinity;
      const outside = Math.abs(ac.position.x) > half || Math.abs(ac.position.z) > half;
      if (t - since >= WITHDRAW_CREDIT || range >= WITHDRAW_RANGE || outside) this.credit(ac);
    }
    this.lastBanditCall();
  }

  /** On a ground-attack task with bombs or missiles for it left: between passes, not running away. */
  private onStrike(ac: AircraftEntity): boolean {
    const g = ac.groupId ? this.s.groups.get(ac.groupId) : undefined;
    if (g?.task?.kind !== 'attack_group') return false;
    for (const st of ac.stores) if (st.count > 0 && WEAPON_INFO[st.weapon].kind !== 'aam') return true;
    return false;
  }

  /** A friendly (non-player) jet is within ENGAGE_RANGE of it: it is still in someone's fight. */
  private fightingFriendly(ac: AircraftEntity): boolean {
    const p = this.s.player!;
    for (const b of this.s.world.aircraft) {
      if (!b.alive || b === p || b.team !== p.team) continue;
      // an unarmed friendly (transport, Winchester jet going home) isn't a fight
      let armed = b.gunAmmo > 0;
      for (const st of b.stores) if (st.count > 0) armed = true;
      if (!armed) continue;
      if (Math.hypot(b.position.x - ac.position.x, b.position.z - ac.position.z) < ENGAGE_RANGE) return true;
    }
    return false;
  }

  /** A player missile is (or was just) flying at this aircraft. */
  private shotAtByPlayer(id: number): boolean {
    const p = this.s.player;
    if (!p) return false;
    for (const m of this.s.world.missiles) if (m.alive && m.shooterId === p.id && m.targetId === id) return true;
    return false;
  }

  private callBugout(ac: AircraftEntity): void {
    const s = this.s;
    const p = s.player;
    if (!p || !p.alive || s.time - this.lastCall < 15) return;
    this.lastCall = s.time;
    s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}, ${braaText(pictureOf(ac), p)} — bugging out. Splash him for the bonus.`, priority: 2 });
  }

  private credit(ac: AircraftEntity, winchester = false): void {
    const s = this.s;
    if (s.stats.aamShots === 0 && s.stats.gunKills === 0) return; // the player hasn't joined the fight
    s.withdrawn.add(ac.id);
    s.withdrawSince.delete(ac.id);
    this.winchesterSince.delete(ac.id);
    this.farSince.delete(ac.id);
    s.stats.drivenOff++;
    const name = aircraftHudName(ac.type);
    s.hud(winchester ? `${name} WINCHESTER — NO LONGER A THREAT` : `${name} DRIVEN OFF`, 'info', 2.5);
    s.radio.push({
      from: s.awacsCallsign,
      text: winchester
        ? `${s.callsign}, ${s.awacsSpoken}. That ${name} is out of missiles — guns only, no threat to the city. Watch your six.`
        : `${s.callsign}, ${s.awacsSpoken}. That ${name} is out of the fight — running for home.`,
      priority: 2,
    });
  }

  /** BRAA on the last live bandit of an active primary air 'destroy' objective. */
  private lastBanditCall(): void {
    const s = this.s;
    const p = s.player;
    if (!p || !p.alive || s.time - this.lastBraa < LAST_BANDIT_INTERVAL) return;
    let last: AircraftEntity | null = null;
    let live = 0;
    for (const o of s.objectives) {
      if (o.status.state !== 'active' || !o.def.primary || o.def.kind !== 'destroy') continue;
      for (const id of o.def.groups) {
        const g = s.groups.get(id);
        if (!g || !g.air || g.members.length < g.expected) {
          if (g && g.air && g.members.length < g.expected) live += 99; // more to come
          continue;
        }
        for (const m of g.members) {
          if (!m.alive || m.kind !== 'aircraft' || s.withdrawn.has(m.id)) continue;
          live++;
          last = m;
        }
      }
    }
    if (live !== 1 || !last) return;
    // only when the player has lost it (not a live sensor track)
    for (const c of p.radar.contacts) if (c.id === last.id && c.source !== 'datalink' && c.lastSeen >= s.time - 3) return;
    this.lastBraa = s.time;
    s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}, last bandit: ${braaText(pictureOf(last), p)}.`, voice: 'a_bandits', priority: 2 });
  }
}
