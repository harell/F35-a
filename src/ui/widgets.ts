/**
 * F35-A UI — reusable widgets: screen header, segmented control, toggle, slider, setting rows.
 */
import { icon } from './art/icons';
import { h } from './dom';

export function screenHeader(o: { kicker?: string; title: string; back?: () => void; backLabel?: string; right?: (Node | null)[] }): HTMLElement {
  const head = h('header', { class: 'scr-head' });
  if (o.back) {
    const b = h('button', { class: 'ui-btn icon-only back-btn', attrs: { 'aria-label': o.backLabel ?? 'Back', type: 'button' }, html: icon('back') });
    b.addEventListener('click', o.back);
    head.appendChild(b);
  }
  const t = h('div', { class: 'scr-title' });
  if (o.kicker) t.appendChild(h('div', { class: 'scr-kicker', text: o.kicker }));
  t.appendChild(h('h1', { text: o.title }));
  head.appendChild(t);
  for (const r of o.right ?? []) if (r) head.appendChild(r);
  return head;
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
  icon?: string;
  title?: string;
}

/** Segmented control; calls onChange with the new value. */
export function segmented<T extends string>(options: SegOption<T>[], value: T, onChange: (v: T) => void, cls = ''): HTMLElement & { set(v: T): void } {
  const wrap = h('div', { class: `seg ${cls}`, attrs: { role: 'radiogroup' } }) as unknown as HTMLElement & { set(v: T): void };
  const buttons: HTMLButtonElement[] = [];
  let cur = value;
  const sync = () => {
    for (const b of buttons) {
      const on = b.dataset.value === cur;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    }
  };
  for (const o of options) {
    const b = h('button', {
      attrs: { type: 'button', role: 'radio', title: o.title, 'aria-label': o.title ?? o.label },
      dataset: { value: o.value },
      html: `${o.icon ? icon(o.icon) : ''}<span>${o.label}</span>`,
    });
    b.addEventListener('click', () => {
      if (cur === o.value) return;
      cur = o.value;
      sync();
      onChange(o.value);
    });
    buttons.push(b);
    wrap.appendChild(b);
  }
  wrap.set = (v: T) => {
    cur = v;
    sync();
  };
  sync();
  return wrap;
}

export function toggle(on: boolean, onChange: (v: boolean) => void, label: string): HTMLButtonElement {
  const b = h('button', { class: `tgl ${on ? 'is-on' : ''}`, attrs: { type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': label } });
  let v = on;
  b.addEventListener('click', () => {
    v = !v;
    b.classList.toggle('is-on', v);
    b.setAttribute('aria-checked', String(v));
    onChange(v);
  });
  return b;
}

/** Range slider with a live value readout. */
export function slider(o: {
  min: number;
  max: number;
  step: number;
  value: number;
  label: string;
  format: (v: number) => string;
  onInput: (v: number) => void;
  onCommit?: (v: number) => void;
}): HTMLElement {
  const wrap = h('div', { class: 'sld' });
  const input = h('input', { class: 'rng', attrs: { type: 'range', min: o.min, max: o.max, step: o.step, 'aria-label': o.label } });
  input.value = String(o.value);
  const out = h('span', { class: 'sld-val mono', text: o.format(o.value) });
  const paint = () => {
    const v = Number(input.value);
    input.style.setProperty('--v', `${(((v - o.min) / (o.max - o.min)) * 100).toFixed(1)}%`);
    out.textContent = o.format(v);
  };
  input.addEventListener('input', () => {
    paint();
    o.onInput(Number(input.value));
  });
  input.addEventListener('change', () => o.onCommit?.(Number(input.value)));
  paint();
  wrap.append(input, out);
  return wrap;
}

/** A labelled settings row: title + optional description on the left, control on the right. */
export function settingRow(title: string, desc: string | null, control: Node, cls = ''): HTMLElement {
  const row = h('div', { class: `set-row ${cls}` });
  const txt = h('div', { class: 'set-txt' }, h('div', { class: 'set-title', text: title }), desc ? h('div', { class: 'set-desc', text: desc }) : null);
  row.append(txt, h('div', { class: 'set-ctl' }, control));
  return row;
}

/** Assign --i stagger indices to children. */
export function stagger(el: HTMLElement): HTMLElement {
  el.classList.add('stagger');
  Array.from(el.children).forEach((c, i) => (c as HTMLElement).style.setProperty('--i', String(i)));
  return el;
}
