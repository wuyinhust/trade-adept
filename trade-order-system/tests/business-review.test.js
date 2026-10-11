import { jest } from '@jest/globals';

const auth = {
    currentUser: { id: 'demo-user', name: 'Alex', role: 'admin' },
    users: [{ id: 'demo-user', name: 'Alex', role: 'admin' }],
    canSeeAll: jest.fn(() => true),
    canSeeFinancials: jest.fn(() => true),
    getVisibleCompanyIds: () => null,
    filterOrders: rows => rows,
    filterCustomers: rows => rows,
    filterShipments: rows => rows
};
const app = {
    toast: jest.fn(),
    closeModal: jest.fn(),
    escapeHtml: value =>
        String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;'),
    formatMoney: value => String(value),
    formatDate: value => value || '-',
    getProfitColor: () => '',
    exportExcel: jest.fn(),
    showModal: jest.fn((title, html) => {
        document.getElementById('modal').innerHTML = html;
    })
};
jest.unstable_mockModule('../js/auth.js', () => ({ Auth: auth }));
jest.unstable_mockModule('../js/app.js', () => ({ App: app }));
jest.unstable_mockModule('../js/cloud.js', () => ({ Cloud: {} }));
jest.unstable_mockModule('../js/exchange.js', () => ({
    Exchange: {
        isDomestic: id => ['CO-GR', 'CO-WY'].includes(id),
        calcOrderProfit: () => 123,
        getOrderFinancials: order => ({
            currency: ['CO-GW', 'CO-LK'].includes(order.companyId) ? 'USD' : 'CNY',
            revenue: order.orderAmountRMB || 0,
            factoryCost: order.factoryCostRMB || 0,
            freightCost: order.freightCostUSD || 0,
            insuranceCost: 0,
            otherCost: order.otherCostUSD || 0,
            taxRebate: 0,
            profit: order.profitRMB || 0,
            profitRate: order.profitRate || 0,
            policy: 'test-policy'
        })
    }
}));
const { DB } = await import('../js/data.js');
const { processImportRows } = await import('../js/order-import.js');
await import('../js/customers.js');
await import('../js/orders.js');
await import('../js/shipping.js');
await import('../js/profit.js');
const Customers = window.Customers;
const Orders = window.Orders;
const Shipping = window.Shipping;
const Profit = window.Profit;

const orderInput = overrides => ({
    customerId: 'demo-customer',
    companyId: 'CO-GR',
    companyOperationNo: 'DEMO-001',
    orderAmountUSD: 1000,
    factoryCostRMB: 500,
    freightCostUSD: 10,
    insuranceCostUSD: 13,
    otherCostUSD: 2,
    ...overrides
});

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    global.document = window.document;
    global.FormData = window.FormData;
    document.body.innerHTML = '<div id="modal"></div><div id="pageContent"></div><input id="importFileInput">';
    DB.currentCompanyId = 'CO-GR';
    DB.companies = [
        { id: 'CO-GR', name: 'Demo CNY', orderPrefix: 'GR' },
        { id: 'CO-WY', name: 'Demo CNY 2', orderPrefix: 'WY' },
        { id: 'CO-GW', name: 'Demo USD' }
    ];
    DB.data = {
        orders: [],
        customers: [
            {
                id: 'demo-customer',
                company: 'Demo Customer',
                companyId: 'CO-GR',
                country: 'Demo',
                contacts: [{ id: 'contact-existing', name: 'Demo Contact' }]
            }
        ],
        factories: [],
        shipments: [],
        invoices: []
    };
    DB._cloudReady = true;
    DB._preserveImportedValues = false;
    auth.canSeeAll.mockReturnValue(true);
    auth.canSeeFinancials.mockReturnValue(true);
    jest.spyOn(DB, '_backupToLocal').mockImplementation(() => {});
    jest.spyOn(DB, 'flush').mockResolvedValue(true);
    jest.spyOn(Orders, 'renderDetail').mockImplementation(() => {});
    jest.spyOn(Orders, 'renderTable').mockImplementation(() => {});
    jest.spyOn(Customers, 'renderTable').mockImplementation(() => {});
    jest.spyOn(Shipping, 'renderDetail').mockImplementation(() => {});
});

