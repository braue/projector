import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { loadSettings } from './lib/settings'
import { applySavedTheme } from './lib/theme'

// Settings first: pane widths and remembered form fields are read on the
// first render.
loadSettings().then(() => {
  applySavedTheme()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
})
