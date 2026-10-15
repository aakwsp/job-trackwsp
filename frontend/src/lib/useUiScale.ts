import { useEffect, useState } from 'react'
import { applyScale, loadScale, saveScale, stepScale, type Scale } from './scale'

/**
 * The current UI scale, kept in sync with <html>'s font-size and storage,
 * plus the ctrl +/- / ctrl 0 shortcuts. A custom hook is just a function
 * that calls other hooks — it lets App say `useUiScale()` instead of
 * carrying this state and both effects itself.
 */
export function useUiScale(): Scale {
  const [scale, setScale] = useState<Scale>(loadScale)

  // Whenever the scale changes: apply it to the page and remember it.
  useEffect(() => {
    applyScale(scale)
    saveScale(scale)
  }, [scale])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // metaKey too, so cmd works if this ever runs on a Mac.
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      // `=` is the unshifted key that carries `+` on most layouts; `+`
      // also covers the numpad.
      if (e.key === '=' || e.key === '+') setScale((s) => stepScale(s, 1))
      else if (e.key === '-' || e.key === '_') setScale((s) => stepScale(s, -1))
      else if (e.key === '0') setScale(1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return scale
}