describe('order identity and business numbering', () => {
    test('uses independent UUIDs while allowing the same number in separate companies', () => {
        const a = DB.addOrder(orderInput());
        const b = DB.addOrder(orderInput({ companyId: 'CO-GW' }));
        expect(a.id).toMatch(/^ORD-[0-9a-f-]{36}$/);
        expect(b.id).not.toBe(a.id);
        expect(a.id).not.toBe(a.companyOperationNo);
    });
    test('rejects duplicate numbers including tombstones and case differences', () => {
        DB.data.orders.push({ ...orderInput(), id: 'legacy-id', deleted: true });
        expect(DB.addOrder(orderInput({ companyOperationNo: ' demo-001 ' }))).toBeNull();
        expect(DB.data.orders).toHaveLength(1);
    });
    test('generates a number before checking required fields and reserves deleted sequences', () => {
        const prefix = DB.generateCompanyOperationNo('CO-GR', 'demo-user').slice(0, -3);
        DB.data.orders.push({ ...orderInput({ companyOperationNo: prefix + '005' }), id: 'legacy-id', deleted: true });
        const order = DB.addOrder(orderInput({ companyOperationNo: '' }));
        expect(order.companyOperationNo).toBe(prefix + '006');
    });
    test('uses a configured order prefix for a new generic company', () => {
        DB.companies.push({ id: 'EX-01', orderPrefix: 'EX' });
        const created = DB.addOrder(orderInput({ companyId: 'EX-01', companyOperationNo: '' }));
        expect(created.companyOperationNo).toMatch(/^EX\d{2}A001$/);
    });
    test('does not change historical identity and rejects a duplicate edit', () => {
        DB.data.orders.push(
            { ...orderInput(), id: 'legacy-id' },
            { ...orderInput({ companyOperationNo: 'DEMO-002' }), id: 'other' }
        );
        const edited = DB.updateOrder('legacy-id', { id: 'forged-id', companyOperationNo: 'DEMO-003' });
        expect(edited.id).toBe('legacy-id');
        expect(DB.updateOrder('legacy-id', { companyOperationNo: 'DEMO-002' })).toBeNull();
        expect(DB.getOrder('legacy-id').companyOperationNo).toBe('DEMO-003');
    });
    test('rejects non-finite amounts for both create and edit', () => {
        expect(DB.addOrder(orderInput({ orderAmountUSD: Infinity }))).toBeNull();
        DB.data.orders.push({ ...orderInput(), id: 'legacy-id' });
        expect(DB.updateOrder('legacy-id', { orderAmountUSD: -1 })).toBeNull();
    });
    test('historical revenue and profit remain saved when only remarks or status change', () => {
        DB._preserveImportedValues = true;
        const saved = { ...orderInput(), id: 'legacy-id', orderAmountRMB: 6789, profitRMB: 321, profitRate: 4.73 };
        DB.data.orders.push(saved);
        const calculate = jest.spyOn(DB, '_applyProfitFields');
        const updated = DB.updateOrder('legacy-id', { remarks: 'Updated remarks', status: '已订船' });
        expect(updated).toMatchObject({ orderAmountRMB: 6789, profitRMB: 321, profitRate: 4.73 });
        expect(calculate).not.toHaveBeenCalled();
    });
    test('preserved history is recalculated only after an actual raw financial input change', () => {
        DB._preserveImportedValues = true;
        DB.data.orders.push({ ...orderInput(), id: 'legacy-id', orderAmountRMB: 6789, profitRMB: 321 });
        const calculate = jest.spyOn(DB, '_applyProfitFields');
        expect(DB.updateOrder('legacy-id', { orderAmountUSD: '1000', factoryCostRMB: '500' }).profitRMB).toBe(321);
        expect(calculate).not.toHaveBeenCalled();
        expect(DB.updateOrder('legacy-id', { factoryCostRMB: 600 }).profitRMB).toBe(123);
        expect(calculate).toHaveBeenCalledTimes(1);
    });
    test('legacy non-preserving mode retains its existing recalculation behavior', () => {
        DB.data.orders.push({ ...orderInput(), id: 'legacy-id', profitRMB: 321 });
        expect(DB.updateOrder('legacy-id', { remarks: 'Legacy change' }).profitRMB).toBe(123);
    });
});

