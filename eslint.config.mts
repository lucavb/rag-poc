import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(eslint.configs.recommended, tseslint.configs.recommended, {
    languageOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        globals: {
            node: true,
            es6: true,
        },
    },
    rules: {
        // TypeScript specific rules
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/explicit-module-boundary-types': 'off',
        '@typescript-eslint/no-explicit-any': 'warn',
        '@typescript-eslint/no-non-null-assertion': 'warn',
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

        // General rules
        'arrow-spacing': 'error',
        'no-console': 'off', // CLI app needs console
        'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 1 }],
        'no-var': 'error',
        'object-shorthand': 'error',
        'prefer-const': 'error',
        'prefer-template': 'error',
        'template-curly-spacing': 'error',
        quotes: ['error', 'single', { avoidEscape: true }],
        semi: ['error', 'always'],
    },
    ignores: ['dist/', 'node_modules/'],
});
