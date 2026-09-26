/**
 * F35-A — air-to-ground strike for AI jets carrying A/G stores (friendly F-35 strike packages
 * on a mission 'attack' task against a SAM site / ground target).
 *
 *  STRIKE   fly to the target at strike altitude, pick the best weapon (AARGM vs an emitting
 *           radar, SDB / JDAM otherwise), release through combat.fire when launchZoneFor says
 *           the GPS/ARM envelope is met — same release rules as the player
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

export class StrikePlanner {
  private lastRelease = -99;
  private zoneTime = -99;
  private shoot = false;
  private zoneWeapon: WeaponId | null = null;
  /** Releases made against the current target. */
  released = 0;
  private targetId = -1;

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
    dirWithElevation(_h, gammaForAltitude(ac, Math.min(alt, ground + 7_000), 0.2, 8), it.dir);
    it.speed = 270;
    it.allowAb = false;
    it.gMax = Math.min(4, c.skill.maxG);
    it.gain = 0.9;

    if (now - this.zoneTime > 0.5 || this.zoneWeapon !== weapon) {
      this.zoneTime = now;
      this.zoneWeapon = weapon;
      const z = world.combat.launchZoneFor(ac, weapon, t, world);
      // don't toss from the very edge of the envelope
      this.shoot = z.shoot && z.range < Math.max(z.rMax * 0.85, 1);
    }
    if (this.shoot && now - this.lastRelease > 1.5) {
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
