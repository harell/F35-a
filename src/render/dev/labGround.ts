/**
 * DEV ONLY — SAM site / ground target preview for the models lab (sam:<type>, gt:<type>,
 * gt:ship:container / gt:ship:cruise / gt:ship:tanker for the civil merchant ships).
 * Animates radars/launchers with fake entity state; &dead=1 shows the wreck (a ship sinks from t = 0;
 * &anchored=1 swings it at anchor).
 */
import { Group, Scene, Vector3 } from 'three';
import { GroundTargetEntity, SamSiteEntity } from '../../sim/entities';
import type { GroundTargetType, SamType, VesselClass } from '../../core/types';
import { getSamPrototype } from '../models/sams';
import { getGroundPrototype } from '../models/ground';
import { GroundVisual, SamVisual } from '../visuals/SiteVisuals';

export function buildLabGround(id: string, _scene: Scene, onUpdate: (fn: (t: number, dt: number) => void) => void): { object: Group; radius: number } {
  const q = new URLSearchParams(location.search);
  const dead = q.get('dead') === '1';
  const holder = new Group();
  const cam = new Vector3(0, 0, 1e9);
  if (id.startsWith('sam:')) {
    const type = id.slice(4) as SamType;
    const e = new SamSiteEntity(1, type, 'red', { missiles: 6 });
    e.missilesReady = Number(q.get('ready') ?? 6);
    e.alive = !dead;
    const v = new SamVisual(getSamPrototype(type));
    holder.add(v.root);
    onUpdate((t, dt) => {
      e.radarAzimuth = t * 2;
      e.launcherAzimuth = 0.6 + Math.sin(t * 0.3) * 0.5;
      e.launcherElevation = 0.5 + Math.sin(t * 0.5) * 0.3;
      v.update(e, t, dt, cam.set(0, 0, 100), 1e9);
      v.root.position.set(0, 0, 0);
    });
    return { object: holder, radius: v.proto.radius * 1.1 };
  }
  const [type, vessel] = id.slice(3).split(':') as [GroundTargetType, VesselClass | undefined];
  const e = new GroundTargetEntity(1, type, vessel ? 'neutral' : 'red');
  e.vessel = vessel ?? null;
  e.alive = !dead;
  if (dead) e.destroyedAt = 0;
  e.anchored = q.get('anchored') === '1';
  if (type === 'ship' && !e.anchored) e.velocity.set(0, 0, -10);
  const v = new GroundVisual(getGroundPrototype(type, 'green', e.vessel));
  holder.add(v.root);
  onUpdate((t, dt) => {
    v.update(e, t, dt, cam.set(0, 0, 100), 1e9);
  });
  return { object: holder, radius: v.proto.radius * 1.4 };
}
