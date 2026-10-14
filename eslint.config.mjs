import { defineConfig } from 'eslint/config';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';
import globals from 'globals';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all,
});

export default defineConfig([
    {
        extends: compat.extends(
            'eslint:recommended',
            'plugin:@typescript-eslint/eslint-recommended',
            'plugin:@typescript-eslint/recommended',
        ),

        plugins: {
            '@typescript-eslint': typescriptEslint,
        },

        languageOptions: {
            parser: tsParser,
        },

        rules: {
            // import x = require() for untyped CJS modules
            '@typescript-eslint/no-require-imports': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        // renderer scripts run in BrowserView: browser globals, plain JS, no TS parser
        files: [
            'src/header/**/*.js',
            'src/settings/*.js',
            'src/notification/*.js',
            'src/confirm/*.js',
            'src/downloads/*.js',
        ],
        languageOptions: {
            parser: undefined,
            sourceType: 'script',
            globals: {
                ...globals.browser,
            },
        },
    },
]);
