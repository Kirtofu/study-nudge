import 'lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Keep feature styles after the shared foundation: their layout rules replace v2.1 defaults.
import './styles.css'
import './features/tasks/tasks.css'
import './features/learning/workspace.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
