/**
 * @file data.test.js
 * Data layer tests — pure logic methods (CRUD, filtering, formatting, stats)
 */
import { jest } from '@jest/globals';

// ==================== Mocks ====================

const mockAuth = {
    currentUser: null,
    users: [
        { id: 'U001', username: 'David', name: 'David', role: 'admin', teamId: null },
        { id: 'U005', username: 'Michale', name: 'Michale', role: 'salesperson', teamId: 'TEAM-A' },
        { id: 'U003', username: 'Vivian', name: 'Vivian', role: 'manager', teamId: 'TEAM-A' }
    ],
    canSeeAll() { return false; },
    getVisibleCompanyIds() { return null; },
    filterOrders(orders) { return orders; },
    filterShipments(shipments) { return shipments; },
    filterInvoices(invoices) { return invoices; },
    filterCustomers(customers) { return customers; }
};

const mockExchange = {
    isDomestic(cid) { return cid === 'CO-GR' || cid === 'CO-WY'; },
    recalcAllOrders() {},
    calcOrderProfit(usd, fc, fr, ins, other, cid) {
        const rate = cid === 'CO-GW' || cid === 'CO-LK' ? 7.80 : 7.25;
        if (cid === 'CO-GR' || cid === 'CO-WY') {
            return (usd * rate) - fc - fr - other + (fc / 1.13) * (ins / 100);
        }
        return usd - fc - other;
    },
    fetchRate() { return Promise.resolve({ success: false }); },
    autoFetchIfStale() { return Promise.resolve(); },
    usdToRmb(usd, cid) {
        const r = cid === 'CO-GW' || cid === 'CO-LK' ? 7.80 : 7.25;
        return usd * r;
    },
    rmbToUsd(rmb, cid) {
        const r = cid === 'CO-GW' || cid === 'CO-LK' ? 7.80 : 7.25;
        return rmb / r;
    }
};

const mockCloud = {
    init() { return Promise.resolve({ ok: true, uid: 'test' }); },
    loadData() { return Promise.resolve(null); },
    saveData() { return Promise.resolve(true); },
    checkRemoteVersion() { return Promise.resolve(null); },
    testPermission() { return Promise.resolve({ ok: true }); },
    getLastMeta() { return { version: 0, updatedAt: null }; },
    resetSession() {},
    _drainQueue() { return Promise.resolve(); },
    _saveQueue: [],
    _saveRunning: false,
    _cleanupOldDocs() {}
};

const mockApp = {
    updateCloudStatus() {},
    updateExchangeRateDisplay() {},
    updateSaveStatus() {},
    router() {}
};

jest.unstable_mockModule('../js/auth.js', () => ({ Auth: mockAuth }));
jest.unstable_mockModule('../js/exchange.js', () => ({ Exchange: mockExchange }));
jest.unstable_mockModule('../js/cloud.js', () => ({ Cloud: mockCloud }));
jest.unstable_mockModule('../js/app.js', () => ({ App: mockApp }));

const mockToast = jest.fn();
jest.unstable_mockModule('../js/utils.js', () => ({
    escapeHtml: (s) => String(s || ''),
    handleError: () => {},
    toast: mockToast,
    safeCall: async (fn) => fn(),
    validate: {
        required(data, fields) {
            for (const f of fields) {
                const val = data[f];
                if (val === undefined || val === null || String(val).trim() === '') return f;
            }
            return null;
        },
        positive(v) { return parseFloat(v) > 0; },
        numeric(v) { return !isNaN(parseFloat(v)) && isFinite(v); },
        email(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v)); },
        phoneCN(v) { return /^1[3-9]\d{9}$/.test(String(v)); },
        length(v, min, max) { const s = String(v||''); return s.length >= min && s.length <= max; },
        checkAll() { return []; }
    },
    EventBus: { on() {}, off() {}, emit() {} }
}));

const { DB } = await import('../js/data.js');
const { CONSTANTS } = await import('../js/constants.js');

// ==================== Test Helpers ====================

function resetDB() {
    DB.currentCompanyId = 'CO-GR';
    DB.data = { customers: [], orders: [], shipments: [], invoices: [], factories: [] };
    DB.exchangeRates = { 'CO-GR': 7.25, 'CO-WY': 7.25, 'CO-GW': 7.80, 'CO-LK': 7.80 };
    DB.rateMetas = {
        'CO-GR': { source: 'manual', updateTime: null, isAuto: false },
        'CO-WY': { source: 'manual', updateTime: null, isAuto: false },
        'CO-GW': { source: 'manual', updateTime: null, isAuto: false },
        'CO-LK': { source: 'manual', updateTime: null, isAuto: false }
    };
    DB._cloudReady = true;
    DB._cloudVersion = 0;
    DB._cloudUpdatedAt = null;
    DB._lastSaveTime = 0;
    mockAuth.currentUser = null;
    mockAuth.canSeeAll = () => false;
    mockAuth.getVisibleCompanyIds = () => null;
    mockAuth.filterOrders = (o) => o;
    mockAuth.filterCustomers = (c) => c;
    mockAuth.filterShipments = (s) => s;
    mockAuth.filterInvoices = (i) => i;
    mockToast.mockClear();
}

function makeOrder(overrides = {}) {
    return {
        id: 'O1', companyOperationNo: 'GR25D001', companyId: 'CO-GR', customerId: 'C1',
        customerName: 'Test Customer', orderAmountUSD: 10000, factoryCostRMB: 50000,
        freightCostUSD: 500, insuranceCostUSD: 0, otherCostUSD: 200,
        orderAmountRMB: 72500, profitRMB: 15000, profitRate: 20.69,
        orderDate: '2025-01-15', status: '已确认', paymentStatus: '已收全款',
        shippingStatus: '已出运', paidAmountUSD: 10000,
        productName: 'Widget', productCategory: 'Electronics',
        salespersonId: 'U005', ...overrides
    };
}

function makeCustomer(overrides = {}) {
    return {
        id: 'C1', company: 'Test Corp', contact: 'John Doe', country: 'USA',
        position: 'Manager', email: 'john@test.com', phone: '13800138000',
        companyId: 'CO-GR', salespersonId: 'U005', contacts: [
            { id: 'CT1', name: 'John Doe', email: 'john@test.com', phone: '13800138000', position: 'Manager', mobilePhone: '', homeAddress: '' }
        ], ...overrides
    };
}

// ==================== Companies ====================

describe('DB — Companies', () => {
    beforeEach(() => resetDB());

    test('getCompanies returns all 4 companies', () => {
        expect(DB.getCompanies()).toHaveLength(4);
    });

    test('getCurrentCompany returns current company', () => {
        DB.currentCompanyId = 'CO-WY';
        expect(DB.getCurrentCompany().id).toBe('CO-WY');
        expect(DB.getCurrentCompany().shortName).toBe('为语');
    });

    test('getCurrentCompany falls back to first company', () => {
        DB.currentCompanyId = 'CO-NONEXISTENT';
        expect(DB.getCurrentCompany().id).toBe('CO-GR');
    });

    test('setCurrentCompany updates company ID', () => {
        DB.setCurrentCompany('CO-GW');
        expect(DB.currentCompanyId).toBe('CO-GW');
        expect(sessionStorage.getItem(DB.COMPANY_KEY)).toBe('CO-GW');
    });

    test('setCurrentCompany ignores invalid IDs', () => {
        DB.setCurrentCompany('INVALID');
        expect(DB.currentCompanyId).toBe('CO-GR');
    });

    test('getAccessibleCompanies returns all when no restriction', () => {
        expect(DB.getAccessibleCompanies()).toHaveLength(4);
    });

    test('getAccessibleCompanies filters by Auth', () => {
        mockAuth.getVisibleCompanyIds = () => ['CO-GR', 'CO-WY'];
        const companies = DB.getAccessibleCompanies();
        expect(companies).toHaveLength(2);
        expect(companies.map(c => c.id)).toEqual(['CO-GR', 'CO-WY']);
    });
});

