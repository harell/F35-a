/**
 * Pests lab (dev only): labs/pests-lab.html. Shows one Codex pest in the turntable viewer.
 * Query: ?pest=possum|rat|stoat|wasp&yaw=35&pitch=18&dist=1.9&fur=0&wire=1&buzz=1
 * window.__pests is the viewer, for scripted screenshots.
 */
import { PESTS, type PestId } from '../models/pests';
import { mountPestViewer } from './pestViewer';

const q = new URLSearchParams(location.search);
const v = mountPestViewer(document.getElementById('c') as HTMLCanvasElement);
const info = document.getElementById('info') as HTMLElement;
const show = (id: PestId) => {
  const r = v.select(id);
  const p = PESTS.find((x) => x.id === id);
  info.textContent = `${p?.name} · ${r.triangles.toLocaleString()} tris · built in ${r.ms.toFixed(0)} ms · ${(r.size.z * 1000).toFixed(0)} mm long`;
  if (q.has('yaw')) v.view(+q.get('yaw')!, +(q.get('pitch') ?? 18), +(q.get('dist') ?? 1.9));
};
show((q.get('pest') as PestId) ?? 'possum');
if (q.get('fur') === '0') v.setFur(false);
if (q.get('wire') === '1') v.setWire(true);
if (q.get('buzz') === '1') v.setBuzz(true);
(window as unknown as { __pests: unknown }).__pests = { ...v, show };
