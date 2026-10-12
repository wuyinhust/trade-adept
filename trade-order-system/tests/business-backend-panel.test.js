import { jest } from '@jest/globals';

const data = { orders: [], factories: [] };
const db = {
    data,
    companies: [{ id: 'C1', settlementCurrency: 'CNY' }],
    _cloudVersion: 4,
    flush: jest.fn(),
    _initFromBusinessAPI: jest.fn(),
    _handleSaveFailure: jest.fn(),
    updateOrder: jest.fn()
};
const auth = { hasCapability: jest.fn(() => true) };
const app = {
    showModal: jest.fn((title, body, options) => {
        document.getElementById('modalContainer').innerHTML = body + options.footer;
    }),
    closeModal: jest.fn(() => {
        document.getElementById('modalContainer').innerHTML = '';
    }),
    showConfirm: jest.fn(),
    updateSaveStatus: jest.fn(),
    router: jest.fn()
};
const toast = jest.fn();
const escapeHtml = value =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
jest.unstable_mockModule('../js/data.js', () => ({ DB: db }));
jest.unstable_mockModule('../js/auth.js', () => ({ Auth: auth }));
jest.unstable_mockModule('../js/app.js', () => ({ App: app }));
jest.unstable_mockModule('../js/utils.js', () => ({ escapeHtml, toast }));
const { BusinessBackendPanel: panel, summarizeBusinessItems } = await import('../js/erpnext-panel.js');
const sales = docstatus => [{ doctype: 'Sales Order', name: 'SO-1', docstatus }];

beforeEach(() => {
    jest.clearAllMocks();
    global.FormData = window.FormData;
    document.body.innerHTML = '<div id="workspaceBusinessBackend"></div><div id="modalContainer"></div>';
    data.orders = [
        { id: 'OLD', companyOperationNo: 'OLD-1', stage: 'legacy', paidAmountUSD: 500 },
        { id: 'BRIEF', companyId: 'C1', stage: 'brief', orderAmountUSD: 1000, factoryCostRMB: 700 },
        { id: 'DRAFT', stage: 'native', nativeDocuments: sales(0) },
        { id: 'FORMAL', stage: 'native', orderAmountUSD: 1000, paidAmountUSD: 100, nativeDocuments: sales(1) }
    ];
    auth.hasCapability.mockReturnValue(true);
    db.flush.mockResolvedValue(true);
    db._initFromBusinessAPI.mockResolvedValue(true);
    panel._requests.clear();
    window.Workspace = {
        api: {
            backendStatus: jest.fn().mockResolvedValue({
                backend: 'erpnext',
                singleSystem: true,
                capabilities: { convertOrder: true, submitOrder: true, receivePayment: true, cancelOrder: true },
                orders: []
            }),
            convertOrder: jest.fn().mockResolvedValue({ meta: { version: 5 } }),
            cancelOrder: jest.fn().mockResolvedValue({ meta: { version: 5 } }),
            receivePayment: jest.fn().mockResolvedValue({ meta: { version: 5 } })
        }
    };
});

test('historical references never offer conversion or receipt while native actions match document state', async () => {
    await panel.render();
    const target = document.getElementById('workspaceBusinessBackend');
    expect(target.textContent).toContain('历史参考');
    expect(target.textContent).not.toContain('同步队列');
    expect(
        [...target.querySelectorAll('[data-business-convert]')].map(button => button.dataset.businessConvert)
    ).toEqual(['BRIEF']);
    expect([...target.querySelectorAll('[data-business-submit]')].map(button => button.dataset.businessSubmit)).toEqual(
        ['DRAFT']
    );
    expect(
        [...target.querySelectorAll('[data-business-payment]')].map(button => button.dataset.businessPayment)
    ).toEqual(['FORMAL']);
    panel.receivePayment('OLD');
    panel.editItems('OLD');
    expect(app.showModal).not.toHaveBeenCalled();
    expect(data.orders[0].paidAmountUSD).toBe(500);
});

test('read-only finance visibility cannot open native mutation controls', async () => {
    auth.hasCapability.mockReturnValue(false);
    await panel.render();
    expect(
        document.querySelectorAll(
            '[data-business-items], [data-business-convert], [data-business-submit], [data-business-payment]'
        )
    ).toHaveLength(0);
    panel.receivePayment('FORMAL');
    panel.editItems('BRIEF');
    await panel.runAction('convert', 'BRIEF');
    expect(app.showModal).not.toHaveBeenCalled();
    expect(window.Workspace.api.convertOrder).not.toHaveBeenCalled();
});

test('backend failure preserves workspace rows and offers no alternate datastore', async () => {
    window.Workspace.api.backendStatus.mockRejectedValue(new Error('Business database unavailable'));
    const before = JSON.stringify(data);
    await panel.render();
    expect(document.getElementById('workspaceBusinessBackend').textContent).toContain('Business database unavailable');
    expect(document.querySelectorAll('[data-business-convert]')).toHaveLength(0);
    expect(JSON.stringify(data)).toBe(before);
});

test('network-lost conversion retry retains the same idempotency key and source version', async () => {
    window.Workspace.api.convertOrder.mockRejectedValueOnce(
        Object.assign(new Error('lost response'), { code: 'NETWORK' })
    );
    await panel.runAction('convert', 'BRIEF');
    await panel.runAction('convert', 'BRIEF');
    const calls = window.Workspace.api.convertOrder.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual(calls[1][1]);
    expect(calls[0][1].expectedVersion).toBe(4);
    expect(calls[0][1].idempotencyKey).toBeTruthy();
    expect(db._initFromBusinessAPI).toHaveBeenCalledTimes(1);
});

