/**
 * F35-A UI art — inline SVG icon set (24×24, stroke = currentColor). All hand-drawn, no assets.
 */

const P: Record<string, string> = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.2" fill="currentColor"/>',
  gear:
    '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3L5.5 5.5"/><circle cx="12" cy="12" r="6.4"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  retry: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4.5v4h4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  quit: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  jet: '<path d="M12 2.5l1.6 5.2 1.4 1.6 6.5 4.6v1.8l-6.8-2.1-.6 4.2 2.6 2v1.6L12 20.2l-4.7 1.2v-1.6l2.6-2-.6-4.2-6.8 2.1v-1.8L9 9.3l1.4-1.6z" fill="currentColor" stroke="none"/>',
  missile: '<path d="M5 19l9.5-9.5M14.5 9.5l2-5.5 3.5 3.5-5.5 2zM7.5 13.5l-3-1 2-2 3 1M10.5 16.5l1 3 2-2-1-3"/>',
  radar: '<path d="M12 12L19 5"/><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="16.5" cy="8.5" r="1" fill="currentColor"/>',
  sam: '<path d="M4 20h16M7 20l3-6h4l3 6M12 14V4M12 4l-2 3M12 4l2 3"/>',
  bomb: '<ellipse cx="12" cy="13" rx="4" ry="6.5"/><path d="M12 6.5V3M9 3h6M8.8 18.5L7 21M15.2 18.5L17 21"/>',
  shield: '<path d="M12 3l7 3v5.5c0 4.5-3 7.8-7 9.5-4-1.7-7-5-7-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
  // baby pram (A Stroll in the Park): hood, basket, push handle, two wheels
  pram: '<path d="M4 11h11a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M4 11a5.5 5.5 0 0 1 5.5-5.5V11"/><path d="M15 11l2.5-5.5H20"/><circle cx="8" cy="19" r="1.8"/><circle cx="14" cy="19" r="1.8"/>',
  waves: '<path d="M3 9c3-3 6 3 9 0s6 3 9 0M3 15c3-3 6 3 9 0s6 3 9 0"/>',
  dogfight: '<path d="M4 20l6-6M10 14l1.5-4.5L16 8l-1.5 4.5zM20 4l-4 4"/><path d="M14 20l6-6M20 20l-3-3"/>',
  pin: '<path d="M12 21s-6.5-5.9-6.5-11a6.5 6.5 0 0 1 13 0c0 5.1-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  dawn: '<path d="M3 18h18M6.5 18a5.5 5.5 0 0 1 11 0M12 5v4M9.5 7.5L12 5l2.5 2.5M4.6 12.4l1.6 1M19.4 12.4l-1.6 1"/>',
  day: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  dusk: '<path d="M3 18h18M6.5 18a5.5 5.5 0 0 1 11 0M12 5v4M9.5 6.5L12 9l2.5-2.5M4.6 12.4l1.6 1M19.4 12.4l-1.6 1"/>',
  night: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/><path d="M17 4.5v3M15.5 6h3" stroke-width="1.4"/>',
  clear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2" opacity=".7"/>',
  scattered: '<path d="M7.5 18.5h9a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6 1.2 2.9 2.9 0 0 0 .2 5.8z"/><path d="M16 5.5v1.5M20 9.5h-1.5M19 6.5l-1 1"/>',
  overcast: '<path d="M6.5 19h11a3.8 3.8 0 0 0 .4-7.6 5.6 5.6 0 0 0-10.8 1.3A3.2 3.2 0 0 0 6.5 19z"/><path d="M4 9.5a4.5 4.5 0 0 1 7.8-2.7"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M9.5 17h5v3h-5z"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3.5" y="14" width="4" height="6.5" rx="1.5"/><rect x="16.5" y="14" width="4" height="6.5" rx="1.5"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
  rotate: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M6.5 12h.01M17 9.5v5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.4"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  sound: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  display: '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 17v3"/>',
  gamepad: '<path d="M7 8h10a4 4 0 0 1 3.9 4.8l-.8 3.9a2 2 0 0 1-3.4.9L14.5 15h-5l-2.2 2.6a2 2 0 0 1-3.4-.9l-.8-3.9A4 4 0 0 1 7 8z"/><path d="M8 11v3M6.5 12.5h3"/><circle cx="16" cy="11.5" r=".8" fill="currentColor"/><circle cx="17.5" cy="13.5" r=".8" fill="currentColor"/>',
  hand: '<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a5 5 0 0 1-4-2l-2.8-3.8a1.5 1.5 0 0 1 2.3-1.9L8 14"/>',
  skull: '<path d="M12 3a7 7 0 0 0-7 7c0 2.6 1.3 4.4 3 5.4V19h8v-3.6c1.7-1 3-2.8 3-5.4a7 7 0 0 0-7-7z"/><circle cx="9.3" cy="11" r="1.5"/><circle cx="14.7" cy="11" r="1.5"/><path d="M10.5 19v2M13.5 19v2"/>',
  crosshair: '<circle cx="12" cy="12" r="8"/><path d="M12 4v5M12 15v5M4 12h5M15 12h5"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  paw: '<path d="M12 12.5c-2.6 0-5 2.6-5 4.8 0 1.5 1.2 2.2 2.6 2.2 1 0 1.6-.5 2.4-.5s1.4.5 2.4.5c1.4 0 2.6-.7 2.6-2.2 0-2.2-2.4-4.8-5-4.8z"/><ellipse cx="6" cy="10" rx="1.6" ry="2.1"/><ellipse cx="9.6" cy="6.4" rx="1.6" ry="2.2"/><ellipse cx="14.4" cy="6.4" rx="1.6" ry="2.2"/><ellipse cx="18" cy="10" rx="1.6" ry="2.1"/>',
};

export type IconName = keyof typeof P;

export function icon(name: string, cls = ''): string {
  const body = P[name] ?? P.info;
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
