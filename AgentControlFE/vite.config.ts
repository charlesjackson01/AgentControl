import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Config-only (no VITE_ prefix), so it never reaches the client bundle.
  const env = loadEnv(mode, process.cwd(), 'AGENTCONTROL_')
  // Defaults to the BE's own default PORT; point it at another BE (e.g. a
  // sandbox on :3101) with AGENTCONTROL_API_TARGET in .env.local.
  const apiTarget = env.AGENTCONTROL_API_TARGET || 'http://localhost:3001'

  return {
    plugins: [react()],
    server: {
      proxy: {
        // /api rides this proxy to the BE, so no CORS is involved. `vite
        // preview` inherits it, so preview builds stay same-origin too.
        '/api': apiTarget,
      },
    },
  }
})
