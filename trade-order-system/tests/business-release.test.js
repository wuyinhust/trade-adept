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
    canDeleteOrder: () => true
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
    toast: jest.fn(),
    formatDate: value => value || '-',
    formatMoney: value => String(value || 0),
    getPaymentBadge: value => value || '-',
    getShippingBadge: value => value || '-',
    getStatusBadge: value => value || '-',
    getCustomsBadge: value => value || '-',
    getProfitColor: () => '',
    exportExcel: jest.fn()
};
jest.unstable_mockModule('../js/auth.js', () => ({ Auth: auth }));
jest.unstable_mockModule('../js/app.js', () => ({ App: app }));
jest.unstable_mockModule('../js/cloud.js', () => ({ Cloud: {} }));
jest.unstable_mockModule('../js/exchange.js', () => ({
    Exchange: {
        isDomestic: id => id === 'TEST-CN',
        calcOrderProfit: () => 100,
        getOrderFinancials: () => ({ policy: 'grandware-v40', currency: 'CNY', computedProfit: 100 })
    }
}));
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
        auth.canSeeFinancials.mockReturnValue(canRead);
        auth.hasCapability.mockReturnValue(false);
        Orders.showAddForm();
        const editor = document.getElementById('orderForm');
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
