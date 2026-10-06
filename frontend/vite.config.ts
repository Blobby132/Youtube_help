import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backendPort = process.env.BACKEND_PORT || '8765'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    open: process.env.OPEN_BROWSER !== '0',
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
})
