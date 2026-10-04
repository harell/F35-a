/**
 * F35-A UI — credits & licences.
 */
import { icon } from '../art/icons';
import { logoMark } from '../art/logo';
import { h } from '../dom';
import type { UiHost } from '../host';
import { screenHeader } from '../widgets';

const SECTIONS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Game',
    items: [
      ['F35-A', 'A mobile-browser combat flight simulator. Design, code and procedural art built with AI-assisted development.'],
      ['Setting', 'A fictional defence of Auckland (Tāmaki Makaurau), New Zealand. All scenarios are fiction.'],
      ['Inspiration', 'NovaLogic’s F-22 Raptor (1997) — mission-based campaign, AWACS radio calls, SAM-infested skies.'],
    ],
  },
  {
    title: 'Technology',
    items: [
      ['three.js', 'WebGL 3D engine by Ricardo Cabello (mrdoob) and contributors — MIT licence.'],
      ['Web Audio API', 'Engine, weapons, RWR tones and warnings synthesised in real time.'],
      ['Voices', 'Cockpit “Betty”, radio and AWACS voices generated offline with espeak-ng (GPL-3.0 tool; generated clips).'],
      ['B612 Mono', 'Cockpit display typeface by the B612 Project (Airbus / ENAC) — SIL Open Font License 1.1.'],
      ['Vite + TypeScript', 'Build tooling.'],
    ],
  },
  {
    title: 'Art & assets',
    items: [
      ['Procedural', 'Aircraft, terrain, clouds, cockpit, HMD symbology, menus, icons and the Auckland chart are generated in code.'],
      ['Textures', 'Water normals, lens flare and moon textures from the three.js examples (MIT). See docs/CREDITS.md.'],
      ['Map data', 'Auckland coastline, terrain, bush, harbour depths, roads, CBD buildings, the aerial photo of the CBD and waterfront, and the Herne Bay and Westhaven models (roofs, trees and boats from the 2024 LiDAR and aerial): sourced from the LINZ Data Service (Toitū Te Whenua Land Information New Zealand — NZ LiDAR 1m DEM, NZ Contour-Interpolated 8m DEM, NZ Native / Exotic / Scrub Polygons, Hydro depth areas (not for navigation), NZ Addresses: Road Sections, NZ Tunnel Centrelines, NZ Building Outlines, Auckland 0.075m Urban Aerial Photos (2024-2025)) and licensed for reuse under CC BY 4.0. Other landmarks hand-placed from public geography.'],
      ['OpenStreetMap', 'Airfield layouts (Whenuapai, Auckland Airport, Ardmore, North Shore), the port, marinas and wharves, Devonport Naval Base, the Wiri oil terminal, Eden Park, the Harbour Bridge piers, the Sky Tower model and the building outlines of Herne Bay and Westhaven — © OpenStreetMap contributors. Data available under the Open Database License (ODbL 1.0): openstreetmap.org/copyright.'],
    ],
  },
  {
    title: 'Disclaimer',
    items: [
      ['Not affiliated', 'F35-A Ratites is an independent fan project. It is not affiliated with, endorsed or sponsored by Lockheed Martin, the U.S. Air Force, the RNZAF or NovaLogic. “F-35” and “Lightning II” are used descriptively.'],
      ['Realism', 'Performance figures, ranges and tactics are simplified and compressed for gameplay.'],
    ],
  },
];

export function showCredits(host: UiHost, build: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const el = h('section', { class: 'scr-credits' });
    const finish = () => {
      if (done) return;
      done = true;
      host.leave(el);
      resolve();
    };
    el.appendChild(screenHeader({ kicker: `Build ${build}`, title: 'Credits', back: finish }));
    const body = h('div', { class: 'scr-body cr-body' });
    const side = h('div', { class: 'cr-side', html: `<div class="cr-emblem">${logoMark()}</div><div class="cr-word">F35<span>-</span>A</div><div class="cr-tag">RATITES</div>` });
    const list = h('div', { class: 'cr-list ui-panel ui-scroll' });
    for (const s of SECTIONS) {
      list.appendChild(h('div', { class: 'cr-h', text: s.title }));
      const dl = h('dl', { class: 'cr-dl' });
      for (const [k, v] of s.items) dl.append(h('dt', { text: k }), h('dd', { text: v }));
      list.appendChild(dl);
    }
    list.appendChild(h('div', { class: 'cr-thanks', html: `${icon('headphones')}<span>Thanks for flying. Check six.</span>` }));
    body.append(side, list);
    el.appendChild(body);
    const back = h('button', { class: 'ui-btn primary', attrs: { type: 'button' }, html: `${icon('back')}<span>Back</span>` });
    back.addEventListener('click', finish);
    el.appendChild(h('footer', { class: 'scr-foot' }, h('div', { class: 'spacer' }), back));
    host.present(el, { bg: true, back: finish, focus: back });
  });
}
