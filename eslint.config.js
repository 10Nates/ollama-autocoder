const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('@typescript-eslint/eslint-plugin');
const tseslintParser = require('@typescript-eslint/parser');

/** @type {import('eslint').ConfigArray} */
module.exports = [
  {
    ignores: ['out/**', 'node_modules/**', '.vscode-test/**'],
  },
  js.configs.recommended,
  ...tseslint.configs['flat/recommended'],
  {
    languageOptions: {
      parser: tseslintParser,
      globals: globals.node,
    },
    rules: {
      'semi': ['error', 'always'],
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];
