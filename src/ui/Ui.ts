/**
 * STUB UI — to be replaced by the UI agent. Keeps export `createUi`.
 */
import type { CreateUi, UiApi } from '../core/contracts';

export const createUi: CreateUi = (root) => {
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:#cfe;font:16px sans-serif;background:rgba(0,10,20,.85);z-index:30';
  root.appendChild(layer);
  const menu = <T extends string>(title: string, items: [T, string][]) =>
    new Promise<T>((resolve) => {
      layer.style.display = 'flex';
      layer.innerHTML = `<h2>${title}</h2>`;
      for (const [id, label] of items) {
        const b = document.createElement('button');
        b.textContent = label;
        b.dataset.id = id;
        b.onclick = () => { layer.style.display = 'none'; resolve(id); };
        layer.appendChild(b);
      }
    });
  const ui: UiApi = {
    showSplash: () => menu('F35-A', [['start', 'TAP TO START']]).then(() => {}),
    showLoading(f, label) { layer.style.display = 'flex'; layer.innerHTML = `Loading ${label} ${(f * 100).toFixed(0)}%`; },
    hideLoading() { layer.style.display = 'none'; },
    showMainMenu: () => menu('F35-A', [['campaign', 'Campaign'], ['instant', 'Instant Action'], ['training', 'Training'], ['settings', 'Settings'], ['credits', 'Credits']]),
    showCampaign: (missions) => menu('Campaign', missions.map((m) => [m.id, m.title] as [string, string]).concat([['back', 'Back']])).then((id) => missions.find((m) => m.id === id) ?? null),
    showTraining: async () => null,
    showInstantAction: async () => ({ mode: 'dogfight', theater: 'desert', timeOfDay: 'day', weather: 'clear', enemyType: 'mig29', enemyCount: 2 }),
    showBriefing: (m) => menu(m.title, [['fly', 'FLY'], ['back', 'Back']]).then((id) => (id === 'fly' ? { loadout: m.recommendedLoadout } : null)),
    showSettings: async (s) => s,
    showPause: () => menu('Paused', [['resume', 'Resume'], ['restart', 'Restart'], ['quit', 'Quit']]),
    showDebrief: (r, next) => menu(r.success ? 'Mission Complete' : 'Mission Failed', [['retry', 'Retry'], ['menu', 'Menu'], ...(next ? ([['next', 'Next']] as ['next', string][]) : [])]),
    showCredits: async () => {},
    setRotateHint() {},
    toast() {},
    hideAll() { layer.style.display = 'none'; },
  };
  return ui;
};
