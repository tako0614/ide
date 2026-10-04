import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Installed noVNC 1.7 uses top-level await for feature detection.
  build: { target: 'es2022' },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../src/shared')
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.DECKIDE_DEV_API_URL || 'http://localhost:8787',
        // Preserve the browser-facing Host so strict session CSRF checks see
        // the same origin through the development proxy, including WebSockets.
        changeOrigin: false,
        ws: true
      }
    }
  }
});
