import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative base so the build works both at localhost:5173/ and under a
  // GitHub Pages project path (/pyrolens-app/).
  base: './',
  plugins: [tailwindcss()],
  server: {
    port: 5173,
    watch: {
      // raw/ holds pipeline inputs (parquet, venv, exports) — never served,
      // and its file count would choke the dev watcher.
      ignored: ['**/raw/**', '**/.venv/**', '**/*.parquet'],
    },
  },
});
