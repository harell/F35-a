/**
 * A turntable viewer for the Codex pests (render/models/pests): orbit, zoom and pan, studio lighting
 * with a soft contact shadow, and switches for the fur, wireframe and the wasp's wing beat.
 * Used by labs/pests-lab.html and the review artifact (tools/pests-artifact.mjs).
 */
import {
  ACESFilmicToneMapping,
  Box3,
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  type Material,
  MeshStandardMaterial,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { pestModel, type PestId } from '../models/pests';

export interface PestViewer {
  select(id: PestId): { ms: number; triangles: number; size: Vector3 };
  setFur(on: boolean): void;
  setWire(on: boolean): void;
  setSpin(on: boolean): void;
  setBuzz(on: boolean): void;
  /** Camera from a yaw / pitch (degrees) at a distance in model sizes. */
  view(yaw: number, pitch: number, dist?: number): void;
  setBackground(hex: number): void;
  dispose(): void;
}

export function mountPestViewer(canvas: HTMLCanvasElement, opts: { detail?: number } = {}): PestViewer {
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  scene.background = new Color(0x15181c);
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.8;

  const camera = new PerspectiveCamera(32, 1, 0.0001, 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 1.2;

  const hemi = new HemisphereLight(0xdfe8f2, 0x4a4038, 1.1);
  const key = new DirectionalLight(0xfff1df, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 6;
  key.shadow.intensity = 0.7;
  const rim = new DirectionalLight(0xbcd2ff, 1.6);
  scene.add(hemi, key, key.target, rim);

  const ground = new Mesh(new CircleGeometry(1, 64), new ShadowMaterial({ opacity: 0.35 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const models = new Map<PestId, Object3D>();
  let current: Object3D | null = null;
  let size = 1;
  let wire = false;
  let buzz = false;

  const fit = (yaw = 35, pitch = 18, dist = 1.25) => {
    // narrow (portrait) views back off so the long axis still fits
    const r = size * dist * Math.max(1, 1.15 / Math.max(0.3, camera.aspect));
    const y = (yaw * Math.PI) / 180;
    const p = (pitch * Math.PI) / 180;
    const target = controls.target;
    camera.position.set(target.x - Math.sin(y) * Math.cos(p) * r, target.y + Math.sin(p) * r, target.z - Math.cos(y) * Math.cos(p) * r);
    camera.lookAt(target);
    controls.update();
  };

  const applyWire = (o: Object3D) =>
    o.traverse((c) => {
      const m = (c as Mesh).material as Material | undefined;
      if (m && 'wireframe' in m) (m as MeshStandardMaterial).wireframe = wire;
    });

  function select(id: PestId) {
    const t0 = performance.now();
    let m = models.get(id);
    if (!m) {
      m = pestModel(id, opts.detail ?? 1);
      m.traverse((c) => {
        if ((c as Mesh).isMesh) c.castShadow = true;
      });
      models.set(id, m);
    }
    const ms = performance.now() - t0;
    if (current) scene.remove(current);
    current = m;
    scene.add(m);
    applyWire(m);
    const box = new Box3().setFromObject(m);
    const s = box.getSize(new Vector3());
    size = Math.max(s.x, s.y, s.z);
    controls.target.copy(box.getCenter(new Vector3()));
    controls.minDistance = size * 0.15;
    controls.maxDistance = size * 6;
    camera.near = size * 0.005;
    camera.far = size * 50;
    camera.updateProjectionMatrix();
    ground.scale.setScalar(size * 2.5);
    ground.position.y = box.min.y + size * 0.0005;
    key.position.set(controls.target.x - size * 1.2, controls.target.y + size * 4, controls.target.z - size * 0.8);
    key.target.position.copy(controls.target);
    const cam = key.shadow.camera;
    cam.left = cam.bottom = -size;
    cam.right = cam.top = size;
    cam.near = size * 0.5;
    cam.far = size * 8;
    cam.updateProjectionMatrix();
    key.shadow.bias = -0.0005;
    rim.position.set(controls.target.x + size * 2, controls.target.y + size * 1.2, controls.target.z + size * 2);
    fit();
    let triangles = 0;
    m.traverse((c) => {
      const g = (c as Mesh).geometry;
      if ((c as Mesh).isMesh && c.visible && g) {
        const fur = c.parent?.name === 'fur';
        if (!fur) triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
      }
    });
    return { ms, triangles: Math.round(triangles), size: s };
  }

  const resize = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  };

  let raf = 0;
  const t0 = performance.now();
  const loop = () => {
    raf = requestAnimationFrame(loop);
    resize();
    const t = (performance.now() - t0) / 1000;
    current?.traverse((c) => {
      const flap = c.userData.flap as { base: number; amp: number; side: number } | undefined;
      if (flap) c.rotation.z = flap.base + (buzz ? Math.sin(t * 2 * Math.PI * 9) * flap.amp * flap.side : 0);
    });
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  return {
    select,
    setFur: (on) => current?.traverse((c) => c.name === 'fur' && (c.visible = on)) ?? undefined,
    setWire: (on) => {
      wire = on;
      for (const m of models.values()) applyWire(m);
    },
    setSpin: (on) => (controls.autoRotate = on),
    setBuzz: (on) => (buzz = on),
    view: (yaw, pitch, dist) => fit(yaw, pitch, dist),
    setBackground: (hex) => ((scene.background as Color).setHex(hex)),
    dispose: () => {
      cancelAnimationFrame(raf);
      controls.dispose();
      renderer.dispose();
    },
  };
}
