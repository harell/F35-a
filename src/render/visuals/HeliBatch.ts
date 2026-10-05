/**
 * The civil helicopters (#144) drawn instanced: one InstancedMesh per type (one draw call each, whatever the number
 * in the air) holding the whole airframe and both rotors merged. The rotors spin in the vertex shader: every vertex
 * of a rotor carries its hub (aPivot), spin axis and rate (aSpin: xyz axis, w rad/s; 0 = airframe), and is turned
 * by uTime · rate about the hub. A wreck stops its rotors and goes dark (per-instance colour). The Eagle's
 * searchlight is a second, additive InstancedMesh, drawn only at night (one more call then, for all of them).
 *
 * The AircraftVisual of a helicopter keeps no meshes (AircraftPrototype.instanced): it still tracks the pose, LOD
 * distance and the nav-light anchors (the lights join the renderer's sprite batch), and this batch draws each frame
 * from its root's matrix.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Material,
  type MeshStandardMaterial,
  type Mesh,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AircraftType } from '../../core/types';
import type { AircraftPrototype } from '../models/aircraft/types';
import { getVariant } from '../models/materials';

/** Most helicopters of one type drawn at once (the traffic flies at most 4 in all). */
const CAPACITY = 8;
const WRECK = new Color(0x2a2724);
const ALIVE = new Color(0xffffff);


/**
 * One geometry for a whole helicopter: the LOD0 body plus each spinning part moved into the model frame, with the
 * spin attributes (aPivot, aSpin) the batch's vertex shader reads. Pure geometry (node-safe).
 */
export function mergedHelicopter(proto: AircraftPrototype): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const rate = new Map(proto.drives.map((d) => [d.part, d.max]));
  const m = new Matrix4();
  const axis = new Vector3();
  const q = new Quaternion();
  for (const child of proto.lod0.children) {
    let mesh: Mesh | null = null;
    let spin = 0;
    m.identity();
    axis.set(0, 0, 0);
    if (child.name === 'body') mesh = child as Mesh;
    else if (child.name.startsWith('pivot:')) {
      const name = child.name.slice(6);
      mesh = (child.getObjectByName(`part:${name}`) as Mesh) ?? null;
      spin = rate.get(name) ?? 0;
      m.compose(child.position, child.quaternion, child.scale);
      // the part spins about its pivot's local X axis
      q.copy(child.quaternion);
      axis.set(1, 0, 0).applyQuaternion(q);
    }
    if (!mesh || !(mesh as Mesh).isMesh) continue;
    const g = mesh.geometry.clone();
    g.applyMatrix4(m);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
    if (!g.getAttribute('color')) g.setAttribute('color', new Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 3).fill(1), 3));
    g.clearGroups();
    const n = g.getAttribute('position').count;
    const pivot = new Float32Array(n * 3);
    const sp = new Float32Array(n * 4);
    const p = child.position;
    for (let i = 0; i < n; i++) {
      pivot.set([p.x, p.y, p.z], i * 3);
      sp.set([axis.x, axis.y, axis.z, spin], i * 4);
    }
    g.setAttribute('aPivot', new BufferAttribute(pivot, 3));
    g.setAttribute('aSpin', new BufferAttribute(sp, 4));
    parts.push(g.index ? g.toNonIndexed() : g);
  }
  const out = mergeGeometries(parts, false)!;
  for (const g of parts) g.dispose();
  out.computeBoundingSphere();
  return out;
}

const SPIN_GLSL = /* glsl */ `
attribute vec3 aPivot;
attribute vec4 aSpin;
attribute float iSpin;
uniform float uHeliTime;
vec3 heliSpin(vec3 v, vec3 pivotOffset, float a) {
  vec3 k = aSpin.xyz;
  float c = cos(a), s = sin(a);
  vec3 r = v - pivotOffset;
  return pivotOffset + r * c + cross(k, r) * s + k * dot(k, r) * (1.0 - c);
}
`;

/** The paint material with the spinning-rotor vertex stage (cached variant of 'munition'). */
function spinMaterial(time: { value: number }): Material {
  return getVariant('munition', 'heli-spin', (base) => {
    const m = (base as MeshStandardMaterial).clone();
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uHeliTime = time;
      shader.vertexShader = SPIN_GLSL + shader.vertexShader
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
  float heliA = uHeliTime * aSpin.w * iSpin;
  if (aSpin.w > 0.0) objectNormal = heliSpin(objectNormal, vec3(0.0), heliA);`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  if (aSpin.w > 0.0) transformed = heliSpin(transformed, aPivot, heliA);`);
    };
    m.customProgramCacheKey = () => 'heli-spin';
    return m;
  });
}

