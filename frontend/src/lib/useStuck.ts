import { useEffect, useState, type RefObject } from 'react'

// Whether a `position: sticky` element is currently stuck. CSS can't say
// (and WebKitGTK has no scroll-state queries), so: stick the element at
// `top: -1px`; while stuck, its top pixel is clipped by the scroll
// container, so it's no longer fully visible, which an IntersectionObserver
// on that container reports. Used to draw a hairline only while stuck.
// `offset`: where it sticks (px from the top) when that isn't 0, e.g. under
// a sticky toolbar; the observed area starts there.
export function useStuck(ref: RefObject<HTMLElement | null>, offset = 0): boolean {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = scrollParent(el)
    const io = new IntersectionObserver(([e]) => setStuck(e.intersectionRatio < 1 && e.boundingClientRect.top < (e.rootBounds?.top ?? 0) + 1), {
      root,
      rootMargin: `-${offset}px 0px 0px 0px`,
      threshold: [1],
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, offset])
  return stuck
}

/** The nearest ancestor that scrolls vertically (or null = the viewport). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}
