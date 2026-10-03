// ESLint (flat config): the recommended JavaScript and typescript-eslint rules for the game, its tests and the Node tools.
// `npm run lint` checks, `npm run lint:fix` fixes what it can; CI runs it on every pull request.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/', 'public/', 'labs/**/dist/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    rules: {
      // a leading underscore marks a deliberately unused argument or binding (interface methods, destructuring)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      // `const self = this` is how the sim and the labs hand an object to callbacks that rebind `this`
      '@typescript-eslint/no-this-alias': 'off',
    },
  },
  {
    // tests and build configs stub browser APIs and untyped plugin options
    files: ['tests/**/*.ts', 'vite.config.ts', 'vite.e2e.config.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
