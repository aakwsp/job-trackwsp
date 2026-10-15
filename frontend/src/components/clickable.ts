import type { KeyboardEvent } from 'react'

// Props that make a non-button element (a whole card) act like a button:
// focusable with Tab, announced as a button, activated by Enter or Space.
// A real <button> can't be used for the card because it contains another
// button (↗), and buttons can't nest.
export function clickable(onActivate: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      // Only when the card itself is focused, not the ↗ inside it.
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault() // Space would otherwise scroll the page
        onActivate()
      }
    },
  }
}
