/**
 * Per-instance visuals for SAM sites and ground targets: animates radars / launchers / spinners,
 * shows ready missiles (one InstancedMesh per site), ship wakes, and wreck variants when destroyed.
 */
import { InstancedMesh, Matrix4, Mesh, Object3D, Vector3, type Material } from 'three';
import type { GroundTargetEntity, SamSiteEntity } from '../../sim/entities';
import type { SamPrototype } from '../models/sams';
import { tubeCapGeometry } from '../models/sams';
import type { GroundPrototype } from '../models/ground';
import { munitionGeometry } from '../models/munitions';
import { charredMaterial, getMaterial } from '../models/materials';

const _v = new Vector3();
const _f = new Vector3();
const _m = new Matrix4();

/** Heading (0 = north/-Z, clockwise) of an object's forward axis. */
function headingOfQuat(q: { x: number; y: number; z: number; w: number }): number {
  // forward (0,0,-1) rotated by q
  const fx = -2 * (q.x * q.z + q.w * q.y);
  const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return Math.atan2(fx, -fz);
}

function charAll(root: Object3D, store: Map<Mesh, Material | Material[]>, on: boolean): void {
  const c = charredMaterial();
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || (o as InstancedMesh).isInstancedMesh) return;
    if (on) {
      if (!store.has(m)) store.set(m, m.material);
      m.material = c;
    } else {
      const orig = store.get(m);
      if (orig) m.material = orig;
    }
  });
}

interface SlotRef {
  yaw: Object3D | null;
  pitch: Object3D | null;
  slot: Matrix4;
}

export class SamVisual {
  readonly root: Object3D;
  private yaws: (Object3D | null)[] = [];
  private pitches: (Object3D | null)[][] = [];
  private radars: { node: Object3D; mode: 'search' | 'track' }[] = [];
  private ready: InstancedMesh | null = null;
  private order: SlotRef[] = [];
  private wreck = false;
  private mats = new Map<Mesh, Material | Material[]>();

  constructor(readonly proto: SamPrototype) {
    this.root = proto.root.clone(true);
    for (const l of proto.launchers) {
      const y = l.yaw ? this.root.getObjectByName(l.yaw) ?? null : null;
      this.yaws.push(y);
      this.pitches.push(l.pitches.map((p) => (p.name ? this.root.getObjectByName(p.name) ?? null : null)));
    }
    for (const r of proto.radars) {
      const n = this.root.getObjectByName(r.name);
      if (n) this.radars.push({ node: n, mode: r.mode });
    }
    // firing order: slot index major, launcher minor (spreads launches across launchers)
    const maxSlots = Math.max(0, ...proto.launchers.flatMap((l) => l.pitches.map((p) => p.slots.length)));
    for (let s = 0; s < maxSlots; s++)
      proto.launchers.forEach((l, li) =>
        l.pitches.forEach((p, pi) => {
          if (s < p.slots.length) this.order.push({ yaw: this.yaws[li], pitch: this.pitches[li][pi], slot: p.slots[s] });
        }),
      );
    if (proto.ready.kind !== 'none' && this.order.length) {
      const geo = proto.ready.kind === 'cap' ? tubeCapGeometry() : munitionGeometry(proto.ready.munition);
      this.ready = new InstancedMesh(geo, getMaterial('munition'), this.order.length);
      this.ready.frustumCulled = false;
      this.ready.name = 'ready';
      this.root.add(this.ready);
    }
  }

  update(sam: SamSiteEntity, time: number, dt: number, camPos: Vector3, far: number): boolean {
    this.root.position.copy(sam.position);
    this.root.quaternion.copy(sam.quaternion);
    const dist = _v.copy(sam.position).sub(camPos).length();
    if (dist > far) {
      this.root.visible = false;
      return false;
    }
    this.root.visible = true;
    if (!sam.alive) {
      if (!this.wreck) this.makeWreck();
      return true;
    }
    if (this.wreck) {
      this.wreck = false;
      charAll(this.root, this.mats, false);
    }
    const siteH = headingOfQuat(sam.quaternion);
    const az = -(sam.launcherAzimuth - siteH);
    for (const y of this.yaws) if (y) y.rotation.y = az;
    for (const ps of this.pitches) for (const p of ps) if (p) p.rotation.x = Math.max(-0.05, Math.min(1.45, sam.launcherElevation));
    for (const r of this.radars) {
      if (r.mode === 'search') {
        if (sam.radarOn) r.node.rotation.y = -(sam.radarAzimuth - siteH);
      } else r.node.rotation.y = az;
    }
    if (this.ready) {
      const n = sam.missilesMax > 0 ? Math.round((Math.max(0, sam.missilesReady) / sam.missilesMax) * this.order.length) : 0;
      this.ready.count = Math.min(this.order.length, n);
      if (dist < 4000 && this.ready.count > 0) {
        for (let i = 0; i < this.ready.count; i++) {
          const o = this.order[i];
          _m.identity();
          if (o.yaw) {
            o.yaw.updateMatrix();
            _m.copy(o.yaw.matrix);
          }
          if (o.pitch) {
            o.pitch.updateMatrix();
            _m.multiply(o.pitch.matrix);
          }
          _m.multiply(o.slot);
          this.ready.setMatrixAt(i, _m);
        }
        this.ready.instanceMatrix.needsUpdate = true;
      }
    }
    void time;
    void dt;
    return true;
  }

