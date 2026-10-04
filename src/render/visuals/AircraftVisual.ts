/**
 * Per-aircraft visual instance: clones the type prototype, drives control surfaces / bay doors /
 * variable geometry from the flight state, shows internal & external stores from the loadout,
 * runs afterburner flames, switches LOD by distance and turns into a charred wreck when dead.
 */
import { Group, Material, Mesh, Object3D, Vector3 } from 'three';
import type { AircraftEntity } from '../../sim/entities';
import type { MunitionId, WeaponId } from '../../core/types';
import { nozzleOpening, type AircraftPrototype, type DriveDef, type StoreSlot } from '../models/aircraft/types';
import type { AircraftSpec } from '../models/specs';
import { MUNITION_DIMS } from '../models/specs';
import { Flame } from '../models/flame';
import { munitionMesh } from '../models/munitions';
import { charredMaterial } from '../models/materials';

const _v = new Vector3();

interface StoreItem {
  obj: Object3D;
  weapon: WeaponId;
  internal: boolean;
  index: number; // order among items with the same weapon + bay/pylon kind
}

export interface LodConfig {
  /** Distance (m) below which LOD0 (animated) is used for AI aircraft. */
  lod0: number;
  /** Max visible distance (m). */
  far: number;
}

export class AircraftVisual {
  readonly root = new Group();
  private readonly lod0: Group;
  private readonly lod1: Group;
  private readonly drives: { obj: Object3D; def: DriveDef }[] = [];
  private readonly flames: Flame[] = [];
  private readonly flameGroup = new Group();
  private stores: StoreItem[] = [];
  private fixed: Object3D[] = [];
  private fixedTotal = -1;
  private storesBuilt = false;
  private pylons = new Map<string, Object3D>();
  private wreck = false;
  private originalMats = new Map<Mesh, Material | Material[]>();
  /** Variable-area nozzle: smoothed opening 0..1 (NaN until the first update snaps it). */
  private nozzleOpen = Number.NaN;
  private readonly nozzle: { mesh: Mesh; def: DriveDef } | null = null;
  private lodLevel = -1;
  /** World-space light anchors (updated by the renderer). */
  readonly lightLocal: { pos: Vector3; color: number; kind: 'nav' | 'strobe' | 'tail' }[];

  constructor(
    readonly proto: AircraftPrototype,
    readonly spec: AircraftSpec,
    private readonly isPlayer: boolean,
    shadows: boolean,
  ) {
    this.lod0 = proto.lod0.clone(true);
    this.lod1 = proto.lod1.clone(true);
    this.root.add(this.lod0, this.lod1);
    this.root.add(this.flameGroup);
    for (const def of proto.drives) {
      const pivot = this.lod0.getObjectByName(`pivot:${def.part}`);
      const part = pivot?.getObjectByName(`part:${def.part}`);
      if (!part) continue;
      // the nozzle morphs instead of rotating (clone(true) gave this instance its own influences)
      if (def.kind === 'nozzle') this.nozzle = { mesh: part as Mesh, def };
      else this.drives.push({ obj: part, def });
    }
    this.lod0.children.forEach((c) => {
      if (c.name.startsWith('pivot:pylon')) {
        this.pylons.set(c.name.slice(6), c);
        c.visible = false;
      }
    });
    // flames: one per engine, origin slightly inside the nozzle so the hot interior sits in the tailpipe
    if (spec.abLength > 0) {
      spec.engines.forEach((e, i) => {
        const f = new Flame(e.radius, spec.abLength, 'afterburner', i * 13.7 + Math.random() * 50);
        f.group.position.set(e.pos[0], e.pos[1], e.pos[2] - 0.35);
        this.flames.push(f);
        this.flameGroup.add(f.group);
      });
    }
    // fixed AI stores
    for (const s of proto.fixedStores) {
      const m = munitionMesh(s.munition);
      const r = MUNITION_DIMS[s.munition].diameter / 2;
      m.position.set(s.pos[0], s.pos[1] - r, s.pos[2]);
      this.lod0.add(m);
      this.fixed.push(m);
    }
    this.lightLocal = spec.lights.map((l) => ({ pos: new Vector3(...l.pos), color: l.color, kind: l.kind }));
    if (shadows && isPlayer) {
      this.lod0.traverse((o) => {
        if ((o as Mesh).isMesh) o.castShadow = true;
      });
    }
    this.lod1.visible = false;
  }

