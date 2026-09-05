/**
 * Host device detection + UI scale policy.
 *
 * The Steam Deck's 7" 1280x800 panel is ~215 PPI, but SteamOS reports a
 * device pixel ratio of 1, so CSS pixels are ~2.5x smaller than on a desktop
 * monitor and the UI reads as tiny. CSS can't tell the difference (a 1280px
 * window on a monitor looks identical to the page), so the main process
 * decides: detect the Deck from its DMI product name and zoom the whole
 * renderer uniformly. The user can override in Settings → UI scale.
 *
 * No electron imports — unit-testable standalone.
 */
import * as fs from 'fs';

/** SteamOS exposes the board model here: "Jupiter" (LCD Deck), "Galileo" (OLED Deck). */
const DMI_PRODUCT_NAME = '/sys/devices/virtual/dmi/id/product_name';
const DECK_MODELS = /^(Jupiter|Galileo)\b/i;

export type UiScale = 'auto' | '100' | '125' | '150' | '175' | '200';
export const UI_SCALES: UiScale[] = ['auto', '100', '125', '150', '175', '200'];

/** Zoom applied when scale is "auto" on a Steam Deck (1.0 everywhere else). */
export const DECK_AUTO_ZOOM = 1.4;

let deckMemo: boolean | null = null;

/** True on a Steam Deck (LCD or OLED). `readFile` is injectable for tests. */
export function isSteamDeck(readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'), platform = process.platform): boolean {
  if (platform !== 'linux') return false;
  try {
    return DECK_MODELS.test(readFile(DMI_PRODUCT_NAME).trim());
  } catch {
    return false;
  }
}

export function isSteamDeckCached(): boolean {
  if (deckMemo === null) deckMemo = isSteamDeck();
  return deckMemo;
}

export function normalizeUiScale(value: unknown): UiScale {
  return (UI_SCALES as string[]).includes(String(value)) ? (value as UiScale) : 'auto';
}

/** The zoom factor a scale setting resolves to on this device. */
export function zoomForScale(scale: UiScale, deck: boolean): number {
  if (scale === 'auto') return deck ? DECK_AUTO_ZOOM : 1;
  return Number(scale) / 100;
}

/** Next explicit scale step from the current effective zoom (for Ctrl +/-). */
export function stepScale(currentZoom: number, direction: 1 | -1): UiScale {
  const steps = UI_SCALES.filter((s) => s !== 'auto') as UiScale[];
  const zooms = steps.map((s) => Number(s) / 100);
  // Index of the first step strictly above / below the current zoom.
  if (direction > 0) {
    const i = zooms.findIndex((z) => z > currentZoom + 1e-6);
    return i === -1 ? steps[steps.length - 1] : steps[i];
  }
  for (let i = zooms.length - 1; i >= 0; i--) if (zooms[i] < currentZoom - 1e-6) return steps[i];
  return steps[0];
}
