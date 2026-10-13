import { jest } from '@jest/globals';

const app = {
    escapeHtml: value =>
        String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;'),
    showModal: jest.fn((title, html) => {
        document.getElementById('modal').innerHTML = html;
    }),
    closeModal: jest.fn(),
    toast: jest.fn(),
    formatMoney: value => String(value ?? ''),
    formatDate: value => value || '—'
};
const db = {
    currentCompanyId: 'TEST-CN',
    _businessAPI: null,
    _cloudReady: true,
    companies: [{ id: 'TEST-CN', settlementCurrency: 'CNY', profitPolicy: 'grandware-v40', orderPrefix: 'TT' }],
    data: { orders: [], customers: [] },
    getCustomers: () => db.data.customers,
    getCustomer: id => db.data.customers.find(row => String(row.id) === String(id)),
    getOrder: id => db.data.orders.find(row => String(row.id) === String(id)),
    getFactories: () => [],
    getFactory: () => null,
    getCurrentCompany: () => db.companies[0],
    generateCompanyOperationNo: () => 'TT26A001',
    flush: jest.fn(async () => true),
    addOrder: jest.fn(value => {
        const row = { id: 'NEW-ORDER', ...value };
        db.data.orders.push(row);
        return row;
    }),
    updateOrder: jest.fn((id, patch) => {
        const row = db.getOrder(id);
        Object.assign(row, patch);
        return row;
    })
};
jest.unstable_mockModule('../js/app.js', () => ({ App: app }));
jest.unstable_mockModule('../js/data.js', () => ({ DB: db }));
jest.unstable_mockModule('../js/auth.js', () => ({
    Auth: { currentUser: { id: 'A', name: 'Alex' }, canSeeAll: () => false }
}));
jest.unstable_mockModule('../js/exchange.js', () => ({
    Exchange: { isDomestic: () => true, getOrderFinancials: () => ({ computedProfit: 100 }) }
}));
jest.unstable_mockModule('../js/erpnext-panel.js', () => ({ BusinessBackendPanel: {} }));
jest.unstable_mockModule('../js/order-import.js', () => ({
    handleFileImport: jest.fn(),
    processImportRows: jest.fn(),
    validateOrderData: () => '',
    validateNativeProductionPlan: () => '',
    requiresOverseasPort: () => false,
    canWriteFinancials: () => false
}));
const { FormDrafts } = await import('../js/form-drafts.js');
await import('../js/orders.js');
const Orders = window.Orders;
const contacts = () => [
    { id: 'CONTACT-A', name: '同名联系人', position: '采购', email: 'a@example.invalid' },
    { id: 'CONTACT-B', name: '同名联系人', position: '财务', email: 'b@example.invalid' }
];
const existing = changes => ({
    id: 'OLD',
    companyId: 'TEST-CN',
    customerId: 7,
    customerName: '虚构客户',
    companyOperationNo: 'TT25A007',
    contactPerson: '旧姓名',
    contactId: 'CONTACT-A',
    orderAmountUSD: 1000,
    factories: [],
    remarks: '原备注',
    ...changes
});