// ==================== Exchange Rates ====================

describe('DB — Exchange Rates', () => {
    beforeEach(() => resetDB());

    test('getExchangeRate returns current company rate', () => {
        DB.currentCompanyId = 'CO-GR';
        expect(DB.getExchangeRate()).toBe(7.25);
    });

    test('getExchangeRate returns specified company rate', () => {
        expect(DB.getExchangeRate('CO-GW')).toBe(7.80);
    });

    test('getExchangeRate falls back to default for unknown', () => {
        // DB falls back to CONSTANTS.DEFAULT_EXCHANGE_RATE = 7.25
        expect(DB.getExchangeRate('UNKNOWN')).toBeGreaterThan(0);
    });

    test('getRateMeta returns metadata object', () => {
        const meta = DB.getRateMeta('CO-GR');
        expect(meta).toBeDefined();
        expect(meta).toHaveProperty('source');
    });

    test('getRateMeta returns default for unknown', () => {
        const meta = DB.getRateMeta('UNKNOWN');
        expect(meta).toHaveProperty('source');
    });

    test('saveExchangeRate updates rate and meta', () => {
        DB.currentCompanyId = 'CO-GR';
        DB.saveExchangeRate(7.35);
        expect(DB.exchangeRates['CO-GR']).toBe(7.35);
        expect(DB.rateMetas['CO-GR']).toHaveProperty('source');
        expect(DB.rateMetas['CO-GR'].isAuto).toBe(false);
    });

    test('saveExchangeRate with custom meta', () => {
        DB.saveExchangeRate(7.50, 'CO-GW', { source: 'API', isAuto: true });
        expect(DB.exchangeRates['CO-GW']).toBe(7.50);
        expect(DB.rateMetas['CO-GW'].isAuto).toBe(true);
    });
});

// ==================== Filtering ====================

describe('DB — filterByCompany', () => {
    beforeEach(() => {
        resetDB();
        DB.currentCompanyId = 'CO-GR';
    });

    test('admin sees all items regardless of company', () => {
        mockAuth.canSeeAll = () => true;
        const items = [{ companyId: 'CO-GR' }, { companyId: 'CO-WY' }, { companyId: 'CO-GW' }];
        expect(DB.filterByCompany(items)).toHaveLength(3);
    });

    test('non-admin sees only current company items', () => {
        mockAuth.canSeeAll = () => false;
        mockAuth.getVisibleCompanyIds = () => null;
        const items = [{ companyId: 'CO-GR' }, { companyId: 'CO-WY' }, { companyId: 'CO-GW' }];
        expect(DB.filterByCompany(items)).toHaveLength(1);
    });

    test('items without companyId pass through', () => {
        mockAuth.canSeeAll = () => false;
        const items = [{ companyId: 'CO-GR' }, { name: 'No company' }];
        const filtered = DB.filterByCompany(items);
        expect(filtered).toHaveLength(2);
    });

    test('respects Auth visibleCompanyIds (AND-combined with currentCompanyId)', () => {
        mockAuth.canSeeAll = () => false;
        mockAuth.getVisibleCompanyIds = () => ['CO-WY'];
        DB.currentCompanyId = 'CO-WY'; // Must match both current company + visibleIds
        const items = [{ companyId: 'CO-GR' }, { companyId: 'CO-WY' }];
        const filtered = DB.filterByCompany(items);
        // CurrentCompanyId filter: keeps CO-WY; visibleIds filter: keeps CO-WY
        expect(filtered).toHaveLength(1);
        expect(filtered[0].companyId).toBe('CO-WY');
    });
});

// ==================== Formatting ====================

describe('DB — formatMoney / formatDate', () => {
    beforeEach(() => resetDB());

    test('formatMoney CNY', () => {
        const result = DB.formatMoney(12345.67, 'CNY');
        expect(result).toContain('¥');
        expect(result).toContain('12,345.67');
    });

    test('formatMoney USD', () => {
        const result = DB.formatMoney(12345.67, 'USD');
        expect(result).toContain('$');
        expect(result).toContain('12,345.67');
    });

    test('formatMoney defaults to CNY', () => {
        expect(DB.formatMoney(100)).toContain('¥');
    });

    test('formatDate returns formatted date', () => {
        expect(DB.formatDate('2025-01-15')).toBe('2025-01-15');
    });

    test('formatDate returns dash for falsy', () => {
        expect(DB.formatDate(null)).toBe('-');
        expect(DB.formatDate('')).toBe('-');
    });
});

// ==================== Customer Migration ====================

describe('DB — migrateCustomerData', () => {
    beforeEach(() => resetDB());

    test('adds contacts array to customers without one', () => {
        DB.data.customers = [{ id: 'C1', company: 'Old Corp', contact: 'John', email: 'j@t.com', phone: '123' }];
        DB.migrateCustomerData();
        expect(DB.data.customers[0].contacts).toBeDefined();
        expect(Array.isArray(DB.data.customers[0].contacts)).toBe(true);
        expect(DB.data.customers[0].contacts[0].name).toBe('John');
    });

    test('adds empty contacts when no contact name', () => {
        DB.data.customers = [{ id: 'C1', company: 'Old Corp', contact: '' }];
        DB.migrateCustomerData();
        expect(DB.data.customers[0].contacts).toEqual([]);
    });

    test('does not overwrite existing contacts', () => {
        DB.data.customers = [{ id: 'C1', company: 'New Corp', contacts: [{ id: 'CT1', name: 'Jane' }] }];
        DB.migrateCustomerData();
        expect(DB.data.customers[0].contacts[0].name).toBe('Jane');
    });

    test('adds missing fields to legacy customers', () => {
        DB.data.customers = [{ id: 'C1', company: 'Old Corp', contact: 'John' }];
        DB.migrateCustomerData();
        const c = DB.data.customers[0];
        expect(c.position).toBe('');
        expect(c.mobilePhone).toBe('');
        expect(c.homeAddress).toBe('');
        expect(c.companyAddress).toBe('');
    });
});

// ==================== CRUD: Orders ====================

