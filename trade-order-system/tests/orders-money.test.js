import { jest } from '@jest/globals';

let currentRate = 7;
let financialWrite = true;
let financialRead = true;
let bankRead = true;
let paymentRead = true;
const companies = [
    { id: 'CO-GR', settlementCurrency: 'CNY', profitPolicy: 'grandware-v40' },
    { id: 'CO-WY', settlementCurrency: 'CNY', profitPolicy: 'grandware-v40' },
    { id: 'CO-GW', settlementCurrency: 'USD', profitPolicy: 'grandware-v40' },
    { id: 'CO-LK', settlementCurrency: 'USD', profitPolicy: 'grandware-v40' },
    { id: 'GENERIC-CN', settlementCurrency: 'CNY', profitPolicy: 'generic-native' }
];
const db = {
    companies,
    currentCompanyId: 'GENERIC-CN',
    _cloudReady: true,
    _businessAPI: null,
    data: { orders: [], customers: [], factories: [] },
    getExchangeRate: () => currentRate,
    getOrders: () => db.data.orders,
    getCustomers: () => db.data.customers,
    getFactories: () => db.data.factories,
    getOrder: id => db.data.orders.find(row => String(row.id) === String(id)),
    getCustomer: id => db.data.customers.find(row => String(row.id) === String(id)),
    getFactory: id => db.data.factories.find(row => String(row.id) === String(id)),
    getShipmentByOrder: () => null,
    getInvoicesByOrder: () => [],
    getCurrentCompany: () => db.companies.find(row => row.id === db.currentCompanyId),
    generateCompanyOperationNo: () => 'TEST26A001',
    save: jest.fn(async () => true),
    flush: jest.fn(async () => true),
    updateOrder: jest.fn((id, patch) => Object.assign(db.getOrder(id), patch)),
    addOrder: jest.fn(value => {
        const row = { id: 'NEW', ...value };
        db.data.orders.push(row);
        return row;
    })
};
const h = value =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
const app = {
    escapeHtml: h,
    formatMoney: (value, currency) => `${currency} ${Number(value).toFixed(2)}`,
    formatDate: value => value || '—',
    showModal: jest.fn((title, html) => {
        document.getElementById('modal').innerHTML = html;
    }),
    closeModal: jest.fn(),
    toast: jest.fn(),
    exportExcel: jest.fn(),
    getProfitColor: () => '',
    getPaymentBadge: value => value,
    getFactoryPaidBadge: value => value,
    getShippingBadge: value => value,
    getStatusBadge: value => value
};
jest.unstable_mockModule('../js/data.js', () => ({ DB: db }));
jest.unstable_mockModule('../js/app.js', () => ({ App: app }));
jest.unstable_mockModule('../js/auth.js', () => ({
    Auth: {
        currentUser: { id: 'A', name: 'Alex' },
        canSeeAll: () => false,
        canSeeFinancials: () => financialRead,
        canViewOrder: () => true,
        hasCapability: name =>
            name === 'finance.bank_accounts.read'
                ? bankRead
                : name === 'finance.payment_entry.read'
                  ? paymentRead
                  : false,
        canDeleteOrder: () => false,
        canEdit: () => true
    }
}));
jest.unstable_mockModule('../js/erpnext-panel.js', () => ({ BusinessBackendPanel: {} }));
jest.unstable_mockModule('../js/order-import.js', () => ({
    handleFileImport: jest.fn(),
    processImportRows: jest.fn(),
    validateOrderData: () => '',
    validateNativeProductionPlan: () => '',
    requiresOverseasPort: () => false,
    canWriteFinancials: () => financialWrite
}));
const { Exchange } = await import('../js/exchange.js');
const { FormDrafts } = await import('../js/form-drafts.js');
await import('../js/orders.js');
const Orders = window.Orders;
const order = overrides => ({
    id: 'ORDER',
    companyId: 'GENERIC-CN',
    customerId: 'BUYER',
    customerName: '虚构客户',
    contactPerson: '联系人',
    contactId: 'CONTACT',
    companyOperationNo: 'TEST26A001',
    orderAmountUSD: 1000,
    factoryCostRMB: 1130,
    freightCostRMB: 100,
    otherCostRMB: 20,
    insuranceCostUSD: 0,
    stage: 'brief',
    factories: [],
    status: '进行中',
    paymentStatus: '未收款',
    factoryPaidStatus: '未付款',
    remarks: '原备注',
    ...overrides
});

