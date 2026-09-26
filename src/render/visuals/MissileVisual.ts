/**
 * In-flight missile / bomb visual: shared munition geometry scaled to the combat definition's
 * length/diameter, plus a rocket-motor flame while the motor burns. Pooled by munition id.
 */
import { Group, Mesh, Vector3 } from 'three';
import type { MunitionId } from '../../core/types';
import type { MissileEntity } from '../../sim/entities';
import { MUNITION_DIMS } from '../models/specs';
import { munitionMesh } from '../models/munitions';
import { Flame } from '../models/flame';

const _v = new Vector3();

export class MissileVisual {
  readonly root = new Group();
  private readonly mesh: Mesh;
  private flame: Flame | null = null;

  constructor(readonly id: MunitionId) {
    this.mesh = munitionMesh(id);
    this.root.add(this.mesh);
  }

  /** Called when (re)used for a missile entity. */
  bind(m: MissileEntity): void {
    const dims = MUNITION_DIMS[this.id] ?? MUNITION_DIMS.aim120;
    const kL = m.def.length > 0 ? m.def.length / dims.length : 1;
    const kD = m.def.diameter > 0 ? m.def.diameter / dims.diameter : 1;
    this.mesh.scale.set(kD, kD, kL);
    const hasMotor = m.def.category !== 'bomb' && m.def.boostTime + m.def.sustainTime > 0;
    if (hasMotor && !this.flame) {
      const r = (m.def.diameter || dims.diameter) * 0.42;
      this.flame = new Flame(r, Math.max(1.2, (m.def.diameter || dims.diameter) * 14), 'motor');
      this.root.add(this.flame.group);
    }
    if (this.flame) this.flame.group.position.set(0, 0, (m.def.length || dims.length) / 2 - 0.02);
    this.root.visible = true;
  }

  update(m: MissileEntity, time: number, camPos: Vector3): void {
    this.root.position.copy(m.position);
    this.root.quaternion.copy(m.quaternion);
    const d = _v.copy(m.position).sub(camPos).length();
    // the body is sub-pixel beyond a few km; the motor glow sprite (Effects) remains
    this.mesh.visible = m.alive && d < 3500;
    if (this.flame) this.flame.update(time, 0, 0, m.alive && m.motorBurning && d < 5000);
    this.root.visible = m.alive;
  }

  dispose(): void {
    this.flame?.dispose();
    this.root.removeFromParent();
  }
}
