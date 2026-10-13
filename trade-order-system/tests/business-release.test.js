import { jest } from '@jest/globals';

const auth = {
    currentUser: { id: 'test-user', name: 'Sales Test', role: 'salesperson' },
    users: [
        { id: 'test-user', name: 'Sales Test', role: 'salesperson' },
        { id: 'custom-user', name: 'Configured Role', role: 'custom_sales', roleType: 'salesperson' }
    ],
    canSeeFinancials: jest.fn(() => false),
    hasCapability: jest.fn(() => null),
    canSeeAll: () => false,
    canEdit: () => true,
    isManager: () => false,
    isSalesperson: () => true,
    isDocument: () => false,
    getVisibleCompanyIds: () => null,
    filterOrders: rows => rows,
    filterCustomers: rows => rows,
    filterFactories: rows => rows,
    filterShipments: rows => rows,
    canDeleteOrder: () => true,
    canViewOrder: () => true
};
const app = {
    escapeHtml: value =>
        String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;'),
    showModal: jest.fn((title, html) => {
        document.getElementById('modal').innerHTML = html;
    }),
    closeModal: jest.fn(),
    showConfirm: jest.fn(),
    toast: jest.fn(),
    formatDate: value => value || '-',
    formatMoney: value => String(value || 0),
    getPaymentBadge: value => value || '-',
    getFactoryPaidBadge: value => value || '-',
    getShippingBadge: value => value || '-',
    getStatusBadge: value => value || '-',
    getCustomsBadge: value => value || '-',
    getProfitColor: () => '',
    exportExcel: jest.fn()
};
jest.unstable_mockModule('../js/auth.js', () => ({ Auth: auth }));
jest.unstable_mockModule('../js/app.js', () => ({ App: app }));
jest.unstable_mockModule('../js/cloud.js', () => ({ Cloud: {} }));
const exchange = {
    isDomestic: id => id === 'TEST-CN',
    calcOrderProfit: () => 100,
    getOrderFinancials: () => ({ policy: 'grandware-v40', currency: 'CNY', computedProfit: 100 })
};
jest.unstable_mockModule('../js/exchange.js', () => ({ Exchange: exchange }));
const { DB } = await import('../js/data.js');
const { processImportRows, validateOrderData } = await import('../js/order-import.js');
await import('../js/orders.js');
await import('../js/shipping.js');
const Orders = window.Orders;
const Shipping = window.Shipping;
const order = extra => ({
    id: 'TEST-ORDER',
    companyId: 'TEST-CN',
    customerId: 'TEST-CUSTOMER',
    customerName: 'Fictional Buyer',
    customerOrderNo: 'PO-TEST',
    contactPerson: 'Fictional Contact',
    orderDate: '2026-10-11',
    loadingPort: '上海港',
    paymentTerms: 'T/T',
    companyOperationNo: 'TEST-001',
    orderAmountUSD: 1000,
    paidAmountUSD: 100,
    paymentStatus: '部分收款',
    status: '已订船',
    shippingStatus: '待出运',
    salespersonId: 'test-user',
    factories: [],
    ...extra
});
const importRows = extra => [
    ['客户', '客户订单号', '客户联系人', '订单金额(USD)', '付款条件', ...(extra?.headers || [])],
    ['Fictional Buyer', 'PO-IMPORT', 'Fictional Contact', 1000, 'T/T', ...(extra?.values || [])]
];

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    global.FormData = window.FormData;
    document.body.innerHTML =
        '<div id="modal"></div><div id="pageContent"></div><div id="pageTitle"></div><input id="importFileInput">';
    DB.currentCompanyId = 'TEST-CN';
    DB.companies = [
        {
            id: 'TEST-CN',
            jurisdiction: 'CN',
            settlementCurrency: 'CNY',
            orderPrefix: 'TT',
            profitPolicy: 'grandware-v40'
        },
        { id: 'TEST-HK', jurisdiction: 'HK', settlementCurrency: 'USD' }
    ];
    DB.data = {
        orders: [],
        customers: [
            {
                id: 'TEST-CUSTOMER',
                companyId: 'TEST-CN',
                company: 'Fictional Buyer',
                contacts: [{ name: 'Fictional Contact' }],
                paymentTerms: 'T/T'
            }
        ],
        factories: [{ id: 'TEST-FACTORY', companyId: 'TEST-CN', name: 'Fictional Factory' }],
        shipments: [],
        invoices: []
    };
    DB._businessAPI = null;
    DB._cloudReady = true;
    DB._preserveImportedValues = true;
    auth.canSeeFinancials.mockReturnValue(false);
    auth.hasCapability.mockReturnValue(null);
    Orders._editingOrder = false;
    Orders.selectedOrders.clear();
    jest.spyOn(DB, '_backupToLocal').mockImplementation(() => {});
    jest.spyOn(DB, 'flush').mockResolvedValue(true);
    jest.spyOn(Orders, 'renderTable').mockImplementation(() => {});
    jest.spyOn(Orders, 'renderDetail').mockImplementation(() => {});
    jest.spyOn(Shipping, 'renderDetail').mockImplementation(() => {});
});

function form(html) {
    const element = document.createElement('form');
    element.innerHTML = html;
    return element;
}
function event(target) {
    return { target, preventDefault() {} };
}