describe('Excel header matching and results', () => {
    test('does not report a successful import before database persistence completes', async () => {
        let resolveSave;
        DB.flush.mockImplementation(
            () =>
                new Promise(resolve => {
                    resolveSave = resolve;
                })
        );
        const result = document.createElement('div');
        processImportRows(
            [
                ['客户', '订单金额(USD)'],
                ['Demo Customer', 1000]
            ],
            result
        );
        expect(result.textContent).toContain('待保存');
        expect(result.textContent).not.toContain('成功导入');
        expect(result.querySelector('button').disabled).toBe(true);
        resolveSave(true);
        await Promise.resolve();
        expect(result.textContent).toContain('成功导入：1');
        expect(result.querySelector('button').disabled).toBe(false);
    });
    test('retries a failed import save without creating the orders again', async () => {
        DB.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const result = document.createElement('div');
        processImportRows(
            [
                ['客户', '订单金额(USD)'],
                ['Demo Customer', 1000]
            ],
            result
        );
        await Promise.resolve();
        const id = DB.data.orders[0].id;
        expect(result.textContent).toContain('数据库保存失败');
        expect(result.textContent).not.toContain('成功导入');
        expect(document.getElementById('importFileInput').disabled).toBe(true);
        result.querySelector('button').click();
        await Promise.resolve();
        expect(result.textContent).toContain('成功导入：1');
        expect(DB.data.orders).toHaveLength(1);
        expect(DB.data.orders[0].id).toBe(id);
        expect(DB.flush).toHaveBeenCalledTimes(2);
    });
    test('rejects an explicitly wrong currency for a Grandware v40 company', () => {
        DB.companies[0].profitPolicy = 'grandware-v40';
        const result = document.createElement('div');
        processImportRows(
            [
                ['客户', '订单金额(USD)', '运费(USD)'],
                ['Demo Customer', 1000, 20]
            ],
            result
        );
        expect(result.textContent).toContain('核算口径不符');
        expect(DB.data.orders).toHaveLength(0);
    });
    test('accepts the explicit RMB and tax rate template without changing field values', () => {
        DB.companies[0].profitPolicy = 'grandware-v40';
        const result = document.createElement('div');
        processImportRows(
            [
                ['客户', '订单金额(USD)', '货代费(RMB)', '退税率(%)', '其他费用(RMB)'],
                ['Demo Customer', 1000, 20, 13, 5]
            ],
            result
        );
        expect(DB.data.orders).toHaveLength(1);
        expect(DB.data.orders[0]).toMatchObject({ freightCostUSD: 20, insuranceCostUSD: 13, otherCostUSD: 5 });
    });
    test('keeps customer and customer PO columns separate in the distributed template', () => {
        const result = document.createElement('div');
        processImportRows(
            [
                ['客户', '客户订单号', '订单金额（USD）'],
                ['Demo Customer', 'PO-DEMO', 1000]
            ],
            result
        );
        expect(DB.data.orders).toHaveLength(1);
        expect(DB.data.orders[0].customerOrderNo).toBe('PO-DEMO');
        expect(DB.data.orders[0].customerName).toBe('Demo Customer');
    });
    test('rejects duplicate aliases without partially importing', () => {
        const result = document.createElement('div');
        processImportRows(
            [
                ['客户', '客户名称', '订单金额(USD)'],
                ['Demo Customer', 'Demo Customer', 1000]
            ],
            result
        );
        expect(result.textContent).toContain('歧义');
        expect(DB.data.orders).toHaveLength(0);
        expect(DB.flush).not.toHaveBeenCalled();
    });
    test('rejects a header that contains multiple field meanings', () => {
        const result = document.createElement('div');
        processImportRows(
            [
                ['客户/客户订单号', '订单金额(USD)'],
                ['Demo Customer', 1000]
            ],
            result
        );
        expect(result.textContent).toContain('含义不明确');
        expect(DB.data.orders).toHaveLength(0);
    });
    test('does not count rejected adds as successful imports', () => {
        jest.spyOn(DB, 'addOrder').mockReturnValue(null);
        const result = document.createElement('div');
        processImportRows(
            [
                ['客户', '订单金额(USD)'],
                ['Demo Customer', 1000]
            ],
            result
        );
        expect(result.textContent).toContain('成功导入：0');
        expect(result.textContent).toContain('失败：1');
        expect(DB.flush).not.toHaveBeenCalled();
    });
});

