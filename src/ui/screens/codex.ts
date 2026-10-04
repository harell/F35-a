/**
 * F35-A UI — Codex: the weapons and warnings knowledge base (codex/view.ts).
 *   showCodex        full screen, from the main menu
 *   openCodexSheet   over another screen (the briefing's "?" next to a store, the debrief's "learn" link);
 *                    returns a close function so that screen's Back closes the sheet first
 */
import { icon } from '../art/icons';
import { buildCodex } from '../codex/view';
import { h } from '../dom';
import type { UiHost } from '../host';
import { screenHeader } from '../widgets';

export function showCodex(host: UiHost, initial?: string | null): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const el = h('section', { class: 'scr-codex' });
    const codex = buildCodex({ initial });
    const finish = () => {
      if (done) return;
      done = true;
      codex.dispose();
      host.leave(el);
      resolve();
    };
    el.appendChild(screenHeader({ kicker: 'Weapons · warnings · threats', title: 'Codex', back: finish }));
    el.appendChild(h('div', { class: 'scr-body cx-body' }, codex.el));
    host.present(el, { bg: true, back: finish, focus: codex.focusEl });
  });
}

/** Opens the Codex inside `parent` at an entry; returns a close function (true if it was open). */
export function openCodexSheet(parent: HTMLElement, initial: string, onClose?: () => void): () => boolean {
  parent.querySelector('.cx-sheet')?.remove();
  const sheet = h('div', { class: 'cx-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Codex' } });
  const panel = h('div', { class: 'cx-sheet-panel ui-panel brk' });
  const codex = buildCodex({ initial });
  let open = true;
  const close = (): boolean => {
    if (!open) return false;
    open = false;
    codex.dispose();
    sheet.classList.add('is-out');
    window.setTimeout(() => sheet.remove(), 160);
    onClose?.();
    return true;
  };
  const x = h('button', { class: 'ui-btn icon-only cx-sheet-x', attrs: { type: 'button', 'aria-label': 'Close the Codex' }, html: icon('close') });
  x.addEventListener('click', () => close());
  panel.append(h('div', { class: 'cx-sheet-head', html: `<span class="cx-sheet-t">${icon('book')} Codex</span>` }, x), codex.el);
  sheet.appendChild(panel);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) close();
  });
  parent.appendChild(sheet);
  requestAnimationFrame(() => (codex.focusEl ?? x).focus({ preventScroll: true }));
  return close;
}
