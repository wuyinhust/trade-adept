import { jest } from '@jest/globals';

const auth = {
    currentUser: null,
    users: [],
    filterOrders: rows => rows,
    canSeeAll: () => false,
    getVisibleCompanyIds: () => auth.currentUser?.visibleCompanyIds || [],
    hasCapability: name => {
        const caps = auth.currentUser?.permissions;
        return Array.isArray(caps) ? caps.includes(name) : caps?.[name] === true;
    }
};
const app = {
    toast: jest.fn(),
    closeModal: jest.fn(),
    showConfirm: jest.fn(message => {
        document.getElementById('modal').innerHTML = `<p>${app.escapeHtml(message)}</p>`;
    }),
    showModal: jest.fn((title, html) => {
        document.getElementById('modal').innerHTML = `<h2 class="modal-title">${title}</h2>${html}`;
    }),
    escapeHtml: value =>
        String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;'),
    formatMoney: value => String(value),
    getStatusBadge: value => value
};
jest.unstable_mockModule('../js/auth.js', () => ({ Auth: auth }));
jest.unstable_mockModule('../js/app.js', () => ({ App: app }));
jest.unstable_mockModule('../js/cloud.js', () => ({ Cloud: {} }));
jest.unstable_mockModule('../js/exchange.js', () => ({ Exchange: {} }));
const { DB } = await import('../js/data.js');
await import('../js/factories.js');
const Factories = window.Factories;

const actor = overrides => ({
    id: 'sales-one',
    tenantId: 'demo-tenant',
    role: 'custom-collaborator',
    scope: 'self',
    teamId: 'demo-team',
    visibleCompanyIds: ['CO-GR', 'CO-GW'],
    permissions: ['read', 'create', 'edit', 'delete'],
    ...overrides
});
const factory = overrides => ({
    id: 'factory-existing',
    tenantId: 'demo-tenant',
    companyId: 'CO-GR',
    createdBy: 'sales-one',
    name: 'Demo Factory',
    contact: 'Demo Contact',
    phone: '000',
    mobilePhone: '000',
    products: 'Demo Product',
    address: 'Demo Address',
    bankInfo: 'Demo Bank',
    ...overrides
});
const form = (bank = null) => {
    const element = document.createElement('form');
    element.innerHTML =
        ['name', 'contact', 'phone', 'mobilePhone', 'products', 'address']
            .map(name => `<input name="${name}" value="Demo ${name}">`)
            .join('') + (bank === null ? '' : `<input name="bankInfo" value="${bank}">`);
    return element;
};
const event = target => ({ preventDefault() {}, target });

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    global.document = window.document;
    global.FormData = window.FormData;
    document.body.innerHTML = '<div id="modal"></div><div id="pageContent"></div><div id="pageTitle"></div>';
    auth.currentUser = actor();
    auth.users = [
        { id: 'sales-one', teamId: 'demo-team' },
        { id: 'sales-two', teamId: 'demo-team' },
        { id: 'outside-user', teamId: 'other-team' }
    ];
    DB.currentCompanyId = 'CO-GR';
    DB.companies = [
        { id: 'CO-GR', name: 'Demo Domestic' },
        { id: 'CO-GW', name: 'Demo USD' },
        { id: 'OTHER', name: 'Other Entity' }
    ];
    DB.data = { factories: [factory()], orders: [], customers: [], shipments: [], invoices: [] };
    DB._cloudReady = true;
    DB._businessAPI = null;
    Factories.selectedFactories.clear();
    jest.spyOn(DB, '_backupToLocal').mockImplementation(() => {});
    jest.spyOn(DB, 'flush').mockResolvedValue(true);
});

