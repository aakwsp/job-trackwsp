import { createContext, useCallback, useContext } from 'react'
import { prefersReducedMotion } from './motion'

// Scroll-in reveal for city bands and cards (DEFAULT / COMPACT only; LINE
// rows never use this).
//
// One IntersectionObserver per page visit watches every unrevealed element.
// When elements come within 300px of the bottom of the scroll area it
// reveals them with classList, never React state, so revealing doesn't
// re-render anything:
//   - `is-in`: visible. On its own it's an instant reveal.
//   - `is-rising`: plays the rise animation and sets `will-change` for its
//     duration only; removed again on `animationend`.
// No card on screen may ever sit blank waiting for an animation. On this
// machine's CPU compositing an animation can take several frames to start
// while scrolling, so the rules are:
//   - fast scrolling: reveal instantly (and finish any card still rising)
//   - a card that's already on screen when revealed: instantly
//   - only cards revealed in the 300px zone *below* the screen animate, so
//     they're done by the time they scroll up into view
//   - a second observer watches rising cards; one that reaches the screen
//     while still rising is shown in its final state at once (off screen,
//     WebKit doesn't reliably run the animation, so it may not have moved)
//   - a timer finishes every rise regardless, so `will-change` never lingers
//     even when `animationend` doesn't arrive
// The first screenful at page entry is the exception: it animates in with
// the hero (index.css `.enter`).
//
// `shown` remembers what has revealed. DEFAULT / COMPACT remount every card;
// a remounted card asks `shown` and renders with `is-in` already in its
// className (no replay). React owns `className`, so the class it renders
// must include `is-in` for revealed cards, or a later re-render (say,
// marking applied) would overwrite the attribute and hide the card again.
// App mounts a new RevealProvider (components/) per route, which resets it.

const STAGGER_MS = 40
const MAX_STEPS = 8
// Reveal this far below the visible area, so cards are already done
// animating by the time they scroll on screen.
const ROOT_MARGIN = '0px 0px 300px 0px'
// Faster than this (px per ms, ~1000px/s) counts as fast scrolling.
const FAST_PX_PER_MS = 1
// Duration of the rise (matches --rise-ms in index.css) plus slack, after
// which a rise is finished by timer if `animationend` hasn't done it.
const RISE_TIMEOUT_MS = 350 + 150
// Elements revealed right after the page appears wait for the hero and the
// toolbar (index.css `.enter`) to rise in first.
const PAGE_ENTRY_WINDOW_MS = 400
const PAGE_ENTRY_DELAY_MS = 240

export type Revealer = {
  shown: Set<string>
  observe: (el: HTMLElement, id: string) => void
  unobserve: (el: HTMLElement) => void
  // Scroll-speed tracking; RevealProvider starts and stops it.
  start: () => () => void
}

