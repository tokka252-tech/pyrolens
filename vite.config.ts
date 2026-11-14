import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
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