test('salesperson creation has public production controls and no financial controls or hidden values', () => {
    for (const canRead of [false, true]) {
        document.getElementById('modal').replaceChildren();
        auth.canSeeFinancials.mockReturnValue(canRead);
        auth.hasCapability.mockReturnValue(false);
        Orders.showAddForm();
        const editor = document.getElementById('orderForm');
        expect(editor).not.toBeNull();
        for (const key of [
            'paidAmountUSD',
            'paymentStatus',
            'factoryCostRMB',
            'factory_0_amount',
            'factory_0_prepayment'
        ])
            expect(editor.elements[key]).toBeUndefined();
        for (const key of [
            'factory_0_id',
            'factory_0_productType',
            'factory_0_quantity',
            'factory_0_inspectionDate',
            'factory_0_shipDate'
        ])
            expect(editor.elements[key]).toBeTruthy();
    }
});

test('public production edit preserves hidden per-factory costs and receipt aggregates', async () => {
    const prior = order({
        factories: [
            {
                factoryId: 'TEST-FACTORY',
                factoryName: 'Fictional Factory',
                productType: 'Sample',
                totalQuantity: 10,
                totalAmount: 700,
                prepayment: 70,
                inspectionDate: '2026-10-15',
                estimatedShipDate: '2026-10-20'
            }
        ]
    });
    DB.data.orders.push(prior);
    Orders.showEditForm(prior.id);
    const editor = document.getElementById('orderForm');
    editor.elements.factory_0_quantity.value = '12';
    await Orders.saveOrder(event(editor), prior.id);
    expect(DB.getOrder(prior.id).factories[0]).toMatchObject({ totalQuantity: 12, totalAmount: 700, prepayment: 70 });
    expect(DB.getOrder(prior.id)).toMatchObject({
        paidAmountUSD: 100,
        paymentStatus: '部分收款',
        productCategory: 'Sample',
        factoryName: 'Fictional Factory'
    });
});

test('legacy document remarks edit does not require absent historical production fields', async () => {
    const prior = order({
        factories: [{ factoryId: 'TEST-FACTORY', productType: 'Sample', totalAmount: 700 }],
        productCategory: 'Historical category',
        expectedShipDate: '2026-10-20'
    });
    DB.data.orders.push(prior);
    Orders.showEditForm(prior.id);
    const editor = document.getElementById('orderForm');
    editor.elements.remarks.value = 'Document note';
    await Orders.saveOrder(event(editor), prior.id);
    expect(DB.getOrder(prior.id).remarks).toBe('Document note');
    expect(DB.getOrder(prior.id).productCategory).toBe('Historical category');
    expect(DB.getOrder(prior.id).factories).toEqual(prior.factories);
    expect(DB.flush).toHaveBeenCalledTimes(1);
});

test('Excel preview and cancellation perform zero mutations and zero saves', () => {
    const result = document.createElement('div');
    processImportRows(importRows(), result);
    expect(result.textContent).toContain('待确认：1');
    expect(DB.data.orders).toHaveLength(0);
    expect(DB.flush).not.toHaveBeenCalled();
    result.querySelector('[data-import-cancel]').click();
    expect(app.closeModal).toHaveBeenCalledTimes(1);
    expect(DB.data.orders).toHaveLength(0);
});

test('Excel confirms once, waits for persistence, then retries using identical IDs', async () => {
    DB.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const result = document.createElement('div');
    processImportRows(importRows(), result);
    await result.querySelector('[data-import-confirm]').onclick();
    const id = DB.data.orders[0].id;
    expect(result.textContent).toContain('数据库保存失败');
    expect(result.textContent).not.toContain('成功导入');
    await result.querySelector('[data-import-confirm]').onclick();
    expect(DB.data.orders).toHaveLength(1);
    expect(DB.data.orders[0].id).toBe(id);
    expect(result.textContent).toContain('成功导入：1');
});

test('Excel reserves distinct generated operation numbers within an uncommitted preview', async () => {
    const rows = importRows();
    rows.push([...rows[1], '']);
    const result = document.createElement('div');
    processImportRows(rows, result);
    await result.querySelector('[data-import-confirm]').onclick();
    expect(DB.data.orders).toHaveLength(2);
    expect(new Set(DB.data.orders.map(item => item.companyOperationNo)).size).toBe(2);
});

test('Excel refuses wrong legal-entity customer and invalid quantity-independent amounts', () => {
    DB.data.customers[0].companyId = 'TEST-HK';
    const result = document.createElement('div');
    processImportRows(importRows(), result);
    expect(result.textContent).toContain('未找到');
    expect(DB.data.orders).toHaveLength(0);
    expect(validateOrderData(order({ orderAmountUSD: NaN }))).toContain('大于0');
});

test('HK requires overseas port while USD US legal entity does not', () => {
    expect(validateOrderData(order(), undefined, true, DB.companies[1])).toContain('海外港口');
    expect(validateOrderData(order(), undefined, true, { jurisdiction: 'US', settlementCurrency: 'USD' })).toBe('');
});

test('configured salesperson filter does not widen visibility or hard-code account IDs', () => {
    DB.data.orders.push(order(), order({ id: 'ORDER-TWO', salespersonId: 'custom-user' }));
    expect(DB.getOrders({ salespersonId: 'custom-user' }).map(item => item.id)).toEqual(['ORDER-TWO']);
    const container = document.createElement('div');
    Orders.render(container);
    expect(container.textContent).toContain('Configured Role');
    jest.spyOn(auth, 'canSeeAll').mockReturnValue(true);
    Orders.showAddForm();
    expect(
        document.getElementById('orderForm').elements.salespersonId.querySelector('option[value="custom-user"]')
    ).toBeTruthy();
});

test('minimal shipment schema remains searchable without retired fields', () => {
    DB.data.orders.push(order());
    DB.data.shipments.push({
        id: 'SHP-ONE',
        orderId: 'TEST-ORDER',
        companyId: 'TEST-CN',
        customerName: 'Fictional Buyer'
    });
    expect(DB.getShipments({ search: 'fictional' })).toHaveLength(1);
    expect(DB.getShipments({ search: 'no-match' })).toHaveLength(0);
});

