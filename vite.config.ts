import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  plugins: [react()],
  build: {
    outDir: resolve('dist'),
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true
  },
  preview: {
    host: '127.0.0.1',
    port: 1421
  },
  test: {
    environment: 'jsdom',
    setupFiles: [],
    include: ['src/**/*.test.{ts,tsx}']
  }
})
