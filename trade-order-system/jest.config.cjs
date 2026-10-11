/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'jsdom',
    transform: {},
    testMatch: ['**/tests/**/*.test.js'],
    collectCoverageFrom: [
        'js/constants.js',
        'js/utils.js',
        'js/exchange.js',
        'js/auth.js',
        'js/cloud.js',
        'js/data.js',
        'js/app.js'
    ],
    // Coverage thresholds for business-logic modules (excludes DOM/UI rendering modules)
    coverageThreshold: {
        global: {
            statements: 40,
            branches: 30,
            functions: 40,
            lines: 40
        }
    },
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'html'],
    setupFilesAfterEnv: ['<rootDir>/tests/setup.cjs'],
    verbose: true
};
