/**
 * F35-A UI — Codex view: a searchable, grouped list of entries on the left and the selected entry on
 * the right. Weapon pages lead with what the weapon is for ("Use it on"), then where it can be fired
 * (one range bar style for every weapon), the HUD labels, how to use it, a 3D Inspect / In-action
 * viewer, common mistakes and terms. Warning pages show the warning on a mock HMD and play its sound.
 * A cross-reference page rates every weapon against every target class. Pest pages (the IRGC's
 * army) show the pest's service record next to a 3D model you can turn, zoom and pan.
 * Used full screen from the main menu (screens/codex.ts) and as a sheet from the briefing and debrief.
 */
import { escapeHtml, h } from '../dom';
import { icon } from '../art/icons';
import {
  CODEX_CATS,
  CODEX_ENTRIES,
  IRGC_INTRO,
  MATRIX_WEAPONS,
  RATINGS,
  TARGET_CLASSES,
  THREAT_REFERENCE,
  classHits,
  codexEntry,
  entriesIn,
  hitsText,
  searchCodex,
  useOn,
  type CodexEntry,
  type PestEntry,
  type RangeSpec,
  type TargetClass,
  type WarningEntry,
  type WeaponEntry,
} from './data';
import { drawWarningDemo } from './hudDemo';
import { CodexTones } from './tones';
import { PestStage, pestDetail } from './pestStage';
import { CodexViewer } from './viewer3d';

/** Pseudo entry id of the weapon × target cross-reference page. */
export const MATRIX_ID = 'matrix';

export interface CodexView {
  el: HTMLElement;
  /** First control to focus for keyboard / gamepad users. */
  focusEl: HTMLElement | null;
  select(id: string): void;
  dispose(): void;
}

const CAT_NAME = Object.fromEntries(CODEX_CATS.map((c) => [c.id, c.name])) as Record<string, string>;

/** Default target class for the In-action view: the one the weapon is best at. */
function defaultClass(w: WeaponEntry): TargetClass | null {
  return useOn(w.id)[0]?.cls ?? null;
}

function fmt(v: number, unit: 'km' | 'm'): string {
  return unit === 'm' ? v.toLocaleString('en') : String(+v.toFixed(1));
}

/** The firing-range bar: too close (hatched), can fire, best zone, MIN / MAX marks. */
export function rangeSvg(r: RangeSpec): string {
  const L = 16;
  const R = 584;
  const y = 60;
  const x = (v: number) => L + ((R - L) * v) / r.scale;
  const step = r.unit === 'm' ? 400 : r.scale <= 10 ? 2 : r.scale <= 15 ? 3 : r.scale <= 35 ? 5 : 10;
  let ticks = '';
  for (let v = 0; v <= r.scale + 1e-6; v += step)
    ticks += `<line x1="${x(v)}" y1="${y + 10}" x2="${x(v)}" y2="${y + 15}" class="rk"/><text x="${x(v)}" y="${y + 28}" class="rt" text-anchor="middle">${fmt(v, r.unit)}</text>`;
  let row = 0;
  const mark = (v: number, txt: string, cls: string) => {
    const hy = row++ % 2 ? y - 34 : y - 14;
    const anchor = x(v) < 80 ? 'start' : x(v) > 520 ? 'end' : 'middle';
    return `<line x1="${x(v)}" y1="${hy - 4}" x2="${x(v)}" y2="${y + 9}" class="rm ${cls}"/><text x="${x(v)}" y="${hy - 8}" class="rl ${cls}" text-anchor="${anchor}">${escapeHtml(txt)}</text>`;
  };
  const can = `<rect x="${x(r.min)}" y="${y - 7}" width="${x(r.max) - x(r.min)}" height="14" rx="3" ${r.varMax ? 'fill="url(#cx-vg)"' : 'class="rcan"'}/>`;
  const best = r.best ? `<rect x="${x(r.best[0])}" y="${y - 7}" width="${x(r.best[1]) - x(r.best[0])}" height="14" rx="3" class="rbest"/>` : '';
  const dead = r.min > 0 ? `<rect x="${x(0)}" y="${y - 7}" width="${x(r.min) - x(0)}" height="14" fill="url(#cx-hz)"/>` : '';
  let marks = '';
  if (r.min > 0) marks += mark(r.min, `MIN ${fmt(r.min, r.unit)}`, 'mn');
  if (r.best && r.bestLabel) marks += mark(r.best[1], r.bestLabel, 'bs');
  if (r.mark) marks += mark(r.mark.at, r.mark.label, 'mk');
  marks += mark(r.max, `${r.varMax ? 'MAX ≈ ' : 'MAX '}${fmt(r.max, r.unit)}`, 'mx');
  return (
    `<svg viewBox="0 0 600 96" role="img" aria-label="Can fire from ${fmt(r.min, r.unit)} to ${fmt(r.max, r.unit)} ${r.unit}">` +
    `<defs><pattern id="cx-hz" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="rdead0"/><line x1="0" y1="0" x2="0" y2="6" class="rdead"/></pattern>` +
    `<linearGradient id="cx-vg"><stop offset="0" class="vg0"/><stop offset=".6" class="vg0"/><stop offset="1" class="vg1"/></linearGradient></defs>` +
    `<rect x="${L}" y="${y - 7}" width="${R - L}" height="14" rx="3" class="rtrack"/>${dead}${can}${best}` +
    `<line x1="${L}" y1="${y + 10}" x2="${R}" y2="${y + 10}" class="rk"/>${ticks}${marks}</svg>`
  );
}

