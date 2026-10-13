import { jest } from '@jest/globals';

let financialWrite = true;
let financialRead = true;
const h = value =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
const db = {
    _BACKUP_KEY: 'isolated-orders-draft-test',
    currentCompanyId: 'CN',
    _cloudReady: true,
    _businessAPI: null,
    companies: [
        { id: 'CN', settlementCurrency: 'CNY', profitPolicy: 'generic-native' },
        { id: 'HK', settlementCurrency: 'USD', profitPolicy: 'grandware-v40' }
    ],
    data: { orders: [], customers: [], factories: [] },
    getOrders: () => db.data.orders.filter(row => row.companyId === db.currentCompanyId),
    getOrder: id => db.data.orders.find(row => String(row.id) === String(id)),
    getCustomers: () => db.data.customers.filter(row => row.companyId === db.currentCompanyId),
    getCustomer: id => db.data.customers.find(row => String(row.id) === String(id)),
    getFactories: () => db.data.factories.filter(row => row.companyId === db.currentCompanyId),
    getFactory: id => db.data.factories.find(row => String(row.id) === String(id)),
    getCurrentCompany: () => db.companies.find(row => row.id === db.currentCompanyId),
    getExchangeRate: () => 7,
    generateCompanyOperationNo: () => 'TEST26A001',
    addOrder: jest.fn(value => {
        const row = { id: 'PENDING', stage: 'brief', companyId: db.currentCompanyId, ...value };
        db.data.orders.push(row);
        return row;
    }),
    updateOrder: jest.fn((id, patch) => Object.assign(db.getOrder(id), patch)),
    flush: jest.fn(async () => true)
};
const auth = {
    currentUser: {},
    canSeeAll: () => false,
    canSeeFinancials: () => financialRead,
    canEdit: () => true,
    hasCapability: () => false
};
const app = {
    escapeHtml: h,
    showModal: jest.fn((title, html, options) => {
        document.getElementById('modalContainer').innerHTML =
            html + `<div id="modalFooter">${options?.footer || ''}</div>`;
    }),
    closeModal: jest.fn(() => {
        document.getElementById('modalContainer').innerHTML = '';
    }),
    toast: jest.fn(),
    formatMoney: (value, currency) => `${currency} ${Number(value).toFixed(2)}`,
    formatDate: value => value || '—'
};
jest.unstable_mockModule('../js/data.js', () => ({ DB: db }));
jest.unstable_mockModule('../js/app.js', () => ({ App: app }));
jest.unstable_mockModule('../js/auth.js', () => ({ Auth: auth }));
jest.unstable_mockModule('../js/erpnext-panel.js', () => ({ BusinessBackendPanel: {} }));
jest.unstable_mockModule('../js/order-import.js', () => ({
    handleFileImport: jest.fn(),
    processImportRows: jest.fn(),
    validateOrderData: () => '',
    validateNativeProductionPlan: () => '',
    requiresOverseasPort: () => false,
    canWriteFinancials: () => financialWrite
}));
const { FormDrafts } = await import('../js/form-drafts.js');
await import('../js/orders.js');
const Orders = window.Orders;
const actor = () => ({
    id: 'A',
    tenantId: 'T',
    roleId: 'sales',
    scope: 'self',
    visibleCompanyIds: ['CN', 'HK'],
    permissions: ['edit', 'finance.read', 'finance.write']
});
const factory = (id, quantity = 10) => ({
    id: `LINE-${id}`,
    factoryId: id,
    factoryName: `工厂 ${id}`,
    productType: '原产品',
    totalQuantity: quantity,
    totalAmount: quantity * 10,
    prepayment: 0,
    inspectionDate: '2026-10-20',
    estimatedShipDate: '2026-10-23'
});
const order = changes => ({
    id: 'OLD',
    companyId: 'CN',
    stage: 'brief',
    customerId: 'BUYER',
    customerName: '虚构客户',
    contactId: 'CONTACT-A',
    contactPerson: '同名联系人',
    companyOperationNo: 'TEST26A001',
    customerOrderNo: 'CUSTOMER-PO',
    orderDate: '2026-10-13',
    orderAmountUSD: 1000,
    factoryCostRMB: 300,
    freightCostRMB: 70,
    otherCostRMB: 14,
    insuranceCostUSD: 0,
    factories: [factory('F1'), factory('F2', 20)],
    remarks: '原备注',
    status: '进行中',
    paymentStatus: '未收款',
    factoryPaidStatus: '未付款',
    loadingPort: '上海港',
    ...changes
});
const resetDOM = () => {
    document.body.innerHTML = '<div id="modalContainer"></div><div id="pageContent"></div>';
};
const editor = () => document.getElementById('orderForm');
const change = (form, name, value) => {
    const input = form.elements.namedItem(name);
    input.value = value;
    if (name === 'customerId') Orders.onCustomerChange(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
};
const storage = () => JSON.parse(sessionStorage.getItem(sessionStorage.key(0)));
const save = (form, id = null) => Orders.saveOrder({ target: form, preventDefault() {} }, id);
const reopen = id => {
    resetDOM();
    if (id) Orders.showEditForm(id);
    else Orders.showAddForm();
    return editor();
};
const fillNew = form => {
    change(form, 'customerId', 'BUYER');
    change(form, 'contactPerson', 'CONTACT-B');
    change(form, 'customerOrderNo', 'NEW-PO');
    change(form, 'orderAmountUSD', '1000');
    change(form, 'factory_0_id', 'F1');
    change(form, 'factory_0_productType', '未保存产品');
    change(form, 'factory_0_quantity', '11');
    change(form, 'factory_0_amount', '110');
    change(form, 'factory_0_prepayment', '10');
    change(form, 'factory_0_inspectionDate', '2026-10-20');
    change(form, 'factory_0_shipDate', '2026-10-23');
    change(form, 'paymentTerms', '原付款条件');
};

beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    financialWrite = true;
    financialRead = true;
    auth.currentUser = actor();
    db.currentCompanyId = 'CN';
    db._businessAPI = null;
    db.flush.mockResolvedValue(true);
    db.data = {
        orders: [],
        customers: [
            {
                id: 'BUYER',
                companyId: 'CN',
                company: '虚构客户',
                country: 'US',
                paymentTerms: '原付款条件',
                contacts: [
                    { id: 'CONTACT-A', name: '同名联系人', email: 'a@example.invalid' },
                    { id: 'CONTACT-B', name: '同名联系人', email: 'b@example.invalid' }
                ]
            }
        ],
        factories: [
            { id: 'F1', companyId: 'CN', name: '工厂一' },
            { id: 'F2', companyId: 'CN', name: '工厂二' }
        ]
    };
    global.FormData = window.FormData;
    resetDOM();
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    jest.spyOn(Orders, 'renderDetail').mockImplementation(() => {});
    jest.spyOn(Orders, 'renderTable').mockImplementation(() => {});
});
afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

