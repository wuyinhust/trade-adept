// @ts-check
import { test, expect } from '@playwright/test';

const APP_URL = 'https://grandware-d9gb4owez89cb9df9-1460064035.tcloudbaseapp.com';

test('探测: 登录后页面结构', async ({ page }) => {
    // 1. 打开页面
    await page.goto(APP_URL);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'e2e/screenshots/01-login.png' });

    // 2. 登录（用 placeholder 选择）
    await page.waitForTimeout(3000);
    await page.getByPlaceholder(/username|Enter your username/i).fill('David');
    await page.getByPlaceholder(/password|Enter your password/i).fill('Fuckyou361021');
    await page.getByRole('button', { name: /Sign In|登录|Login/i }).click();
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'e2e/screenshots/02-dashboard.png' });

    // 3. 探测导航栏结构
    const navItems = await page.$$eval('nav a, .sidebar a, .nav-item', els =>
        els.map(e => ({ text: e.textContent?.trim(), href: e.getAttribute('href'), onclick: e.getAttribute('onclick'), dataPage: e.getAttribute('data-page') }))
    );
    console.log('导航项:', JSON.stringify(navItems, null, 2));

    // 4. 进入客户页面
    const customerLink = page.locator('a, button').filter({ hasText: /客户/ }).first();
    await customerLink.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'e2e/screenshots/03-customers.png' });

    // 5. 探测客户页面按钮
    const buttons = await page.$$eval('button', els =>
        els.map(e => ({ text: e.textContent?.trim(), id: e.id, onclick: e.getAttribute('onclick') }))
    );
    console.log('客户页按钮:', JSON.stringify(buttons.filter(b => b.text), null, 2));

    // 6. 点击新建客户
    const newCustomerBtn = page.locator('button').filter({ hasText: /新建|新增|添加/ }).first();
    if (await newCustomerBtn.isVisible().catch(() => false)) {
        await newCustomerBtn.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'e2e/screenshots/04-customer-form.png' });

        // 7. 探测表单字段
        const inputs = await page.$$eval('input, select, textarea', els =>
            els.map(e => ({ tag: e.tagName, type: e.type, id: e.id, name: e.name, placeholder: e.placeholder, label: e.closest('label')?.textContent?.trim() }))
        );
        console.log('客户表单字段:', JSON.stringify(inputs, null, 2));
    }

    // 8. 进入工厂页面
    const factoryLink = page.locator('a, button').filter({ hasText: /工厂/ }).first();
    await factoryLink.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'e2e/screenshots/05-factories.png' });

    // 9. 进入订单页面
    const orderLink = page.locator('a, button').filter({ hasText: /订单/ }).first();
    await orderLink.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'e2e/screenshots/06-orders.png' });

    // 10. 点击新建订单
    const newOrderBtn = page.locator('button').filter({ hasText: /新建|新增|添加/ }).first();
    if (await newOrderBtn.isVisible().catch(() => false)) {
        await newOrderBtn.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'e2e/screenshots/07-order-form.png' });

        // 11. 探测订单表单字段
        const orderInputs = await page.$$eval('input, select, textarea', els =>
            els.map(e => ({ tag: e.tagName, type: e.type, id: e.id, name: e.name, placeholder: e.placeholder }))
        );
        console.log('订单表单字段:', JSON.stringify(orderInputs, null, 2));
    }
});
