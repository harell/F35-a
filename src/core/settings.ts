/**
 * F35-A — settings persistence + automatic quality detection.
 * OWNERSHIP: orchestrator.
 */
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from './data';
import type { QualityLevel, QualitySettings, Settings } from './types';

const SETTINGS_KEY = 'f35a.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const s: Settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    // Ace was removed: a saved Ace setting flies at the hardest level left
    if ((s.difficulty as string) === 'ace') s.difficulty = 'veteran';
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — ignore */
  }
}

/** Heuristic device tier from GPU string, memory and cores. */
export function detectQualityLevel(gl?: WebGLRenderingContext | WebGL2RenderingContext | null): QualityLevel {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency || 4;
  const mem = nav.deviceMemory ?? 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  let gpu = '';
  try {
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    }
  } catch {
    /* ignore */
  }
  const g = gpu.toLowerCase();
  if (/swiftshader|llvmpipe|software/.test(g)) return 'low';
  if (!mobile) return cores >= 8 ? 'high' : 'medium';
  // Apple GPUs (A14+) and recent Adreno/Mali/Xclipse handle medium comfortably.
  if (/apple/.test(g)) return mem >= 6 ? 'high' : 'medium';
  if (/adreno \(tm\) (7[3-9]\d|8\d\d)|mali-g7[1-9]|mali-g[89]|immortalis|xclipse/.test(g)) return 'high';
  if (/adreno \(tm\) (6[4-9]\d|7\d\d)|mali-g(5[7-9]|6\d|7\d)/.test(g)) return 'medium';
  if (mem <= 3 || cores <= 4) return 'low';
  return 'medium';
}

export function resolveQuality(s: Settings, gl?: WebGLRenderingContext | WebGL2RenderingContext | null): QualitySettings {
  const level = s.quality === 'auto' ? detectQualityLevel(gl) : s.quality;
  const q = { ...QUALITY_PRESETS[level] };
  q.hdTerrain = q.hdTerrain && s.hdTerrain !== false;
  q.aerialPhoto = q.aerialPhoto && s.aerialPhoto !== false;
  q.pixelRatio = Math.min(q.pixelRatio, window.devicePixelRatio || 1);
  return q;
}
