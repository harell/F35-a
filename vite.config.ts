import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : undefined),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The game always loads the LINZ Auckland terrain; tests run on the same data.
    setupFiles: ['tests/linz-setup.ts'],
    // `npm run coverage`: V8 coverage of the game's sources (the dev labs are tools, not the game).
    // json-summary feeds the README badge (tools/coverage-badge.mjs), lcov and html are for reading locally.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/dev/**', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      reportsDirectory: 'coverage',
    },
  },
} as any);