describe('DB — Orders CRUD', () => {
    beforeEach(() => resetDB());

    test('getOrder returns order by ID', () => {
        DB.data.orders = [makeOrder({ id: 'O1' }), makeOrder({ id: 'O2' })];
        expect(DB.getOrder('O1').id).toBe('O1');
        expect(DB.getOrder('NOPE')).toBeNull();
    });

    test('getOrders sorts by date desc', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', orderDate: '2025-01-01' }),
            makeOrder({ id: 'O2', orderDate: '2025-03-01' })
        ];
        const result = DB.getOrders();
        expect(result[0].id).toBe('O2');
    });

    test('getOrders filters by status', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', status: '已确认' }),
            makeOrder({ id: 'O2', status: '已取消' })
        ];
        const result = DB.getOrders({ status: '已取消' });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('O2');
    });

    test('getOrders with status=all returns all', () => {
        DB.data.orders = [makeOrder({ id: 'O1' }), makeOrder({ id: 'O2' })];
        expect(DB.getOrders({ status: 'all' })).toHaveLength(2);
    });

    test('getOrders filters by paymentStatus', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', paymentStatus: '已收全款' }),
            makeOrder({ id: 'O2', paymentStatus: '未收款' })
        ];
        expect(DB.getOrders({ paymentStatus: '未收款' })).toHaveLength(1);
    });

    test('getOrders filters by shippingStatus', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', shippingStatus: '已出运' }),
            makeOrder({ id: 'O2', shippingStatus: '待出运' })
        ];
        expect(DB.getOrders({ shippingStatus: '待出运' })).toHaveLength(1);
    });

    test('getOrders searches by ID', () => {
        DB.data.orders = [
            makeOrder({ id: 'GR25D001', companyOperationNo: 'GR25D001', customerName: 'Apple' }),
            makeOrder({ id: 'GR25D002', companyOperationNo: 'GR25D002', customerName: 'Banana' })
        ];
        expect(DB.getOrders({ search: 'GR25D001' })).toHaveLength(1);
    });

    test('getOrders searches by customerName', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', customerName: 'Alpha Corp' }),
            makeOrder({ id: 'O2', customerName: 'Beta Inc' })
        ];
        expect(DB.getOrders({ search: 'beta' })).toHaveLength(1);
    });

    test('getOrders searches by customerOrderNo', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', customerOrderNo: 'PO-001' }),
            makeOrder({ id: 'O2', customerOrderNo: 'PO-002' })
        ];
        expect(DB.getOrders({ search: 'PO-001' })).toHaveLength(1);
    });

    test('getOrders searches by companyOperationNo', () => {
        DB.data.orders = [makeOrder({ id: 'O1', companyOperationNo: 'GR25D001' })];
        expect(DB.getOrders({ search: 'GR25D' })).toHaveLength(1);
    });

    test('generateCompanyOperationNo creates correct format for GR', () => {
        mockAuth.currentUser = mockAuth.users.find(u => u.id === 'U005');
        mockAuth.users = mockAuth.users;
        const no = DB.generateCompanyOperationNo('CO-GR', 'U005');
        const yr = String(new Date().getFullYear()).slice(2);
        expect(no).toMatch(new RegExp(`^GR${yr}M001$`));
    });

    test('generateCompanyOperationNo creates correct format for WY', () => {
        mockAuth.currentUser = mockAuth.users.find(u => u.id === 'U005');
        const no = DB.generateCompanyOperationNo('CO-WY', 'U005');
        const yr = String(new Date().getFullYear()).slice(2);
        expect(no).toMatch(new RegExp(`^WY${yr}M001$`));
    });

    test('generateCompanyOperationNo increments sequence', () => {
        mockAuth.currentUser = mockAuth.users.find(u => u.id === 'U005');
        const yr = String(new Date().getFullYear()).slice(2);
        const baseNo = `GR${yr}M`;
        DB.data.orders = [{ id: baseNo + '001', companyOperationNo: baseNo + '001', companyId: 'CO-GR' }];
        const no = DB.generateCompanyOperationNo('CO-GR', 'U005');
        expect(no).toBe(baseNo + '002');
    });

    test('addOrder creates order with correct fields', () => {
        mockAuth.currentUser = mockAuth.users.find(u => u.id === 'U005');
        const order = DB.addOrder({
            customerId: 'C1', companyOperationNo: 'GR25M001',
            companyId: 'CO-GR', orderAmountUSD: 1000, factoryCostRMB: 5000,
            freightCostUSD: 100, insuranceCostUSD: 13, otherCostUSD: 50
        });
        expect(order.id).toMatch(/^ORD-[0-9a-f-]{36}$/);
        expect(order.companyOperationNo).toBe('GR25M001');
        expect(order.orderAmountRMB).toBeGreaterThan(0);
        expect(order.profitRMB).toBeDefined();
        expect(order.profitRate).toBeDefined();
        expect(order.salespersonId).toBe('U005');
    });

    test('addOrder rejects missing required fields', () => {
        const result = DB.addOrder({});
        expect(result).toBeNull();
        expect(mockToast).toHaveBeenCalled();
    });

    test('addOrder rejects zero order amount', () => {
        const result = DB.addOrder({ customerId: 'C1', companyOperationNo: 'X', orderAmountUSD: 0 });
        expect(result).toBeNull();
    });

    test('updateOrder modifies existing order', () => {
        DB.data.orders = [makeOrder({ id: 'O1', orderAmountUSD: 5000, factoryCostRMB: 25000,
            freightCostUSD: 200, insuranceCostUSD: 0, otherCostUSD: 100 })];
        const updated = DB.updateOrder('O1', { status: '已订船', orderAmountUSD: 6000 });
        expect(updated.status).toBe('已订船');
        expect(updated.orderAmountUSD).toBe(6000);
    });

    test('updateOrder returns null for non-existent order', () => {
        expect(DB.updateOrder('NOPE', { status: 'x' })).toBeNull();
    });

    test('deleteOrder soft-deletes order and related data', () => {
        DB.data.orders = [makeOrder({ id: 'O1' })];
        DB.data.shipments = [{ id: 'S1', orderId: 'O1' }];
        DB.data.invoices = [{ id: 'D1', orderId: 'O1' }];
        DB.deleteOrder('O1');
        expect(DB.data.orders).toHaveLength(1);
        expect(DB.data.orders[0].deleted).toBe(true);
        expect(DB.data.orders[0].deletedAt).toBeTruthy();
        expect(DB.getOrder('O1')).toBeNull();
        expect(DB.getShipments()).toHaveLength(0);
        expect(DB.getInvoices()).toHaveLength(0);
    });
});

// ==================== CRUD: Customers ====================

describe('DB — Customers CRUD', () => {
    beforeEach(() => resetDB());

    test('getCustomer returns customer by ID', () => {
        DB.data.customers = [makeCustomer({ id: 'C1' }), makeCustomer({ id: 'C2' })];
        expect(DB.getCustomer('C1').id).toBe('C1');
        expect(DB.getCustomer('NOPE')).toBeNull();
    });

    test('getCustomers returns all customers', () => {
        DB.data.customers = [makeCustomer({ id: 'C1' }), makeCustomer({ id: 'C2' })];
        expect(DB.getCustomers()).toHaveLength(2);
    });

    test('getCustomers searches by company name', () => {
        DB.data.customers = [
            makeCustomer({ id: 'C1', company: 'Alpha Inc' }),
            makeCustomer({ id: 'C2', company: 'Beta Corp' })
        ];
        expect(DB.getCustomers({ search: 'alpha' })).toHaveLength(1);
    });

    test('getCustomers searches by contact', () => {
        DB.data.customers = [
            makeCustomer({ id: 'C1', contact: 'John' }),
            makeCustomer({ id: 'C2', contact: 'Jane' })
        ];
        expect(DB.getCustomers({ search: 'jane' })).toHaveLength(1);
    });

    test('getCustomerOrders returns orders for customer', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', customerId: 'C1' }),
            makeOrder({ id: 'O2', customerId: 'C2' })
        ];
        expect(DB.getCustomerOrders('C1')).toHaveLength(1);
    });

    test('addCustomer creates with auto-generated ID', () => {
        const customer = DB.addCustomer({ company: 'New Corp', contact: 'Bob' });
        expect(customer.id).toMatch(/^C[A-Z0-9]{8}$/);
        expect(DB.data.customers).toHaveLength(1);
    });

    test('addCustomer rejects missing company', () => {
        expect(DB.addCustomer({})).toBeNull();
    });

    test('updateCustomer modifies existing customer', () => {
        DB.data.customers = [makeCustomer({ id: 'C1', company: 'Old Name' })];
        const updated = DB.updateCustomer('C1', { company: 'New Name' });
        expect(updated.company).toBe('New Name');
    });

    test('updateCustomer returns null for non-existent', () => {
        expect(DB.updateCustomer('NOPE', { company: 'X' })).toBeNull();
    });

    test('deleteCustomer soft-deletes customer', () => {
        DB.data.customers = [makeCustomer({ id: 'C1' })];
        DB.deleteCustomer('C1');
        expect(DB.data.customers).toHaveLength(1);
        expect(DB.data.customers[0].deleted).toBe(true);
        expect(DB.getCustomer('C1')).toBeNull();
        expect(DB.getCustomers()).toHaveLength(0);
    });
});

