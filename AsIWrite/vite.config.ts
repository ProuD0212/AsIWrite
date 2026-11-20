import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { lanShare } from './lanShare.ts'

// https://vite.dev/config/
// lanShare: the in-game "다른 PC에서 접속" switch (settings) — see lanShare.ts
export default defineConfig({
  plugins: [react(), tailwindcss(), lanShare()],
})