test('new order refresh restores incomplete multiple factory rows, stable row identity and same-name contact ID', () => {
    Orders.showAddForm();
    const form = editor();
    fillNew(form);
    Orders.addFactoryRow();
    const secondId = form.querySelectorAll('.factory-card')[1].dataset.draftRowId;
    change(form, 'factory_1_id', 'F2');
    change(form, 'factory_1_productType', '未完成第二行');
    change(form, 'factory_1_quantity', '');
    change(form, 'remarks', '草稿备注');
    const restored = reopen();
    expect(restored.elements.customerId.value).toBe('BUYER');
    expect(restored.elements.contactPerson.value).toBe('CONTACT-B');
    expect(restored.elements.factory_0_productType.value).toBe('未保存产品');
    expect(restored.elements.factory_1_productType.value).toBe('未完成第二行');
    expect(restored.elements.factory_1_quantity.value).toBe('');
    expect(restored.querySelectorAll('.factory-card')[1].dataset.draftRowId).toBe(secondId);
    expect(restored.elements.remarks.value).toBe('草稿备注');
    expect(FormDrafts.canSubmit(restored)).toBe(true);
    expect(db.addOrder).not.toHaveBeenCalled();
});

test('edited factories restore add/remove/reorder by stable row identity instead of positional controls', () => {
    db.data.orders.push(order());
    Orders.showEditForm('OLD');
    const form = editor();
    const cards = form.querySelectorAll('.factory-card');
    const secondId = cards[1].dataset.draftRowId;
    change(form, 'factory_1_productType', '工厂二的本地产品');
    cards[0].remove();
    Orders.addFactoryRow();
    const added = form.querySelectorAll('.factory-card')[1];
    const addedIndex = added.dataset.factoryIndex;
    change(form, `factory_${addedIndex}_id`, 'F1');
    change(form, `factory_${addedIndex}_productType`, '新增工厂一的产品');
    const restored = reopen('OLD');
    expect(restored.querySelectorAll('.factory-card')[0].dataset.draftRowId).toBe(secondId);
    expect(restored.elements.factory_0_id.value).toBe('F2');
    expect(restored.elements.factory_0_productType.value).toBe('工厂二的本地产品');
    expect(restored.elements.factory_1_id.value).toBe('F1');
    expect(restored.elements.factory_1_productType.value).toBe('新增工厂一的产品');
    expect(db.data.orders[0].factories.map(row => row.factoryId)).toEqual(['F1', 'F2']);
});