test('shipment creation is linked to same legal entity and retry preserves record ID', async () => {
    DB.data.orders.push(order({ productName: 'Sample', expectedShipDate: '2026-10-20' }));
    DB.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    Shipping.showAddForm('TEST-ORDER');
    const editor = document.getElementById('shipmentForm');
    await Shipping.saveShipment(event(editor));
    const id = DB.data.shipments[0].id;
    expect(app.closeModal).not.toHaveBeenCalled();
    await Shipping.saveShipment(event(editor));
    expect(DB.data.shipments).toHaveLength(1);
    expect(DB.data.shipments[0].id).toBe(id);
    expect(DB.data.shipments[0].companyId).toBe('TEST-CN');
    expect(app.closeModal).toHaveBeenCalledTimes(1);
});

test('shipment cannot link across legal entities or to deleted orders', () => {
    DB.data.orders.push(order());
    expect(DB.addShipment({ orderId: 'TEST-ORDER', companyId: 'TEST-HK' })).toBeNull();
    DB.data.orders[0].deleted = true;
    expect(DB.addShipment({ orderId: 'TEST-ORDER' })).toBeNull();
    expect(DB.data.shipments).toHaveLength(0);
});

test('ETD never becomes an actual shipment milestone or signed date', async () => {
    DB.data.orders.push(order());
    DB.data.shipments.push({
        id: 'SHP-ONE',
        orderId: 'TEST-ORDER',
        companyId: 'TEST-CN',
        loadingPort: '上海港',
        status: '待出运',
        customsStatus: '未报关',
        etd: '2026-10-20'
    });
    Shipping.renderDetail.mockRestore();
    Shipping.renderDetail(document.getElementById('pageContent'), 'SHP-ONE');
    expect(document.getElementById('pageTitle').textContent).toBe('出运详情 - TEST-001');
    const invoice = [...document.querySelectorAll('.detail-item')].find(item => item.textContent.includes('发票号码'));
    expect(invoice.querySelector('.detail-value').textContent).toBe('未填写');
    const timelineDates = [...document.querySelectorAll('.timeline-date')].map(item => item.textContent);
    expect(timelineDates).not.toContain('2026-10-20');
    const editor = form(
        '<input name="status" value="已出运"><input name="customsStatus" value="已报关"><input name="etd" value="2026-10-20">'
    );
    await Shipping.saveStatus(event(editor), 'SHP-ONE');
    expect(DB.getOrder('TEST-ORDER').actualShipDate).toBeUndefined();
    expect(DB.flush).not.toHaveBeenCalled();
    editor.insertAdjacentHTML('beforeend', '<input name="actualShipDate" value="2026-10-21">');
    await Shipping.saveStatus(event(editor), 'SHP-ONE');
    expect(DB.getOrder('TEST-ORDER').actualShipDate).toBe('2026-10-21');
    expect(DB.getOrder('TEST-ORDER').status).toBe('已订船');
});

test('payment failure retry does not double count or accept duplicate pending submissions', async () => {
    auth.canSeeFinancials.mockReturnValue(true);
    DB.data.orders.push(order());
    DB.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const editor = form('<input name="amount" value="200"><input name="paymentStatus" value="部分收款">');
    await Orders.savePayment(event(editor), 'TEST-ORDER');
    expect(DB.getOrder('TEST-ORDER').paidAmountUSD).toBe(300);
    await Orders.savePayment(event(editor), 'TEST-ORDER');
    expect(DB.getOrder('TEST-ORDER').paidAmountUSD).toBe(300);
    expect(app.closeModal).toHaveBeenCalledTimes(1);
});

test('batch status defaults to no change and only completes after database commit', async () => {
    DB.data.orders.push(order());
    Orders.selectedOrders.add('TEST-ORDER');
    Orders.batchUpdateStatus();
    const editor = document.getElementById('batchStatusForm');
    expect(editor.elements.batchStatus.value).toBe('');
    expect(editor.elements.batchPayment).toBeUndefined();
    editor.elements.batchShipping.value = '已出运';
    DB.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await Orders.saveBatchStatus(event(editor));
    expect(Orders.selectedOrders.has('TEST-ORDER')).toBe(true);
    expect(app.closeModal).not.toHaveBeenCalled();
    expect(DB.getOrder('TEST-ORDER').status).toBe('已订船');
    await Orders.saveBatchStatus(event(editor));
    expect(Orders.selectedOrders.size).toBe(0);
    expect(app.closeModal).toHaveBeenCalledTimes(1);
});

test('orders route loads the shipment editor before using its lazy module', async () => {
    const open = jest.spyOn(Shipping, 'showAddForm').mockImplementation(() => {});
    delete window.Shipping;
    await Orders.createShipment('TEST-ORDER');
    expect(open).toHaveBeenCalledWith('TEST-ORDER');
    expect(window.Shipping).toBe(Shipping);
});

test('finance remarks edit preserves historical aggregate even when the factory display sum differs', async () => {
    auth.canSeeFinancials.mockReturnValue(true);
    const prior = order({
        factoryCostRMB: 999,
        profitRMB: 42,
        profitRate: 4.2,
        factoryPaidStatus: '未付款',
        factories: [
            {
                factoryId: 'TEST-FACTORY',
                productType: 'Sample',
                totalQuantity: 10,
                totalAmount: 700,
                prepayment: 70,
                inspectionDate: '2026-10-15',
                estimatedShipDate: '2026-10-20'
            }
        ]
    });
    DB.data.orders.push(prior);
    Orders.showEditForm(prior.id);
    const editor = document.getElementById('orderForm');
    editor.elements.remarks.value = 'Finance note';
    await Orders.saveOrder(event(editor), prior.id);
    expect(DB.getOrder(prior.id)).toMatchObject({ remarks: 'Finance note', factoryCostRMB: 999, profitRMB: 42 });
});

