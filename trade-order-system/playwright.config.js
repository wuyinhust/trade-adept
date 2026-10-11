// @ts-check
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    timeout: 120000,
    expect: {
        timeout: 15000,
    },
    retries: 1,
    use: {
        baseURL: 'http://localhost:3000',
        headless: true,
        viewport: { width: 1280, height: 720 },
        screenshot: 'only-on-failure',
    },
    webServer: {
        command: 'npx http-server . -p 3000 --cors',
        port: 3000,
        reuseExistingServer: true,
    },
});