beforeEach(() => {
    jest.clearAllMocks();
    currentRate = 7;
    financialRead = true;
    financialWrite = true;
    bankRead = true;
    paymentRead = true;
    global.FormData = window.FormData;
    document.body.innerHTML = '<div id="modal"></div><div id="pageTitle"></div><div id="pageContent"></div>';
    db.currentCompanyId = 'GENERIC-CN';
    db.data = {
        orders: [],
        customers: [{ id: 'BUYER', company: '虚构客户', contacts: [{ id: 'CONTACT', name: '联系人' }] }],
        factories: []
    };
    db._businessAPI = null;
    db.flush.mockResolvedValue(true);
    Orders._editingOrder = false;
});
afterEach(() => jest.restoreAllMocks());
const save = (form, id) => Orders.saveOrder({ target: form, preventDefault() {} }, id);

test.each(['CO-GR', 'CO-WY', 'CO-GW', 'CO-LK'])(
    'Grandware %s canonical and old-column inputs have equivalent actual units',
    companyId => {
        const domestic = companyId === 'CO-GR' || companyId === 'CO-WY';
        const base = { companyId, orderAmountUSD: 1000, insuranceCostUSD: domestic ? 9 : 0 };
        const legacy = domestic
            ? { factoryCostRMB: 1130, freightCostUSD: 100, otherCostUSD: 20 }
            : { factoryCostRMB: 700, otherCostUSD: 20 };
        const canonical = domestic
            ? { factoryCostRMB: 1130, freightCostRMB: 100, otherCostRMB: 20 }
            : { factoryCostUSD: 700, otherCostUSD: 20 };
        const before = JSON.stringify(canonical);
        expect(Exchange.calcOrderProfitForOrder({ ...base, ...legacy })).toBeCloseTo(domestic ? 5840 : 280);
        expect(Exchange.calcOrderProfitForOrder({ ...base, ...canonical })).toBeCloseTo(domestic ? 5840 : 280);
        expect(Exchange.getOrderFinancials({ ...base, ...legacy }).totalCost).toBe(
            Exchange.getOrderFinancials({ ...base, ...canonical }).totalCost
        );
        expect(JSON.stringify(canonical)).toBe(before);
    }
);

test('generic CNY RMB expenses have a different unit from same-number legacy USD expenses', () => {
    const base = {
        companyId: 'GENERIC-CN',
        orderAmountUSD: 1000,
        factoryCostRMB: 1130,
        insuranceCostUSD: 0,
        otherCostUSD: 0
    };
    expect(Exchange.calcOrderProfitForOrder({ ...base, freightCostRMB: 10 })).toBe(5860);
    expect(Exchange.calcOrderProfitForOrder({ ...base, freightCostUSD: 10 })).toBe(5800);
    expect(Exchange.calcOrderProfitForOrder({ ...base, freightCostRMB: 70 })).toBe(5800);
    expect(Exchange.getOrderFinancials({ ...base, freightCostRMB: 10 }).freightCost).toBe(10);
});

test('calculation does not persist converted USD shadow fields', () => {
    const row = order();
    const before = JSON.stringify(row);
    expect(Exchange.calcOrderProfitForOrder(row)).toBe(5750);
    Exchange.getOrderFinancials(row);
    expect(JSON.stringify(row)).toBe(before);
    expect(row).not.toHaveProperty('freightCostUSD');
    expect(row).not.toHaveProperty('otherCostUSD');
});

test('canonical zero is known and is not replaced by a default quote value', () => {
    const row = order({ freightCostRMB: 0, otherCostRMB: 0 });
    expect(Exchange.getOrderMoneyFields(row).freightCost).toEqual({ key: 'freightCostRMB', value: 0, currency: 'CNY' });
    expect(Exchange.getOrderFinancials(row).totalCost).toBe(1130);
});

