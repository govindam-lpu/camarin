import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Dev-only: the built app is served by the API itself (same origin, no CORS — D-010).
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  build: {
    sourcemap: false,
  },
});