interface TypeBatch {
  mesh: InstancedMesh;
  spin: Float32Array;
  spinAttr: InstancedBufferAttribute;
  count: number;
  /** The Eagle's searchlight beams (night only); null for the other types. */
  beam: InstancedMesh | null;
  /** The beam's pose in the model frame (the prototype's night:searchlight). */
  beamLocal: Matrix4;
  beamCount: number;
}

const _m = new Matrix4();

export class HeliBatch {
  readonly group = new Group();
  private readonly types = new Map<AircraftType, TypeBatch>();
  private readonly time = { value: 0 };
  private night = false;

  constructor(private readonly protoOf: (t: AircraftType) => AircraftPrototype) {
    this.group.name = 'civil-helicopters';
  }

  private batch(type: AircraftType): TypeBatch {
    let b = this.types.get(type);
    if (b) return b;
    const proto = this.protoOf(type);
    const geo = mergedHelicopter(proto);
    // per instance: 1 = rotors turning, 0 = a wreck's stopped rotors
    const spin = new Float32Array(CAPACITY).fill(1);
    const spinAttr = new InstancedBufferAttribute(spin, 1);
    spinAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('iSpin', spinAttr);
    const mesh = new InstancedMesh(geo, spinMaterial(this.time), CAPACITY);
    mesh.name = `heli:${type}`;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false; // instances anywhere in the world: culled per instance by the visuals' LOD instead
    mesh.count = 0;
    for (let i = 0; i < CAPACITY; i++) mesh.setColorAt(i, ALIVE);
    let beam: InstancedMesh | null = null;
    const beamLocal = new Matrix4();
    const light = proto.lod0.getObjectByName('night:searchlight') as Mesh | undefined;
    if (light) {
      light.updateMatrix();
      beamLocal.copy(light.matrix);
      beam = new InstancedMesh(light.geometry, light.material as Material, CAPACITY);
      beam.name = `heli:${type}:searchlight`;
      beam.instanceMatrix.setUsage(DynamicDrawUsage);
      beam.frustumCulled = false;
      beam.count = 0;
      this.group.add(beam);
    }
    this.group.add(mesh);
    b = { mesh, spin, spinAttr, count: 0, beam, beamLocal, beamCount: 0 };
    this.types.set(type, b);
    return b;
  }

  /** Start a frame: `time` turns the rotors; the searchlights show at `night`. */
  begin(time: number, night: boolean): void {
    this.time.value = time;
    this.night = night;
    for (const b of this.types.values()) {
      b.count = 0;
      b.beamCount = 0;
    }
  }

  /** Draw one helicopter of `type` at the world matrix of its (mesh-less) visual's root. */
  add(type: AircraftType, matrix: Matrix4, alive: boolean): void {
    const b = this.batch(type);
    if (b.count >= CAPACITY) return;
    const i = b.count++;
    b.mesh.setMatrixAt(i, matrix);
    b.mesh.setColorAt(i, alive ? ALIVE : WRECK);
    b.spin[i] = alive ? 1 : 0;
    if (b.beam && alive && this.night) b.beam.setMatrixAt(b.beamCount++, _m.multiplyMatrices(matrix, b.beamLocal));
  }

  end(): void {
    for (const b of this.types.values()) {
      b.mesh.count = b.count;
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      b.spinAttr.needsUpdate = true;
      if (b.beam) {
        b.beam.count = b.beamCount;
        b.beam.visible = b.beamCount > 0;
        b.beam.instanceMatrix.needsUpdate = true;
      }
      b.mesh.visible = b.count > 0;
    }
  }

  /** Draw calls this batch issues now (tests, stats). */
  get drawCalls(): number {
    let n = 0;
    for (const b of this.types.values()) n += (b.mesh.visible ? 1 : 0) + (b.beam?.visible ? 1 : 0);
    return n;
  }

  dispose(): void {
    for (const b of this.types.values()) {
      b.mesh.geometry.dispose();

    }
    this.group.removeFromParent();
  }
}
