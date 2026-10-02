/**
 * F35-A UI lab (dev only, served at /labs/ui-lab.html): renders one screen with mock data for visual checks.
 *   ?screen=splash|main|campaigns|campaign|training|instant|briefing|settings|pause|debrief|debrief-fail|credits|loading|rotate|toast|controls
 *   &mission=c01          mission for briefing / pause
 *   &tab=obj|hangar       briefing tab to open
 *   &stab=controls|audio|display  settings tab
 *   &next=<label>         debrief NEXT button label (default 'Next mission'; 'Next lesson', 'Start the campaign')
 *   &bg=<image url>       picture behind translucent screens (pause / controls)
 * Resolved values are printed to #log and window.__uiResult.
 */
import type { CampaignProgress, MissionResult, MissionRunnerApi } from '../../core/contracts';
import { DEFAULT_SETTINGS } from '../../core/data';
import { CAMPAIGN, CAMPAIGNS, SOUTHERN_CROSS, TRAINING, missionById } from '../../missions';
import { createInput } from '../../input/Input';
import { createUi } from '../Ui';

const q = new URLSearchParams(location.search);
const screen = q.get('screen') ?? 'main';
const log = document.getElementById('log') as HTMLDivElement;
const out = (v: unknown) => {
  (window as unknown as { __uiResult: unknown }).__uiResult = v;
  log.textContent = `result: ${JSON.stringify(v)}`;
};
const bg = q.get('bg');
if (bg) (document.getElementById('game') as HTMLDivElement).style.backgroundImage = `url(${bg})`;

const ui = createUi(document.getElementById('ui') as HTMLElement, { uiClick: () => undefined, build: 'dev' });
(window as unknown as { __ui: unknown }).__ui = ui;

const progress: CampaignProgress = {
  unlocked: ['c01', 'c02', 'c03', 'c04'],
  best: {
    c01: { score: 12450, grade: 'A', difficulty: 'pilot' },
    c02: { score: 9800, grade: 'B', difficulty: 'veteran' },
    c03: { score: 20100, grade: 'S', difficulty: 'ace' },
    t01: { score: 3000, grade: 'C', difficulty: 'recruit' },
  },
  totals: { missions: 3, airKills: 14, groundKills: 6, deaths: 1 },
};
const mission = missionById(q.get('mission') ?? 'c01') ?? CAMPAIGN[0];

const result = (success: boolean): MissionResult => ({
  missionId: mission.id,
  title: mission.title,
  success,
  reason: success ? 'All primary objectives complete. Harbour is clear.' : 'You were shot down by an SA-6 over Rangitoto.',
  difficulty: 'veteran',
  time: 412.6,
  score: success ? 18450 : 3200,
  grade: success ? 'A' : 'F',
  kills: { air: success ? 4 : 1, sam: success ? 2 : 0, ground: 1 },
  friendlyLosses: success ? 0 : 1,
  shotsFired: 9,
  hits: success ? 7 : 2,
  accuracy: success ? 7 / 9 : 2 / 9,
  damageTaken: success ? 22 : 100,
  objectives: [
    { id: 'a', label: 'Splash the MiG-29 sweep', state: 'complete', primary: true },
    { id: 'b', label: 'Splash the second MiG pair', state: success ? 'complete' : 'failed', primary: true },
    { id: 'c', label: 'Keep the MiGs off the North Shore', state: success ? 'complete' : 'failed', primary: false },
  ],
});

const fakeRunner = {
  def: mission,
  state: 'running',
  objectives: [
    { id: 'a', label: 'Splash the MiG-29 sweep', state: 'complete', primary: true, progress: { done: 2, total: 2 } },
    { id: 'b', label: 'Splash the second MiG pair', state: 'active', primary: true, progress: { done: 1, total: 2 } },
    { id: 'c', label: 'Keep the MiGs off the North Shore', state: 'active', primary: false },
    { id: 'd', label: 'Return to Whenuapai', state: 'pending', primary: true },
  ],
  waypoints: [],
  currentWaypoint: null,
  hint: 'Fire AMRAAM when SHOOT flashes — then keep the target in front',
} as unknown as MissionRunnerApi;

async function run(): Promise<void> {
  switch (screen) {
    case 'splash':
      await ui.showSplash();
      out('splash done');
      break;
    case 'main':
      out(await ui.showMainMenu());
      break;
    case 'campaigns':
      out((await ui.showCampaigns(CAMPAIGNS, progress))?.id ?? null);
      break;
    case 'campaign':
      out((await ui.showCampaign(SOUTHERN_CROSS, progress))?.id ?? null);
      break;
    case 'training':
      out((await ui.showTraining(TRAINING, progress))?.id ?? null);
      break;
    case 'instant':
      out(await ui.showInstantAction());
      break;
    case 'briefing': {
      const p = ui.showBriefing(mission, { ...DEFAULT_SETTINGS, difficulty: 'veteran' });
      const tab = q.get('tab');
      if (tab) setTimeout(() => (document.querySelectorAll<HTMLButtonElement>('.br-tab')[tab === 'obj' ? 1 : 2])?.click(), 50);
      out(await p);
      break;
    }
    case 'settings': {
      const p = ui.showSettings({ ...DEFAULT_SETTINGS, controlScheme: q.get('tilt') ? 'tilt' : 'stick' });
      const t = q.get('stab');
      const idx = { controls: 1, audio: 2, display: 3 }[t ?? ''] ?? 0;
      if (idx) setTimeout(() => document.querySelectorAll<HTMLButtonElement>('.set-tab')[idx]?.click(), 50);
      out(await p);
      break;
    }
    case 'pause':
      out(await ui.showPause(fakeRunner));
      break;
    case 'debrief':
      out(await ui.showDebrief(result(true), q.get('next') ?? 'Next mission'));
      break;
    case 'debrief-fail':
      out(await ui.showDebrief(result(false), null));
      break;
    case 'credits':
      await ui.showCredits();
      out('credits done');
      break;
    case 'loading':
      ui.showLoading(0.62, 'Generating terrain');
      break;
    case 'rotate':
      ui.setRotateHint(true);
      break;
    case 'toast':
      await ui.showMainMenu();
      break;
    case 'controls': {
      const input = createInput(document.getElementById('controls') as HTMLElement, { ...DEFAULT_SETTINGS, leftHanded: q.get('left') === '1', controlScheme: q.get('tilt') ? 'tilt' : 'stick' });
      input.setEnabled(true);
      const loop = () => {
        input.update(1 / 60, {
          dt: 1 / 60,
          time: 0,
          world: undefined as never,
          player: null,
          camera: undefined as never,
          viewMode: 'cockpit',
          focusId: null,
          mission: null,
          settings: DEFAULT_SETTINGS,
          quality: undefined as never,
          paused: false,
          screen: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
        });
        log.textContent = JSON.stringify(input.controls);
        requestAnimationFrame(loop);
      };
      loop();
      (window as unknown as { __input: unknown }).__input = input;
      break;
    }
  }
  if (screen === 'toast') ui.toast('Locked — complete the previous mission first');
}
void run();
if (screen === 'toast') setTimeout(() => ui.toast('Tilt calibrated — this is now level flight'), 200);
