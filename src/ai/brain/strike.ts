/**
 * F35-A — air-to-ground strike for AI jets carrying A/G stores (friendly F-35 strike packages
 * on a mission 'attack' task against a SAM site / ground target).
 *
 *  STRIKE   fly to the target at strike altitude, pick the best weapon (AARGM vs an emitting
 *           radar, SDB / JDAM otherwise), release through combat.fire when launchZoneFor says
 *           the GPS/ARM envelope is met — same release rules as the player. GPS bombs are not
 *           released zoom-climbing or from steeper than ~45°: too close, the jet extends away
 *           and comes round for another run
 *  EGRESS   weapons gone or target destroyed: the brain heads home
 */
import { Vector3 } from 'three';
import type { WeaponId } from '../../core/types';
import type { AnyEntity } from '../../sim/entities';
import { gammaForAltitude } from '../pilot/Autopilot';
import { dirWithElevation } from '../geom';
import type { TickCtx } from './context';

const AG: readonly Exclude<WeaponId, 'gun' | 'aim120' | 'aim9x'>[] = ['aargm', 'gbu39', 'gbu31'];
const _h = new Vector3();
/** Steepest GPS-bomb release: height / horizontal range (tan ≈ 45°). */
const STEEP_SLOPE = 1.1;

export class StrikePlanner {
  private lastRelease = -99;
  private zoneTime = -99;
  private shoot = false;
  private zoneWeapon: WeaponId | null = null;
  /** Releases made against the current target. */
  released = 0;
  private targetId = -1;
  /** Too close for the height: flying away from the target to come round again. */
  private extending = false;

  /** Best A/G weapon for this target (null = none left / none suitable). */
  weaponFor(c: TickCtx, t: AnyEntity): Exclude<WeaponId, 'gun'> | null {
    const { ac, world } = c;
    for (const w of AG) {
      if (world.combat.remaining(ac, w) <= 0) continue;
      if (w === 'aargm' && !((t.kind === 'sam' && (t.radarOn || t.known)) || (t.kind === 'ground' && t.emitter))) continue;
      return w;
    }
    return null;
  }

  /** Any A/G stores at all? */
  hasStores(c: TickCtx): boolean {
    for (const w of AG) if (c.world.combat.remaining(c.ac, w) > 0) return true;
    return false;
  }

  /**
   * Fly the attack on `t`. Returns 'STRIKE' while attacking, or null when done (weapon gone,
   * target dead, or enough bombs on it) — the caller then egresses.
   */
  run(c: TickCtx, t: AnyEntity): string | null {
    const { ac, world, it, now } = c;
    if (t.id !== this.targetId) {
      this.targetId = t.id;
      this.released = 0;
      this.extending = false;
    }
    if (!t.alive || this.released >= 2) return null;
    const weapon = this.weaponFor(c, t);
    if (!weapon) return null;
    if (ac.selectedWeapon !== weapon) world.combat.selectWeapon(ac, weapon, world);
    if (ac.radar.designatedId !== t.id) world.combat.designate(ac, t.id, world);

    // run in at strike altitude (GPS glide weapons like height and speed)
    const ground = t.position.y;
    const alt = Math.max(ac.position.y, ground + 4_000);
    _h.set(t.position.x - ac.position.x, 0, t.position.z - ac.position.z);
    const horiz = _h.length();
    // a GPS bomb can't be dropped onto a target below a ~45° depression (it sails long): too close
    // for the height, extend away and come round for another run
    const steepRange = (ac.position.y - ground) / STEEP_SLOPE;
    if (weapon !== 'aargm') {
      if (!this.extending && horiz < steepRange) this.extending = true;
      else if (this.extending && horiz > Math.max(steepRange * 1.8, 6_000)) this.extending = false;
    } else this.extending = false;
    if (this.extending) _h.negate();
    dirWithElevation(_h, gammaForAltitude(ac, Math.min(alt, ground + 7_000), 0.2, 8), it.dir);
    it.speed = 270;
    it.allowAb = false;
    it.gMax = Math.min(4, c.skill.maxG);
    it.gain = 0.9;

    if (now - this.zoneTime > 0.5 || this.zoneWeapon !== weapon) {
      this.zoneTime = now;
      this.zoneWeapon = weapon;
      const z = world.combat.launchZoneFor(ac, weapon, t, world);
      // don't toss from the very edge of the envelope — unless that leaves no window before the
      // run-in gets too steep for a GPS bomb
      const edge = weapon === 'aargm' ? z.rMax * 0.85 : Math.min(z.rMax, Math.max(z.rMax * 0.85, steepRange + 800));
      this.shoot = z.shoot && z.range < Math.max(edge, 1);
    }
    // no release while still zooming up to strike altitude (a bomb tossed upwards close in can't
    // pull back down), nor once the run-in is too steep or turned away
    const zooming = ac.velocity.y > 0.1 * ac.velocity.length();
    const steep = weapon !== 'aargm' && (this.extending || horiz < steepRange);
    if (this.shoot && !zooming && !steep && now - this.lastRelease > 1.5) {
      const m = world.combat.fire(ac, world, weapon, t.id);
      if (m) {
        this.lastRelease = now;
        this.released++;
        this.shoot = false;
      }
    }
    return 'STRIKE';
  }
}