  private makeWreck(): void {
    this.wreck = true;
    charAll(this.root, this.mats, true);
    if (this.ready) this.ready.count = 0;
    let k = 0;
    for (const y of this.yaws) if (y) y.rotation.set(0.12 * (k++ % 2 ? 1 : -1), y.rotation.y + 0.6, 0.1);
    for (const ps of this.pitches) for (const p of ps) if (p) p.rotation.x = -0.12;
    for (const r of this.radars) r.node.rotation.set(0.35, r.node.rotation.y, 0.5);
  }

  dispose(): void {
    this.ready?.dispose();
    this.root.removeFromParent();
  }
}

export class GroundVisual {
  readonly root: Object3D;
  private spinners: { node: Object3D; rate: number }[] = [];
  private wake: Object3D | null;
  private mid: Object3D | null;
  private wreckT = -1;
  private mats = new Map<Mesh, Material | Material[]>();
  private readonly seed = Math.random();

  constructor(readonly proto: GroundPrototype) {
    this.root = proto.root.clone(true);
    for (const s of proto.spinners) {
      const n = this.root.getObjectByName(s.name);
      if (n) this.spinners.push({ node: n, rate: s.rate });
    }
    this.wake = this.root.getObjectByName('wake') ?? null;
    this.mid = this.root.getObjectByName('span:mid') ?? null;
  }

  update(g: GroundTargetEntity, time: number, dt: number, camPos: Vector3, far: number): boolean {
    this.root.position.copy(g.position);
    this.root.quaternion.copy(g.quaternion);
    const dist = _v.copy(g.position).sub(camPos).length();
    if (dist > far * this.proto.farScale) {
      this.root.visible = false;
      return false;
    }
    this.root.visible = true;
    if (!g.alive) {
      if (this.wreckT < 0) {
        this.wreckT = 0;
        charAll(this.root, this.mats, true);
      }
      this.wreckT += dt;
      this.applyWreck(this.wreckT);
      if (this.wake) this.wake.visible = false;
      return true;
    }
    if (this.wreckT >= 0) {
      this.wreckT = -1;
      charAll(this.root, this.mats, false);
      this.root.scale.set(1, 1, 1);
      if (this.mid) this.mid.position.set(0, 0, 0);
    }
    for (const s of this.spinners) s.node.rotation.y = time * s.rate;
    if (this.wake) {
      const speed = Math.max(g.velocity.length(), g.path ? g.speed : 0);
      this.wake.visible = speed > 0.8;
      this.wake.scale.set(1, 1, Math.min(1.4, 0.25 + speed / 12));
    }
    return true;
  }

  private applyWreck(t: number): void {
    const k = Math.min(1, t / 3);
    switch (this.proto.wreck) {
      case 'building':
        this.root.scale.set(1, 1 - 0.62 * k, 1);
        break;
      case 'bridge':
        if (this.mid) {
          this.mid.position.y = -9 * k;
          this.mid.rotation.x = 0.12 * k;
          this.mid.rotation.z = 0.05 * k;
        }
        break;
      case 'ship': {
        const s = Math.min(1, t / 25);
        this.root.position.y -= 3.5 * s;
        _f.set(0.06 * s, 0, 0.2 * s * (this.seed > 0.5 ? 1 : -1));
        this.root.rotateX(_f.x);
        this.root.rotateZ(_f.z);
        break;
      }
      case 'aircraft':
      case 'vehicle':
      default:
        this.root.scale.set(1, 1 - 0.2 * k, 1);
        this.root.rotateZ(0.12 * k * (this.seed > 0.5 ? 1 : -1));
        break;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}
