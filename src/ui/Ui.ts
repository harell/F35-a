/**
 * F35-A — menus & overlays (UI module). Exports `createUi` (see core/contracts.ts UiApi).
 *
 *   host.ts              layers, transitions, back/Escape, spatial focus (keys + gamepad), click sound
 *   screens/*            splash, main menu (+ first-launch Training prompt, pilot card), service record
 *                        (rank, stats, medals), campaign/training (+ "complete Training" nudge), instant
 *                        action, briefing (+ intel map, difficulty sheet), settings, pause, debrief (+ tips,
 *                        medals, Retry on Recruit), campaign ending, credits
 *   career.ts            pure helpers: difficulty facts from DIFFICULTIES, onboarding flag, rank, medal tally
 *   overlays.ts          loading (progress + tips), rotate-your-phone, toasts
 *   art/*                logo, F-35 planform, icons, Auckland chart, animated menu background
 *   styles/*.css         the look (dark glass, cyan accent, military avionics)
 */
import type { CampaignProgress, CreateUi, UiApi } from '../core/contracts';
import { DIFFICULTIES } from '../core/data';
import { loadSettings } from '../core/settings';
import type { Settings } from '../core/types';
import { failStreak, loadProgress } from '../missions';
import { UiHost } from './host';
import { LoadingOverlay, RotateOverlay, Toasts } from './overlays';
import { showBriefing } from './screens/briefing';
import { showCredits } from './screens/credits';
import { showDebrief } from './screens/debrief';
import { showInstantAction } from './screens/instantAction';
import { showMainMenu } from './screens/mainMenu';
import { showCampaign, showTraining } from './screens/missionList';
import { showPause } from './screens/pause';
import { showSettings } from './screens/settings';
import { showSplash } from './screens/splash';
import './styles/base.css';
import './styles/screens.css';
import './styles/overlays.css';
import './styles/career.css';

export const createUi: CreateUi = (root, deps) => {
  const host = new UiHost(root, () => {
    try {
      deps.uiClick();
    } catch {
      /* audio not ready */
    }
  });
  const loading = new LoadingOverlay(host);
  const rotate = new RotateOverlay(host);
  const toasts = new Toasts(host);
  const toast = (t: string) => toasts.show(t);
  host.onPresent = () => toasts.clearStale();
  /** Settings opened from the pause menu are drawn translucent over the game. */
  let fromPause = false;
  /**
   * The Game's live Settings object (seen through showBriefing / returned by showSettings — Game
   * assigns that return value). Menus that change the difficulty mutate it and save it.
   */
  let live: Settings | null = null;
  /** Saved progress (Game records the result before the debrief); null if storage is unreadable. */
  const readProgress = (): CampaignProgress | null => {
    try {
      return loadProgress();
    } catch {
      return null;
    }
  };
  const liveSettings = (): Settings => {
    if (!live) {
      live = loadSettings();
      try {
        const pd = new URLSearchParams(location.search).get('difficulty');
        if (pd && pd in DIFFICULTIES) live.difficulty = pd as Settings['difficulty'];
      } catch {
        /* no location */
      }
    }
    return live;
  };

  const ui: UiApi = {
    showSplash: () => showSplash(host, deps.build),
    showLoading: (fraction, label) => loading.show(fraction, label),
    hideLoading: () => loading.hide(),
    showMainMenu: () => showMainMenu(host, deps.build, { settings: liveSettings, progress: readProgress }),
    showCampaign: (missions, progress) => showCampaign(host, missions, progress, toast),
    showTraining: (missions, progress) => showTraining(host, missions, progress, toast),
    showInstantAction: () => showInstantAction(host),
    showBriefing: (mission, settings) => {
      live = settings;
      return showBriefing(host, mission, settings);
    },
    showSettings: async (settings) => {
      const overlay = fromPause;
      fromPause = false;
      const before = settings.difficulty;
      const out = await showSettings(host, settings, toast, { overlay });
      // mid-sortie the running mission keeps the difficulty it was built with (Game.runSession)
      if (overlay && out.difficulty !== before) toast(`Difficulty: ${DIFFICULTIES[out.difficulty]?.label ?? out.difficulty} — applies from the next sortie or a restart`);
      live = out;
      return out;
    },
    showPause: async (mission) => {
      const choice = await showPause(host, mission);
      fromPause = choice === 'settings';
      return choice;
    },
    showDebrief: (result, hasNext) => {
      const p = readProgress();
      return showDebrief(host, result, hasNext, { settings: liveSettings, failStreak: p ? failStreak(p, result.missionId) : 0 });
    },
    showCredits: () => showCredits(host, deps.build),
    setRotateHint: (visible) => rotate.set(visible),
    toast,
    hideAll: () => {
      host.hideAll();
      loading.hide();
    },
  };
  return ui;
};