describe('factory saves and bank field permissions', () => {
    test('a failed new save retries the same factory ID instead of inserting again', async () => {
        DB.data.factories = [];
        auth.currentUser.permissions = ['read', 'create'];
        DB.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const add = jest.spyOn(DB, 'addFactory');
        const update = jest.spyOn(DB, 'updateFactory');
        jest.spyOn(Factories, 'renderTable').mockImplementation(() => {});
        const target = form();
        await Factories.saveFactory(event(target));
        const id = target.dataset.pendingRecordId;
        expect(id).toBeTruthy();
        expect(app.closeModal).not.toHaveBeenCalled();
        target.elements.namedItem('name').value = 'Edited Demo Factory';
        await Factories.saveFactory(event(target));
        expect(add).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith(id, expect.objectContaining({ name: 'Edited Demo Factory' }));
        expect(DB.data.factories).toHaveLength(1);
        expect(DB.data.factories[0].id).toBe(id);
        expect(app.closeModal).toHaveBeenCalledTimes(1);
    });

    test('does not close or report success until persistence completes', async () => {
        let resolveSave;
        DB.flush.mockImplementation(
            () =>
                new Promise(resolve => {
                    resolveSave = resolve;
                })
        );
        jest.spyOn(Factories, 'renderDetail').mockImplementation(() => {});
        const saving = Factories.saveFactory(event(form()), 'factory-existing');
        expect(app.closeModal).not.toHaveBeenCalled();
        expect(app.toast).not.toHaveBeenCalled();
        resolveSave(true);
        await saving;
        expect(app.closeModal).toHaveBeenCalledTimes(1);
    });

    test('finance read does not grant bank inputs in either form', () => {
        auth.currentUser.permissions.push('finance.read');
        Factories.showAddForm();
        expect(document.querySelector('[name="bankInfo"]')).toBeNull();
        Factories.showEditForm('factory-existing');
        expect(document.querySelector('[name="bankInfo"]')).toBeNull();
    });

    test('an omitted or forged bank input is absent from the patch and preserves stored bank info', async () => {
        const update = jest.spyOn(DB, 'updateFactory');
        jest.spyOn(Factories, 'renderDetail').mockImplementation(() => {});
        await Factories.saveFactory(event(form()), 'factory-existing');
        expect(update.mock.calls[0][1]).not.toHaveProperty('bankInfo');
        expect(DB.data.factories[0].bankInfo).toBe('Demo Bank');
        await Factories.saveFactory(event(form('Injected Bank')), 'factory-existing');
        expect(update.mock.calls[1][1]).not.toHaveProperty('bankInfo');
        expect(DB.data.factories[0].bankInfo).toBe('Demo Bank');
    });

    test('finance write allows an explicit bank edit or clearing, while a missing input preserves it', async () => {
        auth.currentUser.permissions.push('finance.write');
        Factories.showAddForm();
        expect(document.querySelector('[name="bankInfo"]')).not.toBeNull();
        Factories.showEditForm('factory-existing');
        expect(document.querySelector('[name="bankInfo"]').value).toBe('Demo Bank');
        jest.spyOn(Factories, 'renderDetail').mockImplementation(() => {});
        await Factories.saveFactory(event(form()), 'factory-existing');
        expect(DB.data.factories[0].bankInfo).toBe('Demo Bank');
        await Factories.saveFactory(event(form('')), 'factory-existing');
        expect(DB.data.factories[0].bankInfo).toBe('');
    });
});

