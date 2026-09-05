import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@flow/core': path.resolve(root, 'packages/flow-core/src/index.ts'),
      '@flow/canvas': path.resolve(root, 'packages/flow-canvas/src/index.ts'),
      '@flow/dock': path.resolve(root, 'packages/flow-dock/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5191,
    /* devUrl 固定为 5191（tauri.conf.json 同步），故无需迁就 Tauri 默认的 1420 */
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2020',
  },
  /* Tauri 以 file:// 加载 dist，GitHub Pages 挂在 /flow-navigator/ 子路径 —— 相对路径两者通吃 */
  base: './',
});
