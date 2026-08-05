import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// ============================================================================
// Build do editor novo.
//   • `base: '/v2/'`  — o bundle é servido pelo servidor do FlowForge SOB a rota
//     /v2 (lei 1: o `web/` antigo continua em `/` e não pode ser tocado). Sem
//     isso os assets sairiam apontando pra `/assets/...` e cairiam no app antigo.
//   • `outDir: 'dist'` — o servidor lê `web-next/dist`.
// ============================================================================
export default defineConfig({
  base: '/v2/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    port: 5273
  }
})