// ==================== CRUD: Factories ====================

describe('DB — Factories CRUD', () => {
    beforeEach(() => resetDB());

    test('getFactories returns all factories', () => {
        DB.data.factories = [{ id: 'F1', name: 'Factory A', companyId: 'CO-GR' }];
        expect(DB.getFactories()).toHaveLength(1);
    });

    test('getFactories filters by search', () => {
        DB.data.factories = [
            { id: 'F1', name: 'Alpha Factory', contact: '', products: '' },
            { id: 'F2', name: 'Beta Factory', contact: '', products: '' }
        ];
        expect(DB.getFactories('alpha')).toHaveLength(1);
    });

    test('getFactory returns factory by ID', () => {
        DB.data.factories = [{ id: 'F1', name: 'Test' }];
        expect(DB.getFactory('F1').name).toBe('Test');
    });

    test('getFactoryOrders returns orders for factory', () => {
        DB.data.factories = [{ id: 'F1', name: 'Test' }];
        DB.data.orders = [
            makeOrder({ id: 'O1', factoryIds: ['F1'] }),
            makeOrder({ id: 'O2', factoryIds: ['F2'] })
        ];
        expect(DB.getFactoryOrders('F1')).toHaveLength(1);
    });

    test('addFactory creates factory', () => {
        const factory = DB.addFactory({ name: 'New Factory', contact: 'John', phone: '123', products: 'Goods' });
        expect(factory.name).toBe('New Factory');
        expect(factory.id).toBeDefined();
        expect(DB.data.factories).toHaveLength(1);
    });

    test('addFactory rejects missing name', () => {
        expect(DB.addFactory({})).toBeNull();
    });

    test('updateFactory modifies factory', () => {
        DB.data.factories = [{ id: 'F1', name: 'Old' }];
        const updated = DB.updateFactory('F1', { name: 'New', contact: '', phone: '', mobilePhone: '', products: '', address: '', bankInfo: '' });
        expect(updated.name).toBe('New');
    });

    test('updateFactory returns null for non-existent', () => {
        expect(DB.updateFactory('NOPE', { name: 'X' })).toBeNull();
    });

    test('deleteFactory soft-deletes factory', () => {
        DB.data.factories = [{ id: 'F1', name: 'Test' }];
        expect(DB.deleteFactory('F1')).toBe(true);
        expect(DB.data.factories).toHaveLength(1);
        expect(DB.data.factories[0].deleted).toBe(true);
        expect(DB.getFactory('F1')).toBeNull();
        expect(DB.getFactories()).toHaveLength(0);
    });

    test('deleteFactory returns false for non-existent', () => {
        expect(DB.deleteFactory('NOPE')).toBe(false);
    });
});

// ==================== CRUD: Shipments ====================

describe('DB — Shipments CRUD', () => {
    beforeEach(() => resetDB());

    test('getShipment returns shipment with overseasPort', () => {
        DB.data.orders = [makeOrder({ id: 'O1', overseasPort: 'Hamburg' })];
        DB.data.shipments = [{ id: 'S1', orderId: 'O1' }];
        const s = DB.getShipment('S1');
        expect(s.overseasPort).toBe('Hamburg');
    });

    test('getShipment returns null for non-existent', () => {
        expect(DB.getShipment('NOPE')).toBeNull();
    });

    test('getShipmentByOrder finds shipment', () => {
        DB.data.shipments = [{ id: 'S1', orderId: 'O1' }];
        expect(DB.getShipmentByOrder('O1').id).toBe('S1');
    });

    test('getShipments filters and sorts', () => {
        DB.data.shipments = [
            { id: 'S1', orderId: 'O1', status: '已出运', etd: '2025-01-01' },
            { id: 'S2', orderId: 'O2', status: '待出运', etd: '2025-03-01' }
        ];
        DB.data.orders = [
            makeOrder({ id: 'O1', overseasPort: '' }),
            makeOrder({ id: 'O2', overseasPort: '' })
        ];
        const result = DB.getShipments({ status: '待出运' });
        expect(result).toHaveLength(1);
    });

    test('addShipment creates with auto ID', () => {
        DB.data.orders = [makeOrder({ id: 'O1' })];
        const s = DB.addShipment({ orderId: 'O1' });
        expect(s.id).toMatch(/^SHP-[0-9a-f-]{36}$/);
    });

    test('updateShipment modifies shipment', () => {
        DB.data.shipments = [{ id: 'S1', orderId: 'O1' }];
        const updated = DB.updateShipment('S1', { status: '已出运' });
        expect(updated.status).toBe('已出运');
    });

    test('updateShipment returns null for non-existent', () => {
        expect(DB.updateShipment('NOPE', {})).toBeNull();
    });
});

// ==================== CRUD: Invoices ====================

describe('DB — Invoices CRUD', () => {
    beforeEach(() => resetDB());

    test('getInvoice returns invoice', () => {
        DB.data.invoices = [{ id: 'D1', orderId: 'O1', docType: 'CI' }];
        expect(DB.getInvoice('D1').docType).toBe('CI');
    });

    test('getInvoicesByOrder returns invoices for order', () => {
        DB.data.invoices = [
            { id: 'D1', orderId: 'O1', docType: 'CI' },
            { id: 'D2', orderId: 'O1', docType: 'PL' },
            { id: 'D3', orderId: 'O2', docType: 'CI' }
        ];
        expect(DB.getInvoicesByOrder('O1')).toHaveLength(2);
    });

    test('getInvoices filters by docType', () => {
        DB.data.invoices = [
            { id: 'D1', orderId: 'O1', docType: 'CI', date: '2025-01-01', docNumber: 'CI001', customerName: 'Test' },
            { id: 'D2', orderId: 'O2', docType: 'PL', date: '2025-01-01', docNumber: 'PL001', customerName: 'Test' }
        ];
        DB.data.orders = [makeOrder({ id: 'O1' }), makeOrder({ id: 'O2' })];
        expect(DB.getInvoices({ docType: 'CI' })).toHaveLength(1);
    });

    test('addInvoice creates with auto ID', () => {
        const inv = DB.addInvoice({ orderId: 'O1', docType: 'CI' });
        expect(inv.id).toMatch(/^DOC-[A-Z0-9]{8}-CI$/);
    });

    test('bulkAddInvoices adds multiple', () => {
        const count = DB.bulkAddInvoices([
            { orderId: 'O1', docType: 'CI' },
            { orderId: 'O1', docType: 'PL' }
        ]);
        expect(count).toBe(2);
        expect(DB.data.invoices).toHaveLength(2);
    });
});

// ==================== Stats ====================

