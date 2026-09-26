/**
 * F35-A UI — difficulty chooser sheet (opened from the briefing's DIFFICULTY button): the four
 * levels with their short description and facts derived from the live DIFFICULTIES numbers.
 * Picking one updates the shared Settings object (the Game's own) and saves it; it applies to the
 * sortie about to be flown.
 */
import { DIFFICULTIES } from '../../core/data';
import type { Settings } from '../../core/types';
import { DIFFICULTY_ORDER, difficultyFacts, difficultyShort, setDifficulty } from '../career';
import { icon } from '../art/icons';
import { escapeHtml, h } from '../dom';

/** Opens the sheet inside `parent`; returns a close function (true if it was open). */
export function openDifficultySheet(parent: HTMLElement, settings: Settings, onClose: () => void): () => boolean {
  parent.querySelector('.dsheet')?.remove();
  const sheet = h('div', { class: 'dsheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose difficulty' } });
  const panel = h('div', { class: 'dsheet-panel ui-panel brk' });
  let open = true;
  const close = (): boolean => {
    if (!open) return false;
    open = false;
    sheet.classList.add('is-out');
    window.setTimeout(() => sheet.remove(), 160);
    onClose();
    return true;
  };
  const head = h('div', { class: 'dsheet-head', html: `<span class="dsheet-t">${icon('shield')} Difficulty</span><span class="dsheet-s">Applies to this sortie and is saved for the next ones</span>` });
  const x = h('button', { class: 'ui-btn icon-only dsheet-x', attrs: { type: 'button', 'aria-label': 'Close' }, html: icon('close') });
  x.addEventListener('click', () => close());
  head.appendChild(x);
  const grid = h('div', { class: 'dsheet-grid', attrs: { role: 'radiogroup' } });
  let focusEl: HTMLButtonElement | null = null;
  for (const id of DIFFICULTY_ORDER) {
    const d = DIFFICULTIES[id];
    if (!d) continue;
    const on = settings.difficulty === id;
    const b = h('button', {
      class: `dsheet-opt diff-card diff-${id} ${on ? 'is-on' : ''}`,
      attrs: { type: 'button', role: 'radio', 'aria-checked': String(on), 'aria-label': `${d.label}: ${difficultyShort(d)}` },
      dataset: { id },
      html:
        `<div class="dc-head"><span class="dc-name">${escapeHtml(d.label)}</span><span class="dc-mult mono">×${d.scoreMultiplier}</span></div>` +
        `<div class="dc-desc">${escapeHtml(difficultyShort(d))}</div>` +
        `<ul class="dc-facts">${difficultyFacts(d)
          .slice(0, 4)
          .map((f) => `<li>${escapeHtml(f)}</li>`)
          .join('')}</ul>`,
    });
    b.addEventListener('click', () => {
      setDifficulty(settings, id);
      close();
    });
    if (on) focusEl = b;
    grid.appendChild(b);
  }
  panel.append(head, grid);
  sheet.appendChild(panel);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) close();
  });
  parent.appendChild(sheet);
  requestAnimationFrame(() => (focusEl ?? x).focus());
  return close;
}
