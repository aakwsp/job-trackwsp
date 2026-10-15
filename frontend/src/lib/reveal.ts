import { createContext, useCallback, useContext } from 'react'
import { prefersReducedMotion } from './motion'

// Scroll-in reveal for city bands, cards and rows.
//
// One IntersectionObserver per page visit watches every unrevealed element.
// When a batch scrolls into view it marks each one `data-shown` (CSS plays
// the rise animation, `.rise` in index.css), staggered 40ms apart and
// capped at 8 steps, then stops watching it. The observer writes to the DOM
// directly instead of setting React state, so a batch of 30 cards entering
// doesn't re-render 30 components.
//
// `shown` remembers what has revealed. It lives here rather than in each
// card because DEFAULT / COMPACT / LINE remount every card: a remounted card
// asks `shown` and renders already-revealed (no replay). App mounts a new
// RevealProvider (components/) per route, so returning to a view starts from scratch.

const STAGGER_MS = 40
const MAX_STEPS = 8
// Elements revealed right after the page appears wait for the hero and the
// toolbar (index.css `.enter`) to rise in first.
const PAGE_ENTRY_WINDOW_MS = 400
const PAGE_ENTRY_DELAY_MS = 240

export type Revealer = {
  shown: Set<string>
  observe: (el: Element, id: string) => void
  unobserve: (el: Element) => void
}

export function createRevealer(): Revealer {
  const shown = new Set<string>()
  const ids = new WeakMap<Element, string>()
  const created = performance.now()

  const io = new IntersectionObserver((entries) => {
    const base = performance.now() - created < PAGE_ENTRY_WINDOW_MS ? PAGE_ENTRY_DELAY_MS : 0
    let step = 0
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const el = entry.target as HTMLElement
      // A CSS variable the animation-delay reads, so each element in the
      // batch starts a little after the previous one.
      el.style.setProperty('--rise-delay', `${base + Math.min(step, MAX_STEPS - 1) * STAGGER_MS}ms`)
      el.dataset.shown = 'true'
      const id = ids.get(el)
      if (id) shown.add(id)
      io.unobserve(el)
      step++
    }
  })

  return {
    shown,
    observe(el, id) {
      ids.set(el, id)
      io.observe(el)
    },
    unobserve: (el) => io.unobserve(el),
  }
}

// Provided by components/RevealProvider.tsx, one per page visit.
export const RevealContext = createContext<Revealer | null>(null)

/**
 * For one element that should rise in the first time it's on screen.
 * Spread the result onto it, alongside the `rise` class:
 *   <article className="rise …" {...useReveal(`job:${id}`)}>
 */
export function useReveal(id: string) {
  const revealer = useContext(RevealContext)
  // Already revealed this visit, reduced motion, or no provider: render it
  // in its final state and don't observe it at all.
  const done = !revealer || prefersReducedMotion() || revealer.shown.has(id)

  // A ref callback runs with the DOM element when React attaches it. In
  // React 19 it can return a cleanup, called when the element goes away.
  // useCallback keeps it the same function across re-renders, so React
  // doesn't detach and re-attach it (and re-observe) on every render.
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (!el || !revealer || revealer.shown.has(id) || prefersReducedMotion()) return
      revealer.observe(el, id)
      return () => revealer.unobserve(el)
    },
    [revealer, id],
  )

  return { ref, 'data-revealed': done ? 'true' : undefined }
}