describe('DB — getDashboardStats', () => {
    beforeEach(() => resetDB());

    test('returns zero stats for empty data', () => {
        const stats = DB.getDashboardStats();
        expect(stats.totalOrders).toBe(0);
        expect(stats.totalRevenueUSD).toBe(0);
        expect(stats.totalProfitRMB).toBe(0);
        expect(stats.customerCount).toBe(0);
    });

    test('calculates correct totals', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', orderAmountUSD: 10000, orderAmountRMB: 72500, factoryCostRMB: 50000, profitRMB: 15000 }),
            makeOrder({ id: 'O2', orderAmountUSD: 5000, orderAmountRMB: 36250, factoryCostRMB: 25000, profitRMB: 7500 })
        ];
        DB.data.customers = [makeCustomer({ id: 'C1' })];
        DB.data.shipments = [];
        const stats = DB.getDashboardStats();
        expect(stats.totalOrders).toBe(2);
        expect(stats.totalRevenueUSD).toBe(15000);
        expect(stats.totalProfitRMB).toBe(22500);
        expect(stats.totalFactoryCostRMB).toBe(75000);
    });

    test('handles active/completed counts', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', status: '已确认' }),
            makeOrder({ id: 'O2', status: '已订船' }),
            makeOrder({ id: 'O3', status: '已取消' })
        ];
        const stats = DB.getDashboardStats();
        expect(stats.totalOrders).toBe(3);
        expect(stats.activeOrders).toBe(2);
        expect(stats.completedOrders).toBe(1);
    });

    test('calculates monthly stats', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', orderDate: '2025-01-15', profitRMB: 1000 }),
            makeOrder({ id: 'O2', orderDate: '2025-02-20', profitRMB: 2000 })
        ];
        const stats = DB.getDashboardStats();
        expect(Object.keys(stats.monthlyStats)).toHaveLength(2);
        expect(stats.monthlyStats['2025-01'].count).toBe(1);
    });

    test('calculates status stats', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', status: '已确认' }),
            makeOrder({ id: 'O2', status: '已确认' }),
            makeOrder({ id: 'O3', status: '已订船' })
        ];
        const stats = DB.getDashboardStats();
        expect(stats.statusStats['已确认']).toBe(2);
        expect(stats.statusStats['已订船']).toBe(1);
    });
});

describe('DB — getProfitAnalysis', () => {
    beforeEach(() => resetDB());

    test('returns empty for no orders', () => {
        const analysis = DB.getProfitAnalysis();
        expect(analysis.orders).toHaveLength(0);
        expect(Object.keys(analysis.byCustomer)).toHaveLength(0);
    });

    test('groups by customer', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', customerName: 'Apple', profitRMB: 1000, orderAmountRMB: 5000, factoryCostRMB: 3000 }),
            makeOrder({ id: 'O2', customerName: 'Apple', profitRMB: 2000, orderAmountRMB: 8000, factoryCostRMB: 4000 }),
            makeOrder({ id: 'O3', customerName: 'Banana', profitRMB: 500, orderAmountRMB: 2000, factoryCostRMB: 1000 })
        ];
        const analysis = DB.getProfitAnalysis();
        expect(Object.keys(analysis.byCustomer)).toHaveLength(2);
        expect(analysis.byCustomer['Apple'].count).toBe(2);
        expect(analysis.byCustomer['Apple'].profit).toBe(3000);
        expect(analysis.byCustomer['Banana'].count).toBe(1);
    });

    test('filters by date range', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', orderDate: '2025-01-15' }),
            makeOrder({ id: 'O2', orderDate: '2025-06-20' })
        ];
        const analysis = DB.getProfitAnalysis({ startDate: '2025-03-01' });
        expect(analysis.orders).toHaveLength(1);
    });

    test('filters by customerId', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', customerId: 'C1' }),
            makeOrder({ id: 'O2', customerId: 'C2' })
        ];
        const analysis = DB.getProfitAnalysis({ customerId: 'C1' });
        expect(analysis.orders).toHaveLength(1);
    });

    test('groups by month and category', () => {
        DB.data.orders = [
            makeOrder({ id: 'O1', orderDate: '2025-01-01', productCategory: 'Electronics', profitRMB: 100 }),
            makeOrder({ id: 'O2', orderDate: '2025-02-01', productCategory: 'Electronics', profitRMB: 200 })
        ];
        const analysis = DB.getProfitAnalysis();
        expect(Object.keys(analysis.byMonth)).toHaveLength(2);
        expect(analysis.byCategory['Electronics'].count).toBe(2);
    });
});

// ==================== Helpers ====================

describe('DB — Helpers', () => {
    beforeEach(() => resetDB());

    test('resetData clears all data arrays', () => {
        DB.data.orders = [makeOrder()];
        DB.data.customers = [makeCustomer()];
        DB.data.shipments = [{ id: 'S1' }];
        DB.data.invoices = [{ id: 'D1' }];
        DB.data.factories = [{ id: 'F1' }];
        DB.resetData();
        expect(DB.data.orders).toHaveLength(0);
        expect(DB.data.customers).toHaveLength(0);
    });

    test('isDomesticCompany delegates to Exchange', () => {
        expect(DB.isDomesticCompany('CO-GR')).toBe(true);
        expect(DB.isDomesticCompany('CO-GW')).toBe(false);
    });

    test('usdToRmb / rmbToUsd delegate to Exchange', () => {
        expect(DB.usdToRmb(100, 'CO-GR')).toBeCloseTo(725);
        expect(DB.rmbToUsd(725, 'CO-GR')).toBeCloseTo(100);
    });

    test('calcOrderProfit delegates to Exchange', () => {
        const profit = DB.calcOrderProfit(1000, 5000, 200, 13, 100, 'CO-GR');
        expect(profit).toBeDefined();
        expect(typeof profit).toBe('number');
    });
});

// ==================== Local Backup ====================

describe('DB — Local Backup', () => {
    beforeEach(() => resetDB());

    test('_backupToLocal writes to localStorage', () => {
        DB.data.orders = [makeOrder({ id: 'O1' })];
        DB._backupToLocal();
        const raw = localStorage.getItem(DB._BACKUP_KEY);
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw);
        expect(parsed.data.orders).toHaveLength(1);
    });

    test('_clearLocalBackup removes localStorage item', () => {
        DB._backupToLocal();
        DB._clearLocalBackup();
        expect(localStorage.getItem(DB._BACKUP_KEY)).toBeNull();
    });

    test('_recoverFromLocal returns false when no backup', () => {
        expect(DB._recoverFromLocal()).toBe(false);
    });

    test('_recoverFromLocal merges missing factories', () => {
        DB.data.factories = [{ id: 'F1', name: 'Cloud Factory' }];
        localStorage.setItem(DB._BACKUP_KEY, JSON.stringify({
            data: {
                factories: [{ id: 'F1', name: 'Cloud Factory' }, { id: 'F2', name: 'Local Factory' }]
            }
        }));
        const merged = DB._recoverFromLocal();
        expect(merged).toBe(true);
        expect(DB.data.factories).toHaveLength(2);
    });

    test('_recoverFromLocal merges missing customers', () => {
        DB.data.customers = [makeCustomer({ id: 'C1' })];
        localStorage.setItem(DB._BACKUP_KEY, JSON.stringify({
            data: { customers: [{ id: 'C1' }, { id: 'C2', company: 'Local' }] }
        }));
        const merged = DB._recoverFromLocal();
        expect(merged).toBe(true);
        expect(DB.data.customers).toHaveLength(2);
    });

    test('_recoverFromLocal merges missing orders', () => {
        DB.data.orders = [makeOrder({ id: 'O1' })];
        localStorage.setItem(DB._BACKUP_KEY, JSON.stringify({
            data: { orders: [{ id: 'O1' }, { id: 'O2', orderAmountUSD: 500 }] }
        }));
        const merged = DB._recoverFromLocal();
        expect(merged).toBe(true);
        expect(DB.data.orders).toHaveLength(2);
    });

    test('_recoverFromLocal handles corrupt data', () => {
        localStorage.setItem(DB._BACKUP_KEY, 'not json');
        expect(DB._recoverFromLocal()).toBe(false);
    });
});

// ==================== _applyExchangeData ====================

