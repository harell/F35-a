/**
 * F35-A UI — Codex pest viewer: one IRGC pest (render/models/pests) on a turntable. Orbit, zoom and
 * pan; studio lighting with a soft contact shadow; switches for the fur and the wasp's wing beat.
 * No wireframe mode: on furred models it draws every shell's edges and brings a PC to a crawl.
 * Used by the Codex's pest pages (codex/view.ts), labs/pests-lab.html and the review page
 * (tools/pests-artifact.mjs).
 *
 * Memory: only one model is alive at a time. show() frees the previous model's geometry and materials,
 * and dispose() frees the model and the WebGL context, so leaving the page returns the 5–8 MB a model
 * takes. Phones get a lighter model (pestDetail). Renders only while the canvas is on screen.
 */
import {
  ACESFilmicToneMapping,
  Box3,
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  type Material,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { pestModel, type PestId } from '../../render/models/pests';

export interface PestStats {
  /** Sculpt time (ms). */
  ms: number;
  /** Triangles of the skin and parts (the fur shells repeat the skin and aren't counted). */
  triangles: number;
  /** Model bounding size (m). */
  size: Vector3;
}

/** Mesh detail for this device: lighter on phones and low-memory devices (about half the memory). */
export function pestDetail(): number {
  if (typeof window === 'undefined') return 1;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const phone = window.matchMedia?.('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
  return phone || (mem !== undefined && mem <= 4) ? 0.65 : 1;
}

/** Free a model's GPU buffers. Shared generated textures (render/models/pests/textures.ts) stay cached. */
function freeModel(o: Object3D): void {
  const seen = new Set<unknown>();
  o.traverse((c) => {
    const m = c as Mesh;
    if (m.geometry && !seen.has(m.geometry)) {
      seen.add(m.geometry);
      m.geometry.dispose();
    }
    const mats = (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) as Material[];
    for (const mat of mats) {
      // a texture cloned for its own repeat (the rat's tail, the wasp's eyes) belongs to the model
      const sm = mat as MeshStandardMaterial;
      for (const tex of [sm.map, sm.bumpMap] as (Texture | null)[]) if (tex?.userData.own) tex.dispose();
      mat.dispose();
    }
  });
}

export class PestStage {
  readonly ok: boolean;
  private renderer: WebGLRenderer | null = null;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(32, 1, 0.0001, 100);
  private controls: OrbitControls | null = null;
  private readonly key = new DirectionalLight(0xfff1df, 2.2);
  private readonly rim = new DirectionalLight(0xbcd2ff, 1.6);
  private readonly ground = new Mesh(new CircleGeometry(1, 64), new ShadowMaterial({ opacity: 0.35 }));
  private model: Object3D | null = null;
  private size = 1;
  private fur = true;
  private buzz = false;
  private raf = 0;
  private token = 0;
  private readonly t0 = performance.now();
  private readonly sz = new Vector2();

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly opts: { detail?: number; background?: number; preserve?: boolean } = {},
  ) {
    try {
      this.renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: !!opts.preserve });
    } catch {
      this.renderer = null;
    }
    this.ok = !!this.renderer;
    if (!this.renderer) return;
    const r = this.renderer;
    const phone = (opts.detail ?? 1) < 1;
    r.setPixelRatio(Math.min(phone ? 1.5 : 2, window.devicePixelRatio || 1));
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;

    this.scene.background = new Color(opts.background ?? 0x0b141b);
    const pmrem = new PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.8;

    const c = new OrbitControls(this.camera, canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.autoRotateSpeed = 1.2;
    this.controls = c;

    this.key.castShadow = true;
    this.key.shadow.mapSize.set(phone ? 1024 : 2048, phone ? 1024 : 2048);
    this.key.shadow.radius = 6;
    this.key.shadow.intensity = 0.7;
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(new HemisphereLight(0xdfe8f2, 0x4a4038, 1.1), this.key, this.key.target, this.rim, this.ground);
    this.start();
  }

  /** Build and show a pest (after a frame, so a "Sculpting…" note can paint). Resolves with its stats, or null if superseded. */
  show(id: PestId): Promise<PestStats | null> {
    const token = ++this.token;
    return new Promise((resolve) => {
      window.setTimeout(() => {
        if (token !== this.token || !this.renderer) return resolve(null);
        this.clear();
        const t0 = performance.now();
        const m = pestModel(id, this.opts.detail ?? 1);
        const ms = performance.now() - t0;
        m.traverse((o) => {
          if ((o as Mesh).isMesh) o.castShadow = true;
          if (o.name === 'fur') o.visible = this.fur;
        });
        this.model = m;
        this.scene.add(m);
        this.frame(m);
        resolve({ ms, triangles: triangles(m), size: new Box3().setFromObject(m).getSize(new Vector3()) });
      }, 30);
    });
  }

  setFur(on: boolean): void {
    this.fur = on;
    this.model?.traverse((o) => o.name === 'fur' && (o.visible = on));
  }
  setSpin(on: boolean): void {
    if (this.controls) this.controls.autoRotate = on;
  }
  setBuzz(on: boolean): void {
    this.buzz = on;
  }
  setBackground(hex: number): void {
    (this.scene.background as Color).setHex(hex);
  }

  /** Camera at a yaw / pitch (degrees) and a distance in model sizes, looking at the model's centre. */
  view(yaw = 35, pitch = 15, dist = 1.25): void {
    // narrow (portrait) views back off so the long axis still fits
    const r = this.size * dist * Math.max(1, 1.15 / Math.max(0.3, this.camera.aspect));
    const y = (yaw * Math.PI) / 180;
    const p = (pitch * Math.PI) / 180;
    const t = this.controls?.target ?? new Vector3();
    this.camera.position.set(t.x - Math.sin(y) * Math.cos(p) * r, t.y + Math.sin(p) * r, t.z - Math.cos(y) * Math.cos(p) * r);
    this.camera.lookAt(t);
    this.controls?.update();
  }

  dispose(): void {
    this.token++;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clear();
    this.controls?.dispose();
    this.controls = null;
    this.ground.geometry.dispose();
    (this.ground.material as Material).dispose();
    this.scene.environment?.dispose();
    this.key.shadow.map?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }

  private clear(): void {
    if (!this.model) return;
    this.scene.remove(this.model);
    freeModel(this.model);
    this.model = null;
  }

  /** Aim the camera, lights, shadow and ground at a new model. */
  private frame(m: Object3D): void {
    const box = new Box3().setFromObject(m);
    const s = box.getSize(new Vector3());
    const c = box.getCenter(new Vector3());
    this.size = Math.max(s.x, s.y, s.z);
    const size = this.size;
    this.controls?.target.copy(c);
    if (this.controls) {
      this.controls.minDistance = size * 0.15;
      this.controls.maxDistance = size * 6;
    }
    this.camera.near = size * 0.005;
    this.camera.far = size * 50;
    this.camera.updateProjectionMatrix();
    this.ground.scale.setScalar(size * 2.5);
    this.ground.position.set(c.x, box.min.y + size * 0.0005, c.z);
    this.key.position.set(c.x - size * 1.2, c.y + size * 4, c.z - size * 0.8);
    this.key.target.position.copy(c);
    const sc = this.key.shadow.camera;
    sc.left = sc.bottom = -size;
    sc.right = sc.top = size;
    sc.near = size * 0.5;
    sc.far = size * 8;
    sc.updateProjectionMatrix();
    this.key.shadow.bias = -0.0005;
    this.rim.position.set(c.x + size * 2, c.y + size * 1.2, c.z + size * 2);
    this.view();
  }

  private start(): void {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const r = this.renderer;
      if (!r || !this.canvas.isConnected) return;
      const box = this.canvas.getBoundingClientRect();
      if (box.width <= 0 || box.bottom < 0 || box.top > innerHeight) return; // off screen: skip the frame
      const w = Math.round(box.width);
      const h = Math.round(box.height);
      const sz = r.getSize(this.sz);
      if (w && h && (sz.x !== w || sz.y !== h)) {
        r.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
      }
      const t = (performance.now() - this.t0) / 1000;
      this.model?.traverse((o) => {
        const flap = o.userData.flap as { base: number; amp: number; side: number } | undefined;
        if (flap) o.rotation.z = flap.base + (this.buzz ? Math.sin(t * 2 * Math.PI * 9) * flap.amp * flap.side : 0);
      });
      this.controls?.update();
      r.render(this.scene, this.camera);
    };
    loop();
  }
}

function triangles(m: Object3D): number {
  let n = 0;
  m.traverse((c) => {
    const g = (c as Mesh).geometry;
    if ((c as Mesh).isMesh && g && c.parent?.name !== 'fur') n += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return Math.round(n);
}
