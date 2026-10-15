import { flushSync } from 'react-dom'

/** The OS "reduce motion" setting. Read at call time, so toggling it applies immediately. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Runs a state update as a crossfade instead of a snap, using the browser's
 * View Transitions API: it snapshots the page, lets the update happen, then
 * fades from the old snapshot to the new page. The fade's timing lives in
 * index.css (`::view-transition-*`).
 *
 * `flushSync` makes React apply the update right away, inside the callback.
 * Normally React batches updates and renders a moment later, which would be
 * after the browser took its "new" snapshot.
 *
 * Falls back to a plain update when the API isn't there or reduced motion
 * is on.
 */
export function withTransition(update: () => void) {
  if (!document.startViewTransition || prefersReducedMotion()) {
    update()
    return
  }
  document.startViewTransition(() => flushSync(update))
}
