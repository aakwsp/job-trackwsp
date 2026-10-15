import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
/* fonts — bundled locally so they never fall back to system */
import '@fontsource/dm-serif-display/400.css'
import '@fontsource/space-mono/400.css'
import '@fontsource/space-mono/700.css'
import './index.css'
import App from './App.tsx'
import { applyScale, loadScale } from './lib/scale'

// Apply the saved scale before the first render, so the page doesn't paint
// at 100% and then visibly jump.
applyScale(loadScale())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
