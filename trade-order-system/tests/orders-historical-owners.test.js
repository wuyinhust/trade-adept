import { jest } from '@jest/globals';

const historical = Object.freeze({ id: 'LEGACY', name: '原 Grandware 业务员', teamId: 'OLD-TEAM', enabled: false });
const auth = {
    currentUser: {
        id: 'BOOT',
        name: '新管理员',
        tenantId: 'T',
        roleId: 'admin',
        scope: 'tenant',
        permissions: ['edit', 'create', 'finance.read', 'finance.write'],
        visibleCompanyIds: ['CN']
    },
    users: [{ id: 'BOOT', name: '新管理员', enabled: true }],
    historicalOwners: { LEGACY: historical, 7: { name: '数字编号历史业务员', teamId: 'OLD-TEAM', enabled: false } },
    getRecordOwner: id => {
        const row = auth.users.find(user => String(user.id) === String(id)) || auth.historicalOwners[String(id)];
        return row ? { id: String(id), name: row.name, teamId: row.teamId } : null;
    },
    canSeeAll: () => true,
    canSeeFinancials: () => true,
    hasCapability: name => auth.currentUser.permissions.includes(name),
    canEdit: () => true,
    canDeleteOrder: () => false,
    canViewOrder: () => true,
    isManager: () => false,
    isSalesperson: () => false,
    isDocument: () => false,
    getVisibleCompanyIds: () => null,
    filterOrders: rows => rows,
    filterCustomers: rows => rows,
    filterFactories: rows => rows,
    filterShipments: rows => rows
};
const h = value =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
const app = {
    escapeHtml: h,
    showModal: jest.fn((title, html) => {
        document.getElementById('modal').innerHTML = html;
    }),
    closeModal: jest.fn(() => {
        document.getElementById('modal').innerHTML = '';
    }),
    toast: jest.fn(),
    formatMoney: (value, currency) => `${currency} ${Number(value).toFixed(2)}`,
    formatDate: value => value || '—',
    getProfitColor: () => '',
    getPaymentBadge: value => value || '—',
    getFactoryPaidBadge: value => value || '—',
    getShippingBadge: value => value || '—',
    getStatusBadge: value => value || '—'
};
jest.unstable_mockModule('../js/auth.js', () => ({ Auth: auth }));
jest.unstable_mockModule('../js/app.js', () => ({ App: app }));
jest.unstable_mockModule('../js/cloud.js', () => ({ Cloud: {} }));
jest.unstable_mockModule('../js/exchange.js', () => ({
    Exchange: {
        isDomestic: () => true,
        calcOrderProfit: () => 9999,
        getOrderFinancials: () => ({ currency: 'CNY', policy: 'grandware-v40', computedProfit: null })
    }
}));
jest.unstable_mockModule('../js/erpnext-panel.js', () => ({ BusinessBackendPanel: {} }));
const { DB } = await import('../js/data.js');
await import('../js/orders.js');
const Orders = window.Orders;
const record = changes => ({
    id: 'OLD',
    companyId: 'CN',
    stage: 'legacy',
    customerId: 'CUSTOMER',
    customerName: '虚构客户',
    contactId: 'CONTACT',
    contactPerson: '采购联系人',
    companyOperationNo: 'OLD25A001',
    customerOrderNo: 'OLD-PO',
    orderDate: '2025-10-01',
    orderAmountUSD: 1000,
    orderAmountRMB: 7000,
    factoryCostRMB: 1130,
    freightCostUSD: 70,
    otherCostUSD: 14,
    insuranceCostUSD: 9,
    profitRMB: 123.45,
    profitRate: 1.76,
    salespersonId: 'LEGACY',
    createdBy: 'LEGACY',
    remarks: '历史备注',
    status: '进行中',
    shippingStatus: '待出运',
    paymentStatus: '未收款',
    factoryPaidStatus: '未付款',
    factories: [],
    paymentTerms: 'T/T',
    loadingPort: '上海港',
    ...changes
});
const save = form => Orders.saveOrder({ target: form, preventDefault() {} }, 'OLD');

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    sessionStorage.clear();
    global.FormData = window.FormData;
    document.body.innerHTML = '<div id="modal"></div><div id="pageTitle"></div><div id="pageContent"></div>';
    DB._BACKUP_KEY = 'isolated-historical-owner-test';
    DB.currentCompanyId = 'CN';
    DB.companies = [
        { id: 'CN', jurisdiction: 'CN', settlementCurrency: 'CNY', profitPolicy: 'grandware-v40', orderPrefix: 'OP' }
    ];
    DB._businessAPI = null;
    DB._cloudReady = true;
    DB._preserveImportedValues = true;
    DB.data = {
        orders: [],
        customers: [
            {
                id: 'CUSTOMER',
                companyId: 'CN',
                company: '虚构客户',
                country: 'US',
                contacts: [{ id: 'CONTACT', name: '采购联系人' }]
            }
        ],
        factories: [],
        shipments: [],
        invoices: []
    };
    Orders.selectedOrders.clear();
    Orders.currentFilter = {
        status: 'all',
        paymentStatus: 'all',
        shippingStatus: 'all',
        salespersonId: 'all',
        search: ''
    };
    jest.spyOn(DB, '_backupToLocal').mockImplementation(() => {});
    jest.spyOn(DB, 'flush').mockResolvedValue(true);
    jest.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => jest.restoreAllMocks());

