// @ts-check
/**
 * CRUD 验证测试：新建客户/工厂/订单 -> 保存 -> 刷新 -> 删除 -> 刷新
 * 验证软删除和云持久化是否正常工作
 *
 * 选择器策略：
 * - 表单字段：使用 input[name="..."] / select[name="..."] / textarea[name="..."]
 * - 保存按钮：.modal-footer button:has-text("保存")
 * - 确认按钮：#confirmBtn（App.showConfirm 生成的固定 ID）
 * - 列表删除按钮：tr 内 button:has-text("删除")
 */
import { test, expect } from '@playwright/test';

// 使用 Playwright 的 baseURL（本地服务器或部署 URL）
const APP_URL = '/';

test.describe.serial('CRUD 完整流程验证', () => {
    // 辅助：登录
    async function login(page) {
        captureConsole(page);
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        await page.getByPlaceholder(/username|Enter your username/i).fill('David');
        await page.getByPlaceholder(/password|Enter your password/i).fill('Fuckyou361021');
        await page.getByRole('button', { name: /Sign In|登录|Login/i }).click();
        // 等待主应用加载 + 云端连接
        await page.waitForTimeout(8000);
    }

    // 辅助：刷新（保持登录）
    async function refresh(page) {
        await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        const passwordField = page.getByPlaceholder(/password|Enter your password/i);
        if (await passwordField.isVisible().catch(() => false)) {
            await page.getByPlaceholder(/username|Enter your username/i).fill('David');
            await passwordField.fill('Fuckyou361021');
            await page.getByRole('button', { name: /Sign In|登录|Login/i }).click();
            await page.waitForTimeout(5000);
        }
    }

    // 辅助：关闭任何打开的 modal
    async function closeModals(page) {
        const overlay = page.locator('.modal-overlay').first();
        if (await overlay.isVisible().catch(() => false)) {
            const closeBtn = page.locator('.modal-close, [onclick*="closeModal"], button:has-text("取消")').first();
            if (await closeBtn.isVisible().catch(() => false)) {
                await closeBtn.click({ force: true });
            } else {
                await page.keyboard.press('Escape');
            }
            await page.waitForTimeout(1000);
        }
    }

    // 辅助：导航到指定页面
    async function navigateTo(page, pageName) {
        await closeModals(page);
        await page.click(`#nav-${pageName}`);
        await page.waitForTimeout(3000);
    }

    // 辅助：监听浏览器控制台日志
    function captureConsole(page) {
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('[DB]') || text.includes('[Cloud]') || text.includes('delete') || text.includes('删除') || text.includes('flush') || text.includes('保存')) {
                console.log(`[BROWSER ${msg.type().toUpperCase()}] ${text}`);
            }
        });
        page.on('pageerror', err => console.log(`[BROWSER ERROR] ${err.message}`));
    }
    async function confirmDialog(page) {
        await page.waitForSelector('#confirmBtn', { state: 'visible', timeout: 5000 });
        await page.locator('#confirmBtn').click();
        await page.waitForTimeout(1000);
    }

    // ==================== 客户 CRUD ====================
    test('客户: 新建 -> 保存 -> 刷新验证 -> 删除 -> 刷新验证', async ({ page }) => {
        const TEST_NAME = `TEST-CUSTOMER-${Date.now()}`;

        await login(page);
        await navigateTo(page, 'customers');

        // 1. 点击"新建客户"按钮（按钮文本含 emoji）
        await page.locator('button:has-text("新建客户")').click();
        await page.waitForSelector('#customerForm', { state: 'visible' });

        // 2. 填写所有必填字段（使用 name 属性选择器）
        await page.locator('input[name="company"]').fill(TEST_NAME);
        await page.locator('input[name="companyAddress"]').fill('123 Test Street, Test City');
        await page.locator('input[name="country"]').fill('USA');
        // 联系人信息（第一个联系人卡片，索引 0）
        await page.locator('input[name="contact_name_0"]').fill('Test Contact');
        await page.locator('input[name="contact_position_0"]').fill('Manager');
        await page.locator('input[name="contact_email_0"]').fill('test@example.com');
        await page.locator('input[name="contact_phone_0"]').fill('+1-555-123-4567');
        await page.locator('input[name="contact_mobile_0"]').fill('+1-555-987-6543');

        // 3. 保存（modal footer 中的保存按钮，文本为 "💾 保存"）
        await page.locator('.modal-footer button:has-text("保存")').click();
        await page.waitForTimeout(5000); // 等待保存到云端

        await page.screenshot({ path: 'e2e/screenshots/customer-after-save.png' });
        await closeModals(page);

        // 4. 刷新验证持久化
        await refresh(page);
        await navigateTo(page, 'customers');
        await page.waitForTimeout(3000);

        // 5. 验证客户存在
        const customerExists = await page.locator(`text=${TEST_NAME}`).first().isVisible().catch(() => false);
        console.log(`客户 "${TEST_NAME}" 刷新后存在: ${customerExists}`);
        expect(customerExists).toBeTruthy();

        // 6. 删除客户（列表行内的"删除"按钮）
        const customerRow = page.locator(`tr:has-text("${TEST_NAME}")`).first();
        await customerRow.locator('button:has-text("删除")').click();
        await page.waitForTimeout(1000);

        // 7. 确认删除
        await confirmDialog(page);
        await page.waitForTimeout(5000); // 等待云端同步

        // 8. 刷新验证已删除
        await refresh(page);
        await navigateTo(page, 'customers');
        await page.waitForTimeout(3000);

        const customerStillExists = await page.locator(`text=${TEST_NAME}`).first().isVisible().catch(() => false);
        console.log(`客户 "${TEST_NAME}" 删除刷新后仍存在: ${customerStillExists}`);
        expect(customerStillExists).toBeFalsy();
    });

    // ==================== 工厂 CRUD ====================
    test('工厂: 新建 -> 保存 -> 刷新验证 -> 删除 -> 刷新验证', async ({ page }) => {
        const TEST_NAME = `TEST-FACTORY-${Date.now()}`;

        await login(page);
        await navigateTo(page, 'factories');

        // 1. 点击"新建工厂"
        await page.locator('button:has-text("新建工厂")').click();
        await page.waitForSelector('#factoryForm', { state: 'visible' });

        // 2. 填写所有必填字段
        await page.locator('input[name="name"]').fill(TEST_NAME);
        await page.locator('input[name="contact"]').fill('Factory Manager');
        await page.locator('input[name="phone"]').fill('0755-12345678');
        await page.locator('input[name="mobilePhone"]').fill('13800138001');
        await page.locator('input[name="products"]').fill('Test Products');
        await page.locator('textarea[name="address"]').fill('456 Factory Road, Test City');

        // 3. 保存
        await page.locator('.modal-footer button:has-text("保存")').click();
        await page.waitForTimeout(5000);

        await page.screenshot({ path: 'e2e/screenshots/factory-after-save.png' });
        await closeModals(page);

        // 4. 刷新验证
        await refresh(page);
        await navigateTo(page, 'factories');
        await page.waitForTimeout(3000);

        // 5. 验证存在
        const factoryExists = await page.locator(`text=${TEST_NAME}`).first().isVisible().catch(() => false);
        console.log(`工厂 "${TEST_NAME}" 刷新后存在: ${factoryExists}`);
        expect(factoryExists).toBeTruthy();

        // 6. 删除
        const factoryRow = page.locator(`tr:has-text("${TEST_NAME}")`).first();
        await factoryRow.locator('button:has-text("删除")').click();
        await page.waitForTimeout(1000);

        // 7. 确认删除
        await confirmDialog(page);
        await page.waitForTimeout(5000);

        // 8. 刷新验证已删除
        await refresh(page);
        await navigateTo(page, 'factories');
        await page.waitForTimeout(3000);

        const factoryStillExists = await page.locator(`text=${TEST_NAME}`).first().isVisible().catch(() => false);
        console.log(`工厂 "${TEST_NAME}" 删除刷新后仍存在: ${factoryStillExists}`);
        expect(factoryStillExists).toBeFalsy();
    });

    // ==================== 订单 CRUD ====================
    test('订单: 新建 -> 保存 -> 刷新验证 -> 删除 -> 刷新验证', async ({ page }) => {
        const ORDER_NO = `TEST-OP-${Date.now()}`;

        await login(page);
        await navigateTo(page, 'orders');

        // 1. 点击新建订单
        await page.locator('button:has-text("新建订单")').click();
        await page.waitForSelector('#orderForm', { state: 'visible' });
        await page.waitForTimeout(1000);

        // 2. 选择客户（触发 onCustomerChange，自动填充付款条件和联系人）
        const customerSelect = page.locator('select[name="customerId"]');
        const customerOptions = await customerSelect.locator('option').allTextContents();
        console.log('客户选项:', customerOptions.slice(0, 5));
        if (customerOptions.length > 1) {
            await customerSelect.selectOption({ index: 1 });
            await page.waitForTimeout(1000); // 等待 onCustomerChange 填充联系人
        }

        // 3. 选择客户联系人（onCustomerChange 后应已填充选项）
        const contactSelect = page.locator('#orderContactSelect');
        const contactOptions = await contactSelect.locator('option').allTextContents();
        console.log('联系人选项:', contactOptions.slice(0, 5));
        if (contactOptions.length > 1) {
            await contactSelect.selectOption({ index: 1 });
        }

        // 4. 填写客户订单号
        await page.locator('input[name="customerOrderNo"]').fill(ORDER_NO);

        // 5. 填写订单金额（财务用户可见）
        const amountInput = page.locator('input[name="orderAmountUSD"]');
        if (await amountInput.isVisible().catch(() => false)) {
            await amountInput.fill('10000');

            // 6. 选择工厂（工厂卡片，索引 0）
            const factorySelect = page.locator('select[name="factory_0_id"]');
            const factoryOptions = await factorySelect.locator('option').allTextContents();
            console.log('工厂选项:', factoryOptions.slice(0, 5));
            if (factoryOptions.length > 1) {
                await factorySelect.selectOption({ index: 1 });
            }

            // 7. 填写工厂卡片必填字段
            await page.locator('input[name="factory_0_productType"]').fill('Test Product');
            await page.locator('input[name="factory_0_quantity"]').fill('100');
            await page.locator('input[name="factory_0_amount"]').fill('5000');
            await page.locator('input[name="factory_0_prepayment"]').fill('1000');

            // 填写日期字段（必填）
            const today = new Date().toISOString().split('T')[0];
            const inspectionDate = page.locator('input[name="factory_0_inspectionDate"]');
            if (await inspectionDate.isVisible().catch(() => false)) {
                await inspectionDate.fill(today);
            }
            const shipDate = page.locator('input[name="factory_0_shipDate"]');
            if (await shipDate.isVisible().catch(() => false)) {
                await shipDate.fill(today);
            }
        }

        // 8. 确保付款条件已填充（如果自动填充失败则手动填写）
        const paymentTermsInput = page.locator('input[name="paymentTerms"]');
        if (await paymentTermsInput.isVisible().catch(() => false)) {
            const ptValue = await paymentTermsInput.inputValue();
            if (!ptValue) {
                await paymentTermsInput.fill('30% T/T advance, 70% before shipment');
            }
        }

        await page.screenshot({ path: 'e2e/screenshots/order-form-filled.png' });

        // 9. 保存（按钮文本为 "💾 保存订单"）
        await page.locator('.modal-footer button:has-text("保存订单")').click();
        await page.waitForTimeout(5000);

        await page.screenshot({ path: 'e2e/screenshots/order-after-save.png' });
        await closeModals(page);

        // 10. 刷新验证
        await refresh(page);
        await navigateTo(page, 'orders');
        await page.waitForTimeout(3000);

        // 11. 验证订单存在（搜索客户订单号）
        const orderExists = await page.locator(`text=${ORDER_NO}`).first().isVisible().catch(() => false);
        console.log(`订单 "${ORDER_NO}" 刷新后存在: ${orderExists}`);
        expect(orderExists).toBeTruthy();

        // 12. 删除订单（订单列表无删除按钮，需进入详情页）
        // 注意：表格中"客户订单号"是普通文本不可点击，可点击的是"公司操作单号"的 span.table-link
        const orderRow = page.locator(`tr:has-text("${ORDER_NO}")`).first();
        await orderRow.locator('span.table-link').first().click();
        await page.waitForTimeout(3000);

        await page.screenshot({ path: 'e2e/screenshots/order-detail-before-delete.png' });

        // 在详情页查找删除按钮（文本为 "🗑️ 删除订单"，仅 admin 可见）
        const deleteBtn = page.locator('button:has-text("删除订单")').first();
        await deleteBtn.click();
        await page.waitForTimeout(1000);

        // 13. 确认删除
        await confirmDialog(page);
        await page.waitForTimeout(5000);

        // 14. 刷新验证已删除
        await refresh(page);
        await navigateTo(page, 'orders');
        await page.waitForTimeout(3000);

        const orderStillExists = await page.locator(`text=${ORDER_NO}`).first().isVisible().catch(() => false);
        console.log(`订单 "${ORDER_NO}" 删除刷新后仍存在: ${orderStillExists}`);
        expect(orderStillExists).toBeFalsy();
    });
});