test('receipt requires real bank evidence and leaves balance unchanged until authorized read', async () => {
    panel.receivePayment('FORMAL');
    const form = document.getElementById('businessReceiptForm');
    form.elements.amountUSD.value = '200';
    await form.onsubmit({ preventDefault() {} });
    expect(window.Workspace.api.receivePayment).not.toHaveBeenCalled();
    form.elements.referenceNo.value = 'BANK-20261012-1';
    form.elements.referenceDate.value = '2026-10-12';
    await form.onsubmit({ preventDefault() {} });
    expect(window.Workspace.api.receivePayment).toHaveBeenCalledWith(
        'FORMAL',
        expect.objectContaining({
            amountUSD: 200,
            referenceNo: 'BANK-20261012-1',
            referenceDate: '2026-10-12',
            expectedVersion: 4,
            idempotencyKey: expect.any(String)
        })
    );
    expect(data.orders[3].paidAmountUSD).toBe(100);
    expect(db.updateOrder).not.toHaveBeenCalled();
    expect(db._initFromBusinessAPI).toHaveBeenCalledTimes(1);
});

test('failed receipt retry cannot change amount under the same request identity', async () => {
    window.Workspace.api.receivePayment.mockRejectedValueOnce(
        Object.assign(new Error('response lost'), { code: 'NETWORK' })
    );
    panel.receivePayment('FORMAL');
    const form = document.getElementById('businessReceiptForm');
    form.elements.referenceNo.value = 'BANK-1';
    form.elements.referenceDate.value = '2026-10-12';
    form.elements.amountUSD.value = '200';
    await form.onsubmit({ preventDefault() {} });
    form.elements.amountUSD.value = '250';
    await form.onsubmit({ preventDefault() {} });
    expect(window.Workspace.api.receivePayment).toHaveBeenCalledTimes(1);
    form.elements.amountUSD.value = '200';
    await form.onsubmit({ preventDefault() {} });
    const calls = window.Workspace.api.receivePayment.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual(calls[1][1]);
});

test('cancelling a formal order uses the native action and never deletes business data', async () => {
    await panel.runAction('cancel', 'FORMAL');
    expect(window.Workspace.api.cancelOrder).toHaveBeenCalledWith(
        'FORMAL',
        expect.objectContaining({ expectedVersion: 4, idempotencyKey: expect.any(String) })
    );
    expect(data.orders.find(order => order.id === 'FORMAL').deleted).toBeUndefined();
    expect(db.updateOrder).not.toHaveBeenCalled();
    expect(db._initFromBusinessAPI).toHaveBeenCalledTimes(1);
});

describe('purchase currency reconciliation', () => {
    const line = overrides => ({ quantity: 100, saleRate: 10, purchaseRate: 7, purchaseCurrency: 'CNY', ...overrides });
    test('USD sales and CNY procurement stay in their own currencies before cost comparison', () => {
        expect(summarizeBusinessItems([line()], { currency: 'CNY', usdToCny: 7 })).toEqual({
            salesUSD: 1000,
            purchaseBase: 700,
            currency: 'CNY'
        });
    });
    test('a CNY company buying in USD compares converted cost rather than adding dollar and yuan prices', () => {
        expect(
            summarizeBusinessItems(
                [
                    line({ purchaseRate: 1, purchaseCurrency: 'USD' }),
                    line({ quantity: 20, saleRate: 5, purchaseRate: 5 })
                ],
                { currency: 'CNY', usdToCny: 7 }
            )
        ).toEqual({ salesUSD: 1100, purchaseBase: 800, currency: 'CNY' });
    });
    test('a USD company buying in CNY uses the inverse configured quote', () => {
        expect(summarizeBusinessItems([line()], { currency: 'USD', usdToCny: 7 })).toEqual({
            salesUSD: 1000,
            purchaseBase: 100,
            currency: 'USD'
        });
    });
    test.each([undefined, 0, -7, NaN])('cross-currency cost cannot use an invalid quote %s', rate => {
        expect(() =>
            summarizeBusinessItems([line({ purchaseCurrency: 'USD' })], { currency: 'CNY', usdToCny: rate })
        ).toThrow('配置汇率');
    });
    test('same-currency purchase needs no fabricated quote and unsupported pairs fail clearly', () => {
        expect(summarizeBusinessItems([line()], { currency: 'CNY' }).purchaseBase).toBe(700);
        expect(() =>
            summarizeBusinessItems([line({ purchaseCurrency: 'EUR' })], { currency: 'CNY', usdToCny: 7 })
        ).toThrow('采购币种');
    });
    test('the item form saves explicit USD procurement after reconciling it to CNY company cost', async () => {
        data.factories = [{ id: 'F1', companyId: 'C1', name: 'Factory One' }];
        db.exchangeRates = { C1: 7 };
        db.updateOrder.mockReturnValue(true);
        panel.editItems('BRIEF');
        const form = document.getElementById('businessItemsForm');
        const write = (key, value) => {
            form.querySelector(`[data-business-field="${key}"]`).value = value;
        };
        write('itemCode', 'REAL-SKU');
        write('quantity', '100');
        write('saleRate', '10');
        write('purchaseRate', '1');
        write('purchaseCurrency', 'USD');
        write('factoryId', 'F1');
        await form.onsubmit({ preventDefault() {} });
        expect(db.updateOrder).toHaveBeenCalledWith('BRIEF', {
            erpItems: [
                expect.objectContaining({
                    itemCode: 'REAL-SKU',
                    quantity: 100,
                    saleRate: 10,
                    purchaseRate: 1,
                    purchaseCurrency: 'USD',
                    factoryId: 'F1'
                })
            ]
        });
    });
});