test('history keeps original revenue and profit without deriving or requiring current FX', () => {
    const row = order({
        companyId: 'CO-GR',
        stage: 'legacy',
        orderAmountRMB: 6500,
        profitRMB: 123.45,
        profitRate: 1.9,
        insuranceCostUSD: 9
    });
    const before = JSON.stringify(row);
    currentRate = 99;
    expect(Exchange.getOrderFinancials(row)).toMatchObject({
        revenue: 6500,
        freightCost: 100,
        otherCost: 20,
        profit: 123.45,
        computedProfit: null
    });
    expect(JSON.stringify(row)).toBe(before);
});

test('missing historical canonical amounts stay unknown', () => {
    const row = { companyId: 'CO-GW', stage: 'legacy', orderAmountUSD: 1000, factoryCostUSD: null };
    expect(Exchange.getOrderFinancials(row)).toMatchObject({
        factoryCost: null,
        profit: null,
        incompleteHistory: true
    });
});

test('formal canonical CNY amounts use the native frozen rate for USD insurance and revenue', () => {
    const row = order({
        stage: 'native',
        exchangeRateUsed: 6.5,
        orderAmountRMB: 6500,
        factoryCostRMB: 4000,
        freightCostRMB: 65,
        otherCostRMB: 32.5,
        insuranceCostUSD: 5
    });
    currentRate = 99;
    expect(Exchange.getOrderFinancials(row)).toMatchObject({ totalCost: 4130, computedProfit: 2370 });
    expect(Exchange.calcOrderProfitForOrder(row)).toBe(2370);
});

test('quote recalculation retains canonical RMB fees and skips history and native documents', () => {
    const formal = order({ id: 'NATIVE', stage: 'native', exchangeRateUsed: 6.5, profitRMB: 111 });
    const history = order({ id: 'HISTORY', stage: 'legacy', profitRMB: 222 });
    const quote = order({ id: 'BRIEF' });
    const frozen = JSON.stringify([formal, history]);
    db.data.orders = [formal, history, quote];
    currentRate = 8;
    expect(Exchange.recalcAllOrders({ persist: false })).toBe(1);
    expect(quote.profitRMB).toBe(6750);
    expect(quote.freightCostRMB).toBe(100);
    expect(quote).not.toHaveProperty('freightCostUSD');
    expect(JSON.stringify([formal, history])).toBe(frozen);
    expect(db.save).not.toHaveBeenCalled();
});

test('canonical detail and editor show actual RMB amounts and use canonical input names', () => {
    const row = order();
    db.data.orders.push(row);
    Orders.renderDetail(document.getElementById('pageContent'), row.id);
    const text = document.getElementById('pageContent').textContent;
    expect(text).toContain('运费 (RMB)');
    expect(text).toContain('CNY 100.00');
    expect(text).toContain('其他费用 (RMB)');
    Orders.showEditForm(row.id);
    const form = document.getElementById('orderForm');
    expect(form.elements.freightCostRMB.value).toBe('100');
    expect(form.elements.otherCostRMB.value).toBe('20');
    expect(form.elements.freightCostUSD).toBeUndefined();
    expect(form.elements.otherCostUSD).toBeUndefined();
    expect(form.elements.calcProfit?.value || document.getElementById('calcProfit').value).toBe('5750.00');
});

test('editing canonical fees submits that currency once without unrendered zero shadows', async () => {
    const row = order();
    db.data.orders.push(row);
    Orders.showEditForm(row.id);
    const form = document.getElementById('orderForm');
    form.elements.freightCostRMB.value = '125';
    Orders.calcProfit();
    expect(document.getElementById('calcProfit').value).toBe('5725.00');
    jest.spyOn(Orders, 'renderDetail').mockImplementation(() => {});
    await save(form, row.id);
    expect(db.updateOrder.mock.calls[0][1]).toMatchObject({ freightCostRMB: 125 });
    for (const field of ['freightCostUSD', 'otherCostUSD', 'otherCostRMB', 'factoryCostRMB'])
        expect(db.updateOrder.mock.calls[0][1]).not.toHaveProperty(field);
});

