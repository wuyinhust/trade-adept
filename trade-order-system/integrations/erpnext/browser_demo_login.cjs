/* UI-only protocol check: stub demo config and intercept both login submissions.
 * Never authenticates against the two existing enterprises or changes their data.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
    const origin = 'http://127.0.0.1:3090';
    const output = path.resolve(process.argv[2] || '/private/tmp/tradept-login-final/demo-browser');
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
        const attempts = [];
        await context.route('**/api/login-config', route => route.fulfill({ json: { demoMode: true, demoTenants: ['grandware', 'example-company'], emailOnly: false, setupRequired: false } }));
        await context.route('**/api/login', route => {
            const { tenantId, username, email } = route.request().postDataJSON();
            attempts.push({ tenantId, username, email });
            return route.fulfill({ status: 401, json: { error: 'UI fixture: no authentication attempted', code: 'UI_FIXTURE' } });
        });
        const page = await context.newPage();
        await page.goto(origin);
        await page.locator('#loginTenant').waitFor();
        if (await page.locator('#loginTenant').inputValue()) throw new Error('Demo must not select a tenant by default');
        await page.locator('#loginUsername').fill('David');
        await page.locator('#loginPassword').fill('ui-fixture-not-a-real-password');
        await page.locator('#loginForm [type="submit"]').click();
        if (attempts.length) throw new Error('An empty tenant choice reached login');
        for (const [tenant, username] of [['grandware', 'David'], ['example-company', 'demo-admin']]) {
            await page.locator('#loginTenant').selectOption(tenant);
            await page.locator('#loginUsername').fill(username);
            const posted = page.waitForResponse(response => response.url() === origin + '/api/login');
            await page.locator('#loginForm [type="submit"]').click();
            await posted;
        }
        if (attempts.length !== 2 || attempts[0].tenantId !== 'grandware' || attempts[0].username !== 'David' || attempts[1].tenantId !== 'example-company' || attempts[1].username !== 'demo-admin' || attempts.some(item => item.email !== undefined)) throw new Error('Tenant or original account changed');
        if (await page.locator('#forgotPassword').isVisible()) throw new Error('Demo exposes unconfigured email recovery');
        await page.locator('#loginPassword').fill('');
        await page.locator('#loginError').evaluate(element => { element.style.display = 'none'; });
        await page.screenshot({ path: path.join(output, 'demo-login-selector.png'), fullPage: true });
        const receipt = { ok: true, checks: ['explicit-demo-options-only', 'no-default-tenant', 'browser-requires-tenant-choice', 'both-original-account-names-and-tenants-preserved', 'unconfigured-email-recovery-hidden'], mode: 'UI config and login responses stubbed; native routing separately unit-tested', realAuthenticationAttempted: false };
        fs.writeFileSync(path.join(output, 'demo-browser-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
        console.log(JSON.stringify(receipt));
    } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
