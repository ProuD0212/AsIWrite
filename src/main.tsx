import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { embeddings } from './ai/embeddings'

// dev-only handle for measurements / calibration from tests
if (import.meta.env.DEV) (window as unknown as { __aw: unknown }).__aw = { embeddings }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
