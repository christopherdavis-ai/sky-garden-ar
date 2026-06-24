import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        ar: resolve(__dirname, 'ar.html')
      }
    }
  }
});