test('Excel date cells keep the local calendar date rather than UTC conversion', async () => {
    const rows = importRows({ headers: ['下单日期'], values: [new Date(2026, 9, 11)] });
    const result = document.createElement('div');
    processImportRows(rows, result);
    await result.querySelector('[data-import-confirm]').onclick();
    expect(DB.data.orders[0].orderDate).toBe('2026-10-11');
});

test('assigned salesperson edits an order with an inaccessible customer without changing its reference', async () => {
    DB.data.customers = [];
    const prior = order({
        factories: [
            {
                factoryId: 'TEST-FACTORY',
                productType: 'Sample',
                totalQuantity: 10,
                inspectionDate: '2026-10-15',
                estimatedShipDate: '2026-10-20'
            }
        ]
    });
    DB.data.orders.push(prior);
    Orders.showEditForm(prior.id);
    const editor = document.getElementById('orderForm');
    expect(editor.elements.customerId.value).toBe('TEST-CUSTOMER');
    expect(editor.elements.contactPerson.value).toBe('Fictional Contact');
    expect(editor.elements.contactPerson.options).toHaveLength(1);
    editor.elements.factory_0_quantity.value = '12';
    editor.elements.remarks.value = 'Assigned order note';
    const update = jest.spyOn(DB, 'updateOrder');
    await Orders.saveOrder(event(editor), prior.id);
    expect(DB.getOrder(prior.id)).toMatchObject({
        customerId: 'TEST-CUSTOMER',
        customerName: 'Fictional Buyer',
        contactPerson: 'Fictional Contact',
        remarks: 'Assigned order note'
    });
    expect(DB.getOrder(prior.id).factories[0].totalQuantity).toBe(12);
    expect(update.mock.calls[0][1]).not.toHaveProperty('customerId');
    expect(update.mock.calls[0][1]).not.toHaveProperty('customerName');
    expect(DB.flush).toHaveBeenCalledTimes(1);
});

test('formal order editor keeps native financial and production authority while saving operational remarks', async () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const native = order({
        stage: 'native',
        nativeDocuments: [{ doctype: 'Sales Order', name: 'SO-TEST', docstatus: 1 }],
        factories: [
            {
                factoryId: 'TEST-FACTORY',
                productType: 'Real product',
                totalQuantity: 10,
                totalAmount: 500,
                prepayment: 0
            }
        ]
    });
    DB.data.orders.push(native);
    DB._businessAPI = {};
    const update = jest.spyOn(DB, 'updateOrder').mockReturnValue(native);
    const refresh = jest.spyOn(DB, '_initFromBusinessAPI').mockResolvedValue(true);
    Orders.showEditForm(native.id);
    const editor = document.getElementById('orderForm');
    for (const name of [
        'customerId',
        'orderDate',
        'customerOrderNo',
        'expectedShipDate',
        'actualShipDate',
        'shippingStatus',
        'orderAmountUSD',
        'factoryCostRMB',
        'paymentStatus',
        'paidAmountUSD',
        'factoryPaidStatus',
        'factoryPaidRMB',
        'factory_0_id',
        'factory_0_quantity'
    ]) {
        expect(editor.elements[name].disabled).toBe(true);
    }
    expect(editor.elements.status.querySelector('option[value="已取消"]')).toBeNull();
    editor.elements.remarks.value = 'updated shipping instruction';
    await Orders.saveOrder(event(editor), native.id);
    expect(update).toHaveBeenCalledWith(
        native.id,
        expect.objectContaining({ remarks: 'updated shipping instruction' })
    );
    const patch = update.mock.calls[0][1];
    for (const key of [
        'customerId',
        'orderDate',
        'customerOrderNo',
        'expectedShipDate',
        'actualShipDate',
        'shippingStatus',
        'orderAmountUSD',
        'factoryCostRMB',
        'factories',
        'paidAmountUSD',
        'paymentStatus',
        'factoryPaidRMB'
    ])
        expect(patch).not.toHaveProperty(key);
    expect(refresh).toHaveBeenCalledTimes(1);
    DB._businessAPI = null;
});

test('historical reference balances cannot be posted through the old quick-payment flow', () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const historical = order({ stage: 'legacy' });
    DB.data.orders.push(historical);
    Orders.updatePayment(historical.id);
    expect(app.showModal).not.toHaveBeenCalled();
    expect(historical.paidAmountUSD).toBe(100);
    expect(app.toast).toHaveBeenCalledWith(expect.stringContaining('历史余额'), 'info');
});

test('formal order deletion uses neither single nor bulk legacy deletion commands', () => {
    const native = order({ stage: 'native' });
    DB.data.orders.push(native);
    const deletion = jest.spyOn(DB, 'deleteOrder');
    Orders.deleteOrder(native.id);
    Orders.selectedOrders.add(native.id);
    Orders.batchDelete();
    expect(deletion).not.toHaveBeenCalled();
    expect(app.showConfirm).not.toHaveBeenCalled();
    expect(native.deleted).toBeUndefined();
});

function importAPI() {
    const api = { importOrders: jest.fn().mockResolvedValue({ meta: { version: 2 } }) };
    DB._businessAPI = api;
    DB._cloudVersion = 1;
    return api;
}

