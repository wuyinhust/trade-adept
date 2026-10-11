// @ts-check
import { test } from '@playwright/test';

const APP_URL = 'https://grandware-d9gb4owez89cb9df9-1460064035.tcloudbaseapp.com';

test('调试: 检查云端连接问题', async ({ page }) => {
    const consoleLogs = [];
    const consoleErrors = [];
    const networkErrors = [];

    page.on('console', msg => {
        consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    page.on('pageerror', err => {
        consoleErrors.push(`PAGE ERROR: ${err.message}`);
    });

    page.on('requestfailed', req => {
        networkErrors.push(`FAILED: ${req.method()} ${req.url()} - ${req.failure()?.errorText}`);
    });

    await page.goto(APP_URL);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'e2e/screenshots/debug-initial.png' });

    console.log('=== 初始加载 ===');
    consoleLogs.forEach(l => console.log(l));

    // 登录
    await page.getByPlaceholder(/username|Enter your username/i).fill('David');
    await page.getByPlaceholder(/password|Enter your password/i).fill('Fuckyou361021');
    await page.getByRole('button', { name: /Sign In|登录|Login/i }).click();
    await page.waitForTimeout(10000);
    await page.screenshot({ path: 'e2e/screenshots/debug-after-login.png' });

    console.log('\n=== 登录后 ===');
    consoleLogs.forEach(l => console.log(l));
    consoleErrors.forEach(e => console.log('ERROR:', e));
    networkErrors.forEach(e => console.log('NETWORK:', e));

    // 检查 cloud 状态
    const cloudStatus = await page.evaluate(() => {
        return {
            online: navigator.onLine,
            cloud: typeof Cloud !== 'undefined' ? {
                isOnline: Cloud.isOnline,
                syncInProgress: Cloud.syncInProgress,
                lastSyncAt: Cloud.lastSyncAt,
                envId: Cloud.envId,
                user: Cloud.currentUser?.username
            } : 'Cloud not defined',
            db: typeof DB !== 'undefined' ? {
                customers: DB.data?.customers?.length,
                orders: DB.data?.orders?.length,
                factories: DB.data?.factories?.length,
                version: DB.data?.version
            } : 'DB not defined'
        };
    });
    console.log('\n=== Cloud/DB 状态 ===');
    console.log(JSON.stringify(cloudStatus, null, 2));
});