test('native production drafts keep disabled amounts and quantities from their original matching row', () => {
    db.data.orders.push(order({ stage: 'native', exchangeRateUsed: 6.5, orderAmountRMB: 6500 }));
    Orders.showEditForm('OLD');
    change(editor(), 'factory_1_productType', '本地生产计划');
    const restored = reopen('OLD');
    expect(restored.elements.factory_1_productType.value).toBe('本地生产计划');
    expect(restored.elements.factory_0_quantity.value).toBe('10');
    expect(restored.elements.factory_1_quantity.value).toBe('20');
    expect(restored.elements.factory_1_quantity.disabled).toBe(true);
    expect(restored.elements.factory_1_amount.value).toBe('200');
    expect(restored.elements.factory_1_amount.disabled).toBe(true);
    expect(FormDrafts.canSubmit(restored)).toBe(true);
});

test('new order failed ACK keeps pending identity through refresh and retries without a second add', async () => {
    Orders.showAddForm();
    fillNew(editor());
    db.flush.mockResolvedValue(false);
    await save(editor());
    expect(db.addOrder).toHaveBeenCalledTimes(1);
    expect(editor().dataset.pendingRecordId).toBe('PENDING');
    expect(storage().pendingRecordId).toBe('PENDING');
    const restored = reopen();
    expect(restored.dataset.pendingRecordId).toBe('PENDING');
    expect(restored.dataset.orderId).toBe('PENDING');
    expect(FormDrafts.canSubmit(restored)).toBe(true);
    db.flush.mockResolvedValue(true);
    await save(restored, 'PENDING');
    expect(db.addOrder).toHaveBeenCalledTimes(1);
    expect(db.updateOrder).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
    expect(app.closeModal).toHaveBeenCalledTimes(1);
});

test('unknown pending record stays a conflict and does not create a replacement on retry', async () => {
    Orders.showAddForm();
    fillNew(editor());
    db.flush.mockResolvedValue(false);
    await save(editor());
    db.data.orders = [];
    const restored = reopen();
    expect(FormDrafts.canSubmit(restored)).toBe(false);
    await save(restored);
    expect(db.addOrder).toHaveBeenCalledTimes(1);
    expect(storage().retained.pendingRecordId).toBe('PENDING');
});