test('explicit historical Excel import preserves source balances and profits without inventing origin or local rows', async () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const api = importAPI();
    const result = document.createElement('div');
    processImportRows(
        [
            ['记录ID', '客户', '公司操作单号', '订单金额(USD)', '已收款(USD)', '利润(结算币种)'],
            ['HISTORY-1', 'Fictional Buyer', 'HIS-001', 1000, 300, 777.77]
        ],
        result,
        { importPurpose: 'historical-reference' }
    );
    expect(result.textContent).toContain('累计余额不生成账务');
    expect(api.importOrders).not.toHaveBeenCalled();
    expect(DB.data.orders).toHaveLength(0);
    await result.querySelector('[data-import-confirm]').onclick();
    const [changes, options] = api.importOrders.mock.calls[0];
    expect(options).toEqual({ importPurpose: 'historical-reference', expectedVersion: 1 });
    expect(changes[0]).toMatchObject({
        collection: 'orders',
        id: 'HISTORY-1',
        value: { companyId: 'TEST-CN', companyOperationNo: 'HIS-001', paidAmountUSD: 300, profitRMB: 777.77 }
    });
    for (const key of ['createdBy', 'createdAt', 'orderDate', 'salespersonId', 'contactPerson', 'factories'])
        expect(changes[0].value).not.toHaveProperty(key);
    expect(DB.data.orders).toHaveLength(0);
    expect(DB.flush).not.toHaveBeenCalled();
});

test('Excel history maintenance matches ID and preserves blank fields and historical cross-company customer links', async () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const prior = order({ stage: 'legacy', customerId: 'HISTORICAL-FOREIGN-CUSTOMER' });
    DB.data.orders.push(prior);
    const api = importAPI();
    const result = document.createElement('div');
    processImportRows(
        [
            ['订单号', '法人主体ID', '公司操作单号', '客户', '备注', '已收款(USD)', '下单日期'],
            [prior.id, prior.companyId, prior.companyOperationNo, prior.customerName, 'Excel correction', '', '']
        ],
        result,
        { importPurpose: 'historical-reference' }
    );
    expect(result.textContent).toContain('更新');
    await result.querySelector('[data-import-confirm]').onclick();
    expect(api.importOrders.mock.calls[0][0]).toEqual([
        { collection: 'orders', id: prior.id, value: { remarks: 'Excel correction' } }
    ]);
    expect(prior.paidAmountUSD).toBe(100);
    expect(prior.customerId).toBe('HISTORICAL-FOREIGN-CUSTOMER');
});

test('Excel maintenance also matches current legal entity and operation number without creating a duplicate', async () => {
    const prior = order({ stage: 'legacy' });
    DB.data.orders.push(prior);
    const api = importAPI();
    const result = document.createElement('div');
    processImportRows(
        [
            ['公司操作单号', '备注'],
            [prior.companyOperationNo, 'Updated by Excel']
        ],
        result
    );
    await result.querySelector('[data-import-confirm]').onclick();
    expect(api.importOrders.mock.calls[0][0]).toEqual([
        { collection: 'orders', id: prior.id, value: { remarks: 'Updated by Excel' } }
    ]);
    expect(DB.data.orders).toHaveLength(1);
});

test('new-business Excel import cannot masquerade a cumulative balance as an actual receipt', () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const api = importAPI();
    const result = document.createElement('div');
    processImportRows(importRows({ headers: ['已收款(USD)'], values: [300] }), result);
    expect(result.textContent).toContain('请选择历史参考用途');
    expect(result.querySelector('[data-import-confirm]').disabled).toBe(true);
    expect(api.importOrders).not.toHaveBeenCalled();
    expect(DB.data.orders).toHaveLength(0);
});

test('historical import purpose cannot convert an existing formal order into an editable reference', () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const prior = order({ stage: 'native' });
    DB.data.orders.push(prior);
    const result = document.createElement('div');
    processImportRows(
        [
            ['订单号', '备注'],
            [prior.id, 'Attempted reclassification']
        ],
        result,
        { importPurpose: 'historical-reference' }
    );
    expect(result.textContent).toContain('不能改为历史参考');
    expect(result.querySelector('[data-import-confirm]').disabled).toBe(true);
});

test('failed historical import retains exact IDs and purpose in the preview without creating autosave drafts', async () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const api = importAPI();
    api.importOrders.mockRejectedValueOnce(Object.assign(new Error('network'), { code: 'NETWORK' }));
    const result = document.createElement('div');
    processImportRows(
        [
            ['客户', '公司操作单号', '订单金额(USD)'],
            ['Fictional Buyer', 'HIS-002', 1000]
        ],
        result,
        { importPurpose: 'historical-reference' }
    );
    await result.querySelector('[data-import-confirm]').onclick();
    expect(DB.data.orders).toHaveLength(0);
    expect(DB.flush).not.toHaveBeenCalled();
    await result.querySelector('[data-import-confirm]').onclick();
    expect(api.importOrders.mock.calls[0]).toEqual(api.importOrders.mock.calls[1]);
    expect(result.textContent).toContain('数据库保存成功');
});

test('an invalid historical profit cell cannot turn into null and clear the stored reference value', () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const prior = order({ stage: 'legacy', profitRMB: 777.77 });
    DB.data.orders.push(prior);
    const api = importAPI();
    const result = document.createElement('div');
    processImportRows(
        [
            ['订单号', '利润(结算币种)'],
            [prior.id, 'not a number']
        ],
        result,
        { importPurpose: 'historical-reference' }
    );
    expect(result.textContent).toContain('有限数值');
    expect(result.querySelector('[data-import-confirm]').disabled).toBe(true);
    expect(api.importOrders).not.toHaveBeenCalled();
    expect(prior.profitRMB).toBe(777.77);
});

