import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: { port: 5183, strictPort: true, proxy: { '/api': 'http://localhost:8787' } },
});
