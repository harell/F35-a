/**
 * Per-instance visuals for SAM sites and ground targets: animates radars / launchers / spinners,
 * shows ready missiles (one InstancedMesh per site) and wreck variants when destroyed.
 * Ships ride the swell, swing at anchor and sink (fire, list, bow / stern settling, under in
 * 60–90 s) — the pose maths is shared with the effects in shipMotion.ts.
 */
import { InstancedMesh, Matrix4, Mesh, Object3D, Vector3, type Material } from 'three';
import type { GroundTargetEntity, SamSiteEntity } from '../../sim/entities';
import type { SamPrototype } from '../models/sams';
import { tubeCapGeometry } from '../models/sams';
import type { GroundPrototype } from '../models/ground';
import { munitionGeometry } from '../models/munitions';
import { charredMaterial, getMaterial } from '../models/materials';
import { shipMatrix } from './shipMotion';
import { poseStoat, stoatNodes, type StoatNodes } from './stoatPose';
import { poseRat, ratNodes, type RatNodes } from './ratPose';

const _v = new Vector3();
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
  private wreckT = -1;
  private mats = new Map<Mesh, Material | Material[]>();
  private readonly seed = Math.random();
  /** A ship: swell / anchor swing / sinking pose from shipMotion (sim time, not frame dt). */
  private readonly ship: boolean;
  /** Which ship lights are lit (afloat and in range): 0 = none, 1 under way, 2 at anchor, 4 moored (deck lights only). */
  lightMode = 0;
  /** g03's stoat: its posable parts (render/visuals/stoatPose.ts); null for every other target. */
  private readonly stoat: StoatNodes | null;
  /** t04's rats: posable parts (render/visuals/ratPose.ts); null for every other target. */
  private readonly rat: RatNodes | null;

  constructor(readonly proto: GroundPrototype) {
    this.root = proto.root.clone(true);
    this.stoat = proto.type === 'stoat' ? stoatNodes(this.root) : null;
    this.rat = proto.type === 'rat' ? ratNodes(this.root) : null;
    for (const s of proto.spinners) {
      const n = this.root.getObjectByName(s.name);
      if (n) this.spinners.push({ node: n, rate: s.rate });
    }
    this.ship = proto.wreck === 'ship';
  }

  update(g: GroundTargetEntity, time: number, dt: number, camPos: Vector3, far: number): boolean {
    this.lightMode = 0;
    if (this.ship) {
      const sink = shipMatrix(g, time, _m);
      _m.decompose(this.root.position, this.root.quaternion, this.root.scale);
      if (!g.alive && sink.progress >= 1) {
        // fully under: nothing left to draw
        this.root.visible = false;
        return false;
      }
    } else {
      this.root.position.copy(g.position);
      this.root.quaternion.copy(g.quaternion);
    }
    const dist = _v.copy(g.position).sub(camPos).length();
    if (dist > far * this.proto.farScale) {
      this.root.visible = false;
      return false;
    }
    // a killed stoat or rat leaves nothing to draw (only the crater the bomb dug)
    if ((this.stoat || this.rat) && !g.alive) {
      this.root.visible = false;
      return false;
    }
    this.root.visible = true;
    if (!g.alive) {
      if (this.wreckT < 0) {
        this.wreckT = 0;
        // a sinking ship keeps its colours (the fires and smoke tell the story, and the PiP still
        // shows which ship it was); everything else chars
        if (!this.ship) charAll(this.root, this.mats, true);
      }
      this.wreckT += dt;
      if (!this.ship) this.applyWreck(this.wreckT);
      return true;
    }
    if (this.wreckT >= 0) {
      this.wreckT = -1;
      charAll(this.root, this.mats, false);
      this.root.scale.set(1, 1, 1);
    }
    for (const s of this.spinners) s.node.rotation.y = time * s.rate;
    if (this.stoat && g.stoat) poseStoat(this.stoat, g.stoat, time, this.seed);
    if (this.rat && g.stoat) poseRat(this.rat, g.stoat, time, this.seed);
    const speed = Math.max(g.velocity.length(), g.path ? g.speed : 0);
    if (this.proto.lights.length) this.lightMode = speed > 0.5 ? 1 : g.anchored ? 2 : 4;
    return true;
  }

  private applyWreck(t: number): void {
    const k = Math.min(1, t / 3);
    switch (this.proto.wreck) {
      case 'building':
        this.root.scale.set(1, 1 - 0.62 * k, 1);
        break;
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
