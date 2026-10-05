/**
 * Pests lab (dev only): labs/pests-lab.html. Shows one Codex pest in the Codex's turntable stage.
 * Query: ?pest=possum|rat|stoat|wasp&yaw=35&pitch=18&dist=1.25&fur=0&buzz=1&detail=0.65
 * window.__pests is the stage, for scripted screenshots.
 */
import { PESTS, type PestId } from '../models/pests';
import { PestStage } from '../../ui/codex/pestStage';

const q = new URLSearchParams(location.search);
const stage = new PestStage(document.getElementById('c') as HTMLCanvasElement, { detail: +(q.get('detail') ?? 1), background: 0x15181c, preserve: true });
const info = document.getElementById('info') as HTMLElement;
const show = async (id: PestId) => {
  const r = await stage.show(id);
  if (!r) return;
  const p = PESTS.find((x) => x.id === id);
  info.textContent = `${p?.name} · ${r.triangles.toLocaleString()} tris · built in ${r.ms.toFixed(0)} ms · ${(r.size.z * 1000).toFixed(0)} mm long`;
  if (q.has('yaw')) stage.view(+q.get('yaw')!, +(q.get('pitch') ?? 18), +(q.get('dist') ?? 1.25));
  if (q.get('fur') === '0') stage.setFur(false);
  if (q.get('buzz') === '1') stage.setBuzz(true);
  (window as unknown as { __pests: unknown }).__pests = { stage, show };
};
void show((q.get('pest') as PestId) ?? 'possum');