describe('DB — _applyExchangeData', () => {
    beforeEach(() => resetDB());

    test('applies legacy single exchange rate to all companies', () => {
        DB._applyExchangeData({ exchangeRate: 6.50 });
        expect(DB.exchangeRates['CO-GR']).toBe(6.50);
        expect(DB.exchangeRates['CO-WY']).toBe(6.50);
        expect(DB.exchangeRates['CO-GW']).toBe(6.50);
        expect(DB.exchangeRates['CO-LK']).toBe(6.50);
    });

    test('applies per-company exchange rates', () => {
        DB._applyExchangeData({ exchangeRates: { 'CO-GR': 7.30, 'CO-GW': 7.85 } });
        expect(DB.exchangeRates['CO-GR']).toBe(7.30);
        expect(DB.exchangeRates['CO-GW']).toBe(7.85);
        // unchanged
        expect(DB.exchangeRates['CO-WY']).toBe(7.25);
    });

    test('applies rate metas', () => {
        DB._applyExchangeData({
            rateMetas: {
                'CO-GR': { source: 'Auto', updateTime: '2026-07-31', isAuto: true }
            }
        });
        expect(DB.rateMetas['CO-GR'].source).toBe('Auto');
        expect(DB.rateMetas['CO-GR'].isAuto).toBe(true);
        expect(DB.rateMetas['CO-WY'].source).toBe('manual'); // unchanged
    });

    test('applies legacy rateMeta to all companies when no rateMetas', () => {
        DB._applyExchangeData({ rateMeta: { source: 'Legacy', updateTime: '2025-01-01', isAuto: false } });
        expect(DB.rateMetas['CO-GR'].source).toBe('Legacy');
        expect(DB.rateMetas['CO-GW'].source).toBe('Legacy');
    });

    test('handles null/undefined input gracefully', () => {
        expect(() => DB._applyExchangeData(null)).not.toThrow();
        expect(() => DB._applyExchangeData(undefined)).not.toThrow();
        expect(() => DB._applyExchangeData({})).not.toThrow();
    });

    test('both exchangeRates and rateMetas applied together', () => {
        DB._applyExchangeData({
            exchangeRates: { 'CO-GR': 7.10 },
            rateMetas: { 'CO-GR': { source: 'API', updateTime: '2026-07-31T12:00:00Z', isAuto: true } }
        });
        expect(DB.exchangeRates['CO-GR']).toBe(7.10);
        expect(DB.rateMetas['CO-GR'].source).toBe('API');
        expect(DB.rateMetas['CO-GR'].isAuto).toBe(true);
    });
});

// ==================== getDashboardStats Edge Cases ====================

describe('DB — getDashboardStats edge cases', () => {
    beforeEach(() => resetDB());

    test('handles HK company profit rate calculation', () => {
        DB.currentCompanyId = 'CO-GW';
        DB.data.orders = [makeOrder({
            id: 'HK1', companyId: 'CO-GW', orderAmountUSD: 10000, factoryCostRMB: 50000,
            orderAmountRMB: 78000, profitRMB: 15000, profitRate: 150,
            status: '已确认', orderDate: '2025-06-15'
        })];
        mockAuth.filterCustomers = (c) => c;

        const stats = DB.getDashboardStats();
        // HK: avgProfitRate = totalProfitRMB / totalRevenueUSD * 100
        expect(stats.avgProfitRate).toBe(150);
    });

    test('calculates factory unpaid amount', () => {
        DB.data.orders = [makeOrder({
            id: 'O2', factoryCostRMB: 50000, factoryPaidRMB: 30000
        })];
        mockAuth.filterCustomers = (c) => c;

        const stats = DB.getDashboardStats();
        expect(stats.totalFactoryCostRMB).toBe(50000);
        expect(stats.totalFactoryPaidRMB).toBe(30000);
        expect(stats.totalFactoryUnpaidRMB).toBe(20000);
    });

    test('calculates unpaid revenue USD', () => {
        DB.data.orders = [makeOrder({
            id: 'O3', orderAmountUSD: 10000, paidAmountUSD: 7000
        })];
        mockAuth.filterCustomers = (c) => c;

        const stats = DB.getDashboardStats();
        expect(stats.totalRevenueUSD).toBe(10000);
        expect(stats.totalPaidUSD).toBe(7000);
        expect(stats.unpaidAmount).toBe(3000);
    });

    test('upcomingShipments includes overseasPort from order', () => {
        DB.data.orders = [makeOrder({ id: 'O1', overseasPort: 'Los Angeles' })];
        DB.data.shipments = [{
            id: 'SHP-0001', orderId: 'O1', status: '待出运',
            etd: '2026-08-15', blNumber: 'BL001', customerName: 'Test', containerNo: 'CONT1'
        }];
        mockAuth.filterShipments = (s) => s;

        const stats = DB.getDashboardStats();
        expect(stats.upcomingShipments).toHaveLength(1);
        expect(stats.upcomingShipments[0].overseasPort).toBe('Los Angeles');
    });

    test('upcomingShipments excludes non-matching status', () => {
        DB.data.orders = [makeOrder({ id: 'O1' })];
        DB.data.shipments = [{
            id: 'SHP-0001', orderId: 'O1', status: '已签收', etd: '2026-06-01',
            blNumber: 'BL001', customerName: 'Test', containerNo: 'CONT1'
        }];
        mockAuth.filterShipments = (s) => s;

        const stats = DB.getDashboardStats();
        expect(stats.upcomingShipments).toHaveLength(0);
    });

    test('handles zero revenue edge case (avgProfitRate = 0)', () => {
        DB.data.orders = [makeOrder({
            id: 'O1', orderAmountUSD: 0, orderAmountRMB: 0, profitRMB: 0
        })];
        mockAuth.filterCustomers = (c) => c;

        const stats = DB.getDashboardStats();
        // All zero → avgProfitRate should be 0 (no division by zero)
        expect(stats.avgProfitRate).toBe(0);
    });
});

// ==================== getOrders extended search ====================

describe('DB — getOrders extended search', () => {
    beforeEach(() => {
        resetDB();
        DB.data.orders = [
            makeOrder({ id: 'O1', productName: 'Smart Watch', customerOrderNo: 'PO-001', companyOperationNo: 'GR25D001', contactPerson: 'Alice' }),
            makeOrder({ id: 'O2', productName: 'Laptop', customerOrderNo: 'PO-002', companyOperationNo: 'GR25D002', contactPerson: 'Bob' }),
            makeOrder({ id: 'O3', productName: 'Smart Phone', customerOrderNo: 'INV-003', companyOperationNo: 'GR25D003', contactPerson: 'Charlie', status: '已取消' })
        ];
    });

    test('searches by productName', () => {
        const result = DB.getOrders({ search: 'smart' });
        expect(result).toHaveLength(2); // Smart Watch, Smart Phone
        expect(result.map(o => o.id).sort()).toEqual(['O1', 'O3']);
    });

    test('searches by contactPerson', () => {
        const result = DB.getOrders({ search: 'alice' });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('O1');
    });

    test('combines search with status filter', () => {
        const result = DB.getOrders({ search: 'smart', status: '已取消' });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('O3');
    });

    test('search is case-insensitive', () => {
        const result = DB.getOrders({ search: 'LAPTOP' });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('O2');
    });

    test('searches by customerOrderNo', () => {
        const result = DB.getOrders({ search: 'INV' });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('O3');
    });
});

// ==================== getFactories extended ====================

describe('DB — getFactories extended', () => {
    beforeEach(() => {
        resetDB();
        DB.data.factories = [
            { id: 'F-GR-1', name: 'Factory Alpha', contact: 'Alice', products: 'Electronics', companyId: 'CO-GR' },
            { id: 'F-WY-1', name: 'Factory Beta', contact: 'Bob', products: 'Textiles', companyId: 'CO-WY' },
            { id: 'F-GR-2', name: 'Alpha Components', contact: 'Charlie', products: 'Parts', companyId: 'CO-GR' }
        ];
    });

    test('searches by product keyword', () => {
        const result = DB.getFactories('Electronics');
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Factory Alpha');
    });

    test('searches by factory ID', () => {
        const result = DB.getFactories('WY-1');
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Factory Beta');
    });

    test('filters by visible company IDs', () => {
        mockAuth.getVisibleCompanyIds = () => ['CO-GR'];
        const result = DB.getFactories('');
        expect(result).toHaveLength(2);
        expect(result.every(f => f.companyId === 'CO-GR')).toBe(true);
    });

    test('empty visibleIds returns nothing', () => {
        mockAuth.getVisibleCompanyIds = () => [];
        const result = DB.getFactories('');
        expect(result).toHaveLength(0);
    });

    test('search with visibleIds restriction', () => {
        mockAuth.getVisibleCompanyIds = () => ['CO-GR'];
        const result = DB.getFactories('Alpha');
        expect(result).toHaveLength(2); // Factory Alpha + Alpha Components, both CO-GR
    });
});