test.each(['LEGACY', 7])(
    'actual Orders DOM preserves disabled historical owner %s through an unrelated real Data edit',
    async ownerId => {
        DB.data.orders.push(record({ salespersonId: ownerId }));
        Orders.showEditForm('OLD');
        const form = document.getElementById('orderForm');
        expect(form.elements.salespersonId.value).toBe(String(ownerId));
        expect(form.elements.salespersonId.selectedOptions[0].textContent).toContain('历史负责人（已停用）');
        const update = jest.spyOn(DB, 'updateOrder');
        form.elements.remarks.value = '只改备注';
        await save(form);
        expect(update.mock.calls[0][1]).not.toHaveProperty('salespersonId');
        expect(DB.getOrder('OLD').salespersonId).toBe(ownerId);
        expect(DB.getOrder('OLD')).toMatchObject({
            remarks: '只改备注',
            createdBy: 'LEGACY',
            profitRMB: 123.45,
            factoryCostRMB: 1130
        });
        expect(auth.users.map(user => user.id)).toEqual(['BOOT']);
        expect(historical.enabled).toBe(false);
    }
);

test('only an explicit active choice updates the real Data owner and current active name is displayed', async () => {
    DB.data.orders.push(record({ salesperson: '订单原负责人显示名' }));
    Orders.showEditForm('OLD');
    const form = document.getElementById('orderForm');
    expect(form.elements.salespersonId.options[0].textContent).toContain('订单原负责人显示名');
    form.elements.salespersonId.value = 'BOOT';
    const update = jest.spyOn(DB, 'updateOrder');
    await save(form);
    expect(update.mock.calls[0][1]).toMatchObject({ salespersonId: 'BOOT' });
    expect(DB.getOrder('OLD').salespersonId).toBe('BOOT');
    expect(Orders.salespersonName(DB.getOrder('OLD'))).toBe('新管理员');
    expect(DB.getOrder('OLD').createdBy).toBe('LEGACY');
});

test('new assignment options contain only active Auth.users, with no historical actor added', () => {
    Orders.showAddForm();
    const owner = document.getElementById('orderForm').elements.salespersonId;
    expect([...owner.options].map(option => option.value)).toEqual(['BOOT']);
    expect(owner.value).toBe('BOOT');
    expect(auth.users.map(user => user.id)).toEqual(['BOOT']);
});

test('injected historical actor cannot be assigned to a new order', async () => {
    Orders.showAddForm();
    const form = document.getElementById('orderForm');
    form.elements.salespersonId.insertAdjacentHTML('beforeend', '<option value="LEGACY">原停用人</option>');
    form.elements.salespersonId.value = 'LEGACY';
    const add = jest.spyOn(DB, 'addOrder');
    await Orders.saveOrder({ target: form, preventDefault() {} });
    expect(add).not.toHaveBeenCalled();
    expect(app.toast).toHaveBeenCalledWith(expect.stringContaining('当前启用'), 'warning');
});

test.each([
    [{ salesperson: '订单原显示名' }, '订单原显示名'],
    [{}, '原 Grandware 业务员'],
    [{ salespersonId: 'UNKNOWN' }, 'UNKNOWN']
])('detail and list show a scoped historical name or ID without reviving a login: %j', (changes, expected) => {
    DB.data.orders.push(record(changes));
    const content = document.getElementById('pageContent');
    Orders.renderDetail(content, 'OLD');
    const owner = [...content.querySelectorAll('.detail-item')].find(
        item => item.querySelector('.detail-label')?.textContent === '业务员'
    );
    expect(owner.querySelector('.detail-value').textContent).toBe(expected);
    Orders.render(content);
    expect(document.getElementById('ordersTableBody').textContent).toContain(`负责人：${expected}`);
    expect([...document.getElementById('filterSalesperson').options].map(option => option.value)).toEqual([
        'all',
        'BOOT'
    ]);
    expect(auth.users.map(user => user.id)).toEqual(['BOOT']);
});