test('an untouched canonical editor sends no monetary input and leaves source keys unchanged', async () => {
    const row = order({ stage: 'legacy', profitRMB: 123.45, orderAmountRMB: 6500 });
    db.data.orders.push(row);
    Orders.showEditForm(row.id);
    const form = document.getElementById('orderForm');
    form.elements.remarks.value = '只改备注';
    jest.spyOn(Orders, 'renderDetail').mockImplementation(() => {});
    await save(form, row.id);
    const patch = db.updateOrder.mock.calls[0][1];
    for (const key of [
        'factoryCostRMB',
        'factoryCostUSD',
        'freightCostRMB',
        'freightCostUSD',
        'otherCostRMB',
        'otherCostUSD',
        'insuranceCostUSD'
    ])
        expect(patch).not.toHaveProperty(key);
    expect(row).toMatchObject({ factoryCostRMB: 1130, freightCostRMB: 100, otherCostRMB: 20, profitRMB: 123.45 });
});

test('HK canonical factory cost is displayed and native procurement remains disabled', () => {
    const row = order({
        companyId: 'CO-GW',
        stage: 'native',
        factoryCostUSD: 700,
        factoryCostRMB: undefined,
        nativeSettlementProjection: true
    });
    db.data.orders.push(row);
    Orders.renderDetail(document.getElementById('pageContent'), row.id);
    expect(document.getElementById('pageContent').textContent).toContain('USD 700.00');
    Orders.showEditForm(row.id);
    const form = document.getElementById('orderForm');
    expect(form.elements.factoryCostUSD.value).toBe('700');
    expect(form.elements.factoryCostUSD.disabled).toBe(true);
    expect(form.textContent).toContain('预收及已核销');
});

test('non-financial editing cannot submit injected canonical cost controls', async () => {
    financialWrite = false;
    financialRead = false;
    const row = order();
    db.data.orders.push(row);
    Orders.showEditForm(row.id);
    const form = document.getElementById('orderForm');
    expect(form.elements.freightCostRMB).toBeUndefined();
    form.insertAdjacentHTML(
        'beforeend',
        '<input name="freightCostRMB" value="999"><input name="factoryCostUSD" value="999"><input name="otherCostRMB" value="999">'
    );
    form.elements.remarks.value = '业务备注';
    jest.spyOn(Orders, 'renderDetail').mockImplementation(() => {});
    await save(form, row.id);
    for (const field of ['freightCostRMB', 'factoryCostUSD', 'otherCostRMB'])
        expect(db.updateOrder.mock.calls[0][1]).not.toHaveProperty(field);
});

test('native settlement is distinct from bank net amounts and shared vouchers are not added per order', () => {
    const payment = {
        name: 'PE-SHARED',
        paymentType: 'Receive',
        bankAmount: 97,
        bankCurrency: 'USD',
        postingDate: '2026-10-13',
        sharedReceipt: true,
        additiveByOrder: false
    };
    const row = order({
        stage: 'native',
        nativeSettlementProjection: true,
        paidAmountUSD: 100,
        nativeReceiptSummary: [payment, { ...payment }]
    });
    db.data.orders.push(row);
    Orders.renderDetail(document.getElementById('pageContent'), row.id);
    const detail = document.getElementById('pageContent');
    expect(detail.textContent).toContain('预收及已核销进度');
    expect(detail.textContent).toContain('USD 100.00');
    expect(detail.textContent).toContain('银行实际收付');
    expect(detail.textContent).toContain('USD 97.00');
    expect(detail.querySelectorAll('[data-native-receipt-name="PE-SHARED"]')).toHaveLength(1);
    expect(detail.textContent).not.toContain('USD 194.00');
});

