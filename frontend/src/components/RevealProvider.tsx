import { useEffect, useState, type ReactNode } from 'react'
import { RevealContext, createRevealer } from '../lib/reveal'

// One scroll-reveal observer for everything inside (see lib/reveal.ts).
// App mounts a fresh one per route, which is what resets the reveals.
export default function RevealProvider({ children }: { children: ReactNode }) {
  // Lazy useState: one revealer for this provider's lifetime.
  const [revealer] = useState(createRevealer)
  // Listen for scroll speed while mounted. `start` returns its own undo, so
  // this is safe under React's dev-mode double run (add, remove, add).
  useEffect(() => revealer.start(), [revealer])
  return <RevealContext.Provider value={revealer}>{children}</RevealContext.Provider>
}
