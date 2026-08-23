import path from 'node:path'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'

// The backend is loopback-only; the dev server proxies /api to it. Not PORT:
// launchers set that to the dev server's own port. The backend honors
// PROJECTOR_API_PORT too, so one setting moves both.
const BACKEND_PORT = process.env.PROJECTOR_API_PORT ?? '3003'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: false },
    },
    fs: {
      // The Atlas mode glob-imports the atlas repo's content files directly,
      // so the dev server must be allowed to serve them.
      allow: [searchForWorkspaceRoot(process.cwd()), path.resolve(__dirname, '../../atlas')],
    },
  },
})
