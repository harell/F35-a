/**
 * F35-A UI art — city landmark emblems for the Instant Action city picker (120×150 elevations,
 * stroke = currentColor so a locked city can grey out by colour alone). Hand-drawn, no assets.
 */

export type LandmarkId = 'skyTower' | 'beehive' | 'cathedral';

const P: Record<LandmarkId, string> = {
  // Auckland — Sky Tower: shaft, observation pod, upper deck, mast and aviation light, over city blocks.
  skyTower:
    '<g fill="rgba(5,14,20,0.6)" stroke-opacity="0.35"><rect x="6" y="112" width="18" height="30"/><rect x="26" y="98" width="15" height="44"/><rect x="76" y="104" width="16" height="38"/><rect x="94" y="118" width="20" height="24"/></g>' +
    '<g fill="currentColor" fill-opacity="0.14" stroke-width="2.4"><path d="M54 142L56.5 66h7L66 142z"/><path d="M50 66h20l4-8v-5l-4-4H50l-4 4v5z"/><path d="M53 49h14l-2-6H55z"/><path d="M57.5 43h5l-.9-13h-3.2z"/></g>' +
    '<path d="M60 30V7" stroke-width="2.4"/><circle cx="60" cy="6" r="2.6" fill="#ff5a4a" stroke="none"/>',
  // Wellington — the Beehive: stepped drum tiers under a low dome.
  beehive:
    '<g fill="currentColor" fill-opacity="0.14" stroke-width="2.2"><rect x="10" y="131" width="100" height="11"/><rect x="16" y="120" width="88" height="11"/><rect x="21" y="109" width="78" height="11"/><rect x="26" y="98" width="68" height="11"/><rect x="31" y="87" width="58" height="11"/><rect x="36" y="76" width="48" height="11"/><rect x="41" y="65" width="38" height="11"/><path d="M39 65q21-19 42 0z"/></g>' +
    '<path d="M60 55.5V45" stroke-width="2.2"/>',
  // Christchurch — ChristChurch Cathedral: tower and spire beside the nave, lancet windows.
  cathedral:
    '<g fill="currentColor" fill-opacity="0.14" stroke-width="2.2"><path d="M40 142v-42l6-14h60l6 14v42z"/><rect x="18" y="72" width="22" height="70"/><path d="M21 72l8-54 8 54z"/></g>' +
    '<g stroke-width="2"><path d="M50 134v-16a4 4 0 0 1 8 0v16"/><path d="M70 134v-16a4 4 0 0 1 8 0v16"/><path d="M90 134v-16a4 4 0 0 1 8 0v16"/></g>',
};

export function landmark(id: LandmarkId): string {
  return `<svg class="landmark" viewBox="0 0 120 150" fill="none" stroke="currentColor" stroke-linejoin="round" aria-hidden="true">${P[id]}</svg>`;
}
