import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: [
            'node_modules/**',
            'build/**',
            'dist/**',
            'tmp/**',
            'libs/**',
            '**/.#*'
        ]
    },
    {
        ...js.configs.recommended,
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            globals: { ...globals.browser, ...globals.node, chrome: 'readonly' }
        },
        rules: {
            ...js.configs.recommended.rules,
            'no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', caughtErrors: 'none' }
            ],
            // Browser API fallbacks intentionally ignore unsupported operations.
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    }
];
