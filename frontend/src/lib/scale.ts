// UI scale. Every size in the app is in rem, and 1rem = the font-size of
// <html>. So setting that one value (as a % of the browser default, 16px)
// scales all text, padding and widths together. Hairlines and the 3px
// stripe stay in px on purpose: they should stay crisp, not get thicker.
//
// Not scaled: the column breakpoints in lib/view.ts. Media queries measure
// rem against the browser default, never the root font-size, so at 125%
// cards get roomier text in the same number of columns, and grow taller to
// fit it.

export const SCALES = [0.9, 1, 1.1, 1.25] as const
export type Scale = (typeof SCALES)[number]

const STORAGE_KEY = 'jt.scale'

export function loadScale(): Scale {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY))
    const match = SCALES.find((s) => s === saved)
    if (match !== undefined) return match
  } catch {
    // fall through to the default
  }
  return 1
}

export function saveScale(s: Scale) {
  try {
    localStorage.setItem(STORAGE_KEY, String(s))
  } catch {
    // not worth surfacing; it just won't be remembered
  }
}

export function applyScale(s: Scale) {
  document.documentElement.style.fontSize = `${s * 100}%`
}

/** One step up (+1) or down (-1), clamped to the ends. */
export function stepScale(s: Scale, dir: 1 | -1): Scale {
  const i = SCALES.indexOf(s) + dir
  return SCALES[Math.min(Math.max(i, 0), SCALES.length - 1)]
}