describe('stable contact identities', () => {
    test('editing retains existing IDs; removal is represented by the resulting array', () => {
        document.getElementById('modal').innerHTML =
            '<div id="contactsContainer">' +
            Customers.renderContactRow(0, { id: 'contact-existing', name: 'Demo Contact' }) +
            Customers.renderContactRow(1, { id: 'contact-remove', name: 'Remove' }) +
            '</div>';
        document.querySelector('[name="contact_name_0"]').value = 'Changed';
        Customers.removeContactRow(1);
        expect(Customers.collectContacts()).toEqual([
            expect.objectContaining({ id: 'contact-existing', name: 'Changed' })
        ]);
    });
    test('new contacts receive a stable UUID even on repeated collection before saving', () => {
        document.getElementById('modal').innerHTML =
            '<div id="contactsContainer">' + Customers.renderContactRow(0, { name: 'New' }) + '</div>';
        const first = Customers.collectContacts()[0];
        const second = Customers.collectContacts()[0];
        expect(first.id).toMatch(/^CONT-[0-9a-f-]{36}$/);
        expect(second.id).toBe(first.id);
    });
});

describe('role-limited order edits', () => {
    test('retries a failed new order save using the same pending record', async () => {
        DB.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const form = document.createElement('form');
        form.innerHTML =
            '<input name="customerId" value="demo-customer"><input name="orderAmountUSD" value="1000"><input name="companyOperationNo" value=""><input name="remarks" value="First">';
        const event = { preventDefault() {}, target: form };
        await Orders.saveOrder(event);
        expect(app.closeModal).not.toHaveBeenCalled();
        expect(DB.data.orders).toHaveLength(1);
        const id = DB.data.orders[0].id;
        form.querySelector('[name="remarks"]').value = 'Retry';
        await Orders.saveOrder(event);
        expect(DB.data.orders).toHaveLength(1);
        expect(DB.data.orders[0].id).toBe(id);
        expect(DB.data.orders[0].remarks).toBe('Retry');
        expect(app.closeModal).toHaveBeenCalledTimes(1);
    });
    test('a document user changing remarks preserves production, costs and dates', async () => {
        auth.canSeeAll.mockReturnValue(false);
        auth.canSeeFinancials.mockReturnValue(false);
        const original = {
            ...orderInput(),
            id: 'legacy-id',
            customerName: 'Demo Customer',
            contactPerson: 'Demo Contact',
            customerOrderNo: 'PO-DEMO',
            orderDate: '2026-01-01',
            loadingPort: '上海港',
            factoryId: 'factory-existing',
            factoryIds: ['factory-existing'],
            factoryName: 'Demo Factory',
            factories: [{ factoryId: 'factory-existing', totalAmount: 500, productType: 'Demo Product' }],
            productName: 'Demo Product',
            productCategory: 'Demo',
            quantity: 10,
            unit: 'PCS',
            expectedShipDate: '2026-02-01',
            actualShipDate: '2026-02-02',
            factoryPaidRMB: 200,
            factoryPaidStatus: '部分付款',
            paymentTerms: 'Demo terms',
            remarks: 'Before',
            salespersonId: 'demo-user',
            paidAmountUSD: 0,
            paymentStatus: '未收款',
            shippingStatus: '待出运',
            status: '进行中',
            profitRMB: 123
        };
        DB.data.orders.push(original);
        Orders.showEditForm('legacy-id');
        const form = document.getElementById('orderForm');
        form.querySelector('[name="remarks"]').value = 'After';
        await Orders.saveOrder({ preventDefault() {}, target: form }, 'legacy-id');
        const saved = DB.getOrder('legacy-id');
        expect(saved.remarks).toBe('After');
        for (const key of [
            'factoryId',
            'factoryIds',
            'factoryName',
            'factories',
            'factoryCostRMB',
            'productName',
            'quantity',
            'expectedShipDate',
            'actualShipDate',
            'factoryPaidRMB',
            'paymentTerms',
            'profitRMB'
        ]) {
            expect(saved[key]).toEqual(original[key]);
        }
    });
    test('local guard ignores finance values submitted by a role without financial access', () => {
        auth.canSeeFinancials.mockReturnValue(false);
        DB.data.orders.push({ ...orderInput(), id: 'legacy-id', profitRMB: 123 });
        const result = DB.updateOrder('legacy-id', { remarks: 'Changed', factoryCostRMB: 0, profitRMB: 99999 });
        expect(result.factoryCostRMB).toBe(500);
        expect(result.profitRMB).toBe(123);
    });
});