test('historical orders with unknown profit and balances remain visible without invented financial zeroes', () => {
    auth.canSeeFinancials.mockReturnValue(true);
    const historical = order({
        stage: 'legacy',
        profitRate: undefined,
        profitRMB: undefined,
        factoryCostRMB: undefined,
        paidAmountUSD: undefined
    });
    DB.data.orders.push(historical);
    document.getElementById('pageContent').innerHTML = '<table><tbody id="ordersTableBody"></tbody></table>';
    Orders.renderTable.mockRestore();
    expect(() => Orders.renderTable()).not.toThrow();
    expect(document.getElementById('ordersTableBody').textContent).toContain('—');
    expect(document.getElementById('ordersTableBody').textContent).not.toContain('NaN');
});

test('formal order production dates and type remain editable without changing native supplier, quantity or cost', async () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const factory = {
        factoryId: 'TEST-FACTORY',
        productType: 'Real product',
        totalQuantity: 10,
        totalAmount: 500,
        prepayment: 0,
        inspectionDate: '2026-10-15',
        estimatedShipDate: '2026-10-20'
    };
    const native = order({ stage: 'native', factories: [factory] });
    DB.data.orders.push(native);
    DB._businessAPI = {};
    const update = jest.spyOn(DB, 'updateOrder').mockReturnValue(native);
    jest.spyOn(DB, '_initFromBusinessAPI').mockResolvedValue(true);
    Orders.showEditForm(native.id);
    const editor = document.getElementById('orderForm');
    expect(editor.elements.factory_0_productType.disabled).toBe(false);
    expect(editor.elements.factory_0_inspectionDate.disabled).toBe(false);
    expect(editor.elements.factory_0_shipDate.disabled).toBe(false);
    editor.elements.factory_0_productType.value = 'Updated production type';
    editor.elements.factory_0_inspectionDate.value = '2026-10-16';
    editor.elements.factory_0_quantity.value = '999';
    editor.elements.factory_0_amount.value = '9999';
    await Orders.saveOrder(event(editor), native.id);
    expect(update).toHaveBeenCalledWith(
        native.id,
        expect.objectContaining({
            factories: [{ ...factory, productType: 'Updated production type', inspectionDate: '2026-10-16' }]
        })
    );
});

test('Excel technical record IDs fail preview when they violate the native identifier policy', () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const api = importAPI();
    const result = document.createElement('div');
    processImportRows(
        [
            ['记录ID', '客户', '公司操作单号', '订单金额(USD)'],
            ["id'withquote", 'Fictional Buyer', 'HIS-003', 1000]
        ],
        result,
        { importPurpose: 'historical-reference' }
    );
    expect(result.textContent).toContain('记录 ID 仅支持');
    expect(result.querySelector('[data-import-confirm]').disabled).toBe(true);
    expect(api.importOrders).not.toHaveBeenCalled();
});

test('native commercial and shipping authority cannot be overwritten by disabled controls or production forecasts', async () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const factory = {
        factoryId: 'TEST-FACTORY',
        productType: 'Real product',
        totalQuantity: 10,
        totalAmount: 500,
        prepayment: 0,
        inspectionDate: '2026-10-15',
        estimatedShipDate: '2026-10-20'
    };
    const native = order({
        stage: 'native',
        customerOrderNo: 'NATIVE-PO',
        expectedShipDate: '2026-10-20',
        actualShipDate: '2026-10-21',
        shippingStatus: '已出运',
        factories: [factory]
    });
    DB.data.orders.push(native);
    DB._businessAPI = {};
    const update = jest.spyOn(DB, 'updateOrder').mockReturnValue(native);
    jest.spyOn(DB, '_initFromBusinessAPI').mockResolvedValue(true);
    Orders.showEditForm(native.id);
    const editor = document.getElementById('orderForm');
    for (const [name, value] of Object.entries({
        customerOrderNo: 'FORGED-PO',
        orderDate: '2020-01-01',
        expectedShipDate: '2027-01-01',
        actualShipDate: '2027-01-02',
        shippingStatus: '已签收'
    })) {
        expect(editor.elements[name].disabled).toBe(true);
        editor.elements[name].value = value;
    }
    editor.elements.factory_0_shipDate.value = '2026-10-22';
    await Orders.saveOrder(event(editor), native.id);
    const patch = update.mock.calls[0][1];
    for (const name of ['customerOrderNo', 'orderDate', 'expectedShipDate', 'actualShipDate', 'shippingStatus'])
        expect(patch).not.toHaveProperty(name);
    expect(patch.factories).toEqual([{ ...factory, estimatedShipDate: '2026-10-22' }]);
    expect(native.expectedShipDate).toBe('2026-10-20');
});

test('native shipping status cannot be changed through batch editing or Excel preview', async () => {
    const native = order({ stage: 'native' });
    DB.data.orders.push(native);
    const update = jest.spyOn(DB, 'updateOrder');
    await Orders.saveBatchStatus(
        event(form(`<input name="batchIds" value="${native.id}"><input name="batchShipping" value="已签收">`))
    );
    expect(update).not.toHaveBeenCalled();
    const result = document.createElement('div');
    processImportRows(
        [
            ['订单号', '出运状态'],
            [native.id, '已签收']
        ],
        result
    );
    expect(result.textContent).toContain('由业务单据维护');
    expect(result.querySelector('[data-import-confirm]').disabled).toBe(true);
});

