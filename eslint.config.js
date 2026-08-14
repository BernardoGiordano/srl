import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Type-aware linting over plain JavaScript.
 *
 * `projectService: true` hands each file to the TypeScript program described by
 * tsconfig.json, so rules that need types (no-unsafe-*, no-floating-promises,
 * await-thenable) work on .js exactly as they would on .ts. This is the half of
 * "full compatibility with typecheck and linters" that people assume you give up
 * along with the build step. You do not.
 *
 * Backed by typescript@6.0.3, not tsgo. typescript-eslint requires the compiler
 * API, whose peer range is `>=4.8.4 <6.1.0`; TypeScript 7.0 ships no public API
 * until 7.1. See package.json.
 *
 * Config blocks are scoped by `files` with per-block `extends`, rather than
 * spreading the shared configs at top level. A top-level spread applies the
 * type-checked rules to every file including .d.ts, which then fails to lint
 * because the parser options only reach the .js block.
 */
export default tseslint.config(
  {
    // source/lib/vendor holds third-party bytes verbatim. Linting them says
    // nothing about this codebase, and they are excluded from tsconfig, so the
    // type-aware rules cannot parse them anyway. Their integrity is checked by
    // tools/vendor.mjs and enforced by the browser.
    ignores: [
      'node_modules/**',
      'dist/**',
      'source/lib/vendor/**',
      '**/app.css',
      '**/templates.json',
      'coverage/**',
      // Fixture projects for the project model's tests: deliberately unreadable
      // declarations, which is the point of them.
      'tools/test/fixtures/**',
    ],
  },

  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Browser-native ESM does no extension resolution. A specifier without an
      // extension is a 404, discovered at runtime, on whichever route happens to
      // import it. Catch it at lint time instead.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportDeclaration[source.value=/^[./]/]:not([source.value=/\\.(js|mjs|css|json)$/])',
          message:
            'Relative imports must carry an explicit .js extension. The browser does not guess.',
        },
      ],

      eqeqeq: ['error', 'always'],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // Declaration files need the TypeScript parser but not type information:
    // there is no runtime behaviour in them for the type-aware rules to reason
    // about.
    files: ['**/*.d.ts'],
    extends: [...tseslint.configs.recommended],
  },

  {
    // Node-side code: the tools, the config files, and any application's own backend —
    // plain Node with no dependencies. `*/server/**/*.mjs` rather than a list of them,
    // because an application is discovered rather than configured everywhere else and a
    // named list here is the one place that would go stale when the next one lands. The
    // extension is the declaration: `.mjs` under an application means nothing in it ever
    // reaches a browser, which is what makes the Node globals correct here and wrong in
    // that application's `src/`.
    files: ['tools/**/*.mjs', '*/server/**/*.mjs', '*.config.js', '*.config.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'off',
      // Tooling reads JSON whose shape it validates by hand; `any` from
      // JSON.parse is the point, not an oversight.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  {
    // Both suites: source/lib/test (the framework) and <app>/test (one application).
    files: ['**/test/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.mocha } },
  },

  {
    // tools/benchmark/browser holds the workload modules Chrome imports over the
    // benchmark origin: browser code that is neither library nor application.
    //
    // The unsafe-* rules are off for the same reason they are off for tools/*.mjs,
    // one level further in: the sample loop is generic over fixtures it cannot know
    // the type of, so a workload's `state` is `any` by construction. The alternative
    // is a generic typedef per workload, which buys nothing — these files build DOM
    // and read it back, and the source they measure is type-checked either way.
    files: ['tools/benchmark/browser/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
