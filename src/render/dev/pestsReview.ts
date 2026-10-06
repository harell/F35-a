/**
 * The pests review page (tools/pests-artifact.mjs bundles this into one HTML file): the turntable
 * stage (ui/codex/pestStage.ts) plus the species switcher, display toggles and each pest's "service record" for the
 * Interspecies Revolutionary Guard Corps. The page's markup is tools/pests-artifact.html.
 */
import { PESTS, type PestId } from '../models/pests';
import { PestStage } from '../../ui/codex/pestStage';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('stage');
const viewer = new PestStage(canvas);
const busy = $('busy');
const stats = $('stats');

const stageColour = () => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--stage').trim();
  return parseInt(v.replace('#', ''), 16) || 0x1a1d1a;
};
viewer.setBackground(stageColour());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => viewer.setBackground(stageColour()));
new MutationObserver(() => viewer.setBackground(stageColour())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

const fmtLen = (m: number) => (m < 0.1 ? `${(m * 1000).toFixed(0)} mm` : `${(m * 100).toFixed(0)} cm`);

function show(id: PestId) {
  document.querySelectorAll<HTMLButtonElement>('[data-pest]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pest === id)));
  document.querySelectorAll<HTMLElement>('[data-record]').forEach((r) => (r.hidden = r.dataset.record !== id));
  $('buzzRow').hidden = id !== 'wasp';
  busy.hidden = false;
  void viewer.show(id).then((r) => {
    if (!r) return;
    busy.hidden = true;
    const info = PESTS.find((p) => p.id === id)!;
    stats.innerHTML =
      `<span><b>${r.triangles.toLocaleString('en')}</b> triangles</span>` +
      `<span>sculpted in <b>${r.ms.toFixed(0)}</b> ms</span>` +
      `<span>body <b>${fmtLen(info.body)}</b>, model <b>${fmtLen(Math.max(r.size.x, r.size.z))}</b> with tail or legs</span>`;
    try {
      localStorage.setItem('pest', id);
    } catch {
      /* storage blocked: the page works without it */
    }
  });
}

document.querySelectorAll<HTMLButtonElement>('[data-pest]').forEach((b) => b.addEventListener('click', () => show(b.dataset.pest as PestId)));
$<HTMLInputElement>('fur').addEventListener('change', (e) => viewer.setFur((e.target as HTMLInputElement).checked));
$<HTMLInputElement>('spin').addEventListener('change', (e) => viewer.setSpin((e.target as HTMLInputElement).checked));
$<HTMLInputElement>('buzz').addEventListener('change', (e) => viewer.setBuzz((e.target as HTMLInputElement).checked));
$('reset').addEventListener('click', () => viewer.view());
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    const [yaw, pitch, dist] = b.dataset.view!.split(',').map(Number);
    viewer.view(yaw, pitch, dist);
  }),
);

let start: PestId = 'possum';
try {
  const saved = localStorage.getItem('pest') as PestId | null;
  if (saved && PESTS.some((p) => p.id === saved)) start = saved;
} catch {
  /* storage blocked */
}
const hash = location.hash.slice(1) as PestId;
if (PESTS.some((p) => p.id === hash)) start = hash;
viewer.setSpin(true);
show(start);