beforeEach(() => {
    jest.clearAllMocks();
    global.FormData = window.FormData;
    document.body.innerHTML = '<div id="modal"></div><div id="pageContent"></div>';
    db.data = { orders: [], customers: [{ id: 7, company: '虚构客户', contacts: contacts() }] };
    db._businessAPI = null;
    db.flush.mockResolvedValue(true);
    Orders._editingOrder = false;
    jest.spyOn(Orders, 'renderTable').mockImplementation(() => {});
    jest.spyOn(Orders, 'renderDetail').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

function newForm() {
    Orders.showAddForm();
    const form = document.getElementById('orderForm');
    form.elements.customerId.value = '7';
    Orders.onCustomerChange(form.elements.customerId);
    form.elements.contactPerson.value = 'CONTACT-B';
    form.elements.orderAmountUSD.value = '1000';
    return form;
}
const save = (form, id) => Orders.saveOrder({ target: form, preventDefault() {} }, id);

test('same-name contacts use separate IDs and meaningful labels, with no automatic first selection', () => {
    const form = newForm();
    const options = [...form.elements.contactPerson.options];
    expect(options.map(row => row.value)).toEqual(['', 'CONTACT-A', 'CONTACT-B']);
    expect(options[1].textContent).toContain('a@example.invalid');
    expect(options[2].textContent).toContain('b@example.invalid');
    Orders.onCustomerChange(form.elements.customerId);
    expect(form.elements.contactPerson.value).toBe('');
});

test('new explicit choice persists the selected stable ID and display name', async () => {
    const form = newForm();
    await save(form);
    expect(db.addOrder.mock.calls[0][0]).toMatchObject({ contactId: 'CONTACT-B', contactPerson: '同名联系人' });
});

test('numeric contact IDs match string order IDs after a name edit and a reorder', () => {
    db.data.customers[0].contacts = [
        { id: 9, name: '另一人' },
        { id: 8, name: '新姓名' }
    ];
    db.data.orders.push(existing({ contactId: '8' }));
    Orders.showEditForm('OLD');
    const form = document.getElementById('orderForm');
    expect(form.elements.contactPerson.value).toBe('8');
    expect(form.elements.contactPerson.selectedOptions[0].textContent).toContain('新姓名');
    expect(Orders.collectOrderContact(form, new FormData(form), db.data.customers[0], db.getOrder('OLD'))).toEqual({});
});

test('unrelated edit preserves the original historical display name and contact ID', async () => {
    const row = existing({ stage: 'legacy' });
    db.data.orders.push(row);
    Orders.showEditForm('OLD');
    const form = document.getElementById('orderForm');
    form.elements.remarks.value = '只改备注';
    await save(form, 'OLD');
    expect(row).toMatchObject({ contactPerson: '旧姓名', contactId: 'CONTACT-A', remarks: '只改备注' });
    expect(db.updateOrder.mock.calls[0][1]).not.toHaveProperty('contactId');
    expect(db.updateOrder.mock.calls[0][1]).not.toHaveProperty('contactPerson');
});

test('a native disabled customer selector still preserves its contact on unrelated edits', async () => {
    const row = existing({ stage: 'native' });
    db.data.orders.push(row);
    Orders.showEditForm('OLD');
    const form = document.getElementById('orderForm');
    expect(form.elements.customerId.disabled).toBe(true);
    expect(new FormData(form).has('customerId')).toBe(false);
    expect(Orders.collectOrderContact(form, new FormData(form), db.data.customers[0], row)).toEqual({});
});

test('historical name-only orders do not silently choose the first same-name contact', async () => {
    const row = existing({ contactId: undefined, contactPerson: '同名联系人', stage: 'legacy' });
    db.data.orders.push(row);
    Orders.showEditForm('OLD');
    const form = document.getElementById('orderForm');
    expect(form.elements.contactPerson.selectedOptions[0].dataset.contactPreserve).toBe('true');
    form.elements.remarks.value = '保留历史';
    await save(form, 'OLD');
    expect(db.updateOrder.mock.calls[0][1]).not.toHaveProperty('contactId');
    expect(row.contactPerson).toBe('同名联系人');
});

test('an explicit selection upgrades only that order to a real contact ID', async () => {
    db.data.orders.push(existing({ contactId: undefined, contactPerson: '同名联系人', stage: 'legacy' }));
    Orders.showEditForm('OLD');
    const form = document.getElementById('orderForm');
    form.elements.contactPerson.value = 'CONTACT-B';
    await save(form, 'OLD');
    expect(db.updateOrder.mock.calls[0][1]).toMatchObject({ contactId: 'CONTACT-B' });
    expect(db.getOrder('OLD').contactPerson).toBe('同名联系人');
});

test('missing or unauthorized customer/contact catalog keeps the current historical choice', () => {
    document.getElementById('modal').innerHTML = '<select id="contact"></select>';
    const select = document.getElementById('contact');
    select.innerHTML = Orders.getContactOptions(null, '原联系人', 'NO-LONGER-LISTED');
    expect(select.selectedOptions[0].dataset.contactPreserve).toBe('true');
    expect(select.textContent).toContain('原联系人');
});

test('unique old contacts without IDs use content tokens without mutating the customer or inventing IDs', () => {
    const customer = {
        id: 7,
        contacts: [
            { name: '同名', email: 'one@example.invalid' },
            { name: '同名', email: 'two@example.invalid' }
        ]
    };
    const before = JSON.stringify(customer);
    const form = document.createElement('form');
    form.innerHTML = `<input name="customerId" value="7"><select name="contactPerson">${Orders.getContactOptions(customer)}</select>`;
    form.elements.contactPerson.selectedIndex = 2;
    expect(Orders.collectOrderContact(form, new FormData(form), customer)).toEqual({ contactPerson: '同名' });
    expect(JSON.stringify(customer)).toBe(before);
    expect(form.elements.contactPerson.options[1].value).not.toBe(form.elements.contactPerson.options[2].value);
});

test('indistinguishable old contacts are disabled instead of picking one by name', () => {
    const customer = { contacts: [{ name: '同名' }, { name: '同名' }] };
    const form = document.createElement('form');
    form.innerHTML = `<select name="contactPerson">${Orders.getContactOptions(customer)}</select>`;
    expect([...form.elements.contactPerson.options].slice(1).every(row => row.disabled)).toBe(true);
    form.elements.contactPerson.selectedIndex = 1;
    expect(() => Orders.collectOrderContact(form, new FormData(form), customer)).toThrow('请选择');
});

test('duplicate real IDs or a stale removed choice cannot be persisted', async () => {
    const form = newForm();
    db.data.customers[0].contacts = [
        { id: 'CONTACT-B', name: '甲' },
        { id: 'CONTACT-B', name: '乙' }
    ];
    await save(form);
    expect(db.addOrder).not.toHaveBeenCalled();
    expect(FormDrafts.canSubmit(form)).toBe(false);
    expect(form.querySelector('[data-form-draft-notice]').textContent).toContain('名录已变化');
});

test('switching an identified order to an explicit old unnumbered contact clears the old ID', () => {
    const original = existing();
    const customer = { id: 7, contacts: [{ name: '旧备选', phone: '来源原文' }] };
    const form = document.createElement('form');
    form.innerHTML = `<input name="customerId" value="7"><select name="contactPerson">${Orders.getContactOptions(customer)}</select>`;
    form.elements.contactPerson.selectedIndex = 1;
    expect(Orders.collectOrderContact(form, new FormData(form), customer, original)).toEqual({
        contactId: null,
        contactPerson: '旧备选'
    });
});

test('changing the customer resets the prior order contact rather than reusing a coincident name', () => {
    const form = newForm();
    db.data.customers.push({ id: 8, company: '另一客户', contacts: [{ id: 'OTHER', name: '同名联系人' }] });
    form.elements.customerId.add(new Option('另一客户', '8'));
    form.elements.customerId.value = '8';
    Orders.onCustomerChange(form.elements.customerId);
    expect(form.elements.contactPerson.value).toBe('');
    expect([...form.elements.contactPerson.options].map(option => option.value)).toEqual(['', 'OTHER']);
});

test('contact text is escaped inside both labels and attributes', () => {
    const select = document.createElement('select');
    select.innerHTML = Orders.getContactOptions({
        contacts: [{ id: 'SAFE', name: '<img src=x onerror=evil()>', email: '" onclick="evil' }]
    });
    expect(select.querySelector('img')).toBeNull();
    expect(select.options[1].textContent).toContain('<img');
    expect(select.options[1].dataset.contactName).toContain('<img');
});

test.each(['TT26A001', ''])(
    'new unchanged preview or empty number requests authoritative server allocation: %s',
    async number => {
        const form = newForm();
        form.elements.companyOperationNo.value = number;
        await save(form);
        expect(db.addOrder.mock.calls[0][0].companyOperationNoAuto).toBe(true);
    }
);

test('manual new order number explicitly opts out of automatic allocation', async () => {
    const form = newForm();
    form.elements.companyOperationNo.value = 'MANUAL-2026';
    await save(form);
    expect(db.addOrder.mock.calls[0][0]).toMatchObject({
        companyOperationNo: 'MANUAL-2026',
        companyOperationNoAuto: false
    });
});

test('an existing historical order never receives the number-allocation flag', async () => {
    db.data.orders.push(existing({ stage: 'legacy' }));
    Orders.showEditForm('OLD');
    const form = document.getElementById('orderForm');
    form.elements.remarks.value = '编号不改';
    await save(form, 'OLD');
    expect(db.updateOrder.mock.calls[0][1]).not.toHaveProperty('companyOperationNoAuto');
    expect(db.getOrder('OLD').companyOperationNo).toBe('TT25A007');
});
