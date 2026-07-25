import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { inspectorPlugin } from './plugins/inspector-plugin'
import { safeCssPlugin } from './plugins/safe-css-plugin'

export default defineConfig({
  plugins: [react(), inspectorPlugin(), safeCssPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@ui': path.resolve(__dirname, './src/components/ui'),
      '@store': path.resolve(__dirname, './src/store'),
    },
  },
  server: {
    port: 5173,
    hmr: {
      overlay: true,
    },
  },
})