test('native expense preview retains document revenue, procurement cost and frozen currency rate', () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const native = order({
        stage: 'native',
        profitPolicy: 'generic-native',
        exchangeRateUsed: 7,
        orderAmountRMB: 7000,
        factoryCostRMB: 5000,
        freightCostUSD: 10,
        insuranceCostUSD: 5,
        otherCostUSD: 3,
        factories: [{ factoryId: 'TEST-FACTORY', productType: 'Sample', totalQuantity: 10, totalAmount: 4000 }]
    });
    DB.data.orders.push(native);
    jest.spyOn(DB, 'getExchangeRate').mockReturnValue(99);
    const calculate = jest.spyOn(exchange, 'getOrderFinancials').mockImplementation(preview => ({
        computedProfit:
            preview.orderAmountRMB -
            preview.factoryCostRMB -
            (preview.freightCostUSD + preview.insuranceCostUSD + preview.otherCostUSD) * preview.exchangeRateUsed
    }));
    Orders.showEditForm(native.id);
    const editor = document.getElementById('orderForm');
    expect(editor.elements.factoryCostRMB.value).toBe('5000');
    expect(document.getElementById('calcProfit').value).toBe('1874.00');
    editor.elements.orderAmountUSD.value = '999999';
    editor.elements.factoryCostRMB.value = '1';
    editor.elements.otherCostUSD.value = '4';
    Orders.calcProfit();
    expect(calculate).toHaveBeenLastCalledWith(
        expect.objectContaining({
            stage: 'native',
            profitPolicy: 'generic-native',
            exchangeRateUsed: 7,
            orderAmountUSD: 1000,
            orderAmountRMB: 7000,
            factoryCostRMB: 5000,
            otherCostUSD: 4
        })
    );
    expect(document.getElementById('calcProfit').value).toBe('1867.00');
});

test('native USD remarks edit retains expenses absent from the displayed editor', async () => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const native = order({
        stage: 'native',
        companyId: 'TEST-HK',
        factoryCostRMB: 500,
        freightCostUSD: 10,
        insuranceCostUSD: 5,
        otherCostUSD: 3
    });
    DB.data.orders.push(native);
    DB._businessAPI = {};
    const update = jest.spyOn(DB, 'updateOrder').mockReturnValue(native);
    jest.spyOn(DB, '_initFromBusinessAPI').mockResolvedValue(true);
    const calculate = jest.spyOn(exchange, 'getOrderFinancials');
    Orders.showEditForm(native.id);
    const editor = document.getElementById('orderForm');
    expect(editor.elements.freightCostUSD).toBeUndefined();
    expect(editor.elements.insuranceCostUSD).toBeUndefined();
    expect(calculate).toHaveBeenLastCalledWith(expect.objectContaining({ freightCostUSD: 10, insuranceCostUSD: 5 }));
    editor.elements.remarks.value = 'Production note';
    await Orders.saveOrder(event(editor), native.id);
    expect(update).toHaveBeenCalled();
    expect(update.mock.calls[0][1]).not.toHaveProperty('freightCostUSD');
    expect(update.mock.calls[0][1]).not.toHaveProperty('insuranceCostUSD');
});

test('historical edit preview retains original profit and explicitly displays unknown profit', () => {
    auth.canSeeFinancials.mockReturnValue(true);
    const historical = order({ stage: 'legacy', profitRMB: 777.77 });
    DB.data.orders.push(historical);
    const calculate = jest.spyOn(exchange, 'getOrderFinancials');
    Orders.showEditForm(historical.id);
    expect(document.getElementById('calcProfit').value).toBe('777.77');
    expect(calculate).not.toHaveBeenCalled();
    delete historical.profitRMB;
    Orders.showEditForm(historical.id);
    expect(document.getElementById('calcProfit').value).toBe('—');
});

test('cancelled native order edit keeps the zero profit projected by cancelled documents', () => {
    auth.canSeeFinancials.mockReturnValue(true);
    const native = order({ stage: 'native', status: '已取消', profitRMB: 0 });
    DB.data.orders.push(native);
    const calculate = jest.spyOn(exchange, 'getOrderFinancials');
    Orders.showEditForm(native.id);
    expect(document.getElementById('calcProfit').value).toBe('0.00');
    expect(calculate).not.toHaveBeenCalled();
});

test('legacy requestSubmit allows a remarks-only patch with missing original port, dates and production fields', async () => {
    const prior = order({
        stage: 'legacy',
        companyId: 'TEST-HK',
        overseasPort: '',
        orderDate: undefined,
        factories: [{ factoryId: 'TEST-FACTORY', productType: '', totalQuantity: 0 }]
    });
    DB.data.orders.push(prior);
    DB._businessAPI = {};
    const update = jest.spyOn(DB, 'updateOrder');
    jest.spyOn(DB, '_initFromBusinessAPI').mockResolvedValue(true);
    Orders.showEditForm(prior.id);
    const editor = document.getElementById('orderForm');
    const quantity = editor.elements.factory_0_quantity;
    quantity.min = '1';
    expect(editor.elements.overseasPort.validity.valueMissing).toBe(true);
    expect(quantity.validity.rangeUnderflow).toBe(true);
    expect(editor.noValidate).toBe(true);
    editor.elements.remarks.value = 'Historical document note';
    const submit = jest.spyOn(Orders, 'saveOrder');
    editor.requestSubmit();
    expect(submit).toHaveBeenCalledTimes(1);
    await submit.mock.results[0].value;
    expect(update).toHaveBeenCalledWith(prior.id, { remarks: 'Historical document note' });
    expect(DB.flush).toHaveBeenCalledTimes(1);
    expect(DB.getOrder(prior.id)).toMatchObject({
        overseasPort: '',
        factories: [{ factoryId: 'TEST-FACTORY', productType: '', totalQuantity: 0 }]
    });
    expect(DB.getOrder(prior.id).orderDate).toBeUndefined();
});