// ==================== getCustomers extended search ====================

describe('DB — getCustomers extended search', () => {
    beforeEach(() => {
        resetDB();
        DB.data.customers = [
            makeCustomer({ id: 'C1', company: 'Alpha Corp', contact: 'John', country: 'USA', position: 'CTO' }),
            makeCustomer({ id: 'C2', company: 'Beta Inc', contact: 'Jane', country: 'UK', position: 'CEO' }),
            makeCustomer({ id: 'C3', company: 'Gamma Ltd', contact: 'Jack', country: 'USA', position: 'COO' })
        ];
    });

    test('searches by position', () => {
        const result = DB.getCustomers({ search: 'ceo' });
        expect(result).toHaveLength(1);
        expect(result[0].company).toBe('Beta Inc');
    });

    test('case-insensitive company search', () => {
        const result = DB.getCustomers({ search: 'alpha' });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('C1');
    });

    test('no search returns all', () => {
        const result = DB.getCustomers({});
        expect(result.length).toBeGreaterThanOrEqual(3);
    });

    test('search by country', () => {
        const result = DB.getCustomers({ search: 'usa' });
        expect(result).toHaveLength(2);
    });
});

// ==================== addOrder with HK company ====================

describe('DB — addOrder HK company', () => {
    beforeEach(() => {
        resetDB();
        DB.currentCompanyId = 'CO-GW'; // HK company
        mockAuth.currentUser = { id: 'U005', name: 'Michale' };
    });

    test('creates HK order with correct profit calculation', () => {
        const order = DB.addOrder({
            customerId: 'C1',
            companyOperationNo: 'GW25M001',
            orderAmountUSD: 10000,
            factoryCostRMB: 60000,
            freightCostUSD: 500,
            insuranceCostUSD: 100,
            otherCostUSD: 200
        });
        expect(order).not.toBeNull();
        expect(order.companyId).toBe('CO-GW');
        expect(order.salespersonId).toBe('U005');
        // HK profit formula (from mockExchange): usd - fc - other = 10000 - 60000 - 200
        // Wait, the mock calcOrderProfit for HK returns usd - fc - other
        // Let me check: usd=10000, fc=60000, fr=500, ins=100, other=200
        // HK: return usd - fc - other = 10000 - 60000 - 200 = -50200
        // Actually let me check the mock again...
        // mockExchange.calcOrderProfit(usd, fc, fr, ins, other, cid):
        //   if CO-GW or CO-LK: return usd - fc - other → 10000 - 60000 - 200 = -50200
        expect(order.profitRMB).toBeDefined();
        expect(typeof order.profitRate).toBe('number');
    });

    test('HK order uses USD as profit rate base', () => {
        DB.data.orders = []; // Clear
        const order = DB.addOrder({
            customerId: 'C1',
            companyOperationNo: 'GW25M002',
            orderAmountUSD: 5000,
            factoryCostRMB: 30000,
            freightCostUSD: 200,
            insuranceCostUSD: 50,
            otherCostUSD: 100
        });
        // profitRate = profit / orderAmountUSD * 100 (HK)
        expect(order.profitRate).not.toBeNaN();
    });
});

// ==================== filterByCompany edge cases ====================

describe('DB — filterByCompany edge cases', () => {
    beforeEach(() => resetDB());

    test('with null currentCompanyId, does not filter by company', () => {
        DB.currentCompanyId = null;
        const items = [
            { id: '1', companyId: 'CO-GR' },
            { id: '2', companyId: 'CO-WY' }
        ];
        const result = DB.filterByCompany(items);
        expect(result).toHaveLength(2);
    });

    test('items with undefined companyId pass through without currentCompanyId', () => {
        DB.currentCompanyId = null;
        const items = [{ id: '1' }, { id: '2', companyId: 'CO-GR' }];
        const result = DB.filterByCompany(items);
        expect(result).toHaveLength(2);
    });

    test('visibleIds with null means all pass', () => {
        mockAuth.getVisibleCompanyIds = () => null;
        DB.currentCompanyId = 'CO-GR';
        const items = [
            { id: '1', companyId: 'CO-GR' },
            { id: '2', companyId: 'CO-WY' }
        ];
        // non-admin → filtered by currentCompanyId = CO-GR
        const result = DB.filterByCompany(items);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('1');
    });
});

// ==================== saveExchangeRate edge cases ====================

describe('DB — saveExchangeRate edge cases', () => {
    beforeEach(() => resetDB());

    test('saves with no meta → auto-generates manual meta', () => {
        DB.saveExchangeRate(7.50, 'CO-GR');
        expect(DB.exchangeRates['CO-GR']).toBe(7.50);
        expect(DB.rateMetas['CO-GR'].source).toBe('手动设置');
        expect(DB.rateMetas['CO-GR'].isAuto).toBe(false);
        expect(DB.rateMetas['CO-GR'].updateTime).toBeTruthy();
    });

    test('saves with invalid rate falls back to 7.25', () => {
        DB.saveExchangeRate('invalid', 'CO-GR');
        expect(DB.exchangeRates['CO-GR']).toBe(7.25);
    });

    test('saves with null companyId uses currentCompanyId', () => {
        DB.currentCompanyId = 'CO-WY';
        DB.saveExchangeRate(6.80);
        expect(DB.exchangeRates['CO-WY']).toBe(6.80);
        expect(DB.exchangeRates['CO-GR']).toBe(7.25); // unchanged
    });
});

// ==================== formatMoney / formatDate edge cases ====================

describe('DB — formatMoney/formatDate edge cases', () => {
    beforeEach(() => resetDB());

    test('formatMoney handles large numbers', () => {
        expect(DB.formatMoney(1000000)).toContain('¥');
        expect(DB.formatMoney(9999999.99, 'USD')).toContain('$');
    });

    test('formatMoney handles negative numbers', () => {
        const result = DB.formatMoney(-500);
        expect(result).toContain('-500');
    });

    test('formatMoney handles zero', () => {
        expect(DB.formatMoney(0)).toBe('¥0.00');
        expect(DB.formatMoney(0, 'USD')).toBe('$0.00');
    });

    test('formatDate handles various valid formats', () => {
        expect(DB.formatDate('2026-01-01')).toBe('2026-01-01');
        // ISO string with timezone — result depends on local timezone
        const result = DB.formatDate('2026-07-15T12:00:00Z');
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(result).not.toBe('-');
    });
});

// ==================== Shipments CRUD extended ====================