describe('shared reads and configured mutation scope', () => {
    test('a disabled historical owner remains editable for the authorized team without becoming assignable', () => {
        auth.currentUser = actor({ scope: 'team', role: 'custom-manager' });
        auth.users = [];
        auth.getRecordOwner = id => id === 'disabled-owner' ? { id, teamId: 'demo-team' } : null;
        try {
            expect(Factories.canMutate('edit', factory({ createdBy: 'disabled-owner' }))).toBe(true);
            expect(Factories.canMutate('delete', factory({ createdBy: 'disabled-owner' }))).toBe(true);
            expect(Factories.canMutate('edit', factory({ createdBy: 'unknown-owner' }))).toBe(false);
            expect(Factories.canMutate('edit', factory({ createdBy: 'disabled-owner', companyId: 'ungranted' }))).toBe(false);
            expect(auth.users).toEqual([]);
        } finally {
            delete auth.getRecordOwner;
        }
    });

    test('keeps another owner factory readable across granted entities and removes mutation controls', () => {
        DB.data.factories = [factory({ createdBy: 'outside-user', companyId: 'CO-GW' })];
        const container = document.getElementById('pageContent');
        Factories.render(container);
        const row = container.querySelector('tbody tr');
        expect(row.textContent).toContain('Demo Factory');
        expect(row.textContent).toContain('详情');
        expect(row.textContent).not.toContain('编辑');
        expect(row.textContent).not.toContain('删除');
        expect(row.querySelector('input').disabled).toBe(true);
        Factories.renderDetail(container, 'factory-existing');
        expect(container.textContent).toContain('Demo Factory');
        expect(container.textContent).not.toContain('编辑工厂');
        expect(container.textContent).not.toContain('删除工厂');
    });

    test('direct edit, save and delete calls cannot mutate a shared factory owned by another user', async () => {
        DB.data.factories[0].createdBy = 'outside-user';
        const update = jest.spyOn(DB, 'updateFactory');
        const remove = jest.spyOn(DB, 'deleteFactory');
        Factories.showEditForm('factory-existing');
        await Factories.saveFactory(event(form()), 'factory-existing');
        Factories.deleteFactory('factory-existing');
        expect(app.showModal).not.toHaveBeenCalled();
        expect(app.showConfirm).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(DB.flush).not.toHaveBeenCalled();
    });

    test('team scope follows actual directory team membership, with unknown owners denied', () => {
        auth.currentUser = actor({ scope: 'team', role: 'custom-manager' });
        expect(Factories.canMutate('edit', factory({ createdBy: 'sales-two' }))).toBe(true);
        expect(Factories.canMutate('delete', factory({ ownerId: 'sales-two', createdBy: null }))).toBe(true);
        expect(Factories.canMutate('edit', factory({ createdBy: 'outside-user' }))).toBe(false);
        expect(Factories.canMutate('edit', factory({ createdBy: 'missing-owner' }))).toBe(false);
        auth.currentUser.teamId = null;
        expect(Factories.canMutate('create')).toBe(false);
    });

    test('tenant scope and boolean capabilities work for custom roles without crossing tenants or entity grants', () => {
        auth.currentUser = actor({ scope: 'tenant', role: 'custom-admin', permissions: { edit: true, delete: false } });
        expect(Factories.canMutate('edit', factory({ createdBy: 'outside-user' }))).toBe(true);
        expect(Factories.canMutate('delete', factory())).toBe(false);
        expect(Factories.canMutate('edit', factory({ tenantId: 'different-tenant' }))).toBe(false);
        expect(Factories.canMutate('edit', factory({ companyId: 'OTHER' }))).toBe(false);
        expect(Factories.canMutate('edit', factory({ companyId: 'missing-company' }))).toBe(false);
        expect(Factories.canMutate('edit')).toBe(false);
        auth.currentUser.scope = 'unconfigured';
        expect(Factories.canMutate('edit', factory())).toBe(false);
    });

    test('a read-only configured role cannot create or submit a new factory', async () => {
        auth.currentUser.permissions = ['read'];
        const add = jest.spyOn(DB, 'addFactory');
        Factories.showAddForm();
        await Factories.saveFactory(event(form()));
        expect(app.showModal).not.toHaveBeenCalled();
        expect(add).not.toHaveBeenCalled();
        expect(DB.flush).not.toHaveBeenCalled();
    });

    test('deletion rechecks permission after the confirmation is opened', async () => {
        const remove = jest.spyOn(DB, 'deleteFactory');
        Factories.deleteFactory('factory-existing');
        const confirm = app.showConfirm.mock.calls[0][1];
        auth.currentUser.permissions = ['read'];
        await confirm();
        expect(remove).not.toHaveBeenCalled();
        expect(DB.data.factories[0].deleted).toBeUndefined();
    });

    test('selection ignores unauthorized factories and a mixed batch deletes only authorized factories', async () => {
        DB.data.factories.push(factory({ id: 'factory-shared', createdBy: 'outside-user' }));
        Factories.toggleSelect('factory-shared');
        expect(Factories.selectedFactories.size).toBe(0);
        Factories.selectedFactories.add('factory-existing');
        Factories.selectedFactories.add('factory-shared');
        const remove = jest.spyOn(DB, 'deleteFactory');
        Factories.batchDelete();
        expect(app.showConfirm).toHaveBeenCalledTimes(1);
        await app.showConfirm.mock.calls[0][1]();
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('factory-existing');
        expect(DB.data.factories[1].deleted).toBeUndefined();
        expect(app.toast).toHaveBeenCalledWith('已删除 1 个工厂，跳过 1 个无权限工厂');
    });

    test('select all selects only deletable rows while shared rows remain visible', () => {
        DB.data.factories.push(factory({ id: 'factory-shared', createdBy: 'outside-user' }));
        Factories.render(document.getElementById('pageContent'));
        document.getElementById('selectAllCheckbox').checked = true;
        Factories.toggleSelectAll();
        expect([...Factories.selectedFactories]).toEqual(['factory-existing']);
        expect(document.getElementById('selectAllCheckbox').checked).toBe(true);
        expect(document.querySelectorAll('#factoriesTableBody tr')).toHaveLength(2);
    });
});