describe('stored order form attributes', () => {
    const payload = `0"><b data-injected="yes">Demo</b></textarea><i data-injected="yes">Tail</i>`;
    test('factory detail strings cannot terminate input attributes or create tags', () => {
        const target = document.createElement('div');
        target.innerHTML = Orders.createFactoryRow(0, {
            productType: payload,
            totalQuantity: payload,
            totalAmount: payload,
            prepayment: payload,
            inspectionDate: payload,
            estimatedShipDate: payload
        });
        expect(target.querySelector('[data-injected]')).toBeNull();
        for (const suffix of ['productType', 'quantity', 'amount', 'prepayment', 'inspectionDate', 'shipDate']) {
            expect(target.querySelector(`[name="factory_0_${suffix}"]`).getAttribute('value')).toBe(payload);
        }
    });
    test('zero quantity, total amount and prepayment remain visible as zero', () => {
        const target = document.createElement('div');
        target.innerHTML = Orders.createFactoryRow(0, { totalQuantity: 0, totalAmount: 0, prepayment: 0 });
        for (const suffix of ['quantity', 'amount', 'prepayment']) {
            expect(target.querySelector(`[name="factory_0_${suffix}"]`).value).toBe('0');
        }
    });
    test.each([true, false])(
        'stored values are escaped in finance=%s edit form, including hidden fields',
        showFinance => {
            auth.canSeeAll.mockReturnValue(false);
            auth.canSeeFinancials.mockReturnValue(showFinance);
            jest.spyOn(Orders, 'updateFactoryCost').mockImplementation(() => {});
            jest.spyOn(Orders, 'calcProfit').mockImplementation(() => {});
            const fields = [
                'salespersonId',
                'customerOrderNo',
                'companyOperationNo',
                'orderDate',
                'orderAmountUSD',
                'factoryCostRMB',
                'freightCostUSD',
                'insuranceCostUSD',
                'otherCostUSD',
                'paidAmountUSD',
                'factoryPaidRMB',
                'expectedShipDate',
                'actualShipDate'
            ];
            DB.data.orders.push({
                ...orderInput(),
                id: 'attribute-order',
                ...Object.fromEntries(fields.map(key => [key, payload])),
                factories: []
            });
            Orders.showEditForm('attribute-order');
            const target = document.getElementById('orderForm');
            expect(target.querySelector('[data-injected]')).toBeNull();
            for (const field of fields) {
                const input = target.elements.namedItem(field);
                if (input) expect(input.getAttribute('value')).toBe(payload);
            }
        }
    );
});

