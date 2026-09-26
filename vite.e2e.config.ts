/**
 * Stable dev server for automated playtests: no HMR / file watching, so pages don't reload
 * while other files are being edited. `npx vite --config vite.e2e.config.ts --port 5190`
 */
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

export default mergeConfig(base as any, defineConfig({ server: { hmr: false, watch: { ignored: ['**/*'] } } }));
