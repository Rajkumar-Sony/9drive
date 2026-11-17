import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './style.css'
import { initTheme } from './lib/theme'
import { isDesktop } from './lib/runtime'

initTheme()
if (isDesktop) document.documentElement.classList.add('desktop-app')
else if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller)
  if (hadController) {
    let refreshed = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshed) { refreshed = true; window.location.reload() }
    })
  }
  void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => registration.update()).catch(() => undefined)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