describe('factory template data remains text', () => {
    const payload = `"'><b data-injected="yes">Demo</b></textarea><i data-injected="yes">Tail</i>`;
    test('quotes, closing textarea and tags do not create elements in edit fields, title or confirmation', () => {
        auth.currentUser.permissions.push('finance.write');
        DB.data.factories[0] = factory(
            Object.fromEntries(
                ['name', 'contact', 'phone', 'mobilePhone', 'products', 'address', 'bankInfo'].map(key => [
                    key,
                    payload
                ])
            )
        );
        Factories.showEditForm('factory-existing');
        const target = document.getElementById('factoryForm');
        for (const name of ['name', 'contact', 'phone', 'mobilePhone', 'products', 'address', 'bankInfo']) {
            expect(target.elements.namedItem(name).value).toBe(payload);
        }
        expect(document.querySelector('[data-injected]')).toBeNull();
        expect(document.querySelector('.modal-title').textContent).toBe('编辑工厂 - ' + payload);
        Factories.deleteFactory('factory-existing');
        expect(document.querySelector('[data-injected]')).toBeNull();
        expect(document.getElementById('modal').textContent).toContain(payload);
    });

    test('quoted IDs remain one literal argument in table and form handlers', () => {
        const id = `factory-'"; injectedMarker = true; //`;
        DB.data.factories[0].id = id;
        Factories.render(document.getElementById('pageContent'));
        const argument = jest.fn();
        const checkbox = document.querySelector('#factoriesTableBody input');
        new Function('Factories', checkbox.getAttribute('onchange'))({ toggleSelect: argument });
        expect(argument).toHaveBeenCalledWith(id);
        Factories.showEditForm(id);
        const submit = jest.fn();
        const evt = event(document.getElementById('factoryForm'));
        new Function('Factories', 'event', evt.target.getAttribute('onsubmit'))({ saveFactory: submit }, evt);
        expect(submit).toHaveBeenCalledWith(evt, id);
    });

    test('company, factory, linked order and status data cannot inject list or detail markup', () => {
        DB.companies[0].name = payload;
        DB.data.factories[0].name = payload;
        DB.data.orders = [
            {
                id: 'demo-order',
                factoryIds: ['factory-existing'],
                status: payload,
                customerName: payload,
                productName: payload,
                orderAmountUSD: 100
            }
        ];
        const container = document.getElementById('pageContent');
        Factories.render(container);
        expect(container.querySelector('[data-injected]')).toBeNull();
        expect(container.textContent).toContain(payload);
        Factories.renderDetail(container, 'factory-existing');
        expect(container.querySelector('[data-injected]')).toBeNull();
        expect(container.textContent).toContain(payload);
    });
});
