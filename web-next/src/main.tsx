import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.js'
import { App } from './App.js'

const el = document.getElementById('root')
if (!el) throw new Error('#root não encontrado no index.html')

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>
)