export function createRevealer(): Revealer {
  const shown = new Set<string>()
  const ids = new WeakMap<Element, string>()
  const created = performance.now()

  // Scroll speed, from the last two scroll events.
  let lastY = 0
  let lastT = 0
  let speed = 0
  function onScroll(e: Event) {
    const t = performance.now()
    const y = (e.target as HTMLElement).scrollTop ?? 0
    const dt = t - lastT
    if (dt > 0 && dt < 200) speed = Math.abs(y - lastY) / dt
    else speed = 0 // first event after a pause: treat as slow
    lastY = y
    lastT = t
    // Turned fast: anything still rising snaps to its final state.
    if (speed > FAST_PX_PER_MS) for (const el of [...rising.keys()]) finish(el)
  }
  const scrollingFast = () => speed > FAST_PX_PER_MS && performance.now() - lastT < 150

  // Cards currently rising, with their fallback timer.
  const rising = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

  // Show a rising card in its final state right now.
  function finish(el: HTMLElement) {
    el.classList.remove('is-rising')
    el.style.willChange = ''
    clearTimeout(rising.get(el))
    rising.delete(el)
    onScreen?.unobserve(el)
  }

  function reveal(entries: IntersectionObserverEntry[]) {
    const now = performance.now()
    const pageEntry = now - created < PAGE_ENTRY_WINDOW_MS
    const fast = scrollingFast()
    let step = 0
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const el = entry.target as HTMLElement
      const id = ids.get(el)
      if (id) shown.add(id)
      io?.unobserve(el)

      // `rootBounds` is the scroll area grown by the 300px margin; its
      // bottom minus the margin is the visible bottom edge.
      const visibleBottom = (entry.rootBounds?.bottom ?? Infinity) - 300
      const alreadyOnScreen = entry.boundingClientRect.top < visibleBottom
      if (fast || (alreadyOnScreen && !pageEntry)) {
        el.classList.add('is-in')
        continue
      }

      // A CSS variable the animation-delay reads, so each element in the
      // batch starts a little after the previous one.
      const delay = (pageEntry ? PAGE_ENTRY_DELAY_MS : 0) + Math.min(step, MAX_STEPS - 1) * STAGGER_MS
      el.style.setProperty('--rise-delay', `${delay}ms`)
      el.style.willChange = 'transform, opacity'
      el.classList.add('is-in', 'is-rising')
      el.addEventListener('animationend', () => finish(el), { once: true })
      rising.set(el, setTimeout(() => finish(el), delay + RISE_TIMEOUT_MS))
      if (!pageEntry) onScreen?.observe(el)
      step++
    }
  }

  // Watches rising cards against the visible area (no margin). One that
  // scrolls into view while still rising is shown at once instead of
  // possibly sitting blank.
  function guard(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      if (entry.isIntersecting && rising.has(entry.target as HTMLElement)) finish(entry.target as HTMLElement)
    }
  }

  // Created on the first observe(), because its root has to be the
  // scrolling <main>, which only exists once React has put it on the page.
  // With the window as root, <main> would clip the cards below its edge and
  // the 300px margin would never see them.
  let io: IntersectionObserver | null = null
  let onScreen: IntersectionObserver | null = null

  return {
    shown,
    observe(el, id) {
      const root = el.closest('main')
      io ??= new IntersectionObserver(reveal, { root, rootMargin: ROOT_MARGIN })
      onScreen ??= new IntersectionObserver(guard, { root })
      ids.set(el, id)
      io.observe(el)
    },
    unobserve: (el) => io?.unobserve(el),
    start() {
      // Scroll events don't bubble, but they can be caught on the way down
      // (`capture`), so one listener on the document hears <main> scroll.
      // `passive` promises we never preventDefault, so scrolling never waits.
      document.addEventListener('scroll', onScroll, { capture: true, passive: true })
      return () => document.removeEventListener('scroll', onScroll, { capture: true })
    },
  }
}

// Provided by components/RevealProvider.tsx, one per page visit.
export const RevealContext = createContext<Revealer | null>(null)

/**
 * For one element that should rise in the first time it nears the screen.
 * Put `ref` on it and add `className` next to the `rise` class:
 *   const { ref: revealRef, className: revealClass } = useReveal(`job:${id}`)
 *   <article ref={revealRef} className={`rise ${revealClass}`}>
 * (Destructured on purpose: oxlint reads `reveal.className` on an object
 * that also holds a ref as a ref access during render.)
 * `enabled: false` (LINE view) shows it straight away and never observes.
 */
export function useReveal(id: string, enabled = true) {
  const revealer = useContext(RevealContext)
  // Already revealed this visit, disabled, reduced motion, or no provider:
  // render it visible and don't observe it at all.
  const done = !enabled || !revealer || prefersReducedMotion() || revealer.shown.has(id)

  // A ref callback runs with the DOM element when React attaches it. In
  // React 19 it can return a cleanup, called when the element goes away.
  // useCallback keeps it the same function across re-renders, so React
  // doesn't detach and re-attach it (and re-observe) on every render.
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (!el || done || !revealer) return
      revealer.observe(el, id)
      return () => revealer.unobserve(el)
    },
    [revealer, id, done],
  )

  return { ref, className: done ? 'is-in' : '' }
}
