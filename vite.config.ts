import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4318,
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/media': 'http://127.0.0.1:4317',
    },
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
});
