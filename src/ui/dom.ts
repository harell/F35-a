/**
 * F35-A UI — tiny DOM builder helpers (no framework).
 */

type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
  dataset?: Record<string, string>;
}

/** h('div', {class: 'x'}, child1, 'text', ...) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.text != null) el.textContent = props.text;
    if (props.html != null) el.innerHTML = props.html;
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) {
        if (v === undefined || v === false) continue;
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (props.style) Object.assign(el.style, props.style);
    if (props.dataset) Object.assign(el.dataset, props.dataset);
    if (props.on) {
      for (const [k, fn] of Object.entries(props.on)) el.addEventListener(k, fn as EventListener);
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
  return el;
}

/** Parse trusted static SVG/HTML markup into an element. */
export function svg(markup: string): Element {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as Element;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
