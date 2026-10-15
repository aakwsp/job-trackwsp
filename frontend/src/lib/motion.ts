/** The OS "reduce motion" setting. Read at call time, so toggling it applies immediately. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// No View Transitions API here on purpose: on WebKitGTK 2.52 with the
// DMABUF renderer disabled (which this machine needs, see CLAUDE.md),
// `document.startViewTransition` segfaults the whole app — the API exists,
// so a feature check doesn't help. View and page switches are instant, and
// the new content fades in on one container instead (`.fade-in`, index.css).