test('new business and nonhistorical edit forms retain browser required-field validation', () => {
    Orders.showAddForm();
    const newEditor = document.getElementById('orderForm');
    expect(newEditor.noValidate).toBe(false);
    expect(newEditor.elements.customerId.required).toBe(true);
    expect(newEditor.elements.orderDate.required).toBe(true);
    const brief = order({ stage: 'brief' });
    DB.data.orders.push(brief);
    Orders.showEditForm(brief.id);
    expect(document.getElementById('orderForm').noValidate).toBe(false);
});

test.each([
    ['orderDate', '2026-02-30', '有效日期'],
    ['orderAmountUSD', '0', '大于0'],
    ['freightCostUSD', '-1', '非负数'],
    ['factory_0_quantity', '-1', '正整数']
])('legacy patch validation rejects a newly invalid %s despite noValidate', async (field, value, message) => {
    auth.canSeeFinancials.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    const prior = order({
        stage: 'legacy',
        factories: [
            {
                factoryId: 'TEST-FACTORY',
                productType: 'Sample',
                totalQuantity: 10,
                totalAmount: 700,
                prepayment: 0,
                inspectionDate: '2026-10-15',
                estimatedShipDate: '2026-10-20'
            }
        ]
    });
    DB.data.orders.push(prior);
    const update = jest.spyOn(DB, 'updateOrder');
    Orders.showEditForm(prior.id);
    const editor = document.getElementById('orderForm');
    expect(editor.noValidate).toBe(true);
    editor.elements[field].value = value;
    await Orders.saveOrder(event(editor), prior.id);
    expect(app.toast).toHaveBeenCalledWith(expect.stringContaining(message), 'error');
    expect(update).not.toHaveBeenCalled();
    expect(DB.flush).not.toHaveBeenCalled();
});

function detailValue(label) {
    const field = [...document.querySelectorAll('.detail-item')].find(
        item => item.querySelector('.detail-label')?.textContent === label
    );
    return field?.querySelector('.detail-value')?.textContent;
}

test('native detail renders actual item quantity and UOM without the old aggregate field', () => {
    const native = order({
        stage: 'native',
        unit: 'LEGACY-UNIT',
        erpItems: [
            { itemCode: 'SKU-1', quantity: 4, uom: 'Nos' },
            { itemCode: 'SKU-2', quantity: 6, uom: 'Nos' }
        ],
        factories: [{ factoryId: 'TEST-FACTORY', totalQuantity: 99 }],
        productName: undefined,
        productCategory: '  '
    });
    DB.data.orders.push(native);
    Orders.renderDetail.mockRestore();
    const container = document.getElementById('pageContent');
    for (const financeVisible of [false, true]) {
        auth.canSeeFinancials.mockReturnValue(financeVisible);
        Orders.renderDetail(container, native.id);
        expect(detailValue('数量')).toBe('10 Nos');
        expect(detailValue('产品名称')).toBe('—');
        expect(detailValue('产品类别')).toBe('—');
        expect(container.textContent).not.toContain('undefined');
        if (!financeVisible) {
            const quantityCard = [...container.querySelectorAll('.stat-card')].find(
                card => card.querySelector('.stat-label')?.textContent === '产品数量'
            );
            expect(quantityCard.querySelector('.stat-value').textContent).toBe('10');
            expect(quantityCard.querySelector('.stat-sub').textContent).toBe('Nos');
        }
    }
});

test('native mixed units render separate quantities rather than a misleading combined total', () => {
    const native = order({
        stage: 'native',
        erpItems: [
            { quantity: 10, uom: 'Nos' },
            { quantity: 3, uom: 'Box' }
        ]
    });
    DB.data.orders.push(native);
    Orders.renderDetail.mockRestore();
    Orders.renderDetail(document.getElementById('pageContent'), native.id);
    expect(detailValue('数量')).toBe('10 Nos / 3 Box');
});

test.each([
    [0, '0 PCS'],
    [undefined, '—']
])('historical detail retains original quantity %s and never substitutes production zeroes', (quantity, text) => {
    const historical = order({
        stage: 'legacy',
        quantity,
        unit: 'PCS',
        factories: [{ factoryId: 'TEST-FACTORY', totalQuantity: 10 }]
    });
    DB.data.orders.push(historical);
    Orders.renderDetail.mockRestore();
    Orders.renderDetail(document.getElementById('pageContent'), historical.id);
    expect(detailValue('数量')).toBe(text);
});

test('finance-redacted native details use known public quantity and leave unknown quantities or units explicit', () => {
    const native = order({
        stage: 'native',
        quantity: 99,
        unit: 'LEGACY-UNIT',
        factories: [{ factoryId: 'TEST-FACTORY', totalQuantity: 10 }]
    });
    DB.data.orders.push(native);
    Orders.renderDetail.mockRestore();
    const container = document.getElementById('pageContent');
    Orders.renderDetail(container, native.id);
    expect(detailValue('数量')).toBe('10 —');
    delete native.factories[0].totalQuantity;
    Orders.renderDetail(container, native.id);
    expect(detailValue('数量')).toBe('—');
    expect(container.querySelector('.factory-detail-card').textContent).toContain('总数量：—');
    expect(container.querySelector('.factory-detail-card').textContent).toContain('产品类型：—');
    expect(container.textContent).not.toContain('undefined');
});
