import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client is served by the bot's own Atlas server in normal use; `vite dev`
// exists for iterating on the UI, and proxies the API back to the live bot so
// the pulses are real while developing.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.ATLAS_PORT ?? 7391}`,
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
