const js = require('@eslint/js');

module.exports = [
    // Global ignores (must be standalone, no files key)
    {
        ignores: [
            'node_modules/**',
            'js/cloudbase-sdk.js',
            'js/tcb.js',
            'tests/**',
            'coverage/**',
            'cloudfunctions/**',
        ]
    },
    js.configs.recommended,
    {
        files: ['e2e/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                console: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                require: 'readonly',
                module: 'readonly',
                exports: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
            }
        },
        rules: {
            'no-unused-vars': 'off',
            'no-console': 'off',
            'no-undef': 'error',
            'no-empty': ['error', { allowEmptyCatch: true }],
        }
    },
    {
        files: ['js/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // Browser APIs
                window: 'readonly',
                document: 'readonly',
                console: 'readonly',
                fetch: 'readonly',
                localStorage: 'readonly',
                sessionStorage: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                navigator: 'readonly',
                location: 'readonly',
                AbortSignal: 'readonly',
                JSON: 'readonly',
                Math: 'readonly',
                Date: 'readonly',
                Promise: 'readonly',
                Array: 'readonly',
                Object: 'readonly',
                String: 'readonly',
                Number: 'readonly',
                Boolean: 'readonly',
                parseFloat: 'readonly',
                parseInt: 'readonly',
                isNaN: 'readonly',
                // Web Crypto & Encoding APIs
                TextEncoder: 'readonly',
                crypto: 'readonly',
                // Browser File/Form APIs
                FormData: 'readonly',
                FileReader: 'readonly',
                Blob: 'readonly',
                URL: 'readonly',
                // App globals (assigned to window by modules)
                App: 'writable',
                DB: 'writable',
                Auth: 'writable',
                Cloud: 'writable',
                Exchange: 'writable',
                Orders: 'writable',
                Customers: 'writable',
                Factories: 'writable',
                Dashboard: 'writable',
                Profit: 'writable',
                Shipping: 'writable',
                Settings: 'writable',
                CONSTANTS: 'writable',
                // Third-party globals
                XLSX: 'readonly',
                Chart: 'readonly',
                cloudbase: 'readonly',
                tcb: 'readonly',
                wx: 'readonly',
            }
        },
        rules: {
            // Browser-side ES modules use side-effect imports (register on window),
            // so imported-but-unused is standard. 'local' vars only would still flag imports.
            // Disable this rule — it produces noise, not value, for this architecture.
            'no-unused-vars': 'off',
            'no-console': 'off',
            'no-undef': 'error',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'eqeqeq': ['warn', 'smart'],
            'curly': ['warn', 'multi-line'],
            'no-var': 'warn',
            'prefer-const': 'warn',
            'no-throw-literal': 'error',
            'no-implicit-globals': 'error',
        }
    },
];