  /** Assign loadout items to display slots (once, when the stores are known). */
  private buildStores(ac: AircraftEntity): void {
    this.storesBuilt = true;
    const slots = this.proto.slots;
    if (slots.length === 0) return;
    const used = new Map<StoreSlot, number>();
    const counters = new Map<string, number>();
    const capacity = (s: StoreSlot, w: WeaponId) => (w === 'gbu39' || w === 'gbu53' ? 2 : 1);
    for (const st of ac.stores) {
      for (let i = 0; i < st.count; i++) {
        const slot = slots.find(
          (s) => s.internal === st.internal && s.accepts.includes(st.weapon) && (used.get(s) ?? 0) < capacity(s, st.weapon) && !this.slotTakenByOther(s, st.weapon),
        );
        if (!slot) continue;
        const n = used.get(slot) ?? 0;
        used.set(slot, n + 1);
        this.slotWeapon.set(slot, st.weapon);
        const mesh = munitionMesh(st.weapon as MunitionId);
        const r = MUNITION_DIMS[st.weapon as MunitionId].diameter / 2;
        const off = st.weapon === 'gbu39' || st.weapon === 'gbu53' ? (n === 0 ? -0.11 : 0.11) : 0;
        mesh.position.set(slot.pos[0] + off, slot.pos[1] - r - (st.internal ? 0 : 0.03), slot.pos[2]);
        this.lod0.add(mesh);
        const key = `${st.weapon}|${st.internal ? 1 : 0}`;
        const idx = counters.get(key) ?? 0;
        counters.set(key, idx + 1);
        this.stores.push({ obj: mesh, weapon: st.weapon, internal: st.internal, index: idx });
        if (slot.pylon) this.pylons.get(slot.pylon)?.traverse((o) => (o.visible = true));
      }
    }
  }
  private slotWeapon = new Map<StoreSlot, WeaponId>();
  private slotTakenByOther(s: StoreSlot, w: WeaponId): boolean {
    const cur = this.slotWeapon.get(s);
    return cur !== undefined && cur !== w;
  }

  private updateStores(ac: AircraftEntity): void {
    if (!this.storesBuilt && ac.stores.length > 0) this.buildStores(ac);
    if (this.stores.length) {
      // remaining count per key
      const doorsShut = ac.bayDoors < 0.02;
      for (let i = 0; i < this.stores.length; i++) {
        const it = this.stores[i];
        let remaining = 0;
        for (let k = 0; k < ac.stores.length; k++) {
          const st = ac.stores[k];
          if (st.weapon === it.weapon && st.internal === it.internal) remaining += st.count;
        }
        // internal stores are only visible (and only worth drawing) with the bay doors open
        it.obj.visible = it.index < remaining && !(it.internal && doorsShut);
      }
    }
    if (this.fixed.length) {
      let total = 0;
      for (const st of ac.stores) total += st.count;
      if (this.fixedTotal < 0) this.fixedTotal = Math.max(1, total);
      const show = ac.stores.length === 0 ? this.fixed.length : Math.round((total / this.fixedTotal) * this.fixed.length);
      this.fixed.forEach((m, i) => (m.visible = i < show));
    }
  }

