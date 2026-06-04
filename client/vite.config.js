import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // Forward API calls to the Express backend during dev.
      '/api': 'http://localhost:3001',
    },
  },
});
