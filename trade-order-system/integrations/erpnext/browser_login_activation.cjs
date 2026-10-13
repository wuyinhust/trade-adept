/* Isolated-site browser acceptance. Never use production or employee accounts.
 * Usage: node browser_login_activation.cjs /absolute/private-fixture.json output-dir
 * Fixture: {origin, username, password}; regular 0600 local file, never committed.
 * Keeps a real authenticated cookie, but only opens an inert display-test link.
 * Does not submit a reset, send mail, or modify the authenticated account.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
    const fixturePath = process.argv[2];
    if (!fixturePath || !path.isAbsolute(fixturePath)) throw new Error('Private absolute fixture path required');
    const stat = fs.lstatSync(fixturePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Fixture must be a private regular 0600 file');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const origin = new URL(fixture.origin).origin;
    if (fixture.isolatedTestSite !== true) throw new Error('An explicitly isolated test site is required');
    const output = path.resolve(process.argv[3] || '.');
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const checks = [];
    try {
        const page = await context.newPage();
        const configured = page.waitForResponse(response => response.url() === origin + '/api/login-config' && response.ok());
        await page.goto(origin);
        await configured;
        await page.locator('#loginUsername').fill(fixture.username);
        await page.locator('#loginPassword').fill(fixture.password);
        await page.locator('#loginForm [type="submit"]').click();
        await page.locator('#app').waitFor({ state: 'visible' });
        const before = await context.cookies(origin);
        if (!before.some(cookie => cookie.httpOnly)) throw new Error('No authenticated HttpOnly session cookie');
        const response = await context.request.get(origin + '/api/session');
        if (!response.ok() || !(await response.json()).user) throw new Error('Session is not authenticated');
        checks.push('real_http_session_authenticated');
        const token = 'visibility-test-only-not-a-real-reset-token';
        const linkPage = await context.newPage();
        let sessionCalls = 0;
        let resetSubmissions = 0;
        linkPage.on('request', request => {
            if (request.url() === origin + '/api/session') sessionCalls += 1;
            if (request.url() === origin + '/api/set-password') resetSubmissions += 1;
        });
        await linkPage.goto(origin + '/#set-password=' + token);
        await linkPage.locator('#newPassword').waitFor({ state: 'visible' });
        await linkPage.waitForTimeout(800);
        if (await linkPage.locator('#app').isVisible() || sessionCalls !== 0 || new URL(linkPage.url()).hash) throw new Error('Existing session hid or replaced activation form');
        checks.push('new_tab_activation_has_priority_over_existing_cookie', 'activation_token_removed_from_address_bar');
        await linkPage.screenshot({ path: path.join(output, 'activation-existing-session.png'), fullPage: true });
        await page.evaluate(value => { location.hash = '#set-password=' + value; }, token);
        await page.locator('#newPassword').waitFor({ state: 'visible' });
        if (await page.locator('#app').isVisible() || new URL(page.url()).hash) throw new Error('Signed-in same-tab router hid activation form');
        checks.push('same_signed_in_tab_activation_visible');
        await page.screenshot({ path: path.join(output, 'activation-same-tab.png'), fullPage: true });
        if (resetSubmissions) throw new Error('Unexpected password submission');
        const after = await context.request.get(origin + '/api/session');
        if (!after.ok() || !(await after.json()).user) throw new Error('Opening form modified original session');
        checks.push('original_session_preserved_until_password_submission');
        const receipt = { ok: true, checks, authentication: 'real-isolated-http-cookie', passwordLink: 'inert-display-only-no-submission', mail: 'none' };
        fs.writeFileSync(path.join(output, 'browser-login-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
        console.log(JSON.stringify(receipt));
    } finally {
        await browser.close();
    }
})().catch(error => {
    console.error(error.message.replace(/https?:\/\/\S+/g, '[url]'));
    process.exitCode = 1;
});