test.each(['new', 'edit'])(
    'successful ACK keeps inputs entered during the request and a second save persists them: %s',
    async mode => {
        if (mode === 'edit') db.data.orders.push(order());
        if (mode === 'edit') Orders.showEditForm('OLD');
        else Orders.showAddForm();
        const form = editor();
        if (mode === 'new') fillNew(form);
        change(form, 'remarks', '已提交的第一版');
        let release;
        db.flush.mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    release = resolve;
                })
        );
        const request = save(form, mode === 'edit' ? 'OLD' : null);
        expect(form.dataset.savingOrder).toBe('true');
        change(form, 'remarks', '等待ACK时写入的新内容');
        change(form, 'factory_0_productType', '等待ACK时的新计划');
        await save(form, mode === 'edit' ? 'OLD' : null);
        expect(db.flush).toHaveBeenCalledTimes(1);
        release(true);
        await request;
        expect(app.closeModal).not.toHaveBeenCalled();
        expect(form.elements.remarks.value).toBe('等待ACK时写入的新内容');
        expect(storage().state.fields.remarks[0].value).toBe('等待ACK时写入的新内容');
        expect(storage().state.dynamic.factories[0].productType).toBe('等待ACK时的新计划');
        expect(form.dataset.savingOrder).toBeUndefined();
        expect(FormDrafts.canSubmit(form)).toBe(true);
        expect(app.toast).toHaveBeenCalledWith('上一版已保存，当前新输入尚未保存，请再次保存', 'info');
        await save(form, mode === 'edit' ? 'OLD' : null);
        expect(db.getOrder(mode === 'edit' ? 'OLD' : 'PENDING').remarks).toBe('等待ACK时写入的新内容');
        expect(db.addOrder).toHaveBeenCalledTimes(mode === 'new' ? 1 : 0);
        expect(sessionStorage.length).toBe(0);
        expect(app.closeModal).toHaveBeenCalledTimes(1);
    }
);

test.each([false, true])(
    'retained new-order form adopts the allocated number only when the user left its preview untouched: manual=%s',
    async manual => {
        Orders.showAddForm();
        const form = editor();
        fillNew(form);
        let release;
        db.flush.mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    release = () => {
                        db.getOrder('PENDING').companyOperationNo = 'TEST26A099';
                        resolve(true);
                    };
                })
        );
        const request = save(form);
        change(form, 'remarks', '请求中继续写');
        if (manual) change(form, 'companyOperationNo', 'MANUAL-NO');
        release();
        await request;
        expect(form.elements.companyOperationNo.value).toBe(manual ? 'MANUAL-NO' : 'TEST26A099');
        expect(FormDrafts.canSubmit(form)).toBe(true);
        await save(form);
        expect(db.updateOrder.mock.calls[0][1]).not.toHaveProperty('companyOperationNoAuto');
        if (manual) expect(db.updateOrder.mock.calls[0][1].companyOperationNo).toBe('MANUAL-NO');
        else expect(db.updateOrder.mock.calls[0][1]).not.toHaveProperty('companyOperationNo');
    }
);

test('an older request ACK cannot close a replacement modal or replace its new draft with the old preview', async () => {
    Orders.showAddForm();
    const original = editor();
    fillNew(original);
    change(original, 'remarks', '旧窗口已提交输入');
    let release;
    db.flush.mockImplementationOnce(
        () =>
            new Promise(resolve => {
                release = () => {
                    db.getOrder('PENDING').companyOperationNo = 'TEST26A099';
                    resolve(true);
                };
            })
    );
    const request = save(original);
    const replacement = reopen();
    change(replacement, 'remarks', '新窗口继续填写的内容');
    release();
    await request;
    expect(editor()).toBe(replacement);
    expect(app.closeModal).not.toHaveBeenCalled();
    expect(storage().state.fields.remarks[0].value).toBe('新窗口继续填写的内容');
    expect(FormDrafts.canSubmit(replacement)).toBe(true);
    await save(replacement, 'PENDING');
    expect(db.getOrder('PENDING').remarks).toBe('新窗口继续填写的内容');
    expect(db.getOrder('PENDING').companyOperationNo).toBe('TEST26A099');
    expect(db.updateOrder.mock.calls[0][1]).not.toHaveProperty('companyOperationNo');
});

