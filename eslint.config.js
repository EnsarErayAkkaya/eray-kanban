import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'data/', 'screenshots/', 'node_modules/', '**/fixtures/'] },
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': 'allow-with-description' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['server/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['**/services/**', '**/infra/**', '**/api/**', '**/adapters/**', 'node:*'] },
      ],
    },
  },
);
