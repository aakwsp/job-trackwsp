import { useState, type ReactNode } from 'react'
import { RevealContext, createRevealer } from '../lib/reveal'

// One scroll-reveal observer for everything inside (see lib/reveal.ts).
// App mounts a fresh one per route, which is what resets the reveals.
//
// No cleanup effect that disconnects the observer: each card's ref cleanup
// already unobserves it when it unmounts. A provider-level disconnect would
// also fire during React's dev-mode double effect run (StrictMode) and could
// drop cards that are still waiting, leaving them invisible.
export default function RevealProvider({ children }: { children: ReactNode }) {
  // Lazy useState: one revealer for this provider's lifetime.
  const [revealer] = useState(createRevealer)
  return <RevealContext.Provider value={revealer}>{children}</RevealContext.Provider>
}