test('a new order ACK normalizing HK cost to canonical USD does not resubmit untouched legacy amounts with later input', async () => {
    db.currentCompanyId = 'HK';
    db.data.customers[0].companyId = 'HK';
    db.data.factories.forEach(row => {
        row.companyId = 'HK';
    });
    Orders.showAddForm();
    const form = editor();
    fillNew(form);
    Orders.updateFactoryCost();
    let release;
    db.flush.mockImplementationOnce(
        () =>
            new Promise(resolve => {
                release = () => {
                    const pending = db.getOrder('PENDING');
                    pending.factoryCostUSD = pending.factoryCostRMB;
                    delete pending.factoryCostRMB;
                    resolve(true);
                };
            })
    );
    const request = save(form);
    change(form, 'remarks', '费用已提交后继续输入');
    release();
    await request;
    expect(db.getOrder('PENDING').factoryCostUSD).toBe(110);
    await save(form);
    expect(db.updateOrder.mock.calls[0][1]).not.toHaveProperty('factoryCostRMB');
    expect(db.updateOrder.mock.calls[0][1]).not.toHaveProperty('factoryCostUSD');
    expect(db.getOrder('PENDING').factoryCostUSD).toBe(110);
});

test.each(['during', 'refresh'])(
    'revoked financial grants block blind submission and do not retain or resurrect hidden costs: %s',
    async when => {
        db.data.orders.push(order());
        Orders.showEditForm('OLD');
        change(editor(), 'freightCostRMB', '98765');
        change(editor(), 'factory_1_amount', '87654');
        change(editor(), 'factory_1_productType', '保留公开计划');
        financialWrite = false;
        financialRead = false;
        auth.currentUser.permissions = ['edit'];
        const form = when === 'refresh' ? reopen('OLD') : editor();
        expect(FormDrafts.canSubmit(form)).toBe(false);
        await save(form, 'OLD');
        expect(db.updateOrder).not.toHaveBeenCalled();
        expect(JSON.stringify(storage())).not.toContain('98765');
        expect(JSON.stringify(storage())).not.toContain('87654');
        if (when === 'refresh') {
            expect(form.elements.freightCostRMB).toBeUndefined();
            expect(form.elements.factory_1_amount).toBeUndefined();
            expect(form.textContent).toContain('保留公开计划');
        }
    }
);

test('company switch blocks the old open form and isolates a new company draft', async () => {
    db.data.orders.push(order());
    Orders.showEditForm('OLD');
    const form = editor();
    change(form, 'remarks', '原公司私有备注');
    db.currentCompanyId = 'HK';
    await save(form, 'OLD');
    expect(db.updateOrder).not.toHaveBeenCalled();
    expect(FormDrafts.canSubmit(form)).toBe(false);
    const fresh = reopen();
    expect(fresh.elements.remarks.value).toBe('');
    expect(fresh.dataset.companyId).toBe('HK');
    expect(sessionStorage.getItem(sessionStorage.key(0))).toContain('原公司私有备注');
});

test.each(['remarks', 'customerOrderNo', 'otherCostRMB'])(
    'changed rendered server field blocks stale edit: %s',
    async field => {
        const row = order();
        db.data.orders.push(row);
        Orders.showEditForm(row.id);
        const form = editor();
        change(form, 'remarks', '本地备注');
        row[field] = field === 'otherCostRMB' ? 99 : '服务器新值';
        await save(form, row.id);
        expect(db.updateOrder).not.toHaveBeenCalled();
        expect(FormDrafts.canSubmit(form)).toBe(false);
        expect(form.querySelector('[data-form-draft-notice] button').disabled).toBe(true);
        expect(storage().state.fields.remarks[0].value).toBe('本地备注');
    }
);

test('current price metadata and unrendered derived profit changes do not create false conflicts', () => {
    const row = order();
    db.data.orders.push(row);
    Orders.showEditForm(row.id);
    change(editor(), 'remarks', '独立备注');
    row.profitRMB = 999;
    row.profitRate = 10;
    row.exchangeRateFetchedAt = '2026-10-14T00:00:00Z';
    expect(FormDrafts.canSubmit(editor())).toBe(true);
});

