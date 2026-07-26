import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './theme.css'
import App from './App'
import { useStore } from './store'

useStore.getState().bootstrap()

// Dev-only handle for driving the app over CDP; stripped from production builds.
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__store = useStore

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
