import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The backend is loopback-only; the dev server proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3003', changeOrigin: false },
    },
  },
})
