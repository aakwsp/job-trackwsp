import { useEffect, useState, type RefObject } from 'react'

// Whether a `position: sticky` element is currently stuck. CSS can't say
// (and WebKitGTK has no scroll-state queries), so: stick the element at
// `top: -1px`; while stuck, its top pixel is clipped by the scroll
// container, so it's no longer fully visible, which an IntersectionObserver
// on that container reports. Used to draw a hairline only while stuck.
export function useStuck(ref: RefObject<HTMLElement | null>): boolean {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = scrollParent(el)
    const io = new IntersectionObserver(([e]) => setStuck(e.intersectionRatio < 1 && e.boundingClientRect.top < (e.rootBounds?.top ?? 0) + 1), {
      root,
      threshold: [1],
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
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