test('refresh retains a conflicting local field, keeps the server value and restores an independent field', () => {
    const row = order();
    db.data.orders.push(row);
    Orders.showEditForm(row.id);
    change(editor(), 'remarks', '本地冲突备注');
    change(editor(), 'loadingPort', '宁波港');
    row.remarks = '服务器备注';
    const restored = reopen(row.id);
    expect(restored.elements.remarks.value).toBe('服务器备注');
    expect(restored.elements.loadingPort.value).toBe('宁波港');
    expect(storage().retained.remarks[0].value).toBe('本地冲突备注');
    expect(FormDrafts.canSubmit(restored)).toBe(false);
    expect(restored.querySelector('[data-form-draft-notice]').textContent).toContain('本地冲突备注');
});

test('an already incomplete historical relationship does not block an unrelated draft edit or rewrite amounts', async () => {
    const row = order({
        stage: 'legacy',
        customerId: 'REMOVED',
        contactId: undefined,
        contactPerson: '历史联系人',
        factories: [factory('REMOVED-FACTORY')],
        profitRMB: 123.45
    });
    db.data.orders.push(row);
    Orders.showEditForm(row.id);
    change(editor(), 'remarks', '只补充历史备注');
    const restored = reopen(row.id);
    expect(restored.elements.remarks.value).toBe('只补充历史备注');
    expect(restored.elements.contactPerson.value).toBe('历史联系人');
    expect(FormDrafts.canSubmit(restored)).toBe(true);
    await save(restored, row.id);
    expect(db.updateOrder.mock.calls[0][1]).toMatchObject({ remarks: '只补充历史备注' });
    expect(db.updateOrder.mock.calls[0][1]).not.toHaveProperty('factoryCostRMB');
    expect(row.profitRMB).toBe(123.45);
});

test('remote change after staged failure is still blocked, while unchanged same-DOM retry remains possible', async () => {
    const row = order();
    db.data.orders.push(row);
    Orders.showEditForm(row.id);
    change(editor(), 'remarks', '已暂存本地备注');
    db.flush.mockResolvedValue(false);
    await save(editor(), row.id);
    expect(FormDrafts.canSubmit(editor())).toBe(true);
    row.customerOrderNo = '远端新编号';
    await save(editor(), row.id);
    expect(db.updateOrder).toHaveBeenCalledTimes(1);
    expect(FormDrafts.canSubmit(editor())).toBe(false);
});

test.each(['customer', 'factory', 'contact'])(
    'a newly selected related %s becoming unavailable retains a conflict instead of restoring a stale choice',
    async kind => {
        Orders.showAddForm();
        fillNew(editor());
        if (kind === 'customer') db.data.customers = [];
        else if (kind === 'factory') db.data.factories = db.data.factories.filter(row => row.id !== 'F1');
        else db.data.customers[0].contacts = db.data.customers[0].contacts.filter(row => row.id !== 'CONTACT-B');
        const restored = reopen();
        expect(FormDrafts.canSubmit(restored)).toBe(false);
        await save(restored);
        expect(db.addOrder).not.toHaveBeenCalled();
        expect(storage().retained.dynamic).toBeTruthy();
        expect(restored.textContent).toContain('未覆盖当前资料');
    }
);

test('close preserves drafts and explicit cancel is the only unsaved-close path that discards them', () => {
    Orders.showAddForm();
    change(editor(), 'remarks', '待恢复输入');
    app.closeModal();
    expect(sessionStorage.length).toBe(1);
    expect(reopen().elements.remarks.value).toBe('待恢复输入');
    expect(document.getElementById('modalFooter').innerHTML).toContain('discardDraft:true');
    app.closeModal({ discardDraft: true });
    expect(sessionStorage.length).toBe(0);
});

test('declined modal replacement preserves its original record, row mode and draft scope', () => {
    db.data.orders.push(order());
    Orders.showEditForm('OLD');
    const form = editor();
    change(form, 'remarks', '原记录草稿');
    const before = Orders._factoryIndex;
    window.confirm.mockReturnValue(false);
    Orders.showAddForm();
    expect(editor()).toBe(form);
    expect(editor().dataset.orderId).toBe('OLD');
    expect(Orders._editingOrder).toBe(true);
    expect(Orders._factoryIndex).toBe(before);
    expect(FormDrafts.canSubmit(form)).toBe(true);
});
