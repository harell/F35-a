/**
 * Bloom (#139 item 4, high tier only, behind `QualityLevel.postfx`): the sun, sun glints on the water
 * and night lights glow. It runs after the world pass and before the cockpit pass, so the panel and
 * the PCD never bloom, and it leaves the main render path alone: the finished canvas is copied into a
 * texture, its brightest pixels are kept at a quarter of the drawing-buffer size, blurred once each
 * way, and added back over the canvas. 4 extra draw calls and no extra scene pass.
 */
import {
  AdditiveBlending,
  FramebufferTexture,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';

/** Brightness (display-referred luma, 0..1) where the glow starts, and how hard it ramps. */
export const BLOOM_THRESHOLD = 0.86;
/** Gain on the 16 source pixels summed per quarter-size texel (1/16 would be their average). */
export const BLOOM_BLOCK_GAIN = 0.25;
/** Strength of the glow added back over the frame. */
export const BLOOM_INTENSITY = 2;
/** The glow is computed at 1/BLOOM_DOWNSCALE of the drawing buffer in each axis. */
export const BLOOM_DOWNSCALE = 4;

/** Whether this quality level draws bloom. */
export function bloomEnabled(q: { postfx: boolean }): boolean {
  return q.postfx;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Keep what is brighter than the threshold (soft knee), per source pixel over the 4×4 block this
 * quarter-size texel covers: thresholding after averaging would dilute a 1-2 px light below the
 * knee and drop it. The block's bright light is summed with a gain, so a point light still glows.
 */
export const BLOOM_BRIGHT_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
vec3 bright(vec2 o) {
  vec3 c = texture2D(uSrc, vUv + uTexel * o).rgb;
  return c * smoothstep(uThreshold, 1.0, max(c.r, max(c.g, c.b)));
}
void main() {
  vec3 c = vec3(0.0);
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) c += bright(vec2(float(x) - 1.5, float(y) - 1.5));
  }
  gl_FragColor = vec4(c * ${BLOOM_BLOCK_GAIN.toFixed(3)}, 1.0);
}
`;

/** 9-tap Gaussian along uDir, using bilinear taps (5 fetches). */
export const BLOOM_BLUR_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uSrc, vUv).rgb * 0.2270270270;
  c += texture2D(uSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(uSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(uSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(uSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

export const BLOOM_ADD_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform float uIntensity;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(uSrc, vUv).rgb * uIntensity, 1.0);
}
`;

export class Bloom {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: Mesh;
  private readonly bright: ShaderMaterial;
  private readonly blur: ShaderMaterial;
  private readonly add: ShaderMaterial;
  private copy: FramebufferTexture | null = null;
  private a: WebGLRenderTarget | null = null;
  private b: WebGLRenderTarget | null = null;
  private readonly size = new Vector2();

  constructor() {
    const mat = (fragmentShader: string, uniforms: Record<string, { value: unknown }>) =>
      new ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false });
    this.bright = mat(BLOOM_BRIGHT_FRAG, { uSrc: { value: null }, uTexel: { value: new Vector2() }, uThreshold: { value: BLOOM_THRESHOLD } });
    this.blur = mat(BLOOM_BLUR_FRAG, { uSrc: { value: null }, uDir: { value: new Vector2() } });
    this.add = mat(BLOOM_ADD_FRAG, { uSrc: { value: null }, uIntensity: { value: BLOOM_INTENSITY } });
    this.add.blending = AdditiveBlending;
    this.add.transparent = true;
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.bright);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  private ensure(w: number, h: number): void {
    if (this.copy && this.copy.image.width === w && this.copy.image.height === h) return;
    this.dispose();
    this.copy = new FramebufferTexture(w, h);
    this.copy.minFilter = LinearFilter;
    this.copy.magFilter = LinearFilter;
    const bw = Math.max(1, Math.round(w / BLOOM_DOWNSCALE));
    const bh = Math.max(1, Math.round(h / BLOOM_DOWNSCALE));
    const rt = () => new WebGLRenderTarget(bw, bh, { format: RGBAFormat, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
    this.a = rt();
    this.b = rt();
  }

  private pass(renderer: WebGLRenderer, m: ShaderMaterial, target: WebGLRenderTarget | null): void {
    this.quad.material = m;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  /** Call right after the world pass, with the world image in the canvas. */
  render(renderer: WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.size);
    const w = this.size.x | 0;
    const h = this.size.y | 0;
    if (w < 8 || h < 8) return;
    this.ensure(w, h);
    const copy = this.copy!;
    const a = this.a!;
    const b = this.b!;
    const prevTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.setRenderTarget(null);
    renderer.copyFramebufferToTexture(copy);
    renderer.autoClear = true;
    this.bright.uniforms.uSrc.value = copy;
    (this.bright.uniforms.uTexel.value as Vector2).set(1 / w, 1 / h);
    this.pass(renderer, this.bright, a);
    this.blur.uniforms.uSrc.value = a.texture;
    (this.blur.uniforms.uDir.value as Vector2).set(1 / a.width, 0);
    this.pass(renderer, this.blur, b);
    this.blur.uniforms.uSrc.value = b.texture;
    (this.blur.uniforms.uDir.value as Vector2).set(0, 1 / a.height);
    this.pass(renderer, this.blur, a);
    renderer.autoClear = false;
    this.add.uniforms.uSrc.value = a.texture;
    this.pass(renderer, this.add, null);
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    this.copy?.dispose();
    this.a?.dispose();
    this.b?.dispose();
    this.copy = this.a = this.b = null;
  }
}
