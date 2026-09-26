/**
 * PCD zoom — shared state between the 3D cockpit (which receives the taps) and the HUD overlay (which
 * draws the zoomed page).
 *
 * In the cockpit view the panoramic cockpit display is small on a phone. Tapping one of its portals
 * opens that portal's page as a large, crisp 2D overlay (drawn by the HUD in CSS pixels with the same
 * page renderers). A row of tabs along the bottom of the overlay switches the portal's page; tapping
 * anywhere else (or leaving the cockpit view) closes it. Pure state: unit tested.
 */
import type { PageId } from './pages';

export interface ZoomRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_ZOOM_TABS = 6;

export class PcdZoomState {
  /** Zoomed portal index (-1 = closed). */
  portal = -1;
  /** Pages of the zoomed portal (live reference) and the one on show. */
  pages: readonly PageId[] = [];
  index = 0;
  /** Overlay + tab rectangles in CSS px, written by the HUD every frame it draws the overlay. */
  readonly rect: ZoomRect = { x: 0, y: 0, w: 0, h: 0 };
  readonly tabs: ZoomRect[] = Array.from({ length: MAX_ZOOM_TABS }, () => ({ x: 0, y: 0, w: 0, h: 0 }));
  tabCount = 0;
  /** Seconds the overlay has been open (HUD animation). */
  age = 0;

  get open(): boolean {
    return this.portal >= 0;
  }

  get page(): PageId | null {
    return this.portal >= 0 ? this.pages[this.index] ?? null : null;
  }

  openPortal(portal: number, pages: readonly PageId[], index: number): void {
    this.portal = portal;
    this.pages = pages;
    this.index = Math.max(0, Math.min(pages.length - 1, index));
    this.tabCount = 0;
    this.rect.w = this.rect.h = 0;
    this.age = 0;
  }

  close(): void {
    this.portal = -1;
    this.tabCount = 0;
    this.rect.w = this.rect.h = 0;
  }

  /** Tab index under (x, y) CSS px, or -1. Only valid once the HUD has laid the overlay out. */
  tabAt(x: number, y: number): number {
    for (let i = 0; i < this.tabCount; i++) {
      const t = this.tabs[i];
      if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) return i;
    }
    return -1;
  }
}

/** The one zoom state (one cockpit per session, one HUD). */
export const pcdZoom = new PcdZoomState();
