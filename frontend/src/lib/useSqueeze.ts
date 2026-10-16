import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

// Whether a one-line toolbar band has to squeeze (JT-18): true when its
// contents at full size are wider than the band. The band never wraps;
// squeezed, the filter chips drop their text and the search boxes may
// shrink.
//
// How it measures: the band is `flex-nowrap` and, unsqueezed, nothing in
// it may shrink (`shrink-0`), so too much content overflows and
// `scrollWidth` (the content's width) exceeds `clientWidth` (the band's).
// That full width is remembered, and the band unsqueezes once it's at
// least that wide again. Without remembering it, squeezing would remove
// the overflow and the next check would unsqueeze, flickering forever.
//
// `contentKey` names what's in the band (the chips, the UI scale): when it
// changes, the band is measured again at full size. Resetting is done
// while rendering (React's "adjust state when a prop changes" pattern, not
// an effect): React re-renders straight away, before anything is shown.
// The measuring is a layout effect, which also runs before the browser
// paints, so the full-size try is never seen.
export function useSqueeze(ref: RefObject<HTMLElement | null>, contentKey: string): boolean {
  const [squeezed, setSqueezed] = useState(false)
  const [measuredFor, setMeasuredFor] = useState(contentKey)
  const needed = useRef(0)
  if (measuredFor !== contentKey) {
    setMeasuredFor(contentKey)
    setSqueezed(false)
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => {
      if (!squeezed) {
        if (el.scrollWidth > el.clientWidth) {
          needed.current = el.scrollWidth
          setSqueezed(true)
        }
      } else if (el.clientWidth >= needed.current) {
        setSqueezed(false)
      }
    }
    check()
    // Fires when the band itself changes size (the window narrowing).
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, squeezed, contentKey])

  return squeezed
}
