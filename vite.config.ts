import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'static/panel',
  base: './',
  plugins: [react()],
  build: {
    outDir: 'build',
    emptyOutDir: true,
  },
})
