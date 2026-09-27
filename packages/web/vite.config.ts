import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = process.env.GQLWB_API ?? 'http://127.0.0.1:5470';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // The API owns CORS-free access to third-party GraphQL endpoints, so the UI always talks to it.
    proxy: {
      '/api': { target: API, changeOrigin: true, ws: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Monaco is a large editor and ships as its own chunk on purpose.
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      // Tailwind's build plugin does not emit a sourcemap for the CSS it generates; that is
      // expected and the warning is pure noise.
      onwarn(warning, defaultHandler) {
        if (warning.code === 'SOURCEMAP_BROKEN') return;
        defaultHandler(warning);
      },
      output: {
        // Rolldown (Vite 8) only accepts the function form.
        manualChunks(id: string) {
          if (id.includes('monaco-editor') || id.includes('monaco-graphql') || id.includes('graphql-language-service')) return 'monaco';
          if (id.includes('node_modules/react') || id.includes('node_modules/zustand')) return 'vendor';
          return null;
        },
      },
    },
  },
  worker: { format: 'es' },
});
