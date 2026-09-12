import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx, type ManifestV3Export } from '@crxjs/vite-plugin';
import manifest from './manifest.json' with { type: 'json' };

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  // Las variables de entorno viven en la raíz del monorepo (.env), no aquí.
  envDir: '..',

  plugins: [react(), crx({ manifest: manifest as ManifestV3Export })],

  resolve: {
    alias: {
      '@': resolvePath('./src'),
      // Fuente única de verdad: los mocks y fixtures de la raíz. Ninguna copia
      // dentro de src/ — ver mocks/README.md.
      '@mocks': resolvePath('../mocks'),
      '@fixtures': resolvePath('../fixtures'),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
    // Necesario para servir en dev los JSON de ../mocks y ../fixtures.
    fs: { allow: ['..'] },
  },

  build: {
    target: 'esnext',
    sourcemap: true,
  },
});
