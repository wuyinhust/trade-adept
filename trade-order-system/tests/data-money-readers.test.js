import { jest } from '@jest/globals';

const auth = {
    currentUser: { id: 'fictional-admin', name: 'Fictional Admin' },
    users: [],
    canSeeFinancials: jest.fn(() => true),
    getVisibleCompanyIds: () => ['CN-TEST', 'US-TEST']
};
jest.unstable_mockModule('../js/auth.js', () => ({ Auth: auth }));
jest.unstable_mockModule('../js/app.js', () => ({ App: {} }));
jest.unstable_mockModule('../js/cloud.js', () => ({ Cloud: {} }));

// Keep both Data and Exchange real so the tests exercise the save-path bridge,
// including currency interpretation, rather than a second mock calculation.
const { DB } = await import('../js/data.js');
const { Exchange } = await import('../js/exchange.js');

const input = overrides => ({
    companyId: 'CN-TEST',
    customerId: 'fictional-customer',
    companyOperationNo: 'FICTIONAL-001',
    orderAmountUSD: 1000,
    factoryCostRMB: 2000,
    insuranceCostUSD: 10,
    ...overrides
});

beforeEach(() => {
    jest.restoreAllMocks();
    auth.canSeeFinancials.mockReturnValue(true);
    DB._businessAPI = null;
    DB._preserveImportedValues = false;
    DB.currentCompanyId = 'CN-TEST';
    DB.companies = [
        { id: 'CN-TEST', settlementCurrency: 'CNY', profitPolicy: 'generic-native' },
        { id: 'US-TEST', settlementCurrency: 'USD', profitPolicy: 'generic-native' }
    ];
    DB.exchangeRates = { 'CN-TEST': 7, 'US-TEST': 7.8 };
    DB.data = { orders: [], customers: [], factories: [], shipments: [], invoices: [] };
    jest.spyOn(DB, '_backupToLocal').mockImplementation(() => {});
});

test('Data create uses canonical RMB fees while legacy USD fees retain their distinct dimension', () => {
    const canonical = DB.addOrder(input({ freightCostRMB: 700, otherCostRMB: 140 }));
    const equivalentUsd = DB.addOrder(
        input({ companyOperationNo: 'FICTIONAL-002', freightCostUSD: 100, otherCostUSD: 20 })
    );
    const differentUsd = DB.addOrder(
        input({ companyOperationNo: 'FICTIONAL-003', freightCostUSD: 700, otherCostUSD: 140 })
    );
    expect(canonical.profitRMB).toBe(4090);
    expect(equivalentUsd.profitRMB).toBe(4090);
    expect(differentUsd.profitRMB).toBe(-950);
    expect(canonical.orderAmountRMB).toBe(7000);
    expect(canonical).not.toHaveProperty('freightCostUSD');
    expect(canonical).not.toHaveProperty('otherCostUSD');
    expect(equivalentUsd).not.toHaveProperty('freightCostRMB');
    expect(equivalentUsd).not.toHaveProperty('otherCostRMB');
});

test('Data preserves Grandware RMB expense policy and gives canonical keys priority over stale aliases', () => {
    const order = DB.addOrder(
        input({
            formulaVersion: 'grandware-v40',
            insuranceCostUSD: 13,
            freightCostRMB: 700,
            otherCostRMB: 140,
            freightCostUSD: 9999,
            otherCostUSD: 9999
        })
    );
    expect(order.profitRMB).toBe(4390.09);
    expect(order.freightCostUSD).toBe(9999);
    expect(order.otherCostUSD).toBe(9999);
});

test('Data recognizes canonical fee edits in preserving mode without creating USD shadows', () => {
    const order = DB.addOrder(input({ freightCostRMB: 700, otherCostRMB: 140 }));
    DB._preserveImportedValues = true;
    const edited = DB.updateOrder(order.id, { freightCostRMB: 840 });
    expect(edited.profitRMB).toBe(3950);
    expect(edited).not.toHaveProperty('freightCostUSD');
    expect(edited).not.toHaveProperty('otherCostUSD');
});

test('introducing a canonical zero fee replaces a nonzero legacy fee in preserving mode', () => {
    const order = DB.addOrder(input({ freightCostUSD: 100, otherCostUSD: 20 }));
    DB._preserveImportedValues = true;
    const edited = DB.updateOrder(order.id, { freightCostRMB: 0 });
    expect(edited.profitRMB).toBe(4790);
    expect(edited.freightCostRMB).toBe(0);
    expect(edited.freightCostUSD).toBe(100);
});

test('Data uses canonical USD factory cost for USD companies without multiplying by a CNY quote', () => {
    const order = DB.addOrder(
        input({
            companyId: 'US-TEST',
            factoryCostUSD: 200,
            factoryCostRMB: 99999,
            freightCostUSD: 50,
            otherCostUSD: 20
        })
    );
    expect(order.orderAmountRMB).toBe(1000);
    expect(order.profitRMB).toBe(720);
    expect(order.factoryCostUSD).toBe(200);
    expect(order.factoryCostRMB).toBe(99999);
});

test.each([
    { stage: 'legacy' },
    { stage: 'native' },
    { historicalReference: true },
    { nativeDocuments: [{ doctype: 'Sales Order', name: 'FICTIONAL-SO' }] },
    { exchangeRateUsed: 6.5 }
])('Data edits preserve frozen financial snapshots %j', frozen => {
    const saved = input({
        id: 'fictional-frozen',
        freightCostRMB: 700,
        otherCostRMB: 140,
        orderAmountRMB: 6123,
        profitRMB: 777,
        profitRate: 12.69,
        ...frozen
    });
    DB.data.orders.push(saved);
    const calculate = jest.spyOn(Exchange, 'calcOrderProfitForOrder');
    const edited = DB.updateOrder(saved.id, { factoryCostRMB: 2100, remarks: 'Fictional note' });
    expect(edited).toMatchObject({ orderAmountRMB: 6123, profitRMB: 777, profitRate: 12.69 });
    expect(calculate).not.toHaveBeenCalled();
});

test('users without financial access do not receive calculated fields on creation or fee injection on edit', () => {
    auth.canSeeFinancials.mockReturnValue(false);
    const calculate = jest.spyOn(Exchange, 'calcOrderProfitForOrder');
    const order = DB.addOrder({
        companyId: 'CN-TEST',
        customerId: 'fictional-customer',
        companyOperationNo: 'FICTIONAL-VISIBLE',
        orderAmountUSD: 1000
    });
    const edited = DB.updateOrder(order.id, {
        remarks: 'Fictional document note',
        factoryCostUSD: 200,
        freightCostRMB: 700,
        otherCostRMB: 140,
        profitRMB: 123,
        orderAmountRMB: 7000
    });
    expect(edited.remarks).toBe('Fictional document note');
    for (const key of [
        'factoryCostUSD',
        'freightCostRMB',
        'otherCostRMB',
        'orderAmountRMB',
        'profitRMB',
        'profitRate'
    ]) {
        expect(edited).not.toHaveProperty(key);
    }
    expect(calculate).not.toHaveBeenCalled();
});
