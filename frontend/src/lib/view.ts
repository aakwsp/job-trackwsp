export type ViewMode = 'default' | 'compact' | 'line'

export const VIEW_MODES: { mode: ViewMode; glyph: string; label: string }[] = [
  // Placeholder glyphs until real icons land.
  { mode: 'default', glyph: '⊞', label: 'default' },
  { mode: 'compact', glyph: '⁘', label: 'compact' },
  { mode: 'line', glyph: '≡', label: 'line' },
]

// Columns for the two card views, dropping one at a time as the window
// narrows and going to a single column under 700px. `min-[700px]:` is a
// Tailwind breakpoint: "apply this when the viewport is at least 700px".
//
// These have to be complete literal strings. Tailwind finds classes by
// scanning the source text, so building `min-[${w}px]:grid-cols-${n}` at
// runtime would produce class names it never generated CSS for.
export const GRID_COLS: Record<Exclude<ViewMode, 'line'>, string> = {
  default: 'grid-cols-1 min-[700px]:grid-cols-2 min-[1000px]:grid-cols-3',
  compact:
    'grid-cols-1 min-[700px]:grid-cols-2 min-[850px]:grid-cols-3 min-[1000px]:grid-cols-4 min-[1150px]:grid-cols-5',
}

const STORAGE_KEY = 'jt.view'

// localStorage lives in the webview's data dir, so it survives restarts.
// Wrapped in try/catch because storage can be unavailable, and a broken
// preference should never stop the list from rendering.
export function loadView(): ViewMode {
  try {
    // Map the names from before the rename so a saved choice survives it.
    const legacy: Record<string, ViewMode> = { grid: 'default', list: 'line' }
    const raw = localStorage.getItem(STORAGE_KEY)
    const saved = (raw && legacy[raw]) ?? raw
    if (VIEW_MODES.some((v) => v.mode === saved)) return saved as ViewMode
  } catch {
    // fall through to the default
  }
  return 'default'
}

export function saveView(v: ViewMode) {
  try {
    localStorage.setItem(STORAGE_KEY, v)
  } catch {
    // not worth surfacing; it just won't be remembered
  }
}