describe('customer persistence retry', () => {
    test('keeps failed input open and retries the same pending customer', async () => {
        DB.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const form = document.createElement('form');
        form.innerHTML =
            '<input name="company" value="New Demo Customer"><input name="companyAddress" value="Demo address"><input name="country" value="Demo">';
        const event = { preventDefault() {}, target: form };
        await Customers.saveCustomer(event);
        expect(app.closeModal).not.toHaveBeenCalled();
        expect(DB.data.customers).toHaveLength(2);
        const id = DB.data.customers[1].id;
        form.querySelector('[name="companyAddress"]').value = 'Changed address';
        await Customers.saveCustomer(event);
        expect(DB.data.customers).toHaveLength(2);
        expect(DB.data.customers[1].id).toBe(id);
        expect(DB.data.customers[1].companyAddress).toBe('Changed address');
        expect(app.closeModal).toHaveBeenCalledTimes(1);
    });
});

describe('shipment persistence feedback', () => {
    const setup = () => {
        DB.data.orders.push({ ...orderInput(), id: 'legacy-id' });
        DB.data.shipments.push({ id: 'demo-shipment', orderId: 'legacy-id', status: '待出运' });
        const form = document.createElement('form');
        form.innerHTML =
            '<input name="status" value="已出运"><input name="customsStatus" value="已报关"><input name="etd" value="2026-01-01">';
        return { preventDefault() {}, target: form };
    };
    test('keeps the modal open and avoids success when saving fails', async () => {
        DB.flush.mockResolvedValue(false);
        await Shipping.saveStatus(setup(), 'demo-shipment');
        expect(app.closeModal).not.toHaveBeenCalled();
        expect(app.toast).not.toHaveBeenCalledWith('出运状态已更新');
    });
    test('does not close until the pending database save succeeds', async () => {
        let finish;
        DB.flush.mockImplementation(
            () =>
                new Promise(resolve => {
                    finish = resolve;
                })
        );
        const pending = Shipping.saveStatus(setup(), 'demo-shipment');
        expect(app.closeModal).not.toHaveBeenCalled();
        finish(true);
        await pending;
        expect(app.closeModal).toHaveBeenCalledTimes(1);
        expect(app.toast).toHaveBeenCalledWith('出运状态已更新');
    });
});

describe('reports separate settlement currencies', () => {
    test('order exports identify each row currency and omit private fields for document users', () => {
        DB.data.orders.push({ ...orderInput(), id: 'cny' }, { ...orderInput({ companyId: 'CO-GW' }), id: 'usd' });
        Orders.exportExcel();
        const [rows, , headers] = app.exportExcel.mock.calls[0];
        expect(rows.map(row => row.settlementCurrency).sort()).toEqual(['CNY', 'USD']);
        expect(headers).toContain('factoryCostRMB');
        app.exportExcel.mockClear();
        auth.canSeeFinancials.mockReturnValue(false);
        Orders.exportExcel();
        expect(app.exportExcel.mock.calls[0][2]).not.toContain('factoryCostRMB');
        expect(app.exportExcel.mock.calls[0][2]).not.toContain('profitRMB');
    });
    test('aggregates CNY and USD separately without changing stored order fields', () => {
        const cny = {
            ...orderInput(),
            id: 'cny',
            customerName: 'Demo Customer',
            orderAmountRMB: 1000,
            profitRMB: 100,
            orderDate: '2026-01-01'
        };
        const usd = {
            ...orderInput({ companyId: 'CO-GW' }),
            id: 'usd',
            customerName: 'Demo Customer',
            orderAmountUSD: 100,
            orderAmountRMB: 100,
            profitRMB: 10,
            orderDate: '2026-01-01'
        };
        DB.data.orders.push(cny, usd);
        const before = JSON.stringify(DB.data.orders);
        Profit.reportCurrency = 'CNY';
        const domestic = Profit.getAnalysis();
        expect(domestic.orders.map(order => order.id)).toEqual(['cny']);
        expect(domestic.byMonth['2026-01'].revenue).toBe(1000);
        Profit.reportCurrency = 'USD';
        const overseas = Profit.getAnalysis();
        expect(overseas.orders.map(order => order.id)).toEqual(['usd']);
        expect(overseas.byMonth['2026-01'].revenue).toBe(100);
        expect(overseas.currencies).toEqual(['CNY', 'USD']);
        expect(JSON.stringify(DB.data.orders)).toBe(before);
    });
});