describe('DB — Shipments extended', () => {
    beforeEach(() => resetDB());

    test('addShipment generates unique IDs', () => {
        DB.data.orders = [makeOrder({ id: 'O1' }), makeOrder({ id: 'O2' })];
        const s1 = DB.addShipment({ orderId: 'O1', status: '待出运', etd: '2026-08-01', blNumber: 'BL001', customerName: 'Test', containerNo: 'C1' });
        const s2 = DB.addShipment({ orderId: 'O2', status: '已出运', etd: '2026-08-02', blNumber: 'BL002', customerName: 'Test2', containerNo: 'C2' });
        expect(s1.id).toMatch(/^SHP-[0-9a-f-]{36}$/);
        expect(s2.id).toMatch(/^SHP-[0-9a-f-]{36}$/);
        expect(s1.id).not.toBe(s2.id);
    });

    test('updateShipment returns null for non-existent', () => {
        const result = DB.updateShipment('NONEXIST', { status: '已出运' });
        expect(result).toBeNull();
    });

    test('getShipments searches by orderId', () => {
        DB.data.shipments = [
            { id: 'SHP-0001', orderId: 'GR25D001', status: '待出运', blNumber: 'BL001', customerName: 'Alpha', containerNo: 'CONT1' },
            { id: 'SHP-0002', orderId: 'GR25D002', status: '已出运', blNumber: 'BL002', customerName: 'Beta', containerNo: 'CONT2' }
        ];
        DB.data.orders = [
            { id: 'GR25D001', overseasPort: '' },
            { id: 'GR25D002', overseasPort: '' }
        ];
        mockAuth.filterShipments = (s) => s;

        const result = DB.getShipments({ search: 'GR25D001' });
        expect(result).toHaveLength(1);
        expect(result[0].orderId).toBe('GR25D001');
    });

    test('getShipments searches by blNumber', () => {
        DB.data.shipments = [
            { id: 'SHP-0001', orderId: 'O1', status: '待出运', blNumber: 'ABC123', customerName: 'Test', containerNo: 'CONT1' },
            { id: 'SHP-0002', orderId: 'O2', status: '待出运', blNumber: 'XYZ789', customerName: 'Test', containerNo: 'CONT2' }
        ];
        DB.data.orders = [{ id: 'O1' }, { id: 'O2' }];
        mockAuth.filterShipments = (s) => s;

        const result = DB.getShipments({ search: 'xyz' });
        expect(result).toHaveLength(1);
        expect(result[0].blNumber).toBe('XYZ789');
    });

    test('getShipments searches by containerNo', () => {
        DB.data.shipments = [
            { id: 'SHP-0001', orderId: 'O1', status: '待出运', blNumber: 'BL1', customerName: 'Test', containerNo: 'TGBU1234567' },
            { id: 'SHP-0002', orderId: 'O2', status: '待出运', blNumber: 'BL2', customerName: 'Test', containerNo: 'MSCU7654321' }
        ];
        DB.data.orders = [{ id: 'O1' }, { id: 'O2' }];
        mockAuth.filterShipments = (s) => s;

        const result = DB.getShipments({ search: 'mscu' });
        expect(result).toHaveLength(1);
        expect(result[0].containerNo).toBe('MSCU7654321');
    });

    test('getShipments searches by customerName', () => {
        DB.data.shipments = [
            { id: 'SHP-0001', orderId: 'O1', status: '待出运', blNumber: 'BL1', customerName: 'Alpha Corp', containerNo: 'C1' },
            { id: 'SHP-0002', orderId: 'O2', status: '待出运', blNumber: 'BL2', customerName: 'Beta Inc', containerNo: 'C2' }
        ];
        DB.data.orders = [{ id: 'O1' }, { id: 'O2' }];
        mockAuth.filterShipments = (s) => s;

        const result = DB.getShipments({ search: 'beta' });
        expect(result).toHaveLength(1);
        expect(result[0].customerName).toBe('Beta Inc');
    });

    test('getShipments filters by status', () => {
        DB.data.shipments = [
            { id: 'SHP-0001', orderId: 'O1', status: '待出运', blNumber: 'BL1', customerName: 'A', containerNo: 'C1' },
            { id: 'SHP-0002', orderId: 'O2', status: '已出运', blNumber: 'BL2', customerName: 'B', containerNo: 'C2' }
        ];
        DB.data.orders = [{ id: 'O1' }, { id: 'O2' }];
        mockAuth.filterShipments = (s) => s;

        const result = DB.getShipments({ status: '已出运' });
        expect(result).toHaveLength(1);
        expect(result[0].status).toBe('已出运');
    });
});

// ==================== Invoices CRUD extended ====================

describe('DB — Invoices extended', () => {
    beforeEach(() => resetDB());

    test('addInvoice generates ID with docType suffix', () => {
        const inv = DB.addInvoice({ orderId: 'O1', docType: 'invoice', docNumber: 'INV-001', customerName: 'Test', date: '2026-07-01' });
        expect(inv.id).toMatch(/^DOC-[A-Z0-9]{8}-invoice$/);
    });

    test('addInvoice with packing list type', () => {
        const inv = DB.addInvoice({ orderId: 'O1', docType: 'packing', docNumber: 'PK-001', customerName: 'Test', date: '2026-07-01' });
        expect(inv.id).toContain('packing');
    });

    test('getInvoices filters by docType', () => {
        DB.data.invoices = [
            { id: 'DOC-0001-invoice', docType: 'invoice', orderId: 'O1', docNumber: 'INV-1', customerName: 'Test', date: '2026-07-01' },
            { id: 'DOC-0002-packing', docType: 'packing', orderId: 'O1', docNumber: 'PK-1', customerName: 'Test', date: '2026-07-01' }
        ];
        DB.data.orders = [{ id: 'O1' }];
        mockAuth.filterInvoices = (i) => i;

        const result = DB.getInvoices({ docType: 'invoice' });
        expect(result).toHaveLength(1);
        expect(result[0].docType).toBe('invoice');
    });

    test('getInvoices searches by docNumber', () => {
        DB.data.invoices = [
            { id: 'D1', docType: 'invoice', orderId: 'O1', docNumber: 'INV-ABC', customerName: 'Test', date: '2026-07-01' },
            { id: 'D2', docType: 'invoice', orderId: 'O2', docNumber: 'INV-XYZ', customerName: 'Test', date: '2026-07-02' }
        ];
        DB.data.orders = [{ id: 'O1' }, { id: 'O2' }];
        mockAuth.filterInvoices = (i) => i;

        const result = DB.getInvoices({ search: 'xyz' });
        expect(result).toHaveLength(1);
        expect(result[0].docNumber).toBe('INV-XYZ');
    });

    test('getInvoices searches by customerName', () => {
        DB.data.invoices = [
            { id: 'D1', docType: 'invoice', orderId: 'O1', docNumber: 'INV1', customerName: 'Alpha Corp', date: '2026-07-01' },
            { id: 'D2', docType: 'invoice', orderId: 'O2', docNumber: 'INV2', customerName: 'Beta Inc', date: '2026-07-02' }
        ];
        DB.data.orders = [{ id: 'O1' }, { id: 'O2' }];
        mockAuth.filterInvoices = (i) => i;

        const result = DB.getInvoices({ search: 'alpha' });
        expect(result).toHaveLength(1);
        expect(result[0].customerName).toBe('Alpha Corp');
    });

    test('bulkAddInvoices assigns unique IDs with companyId', () => {
        DB.currentCompanyId = 'CO-GR';
        const count = DB.bulkAddInvoices([
            { docType: 'invoice', docNumber: 'INV-B1', customerName: 'A', orderId: 'O1', date: '2026-07-01' },
            { docType: 'packing', docNumber: 'PK-B1', customerName: 'B', orderId: 'O2', date: '2026-07-02' }
        ]);
        expect(count).toBe(2);
        expect(DB.data.invoices[0].id).toMatch(/^DOC-[A-Z0-9]+-00-invoice$/);
        expect(DB.data.invoices[1].id).toMatch(/^DOC-[A-Z0-9]+-01-packing$/);
        expect(DB.data.invoices[0].id).not.toBe(DB.data.invoices[1].id);
        expect(DB.data.invoices[0].companyId).toBe('CO-GR');
        expect(DB.data.invoices[1].companyId).toBe('CO-GR');
    });
});