  private applyDrives(ac: AircraftEntity, time: number): void {
    const s = ac.flight.surfaces;
    const alpha = ac.flight.alpha;
    for (const { obj, def } of this.drives) {
      let a = 0;
      switch (def.kind) {
        case 'stab':
          a = s.elevator * def.max - def.side * s.aileron * (def.extra ?? 0);
          break;
        case 'flaperon':
          a = s.flaps * (def.extra ?? 0) - def.side * s.aileron * def.max;
          break;
        case 'aileron':
          a = -def.side * s.aileron * def.max;
          break;
        case 'lef':
          a = -Math.min(def.max, Math.max(0, alpha * 1.2 + s.flaps * 0.25));
          break;
        case 'rudder':
          a = s.rudder * def.max + def.side * s.airbrake * (def.extra ?? 0);
          break;
        case 'airbrake':
          a = -s.airbrake * def.max;
          break;
        case 'door':
          a = ac.bayDoors * def.max;
          break;
        case 'radome':
          a = time * def.max;
          break;
        case 'canard':
          a = -s.elevator * def.max;
          break;
        case 'gear': {
          const down = ac.gear ?? 0;
          a = (1 - down) * def.max;
          obj.visible = down > 0.02;
          break;
        }
      }
      obj.rotation.x = a;
    }
  }

  /**
   * Variable-area nozzle: follow the rpm/AB schedule with an actuator lag, set the morph and keep
   * the flame (plume, hot interior, glow) sized to the exit. LOD1 is merged at the closed pose.
   */
  private updateNozzle(ac: AircraftEntity, dt: number, level: number): void {
    const nz = this.nozzle;
    if (!nz) return;
    // a wreck's nozzle stays where it was
    const cur = this.nozzleOpen === this.nozzleOpen ? this.nozzleOpen : 0;
    const target = ac.alive ? nozzleOpening(ac.flight.engineRpm, ac.flight.afterburner) : cur;
    if (this.nozzleOpen !== this.nozzleOpen) this.nozzleOpen = target;
    // ~0.5 s actuator time constant
    else this.nozzleOpen += (target - this.nozzleOpen) * Math.min(1, dt * 2);
    const k = level === 0 ? this.nozzleOpen : 0;
    const inf = nz.mesh.morphTargetInfluences;
    if (inf) inf[0] = k;
    const scale = (nz.def.extra ?? 1) + (nz.def.max - (nz.def.extra ?? 1)) * k;
    for (const f of this.flames) f.exitScale = scale;
  }

  /** Swap every mesh to the charred material (or back). */
  private setWreck(on: boolean): void {
    if (on === this.wreck) return;
    this.wreck = on;
    const charred = charredMaterial();
    this.root.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh || o.parent === this.flameGroup || this.flameGroup.children.includes(o.parent as Object3D)) return;
      if (on) {
        this.originalMats.set(m, m.material);
        m.material = charred;
      } else {
        const orig = this.originalMats.get(m);
        if (orig) m.material = orig;
      }
    });
  }

  /**
   * @param camPos camera world position (for LOD)
   * @returns true if visible this frame
   */
  update(ac: AircraftEntity, time: number, dt: number, camPos: Vector3, lod: LodConfig, night = false): boolean {
    this.root.position.copy(ac.position);
    this.root.quaternion.copy(ac.quaternion);
    const dist = _v.copy(ac.position).sub(camPos).length();
    const size = Math.max(1, this.spec.span / 11);
    let level = this.isPlayer ? 0 : dist < lod.lod0 * size ? 0 : dist < lod.far * size ? 1 : 2;
    if (!ac.alive && ac.crashed) level = 2;
    if (level !== this.lodLevel) {
      this.lodLevel = level;
      this.lod0.visible = level === 0;
      this.lod1.visible = level === 1;
    }
    this.setWreck(!ac.alive);
    this.updateNozzle(ac, dt, level);
    if (level === 0) {
      this.applyDrives(ac, time);
      this.updateStores(ac);
    }
    const flameOn = ac.alive && level < 2 && dist < 9000;
    const far = level > 0 || dist > 1500;
    for (const f of this.flames) {
      f.dryGlow = night ? 3 : 1;
      f.night = night;
      f.update(time, ac.flight.afterburner, ac.flight.engineRpm, flameOn, far);
    }
    this.root.updateMatrixWorld();
    return level < 2;
  }

  dispose(): void {
    this.flames.forEach((f) => f.dispose());
    this.root.removeFromParent();
  }
}