function card(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'cx-card' }, h('h3', { text: title }), ...children);
}
function list(tag: 'ol' | 'ul', items: string[], cls: string): HTMLElement {
  return h(tag, { class: cls }, ...items.map((x) => h('li', { text: x })));
}
function dl(rows: [string, string][], cls: string, chip = false): HTMLElement {
  const d = h('dl', { class: cls });
  for (const [k, v] of rows) d.append(h('dt', null, chip ? h('span', { class: 'cx-chip hud', text: k }) : k), h('dd', { text: v }));
  return d;
}

export function buildCodex(opts: { initial?: string | null } = {}): CodexView {
  const el = h('div', { class: 'cx' });
  const nav = h('nav', { class: 'cx-nav ui-scroll', attrs: { 'aria-label': 'Codex entries' } });
  const detail = h('article', { class: 'cx-detail ui-scroll', attrs: { 'aria-live': 'polite' } });
  const search = h('input', { class: 'cx-search', attrs: { type: 'search', placeholder: 'Search', 'aria-label': 'Search the Codex' } });
  const listEl = h('div', { class: 'cx-list' });
  nav.append(search, listEl);
  el.append(nav, detail);

  const tones = new CodexTones();
  let viewer: CodexViewer | null = null;
  /** The pest viewer: alive only while a pest page is open (a model holds 5–8 MB). */
  let stage: PestStage | null = null;
  const stageCanvas = h('canvas', { class: 'cx-canvas cx-pcanvas' });
  let pestFur = true;
  let pestBuzz = false;
  const dropStage = () => {
    stage?.dispose();
    stage = null;
  };
  const viewCanvas = h('canvas', { class: 'cx-canvas' });
  const hudCanvas = h('canvas', { class: 'cx-canvas' });
  let hudRaf = 0;
  let mode: 'inspect' | 'action' = 'action';
  const classFor = new Map<string, string>();
  let current = opts.initial && (codexEntry(opts.initial) || opts.initial === MATRIX_ID) ? opts.initial : CODEX_ENTRIES[0].id;
  /** The one category open in the list (the cross-reference page sits under Gun & decoys). */
  const catOf = (id: string): string | null => (id === MATRIX_ID ? 'gun' : (codexEntry(id)?.cat ?? null));
  let openCat = catOf(current);
  let soundBtn: HTMLButtonElement | null = null;
  let soundTimer = 0;
  let disposed = false;

  const stopSound = () => {
    tones.stop();
    window.clearTimeout(soundTimer);
    if (soundBtn) {
      soundBtn.classList.remove('is-on');
      soundBtn.innerHTML = `${icon('sound')}<span>${soundBtn.dataset.label ?? 'Play'}</span>`;
      soundBtn = null;
    }
  };
  const soundButton = (label: string, play: () => number) => {
    const b = h('button', { class: 'ui-btn ghost cx-snd', attrs: { type: 'button' }, dataset: { label }, html: `${icon('sound')}<span>${label}</span>` });
    b.addEventListener('click', () => {
      if (soundBtn === b) return stopSound();
      stopSound();
      const dur = play();
      if (dur <= 0) return;
      soundBtn = b;
      b.classList.add('is-on');
      b.innerHTML = `${icon('pause')}<span>Stop</span>`;
      soundTimer = window.setTimeout(stopSound, dur * 1000 + 100);
    });
    return b;
  };

  const subOf = (e: CodexEntry) => (e.kind === 'weapon' ? e.hud[0][0] : e.kind === 'pest' ? e.latin : e.chip);

  /* ───────── list ───────── */
  const renderList = () => {
    // rebuilding the list drops focus; put it back on the same header or entry (keyboard / gamepad)
    const a = document.activeElement as HTMLElement | null;
    const refocus = a && listEl.contains(a) ? (a.dataset.cat ? `[data-cat="${a.dataset.cat}"]` : a.dataset.id ? `[data-id="${a.dataset.id}"]` : null) : null;
    listEl.innerHTML = '';
    const q = search.value;
    const item = (id: string, name: string, sub: string) => {
      const b = h('button', { class: `cx-item ${id === current ? 'is-on' : ''}`, attrs: { type: 'button', 'aria-current': id === current ? 'true' : undefined }, dataset: { id } });
      b.append(h('span', { class: 'cx-in', text: name }), h('span', { class: 'cx-is', text: sub }));
      b.addEventListener('click', () => select(id));
      return b;
    };
    if (q.trim()) {
      const hits = searchCodex(q);
      listEl.appendChild(h('div', { class: 'cx-grp', text: hits.length ? `${hits.length} found` : 'Nothing matches' }));
      for (const e of hits) listEl.appendChild(item(e.id, e.name, subOf(e)));
      if (refocus) listEl.querySelector<HTMLElement>(refocus)?.focus();
      return;
    }
    let group = '';
    for (const c of CODEX_CATS) {
      if (c.group !== group) {
        group = c.group;
        listEl.appendChild(h('div', { class: 'cx-grp cx-grp-top', text: group }));
      }
      // an accordion: only the open category lists its entries
      const open = c.id === openCat;
      const n = entriesIn(c.id).length + (c.id === 'gun' ? 1 : 0);
      const hd = h('button', {
        class: `cx-grp cx-cat ${open ? 'is-open' : ''}`,
        attrs: { type: 'button', 'aria-expanded': String(open) },
        dataset: { cat: c.id },
        html: `${icon(c.icon)}<span>${escapeHtml(c.name)}</span><span class="cx-cn">${n}</span>${icon('next')}`,
      });
      hd.addEventListener('click', () => {
        openCat = open ? null : c.id;
        renderList();
      });
      listEl.appendChild(hd);
      if (!open) continue;
      for (const e of entriesIn(c.id)) listEl.appendChild(item(e.id, e.name, subOf(e)));
      if (c.id === 'gun') listEl.appendChild(item(MATRIX_ID, 'Which weapon for which target', 'Cross-reference'));
    }
    if (refocus) listEl.querySelector<HTMLElement>(refocus)?.focus();
  };
  search.addEventListener('input', renderList);

  /* ───────── detail pages ───────── */
  const head = (kicker: string, title: string, line: string, extra?: Node | null) =>
    h('header', { class: 'cx-head' }, h('div', { class: 'cx-kicker', text: kicker }), h('h2', { text: title }), extra ?? null, line ? h('p', { class: 'cx-line', text: line }) : null);

  const weaponPage = (w: WeaponEntry) => {
    const out: Node[] = [head(CAT_NAME[w.cat], w.name, w.line)];
    if (w.id === 'cms') {
      const t = h('table', { class: 'cx-table' });
      t.innerHTML =
        '<thead><tr><th>Missile type</th><th>Fired by</th><th>What works</th></tr></thead><tbody>' +
        '<tr><td>Heat-seeking missiles</td><td>Air-defence boats</td><td>A hard turn across it, CMS late (last 3 s)</td></tr>' +
        '<tr><td>Heat-seeking missiles</td><td>Fighters\' short-range missiles</td><td>Flares, then break hard into it</td></tr>' +
        '<tr><td>Radar missiles</td><td>Most SAMs</td><td>Turn 90° to it, CMS every 2–3 s from about 6 s</td></tr>' +
        '<tr><td>Radar missiles</td><td>Fighters\' long-range missiles</td><td>Chaff, then turn 90° to it and dive</td></tr></tbody>';
      out.push(card('What it works against', t, h('p', { class: 'cx-note', text: 'An orange arrow in the MISSILE ring means a heat-seeker. One press drops both kinds, so you don\'t need to choose.' })));
    } else {
      const uses = useOn(w.id);
      const ul = h('ul', null);
      for (const u of uses) {
        ul.appendChild(
          h('li', null, h('span', { class: `cx-dot ${u.rating}` }), h('b', { text: u.cls.name }), h('span', { class: 'cx-hits', text: u.hits }), h('span', { class: 'cx-why', text: u.why })),
        );
      }
      out.push(h('div', { class: 'cx-useon' }, h('span', { class: 'cx-ul', text: 'Use it on' }), ul));
    }
    if (w.range) {
      const r = w.range;
      const rng = h('div', { class: 'cx-range', html: rangeSvg(r) });
      const legend = h('div', {
        class: 'cx-rleg',
        html: `<span><i class="k dead"></i>Too close</span><span><i class="k can"></i>Can fire</span>${r.best ? '<span><i class="k best"></i>Best</span>' : ''}<span class="u">${r.unit === 'm' ? 'metres' : 'kilometres'}</span>`,
      });
      out.push(card('Where you can fire it', rng, legend, h('p', { class: 'cx-needs', text: w.needs })));
    }
    out.push(h('div', { class: 'cx-cols' }, card('On your HUD', dl(w.hud, 'cx-hud', true)), card('How to use it', list('ol', w.how, 'cx-steps'))));
    out.push(viewerBlock(w));
    out.push(card('Common mistakes', list('ul', w.avoid, 'cx-avoid')));
    if (w.terms.length) out.push(h('footer', { class: 'cx-terms' }, h('div', { class: 'cx-kicker', text: 'Terms' }), dl(w.terms, 'cx-tdl')));
    return out;
  };

  const viewerBlock = (w: WeaponEntry): HTMLElement => {
    const wrap = h('div', { class: 'cx-vwrap' });
    const box = h('div', { class: 'cx-viewer' });
    const bar = h('div', { class: 'cx-vbar' });
    const foot = h('div', { class: 'cx-vfoot' });
    const hint = h('div', { class: 'cx-vhint' });
    const res = h('div', { class: 'cx-vout' });
    foot.append(hint, res);
    wrap.append(box, foot);
    if (!viewer) viewer = new CodexViewer(viewCanvas, { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
    if (!viewer.ok) {
      box.appendChild(h('div', { class: 'cx-nogl', text: '3D view needs WebGL.' }));
      return wrap;
    }
    box.append(viewCanvas, bar);
    const segBtn = (m: 'inspect' | 'action', label: string) => {
      const b = h('button', { attrs: { type: 'button', 'aria-pressed': String(mode === m) }, text: label });
      b.addEventListener('click', () => {
        if (mode === m) return;
        mode = m;
        render();
      });
      return b;
    };
    bar.appendChild(h('div', { class: 'cx-seg', attrs: { role: 'group', 'aria-label': 'View' } }, segBtn('inspect', 'Inspect'), segBtn('action', 'In action')));
    const classes = useOn(w.id).map((u) => u.cls);
    let cls: TargetClass | null = null;
    if (mode === 'action' && w.id !== 'cms' && classes.length) {
      const pick = h('select', { class: 'cx-sel', attrs: { 'aria-label': 'Target' } });
      for (const c of classes) pick.appendChild(h('option', { attrs: { value: c.id }, text: c.name }));
      const saved = classFor.get(w.id) ?? defaultClass(w)?.id;
      if (saved) pick.value = saved;
      cls = TARGET_CLASSES.find((c) => c.id === pick.value) ?? classes[0];
      pick.addEventListener('change', () => {
        classFor.set(w.id, pick.value);
        cls = TARGET_CLASSES.find((c) => c.id === pick.value) ?? null;
        viewer?.show(w, mode, cls);
      });
      bar.appendChild(pick);
    }
    if (mode === 'action') {
      const again = h('button', { class: 'cx-vbtn', attrs: { type: 'button' }, html: `${icon('retry')}<span>Replay</span>` });
      again.addEventListener('click', () => viewer?.replay());
      bar.appendChild(again);
    }
    if (w.id === 'aim9x') bar.appendChild(soundButton('Seeker tone', () => tones.growl()));
    hint.textContent = mode === 'inspect' ? `${w.inspect} Drag to rotate.` : 'Models enlarged to be visible. Blast rings are to scale: one grid square is 50 m.';
    // the viewer reports into this page's result line
    viewer.onResult = (html) => {
      res.innerHTML = html ?? (mode === 'action' ? '<span class="wait">The result shows when the weapon hits.</span>' : '');
    };
    viewer.show(w, mode, cls);
    return wrap;
  };

  const warningPage = (e: WarningEntry) => {
    const chip = h('div', { class: 'cx-row' }, h('span', { class: `cx-chip ${e.level}`, text: e.chip }), e.voiceText ? h('span', { class: 'cx-tag', text: `Voice: “${e.voiceText}”` }) : null);
    const out: Node[] = [head(CAT_NAME[e.cat], e.name, e.line, chip)];
    const demo = h('div', { class: 'cx-viewer cx-hudv' }, hudCanvas);
    if (e.sound !== 'none' || e.voice) {
      demo.appendChild(
        h(
          'div',
          { class: 'cx-vbar' },
          soundButton('Play sound', () => tones.play(e.sound, e.voice)),
        ),
      );
    }
    out.push(demo);
    if (e.reference) {
      const t = h('table', { class: 'cx-table' });
      t.innerHTML =
        '<thead><tr><th>Symbol</th><th>Threat type</th><th>Reach</th><th>Note</th></tr></thead><tbody>' +
        THREAT_REFERENCE.map((r) => `<tr><td class="cx-sym">${escapeHtml(r[0])}</td><td>${escapeHtml(r[1])}</td><td>${escapeHtml(r[2])}</td><td>${escapeHtml(r[3])}</td></tr>`).join('') +
        '</tbody>';
      out.push(card('Symbols', t, h('p', { class: 'cx-note', text: 'Enemy radars see a clean, stealthy F-35 at about a quarter of their normal range, and at about half with external weapons. Dim symbol: searching. Amber diamond: tracking you. Red blinking circle: guiding a missile at you.' })));
    } else {
      const trig = card('What triggers it', h('p', { class: 'cx-p', text: e.trigger }), e.notes.length ? list('ul', e.notes, 'cx-avoid') : null);
      out.push(h('div', { class: 'cx-cols' }, trig, card('What to do', list('ol', e.how, 'cx-steps'))));
    }
    startHud(e.id);
    return out;
  };

  const pestPage = (p: PestEntry) => {
    const tags = h('div', { class: 'cx-row' }, h('span', { class: 'cx-chip pest', text: p.rank }), h('span', { class: 'cx-tag cx-latin', text: `${p.latin} · ${p.mass}` }));
    const out: Node[] = [head('IRGC · the pest army', p.name, p.line, tags)];

    const wrap = h('div', { class: 'cx-vwrap' });
    const box = h('div', { class: 'cx-viewer cx-pview' });
    const bar = h('div', { class: 'cx-vbar' });
    const foot = h('div', { class: 'cx-vfoot' });
    const hint = h('div', { class: 'cx-vhint', text: 'Drag to turn it, scroll or pinch to zoom, right-drag or two-finger drag to pan.' });
    const res = h('div', { class: 'cx-vout' });
    foot.append(hint, res);
    wrap.append(box, foot);
    if (!stage) stage = new PestStage(stageCanvas, { detail: pestDetail() });
    if (!stage.ok) {
      dropStage();
      box.appendChild(h('div', { class: 'cx-nogl', text: '3D view needs WebGL.' }));
    } else {
      const toggle = (label: string, on: boolean, set: (v: boolean) => void) => {
        const b = h('button', { class: 'cx-vbtn', attrs: { type: 'button', 'aria-pressed': String(on) }, text: label });
        b.addEventListener('click', () => {
          const v = b.getAttribute('aria-pressed') !== 'true';
          b.setAttribute('aria-pressed', String(v));
          set(v);
        });
        return b;
      };
      bar.appendChild(
        toggle(p.id === 'wasp' ? 'Hairs' : 'Fur', pestFur, (v) => {
          pestFur = v;
          stage?.setFur(v);
        }),
      );
      if (p.id === 'wasp')
        bar.appendChild(
          toggle('Wing beat', pestBuzz, (v) => {
            pestBuzz = v;
            stage?.setBuzz(v);
          }),
        );
      const reset = h('button', { class: 'cx-vbtn', attrs: { type: 'button' }, html: `${icon('retry')}<span>Reset view</span>` });
      reset.addEventListener('click', () => stage?.view());
      bar.appendChild(reset);
      box.append(stageCanvas, bar);
      res.innerHTML = '<span class="wait">Sculpting the model…</span>';
      stage.setFur(pestFur);
      stage.setBuzz(p.id === 'wasp' && pestBuzz);
      stage.setSpin(!matchMedia('(prefers-reduced-motion: reduce)').matches);
      void stage.show(p.id).then((r) => {
        if (!r || current !== p.id) return;
        const len = Math.max(r.size.x, r.size.z);
        const real = len < 0.1 ? `${(len * 1000).toFixed(0)} mm` : `${(len * 100).toFixed(0)} cm`;
        res.innerHTML = `<span>True size: <b>${real}</b> ${p.id === 'wasp' ? 'across its legs and antennae' : 'nose to tail'}</span>`;
      });
    }
    out.push(wrap);

    out.push(h('div', { class: 'cx-cols' }, card('Service record', dl(p.service, 'cx-tdl')), card('Field record', list('ul', p.record, 'cx-avoid'))));
    out.push(card('On the model', h('p', { class: 'cx-p', text: p.model })));
    out.push(
      h(
        'footer',
        { class: 'cx-terms' },
        h('div', { class: 'cx-kicker', text: 'About the IRGC' }),
        h('p', { class: 'cx-note', text: IRGC_INTRO }),
        p.pf2050 ? null : h('p', { class: 'cx-note', text: 'Wasps are not on the Predator Free 2050 list, so the Air Wing fights on as an unofficial ally. DOC controls them separately.' }),
      ),
    );
    return out;
  };

  const matrixPage = () => {
    const out: Node[] = [head('Cross-reference', 'Which weapon for which target', 'A cell is filled where the weapon is the right tool or works well, with the usual number of hits.')];
    const t = h('table', { class: 'cx-table cx-mx' });
    let html = `<thead><tr><th>Target</th>${MATRIX_WEAPONS.map((id) => `<th>${escapeHtml(codexEntry(id)?.kind === 'weapon' ? (codexEntry(id) as WeaponEntry).short : id)}</th>`).join('')}</tr></thead><tbody>`;
    for (const c of TARGET_CLASSES) {
      html += `<tr><td><b>${escapeHtml(c.name)}</b>${c.examples ? `<small>${escapeHtml(c.examples)}</small>` : ''}</td>`;
      for (const id of MATRIX_WEAPONS) {
        const [r, why] = RATINGS[id][c.id];
        html +=
          r === 'best' || r === 'good'
            ? `<td title="${escapeHtml(why)}"><span class="cx-rt ${r}">${r === 'best' ? 'Best' : 'Good'}</span><small>${escapeHtml(hitsText(classHits(id, c)))}</small></td>`
            : '<td class="cx-na" aria-label="Not for this">·</td>';
      }
      html += '</tr>';
    }
    t.innerHTML = html + '</tbody>';
    const wrap = h('div', { class: 'cx-mxwrap' }, t);
    out.push(wrap, h('p', { class: 'cx-note', html: '<span class="cx-rt best">Best</span> the right tool · <span class="cx-rt good">Good</span> works · a dot means it\'s not what the weapon is for.' }));
    return out;
  };

  const startHud = (id: string) => {
    cancelAnimationFrame(hudRaf);
    const t0 = performance.now();
    const loop = (now: number) => {
      hudRaf = 0;
      if (disposed || !hudCanvas.isConnected) return;
      const r = hudCanvas.getBoundingClientRect();
      if (r.width > 0) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.round(r.width * dpr);
        const hh = Math.round(r.height * dpr);
        if (hudCanvas.width !== w || hudCanvas.height !== hh) {
          hudCanvas.width = w;
          hudCanvas.height = hh;
        }
        const c = hudCanvas.getContext('2d');
        if (c) drawWarningDemo(c, w, hh, (now - t0) / 1000, id);
      }
      hudRaf = requestAnimationFrame(loop);
    };
    hudRaf = requestAnimationFrame(loop);
  };

  const render = () => {
    stopSound();
    cancelAnimationFrame(hudRaf);
    detail.innerHTML = '';
    let nodes: Node[];
    if (current === MATRIX_ID) nodes = matrixPage();
    else {
      const e = codexEntry(current) as CodexEntry;
      nodes = e.kind === 'weapon' ? weaponPage(e) : e.kind === 'pest' ? pestPage(e) : warningPage(e);
    }
    // leaving the pest pages frees the model and its WebGL context
    if (!(codexEntry(current)?.kind === 'pest')) dropStage();
    detail.append(...nodes);
    detail.scrollTop = 0;
  };

  const select = (id: string) => {
    if (!codexEntry(id) && id !== MATRIX_ID) return;
    current = id;
    openCat = catOf(id);
    renderList();
    render();
  };

  renderList();
  render();

  return {
    el,
    get focusEl() {
      return listEl.querySelector<HTMLElement>('.cx-item.is-on') ?? search;
    },
    select,
    dispose: () => {
      disposed = true;
      stopSound();
      tones.dispose();
      cancelAnimationFrame(hudRaf);
      viewer?.dispose();
      viewer = null;
      dropStage();
    },
  };
}