test.each(['bank', 'payment'])('bank voucher amounts are hidden without the %s read grant', grant => {
    if (grant === 'bank') bankRead = false;
    else paymentRead = false;
    const row = order({
        stage: 'native',
        nativeSettlementProjection: true,
        paidAmountUSD: 100,
        nativeReceiptSummary: [{ name: 'PE-SHARED', bankAmount: 97, bankCurrency: 'USD' }]
    });
    db.data.orders.push(row);
    Orders.renderDetail(document.getElementById('pageContent'), row.id);
    const detail = document.getElementById('pageContent');
    expect(detail.textContent).toContain('预收及已核销进度');
    expect(detail.textContent).not.toContain('PE-SHARED');
    expect(detail.textContent).not.toContain('USD 97.00');
});

test.each([true, false])('order draft is acknowledged only after successful persistence: %s', async ok => {
    const row = order();
    db.data.orders.push(row);
    Orders.showEditForm(row.id);
    const form = document.getElementById('orderForm');
    form.elements.remarks.value = '保存确认';
    const acknowledge = jest.spyOn(FormDrafts, 'acknowledgeStaged');
    const stage = jest.spyOn(FormDrafts, 'stageRecord');
    jest.spyOn(Orders, 'renderDetail').mockImplementation(() => {});
    db.flush.mockResolvedValue(ok);
    await save(form, row.id);
    expect(stage).toHaveBeenCalledWith(form);
    expect(stage.mock.invocationCallOrder[0]).toBeLessThan(db.flush.mock.invocationCallOrder[0]);
    if (ok) {
        expect(acknowledge).toHaveBeenCalledWith(form);
        expect(acknowledge.mock.invocationCallOrder[0]).toBeGreaterThan(db.flush.mock.invocationCallOrder[0]);
        expect(acknowledge.mock.invocationCallOrder[0]).toBeLessThan(app.closeModal.mock.invocationCallOrder[0]);
    } else {
        expect(acknowledge).not.toHaveBeenCalled();
        expect(app.closeModal).not.toHaveBeenCalled();
    }
});

test('canonical-only amounts export with per-item currencies without changing source records', () => {
    const row = order({ freightCostRMB: 700, otherCostRMB: undefined, otherCostUSD: 10, profitRMB: 17 });
    delete row.otherCostRMB;
    const hk = order({
        id: 'HK',
        companyId: 'CO-GW',
        factoryCostUSD: 600,
        freightCostRMB: undefined,
        otherCostRMB: undefined,
        otherCostUSD: 20,
        profitRMB: 19
    });
    delete hk.factoryCostRMB;
    db.data.orders.push(row, hk);
    const before = JSON.stringify(db.data.orders);
    Orders.exportExcel();
    const [exported, , headers] = app.exportExcel.mock.calls[0];
    expect(exported[0]).toMatchObject({
        freightCostUSD: 700,
        freightCostCurrency: 'CNY',
        otherCostUSD: 10,
        otherCostCurrency: 'USD',
        feeCurrency: 'CNY / USD',
        profitRMB: 17
    });
    expect(exported[1]).toMatchObject({ factoryCostRMB: 600, factoryCostCurrency: 'USD', profitRMB: 19 });
    expect(headers).toEqual(
        expect.arrayContaining(['factoryCostCurrency', 'freightCostCurrency', 'otherCostCurrency'])
    );
    expect(JSON.stringify(db.data.orders)).toBe(before);
});

test('non-financial export does not expose canonical amount columns or currencies', () => {
    financialRead = false;
    db.data.orders.push(order());
    Orders.exportExcel();
    const headers = app.exportExcel.mock.calls[0][2];
    for (const field of [
        'factoryCostRMB',
        'factoryCostCurrency',
        'freightCostUSD',
        'freightCostCurrency',
        'otherCostUSD',
        'otherCostCurrency'
    ])
        expect(headers).not.toContain(field);
});

test('history receipt labels and source balance are not migrated to native-settlement labels', () => {
    const row = order({ stage: 'legacy', paidAmountUSD: 17 });
    db.data.orders.push(row);
    Orders.renderDetail(document.getElementById('pageContent'), row.id);
    expect(document.getElementById('pageContent').textContent).toContain('收款进度');
    expect(document.getElementById('pageContent').textContent).not.toContain('预收及已核销');
    expect(row.paidAmountUSD).toBe(17);
});
