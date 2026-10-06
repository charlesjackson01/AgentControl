import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev only: /api rides this proxy to the BE, so no CORS is involved.
      '/api': 'http://localhost:3001',
    },
  },
})
