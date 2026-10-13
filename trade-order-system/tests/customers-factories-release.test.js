import { jest } from '@jest/globals';

let sequence = 0;
const forbidden = new Set();
const auth = {
    currentUser: { id: 'owner', tenantId: 'tenant', scope: 'self', visibleCompanyIds: ['C1'] },
    users: [],
    canDeleteRecord: jest.fn(record => Boolean(record) && !forbidden.has(record.id)),
    canDelete: jest.fn(() => true),
    canSeeFinancials: jest.fn(() => false),
    hasCapability: jest.fn(() => true),
    filterOrders: rows => rows,
    isManager: () => false,
    isSalesperson: () => false
};
const db = {
    _cloudReady: true,
    _BACKUP_KEY: 'customer-factory-tests',
    currentCompanyId: 'C1',
    companies: [{ id: 'C1' }],
    data: {},
    getCustomers: () => db.data.customers.filter(c => !c.deleted),
    getCustomer: id => db.getCustomers().find(c => c.id === id),
    getFactories: () => db.data.factories.filter(f => !f.deleted),
    getFactory: id => db.getFactories().find(f => f.id === id),
    getCurrentCompany: () => ({ id: 'C1', name: 'Current Company' }),
    getCustomerOrders: () => [],
    getFactoryOrders: () => [],
    addCustomer: jest.fn(value => {
        const customer = { ...value, id: 'C-' + ++sequence, companyId: 'C1', createdBy: 'owner' };
        db.data.customers.push(customer);
        return customer;
    }),
    updateCustomer: jest.fn((id, value) => {
        const customer = db.getCustomer(id);
        return customer ? Object.assign(customer, value) : null;
    }),
    addFactory: jest.fn(value => {
        const factory = { ...value, id: 'F-' + ++sequence, companyId: 'C1', createdBy: 'owner' };
        db.data.factories.push(factory);
        return factory;
    }),
    updateFactory: jest.fn((id, value) => {
        const factory = db.getFactory(id);
        return factory ? Object.assign(factory, value) : null;
    }),
    deleteCustomer: jest.fn(id => {
        const c = db.getCustomer(id);
        if (!c) return false;
        c.deleted = true;
        return true;
    }),
    deleteFactory: jest.fn(id => {
        const f = db.getFactory(id);
        if (!f) return false;
        f.deleted = true;
        return true;
    }),
    flush: jest.fn()
};
const esc = value =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
const app = {
    escapeHtml: esc,
    formatMoney: value => String(value),
    toast: jest.fn(),
    closeModal: jest.fn(() => {
        document.getElementById('modal').innerHTML = '';
    }),
    showModal: jest.fn((title, body, options = {}) => {
        document.getElementById('modal').innerHTML = body + (options.footer || '');
    }),
    showConfirm: jest.fn(),
    exportExcel: jest.fn()
};
jest.unstable_mockModule('../js/auth.js', () => ({ Auth: auth }));
jest.unstable_mockModule('../js/data.js', () => ({ DB: db }));
jest.unstable_mockModule('../js/app.js', () => ({ App: app }));
jest.unstable_mockModule('../js/exchange.js', () => ({ Exchange: {} }));
await import('../js/customers.js');
await import('../js/factories.js');
const Customers = window.Customers;
const Factories = window.Factories;
const contact = overrides => ({
    id: 'CONT-A',
    name: 'Alice',
    position: 'Buyer',
    email: 'alice@example.invalid',
    phone: '001-020 0123 ext. 9',
    mobilePhone: '+44 07700 090123',
    homeAddress: 'Home A',
    ...overrides
});
const customer = overrides => ({
    id: 'C-original',
    company: 'Sample Trading',
    companyAddress: 'Company Address',
    country: 'UK',
    code: 'CUSTOM-01',
    paymentTerms: '30 days',
    companyId: 'C1',
    createdBy: 'owner',
    contact: 'Alice',
    position: 'Buyer',
    contacts: [contact()],
    ...overrides
});
const importRow = overrides => ({
    公司名称: 'New Trading',
    公司地址: 'New Address',
    国家: 'UK',
    联系人: 'Alice',
    职位: 'Buyer',
    邮箱: 'alice@example.invalid',
    电话: '001-020 0123 ext. 9',
    手机号码: '+44 07700 090123',
    家庭地址: 'Home A',
    ...overrides
});
const factory = overrides => ({
    id: 'F-original',
    companyId: 'C1',
    tenantId: 'tenant',
    createdBy: 'owner',
    name: 'Sample Factory',
    contact: 'Buyer',
    phone: '007-0123',
    mobilePhone: '+86 00123',
    products: 'Cups',
    address: 'Factory Address',
    bankInfo: 'Private Bank',
    ...overrides
});
const changeForm = (form, name, value) => {
    const input = form.elements.namedItem(name);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    sessionStorage.clear();
    document.body.innerHTML = '<div id="modal"></div><div id="pageContent"></div><div id="pageTitle"></div>';
    db.data = { customers: [], factories: [] };
    db._cloudReady = true;
    sequence = 0;
    forbidden.clear();
    auth.currentUser.scope = 'self';
    auth.canDelete.mockReturnValue(true);
    auth.hasCapability.mockReturnValue(true);
    auth.canSeeFinancials.mockReturnValue(false);
    db.flush.mockResolvedValue(true);
    Customers._importData = null;
    Customers._importing = false;
    Customers._reopenImportPreview = null;
    Customers._importSkipDuplicates = undefined;
    Customers.selectedCustomers.clear();
    Factories.selectedFactories.clear();
    global.XLSX = {
        utils: {
            json_to_sheet: jest.fn(rows => ({ rows })),
            book_new: () => ({}),
            book_append_sheet: (book, sheet) => {
                book.sheet = sheet;
            }
        },
        writeFile: jest.fn()
    };
});
afterEach(() => {
    delete global.XLSX;
});

describe('customer import acknowledgement and retry', () => {
    test('customer ACK keeps later dynamic input and a second save updates the same pending record', async () => {
        Customers.showAddForm();
        const form = document.getElementById('customerForm');
        for (const [name, value] of Object.entries({
            company: 'Submitted Customer',
            companyAddress: 'Address',
            contact_name_0: 'Buyer',
            contact_position_0: 'Buyer',
            contact_email_0: 'buyer@example.invalid',
            contact_phone_0: '00123',
            contact_mobile_0: '+86 00123'
        }))
            changeForm(form, name, value);
        let resolveFlush;
        db.flush.mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    resolveFlush = resolve;
                })
        );
        const saving = Customers.saveCustomer({ preventDefault() {}, target: form });
        changeForm(form, 'company', 'Later Customer Input');
        changeForm(form, 'contact_phone_0', ' 000099 +86 ');
        await Customers.saveCustomer({ preventDefault() {}, target: form });
        expect(db.flush).toHaveBeenCalledTimes(1);
        resolveFlush(true);
        await saving;
        expect(db.data.customers[0].company).toBe('Submitted Customer');
        expect(db.data.customers[0].contacts[0].phone).toBe('00123');
        const contactId = db.data.customers[0].contacts[0].id;
        expect(form.elements.company.value).toBe('Later Customer Input');
        expect(form.elements.namedItem('contact_phone_0').value).toBe(' 000099 +86 ');
        expect(app.closeModal).not.toHaveBeenCalled();
        expect(sessionStorage.length).toBe(1);
        expect(app.toast).toHaveBeenCalledWith('上一版已保存，当前新输入尚未保存，请再次保存', 'warning');
        document.getElementById('modal').innerHTML = '';
        Customers.showAddForm();
        const reopened = document.getElementById('customerForm');
        expect(reopened.elements.company.value).toBe('Later Customer Input');
        expect(reopened.elements.namedItem('contact_phone_0').value).toBe(' 000099 +86 ');
        expect(reopened.querySelector('[data-form-draft-notice]')).toBeNull();
        await Customers.saveCustomer({ preventDefault() {}, target: reopened });
        expect(db.addCustomer).toHaveBeenCalledTimes(1);
        expect(db.updateCustomer).toHaveBeenCalledTimes(1);
        expect(db.data.customers[0].contacts[0]).toMatchObject({ id: contactId, phone: ' 000099 +86 ' });
        expect(sessionStorage.length).toBe(0);
        expect(app.closeModal).toHaveBeenCalledTimes(1);
    });

    test('factory ACK keeps later static input and cannot start overlapping writes', async () => {
        Factories.showAddForm();
        const form = document.getElementById('factoryForm');
        for (const [name, value] of Object.entries({
            name: 'Submitted Factory',
            contact: 'Manager',
            phone: '00123',
            mobilePhone: '+86 00123',
            products: 'Cups',
            address: 'Factory Address'
        }))
            changeForm(form, name, value);
        let resolveFlush;
        db.flush.mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    resolveFlush = resolve;
                })
        );
        const saving = Factories.saveFactory({ preventDefault() {}, target: form });
        changeForm(form, 'phone', ' 000099 +86 ');
        await Factories.saveFactory({ preventDefault() {}, target: form });
        expect(db.flush).toHaveBeenCalledTimes(1);
        resolveFlush(true);
        await saving;
        expect(db.data.factories[0].phone).toBe('00123');
        expect(form.elements.phone.value).toBe(' 000099 +86 ');
        expect(app.closeModal).not.toHaveBeenCalled();
        expect(sessionStorage.length).toBe(1);
        document.getElementById('modal').innerHTML = '';
        Factories.showAddForm();
        const reopened = document.getElementById('factoryForm');
        expect(reopened.elements.phone.value).toBe(' 000099 +86 ');
        expect(reopened.querySelector('[data-form-draft-notice]')).toBeNull();
        await Factories.saveFactory({ preventDefault() {}, target: reopened });
        expect(db.addFactory).toHaveBeenCalledTimes(1);
        expect(db.updateFactory).toHaveBeenCalledTimes(1);
        expect(db.data.factories[0].phone).toBe(' 000099 +86 ');
        expect(sessionStorage.length).toBe(0);
        expect(app.closeModal).toHaveBeenCalledTimes(1);
    });

    test('the actual customer form preserves unsubmitted dynamic input and pending identity until successful ACK', async () => {
        Customers.showAddForm();
        let form = document.getElementById('customerForm');
        for (const [name, value] of Object.entries({
            company: 'Draft Customer',
            companyAddress: 'Draft Address',
            contact_name_0: 'Draft Buyer',
            contact_position_0: 'Buyer',
            contact_email_0: 'draft@example.invalid',
            contact_phone_0: ' 00123 +86 ',
            contact_mobile_0: '000099',
            contact_address_0: 'Draft Home'
        })) {
            const input = form.elements.namedItem(name);
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        db.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await Customers.saveCustomer({ preventDefault() {}, target: form });
        const id = form.dataset.pendingRecordId;
        const contactId = db.data.customers[0].contacts[0].id;
        expect(sessionStorage.length).toBe(1);
        expect(app.closeModal).not.toHaveBeenCalled();
        changeForm(form, 'contact_phone_0', ' 000099 later +86 ');
        // A browser reload rebuilds DOM while the separate DB draft retains the staged record.
        document.getElementById('modal').innerHTML = '';
        Customers.showAddForm();
        form = document.getElementById('customerForm');
        expect(form.dataset.pendingRecordId).toBe(id);
        expect(form.elements.namedItem('contact_phone_0').value).toBe(' 000099 later +86 ');
        expect(form.querySelector('[data-form-draft-notice]')).toBeNull();
        await Customers.saveCustomer({ preventDefault() {}, target: form });
        expect(db.addCustomer).toHaveBeenCalledTimes(1);
        expect(db.data.customers[0].contacts[0].id).toBe(contactId);
        expect(sessionStorage.length).toBe(0);
        expect(app.closeModal).toHaveBeenCalledTimes(1);
    });

    test('reopening a failed customer does not overwrite a newer server contact with later local input', async () => {
        Customers.showAddForm();
        const form = document.getElementById('customerForm');
        for (const [name, value] of Object.entries({
            company: 'Customer',
            companyAddress: 'Address',
            contact_name_0: 'Buyer',
            contact_position_0: 'Buyer',
            contact_email_0: 'buyer@example.invalid',
            contact_phone_0: '00123',
            contact_mobile_0: '+86 00123'
        }))
            changeForm(form, name, value);
        db.flush.mockResolvedValueOnce(false);
        await Customers.saveCustomer({ preventDefault() {}, target: form });
        changeForm(form, 'contact_phone_0', 'Local Later Phone');
        db.data.customers[0].contacts[0].phone = 'Server Updated Phone';
        document.getElementById('modal').innerHTML = '';
        Customers.showAddForm();
        const reopened = document.getElementById('customerForm');
        expect(reopened.elements.namedItem('contact_phone_0').value).toBe('Server Updated Phone');
        expect(reopened.querySelector('[data-form-draft-notice]').textContent).toContain('Local Later Phone');
        await Customers.saveCustomer({ preventDefault() {}, target: reopened });
        expect(db.flush).toHaveBeenCalledTimes(1);
        expect(db.addCustomer).toHaveBeenCalledTimes(1);
        expect(db.updateCustomer).not.toHaveBeenCalled();
    });

    test('preserves the duplicate choice when reopening a partially staged batch', async () => {
        Customers._showImportPreview([importRow({ 客户编号: 'SRC-A' }), importRow({ 客户编号: 'SRC-B' })]);
        document.getElementById('skipDuplicates').checked = false;
        const add = db.addCustomer.getMockImplementation();
        db.addCustomer.mockImplementationOnce(add).mockReturnValueOnce(null);
        await Customers._doImport();
        app.closeModal();
        Customers.importExcel();
        expect(document.getElementById('skipDuplicates').checked).toBe(false);
        await Customers._doImport();
        expect(db.data.customers).toHaveLength(2);
        expect(db.addCustomer).toHaveBeenCalledTimes(3);
        expect(app.toast).toHaveBeenCalledWith('成功导入 2 个客户', 'success');
    });

    test('reopens a failed staged batch after the preview is closed instead of starting another import', async () => {
        Customers._showImportPreview([importRow()]);
        db.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await Customers._doImport();
        const id = db.data.customers[0].id;
        app.closeModal();
        Customers.importExcel();
        expect(document.getElementById('customerImportConfirm')).not.toBeNull();
        await Customers._doImport();
        expect(db.addCustomer).toHaveBeenCalledTimes(1);
        expect(db.data.customers[0].id).toBe(id);
        expect(app.toast).toHaveBeenCalledWith('成功导入 1 个客户', 'success');
    });

    test('an all-duplicate batch still waits for acknowledgement and cannot report success on a failed flush', async () => {
        db.data.customers = [customer()];
        Customers._showImportPreview([importRow({ 公司名称: 'Sample Trading' })]);
        db.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await Customers._doImport();
        expect(db.addCustomer).not.toHaveBeenCalled();
        expect(app.closeModal).not.toHaveBeenCalled();
        expect(Customers._importData).toHaveLength(1);
        await Customers._doImport();
        expect(app.toast).toHaveBeenCalledWith('成功导入 0 个客户，跳过 1 个重复客户', 'success');
    });

    test('waits for cloud acknowledgement and preserves a failed batch without inserting twice', async () => {
        Customers._showImportPreview([importRow(), importRow({ 公司名称: 'Second Trading' })]);
        let finish;
        db.flush.mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    finish = resolve;
                })
        );
        const promise = Customers._doImport();
        expect(db.data.customers).toHaveLength(2);
        expect(Customers._importData).toHaveLength(2);
        expect(app.closeModal).not.toHaveBeenCalled();
        expect(document.getElementById('customerImportConfirm').disabled).toBe(true);
        await Customers._doImport();
        expect(db.addCustomer).toHaveBeenCalledTimes(2);
        finish(false);
        await promise;
        expect(app.closeModal).not.toHaveBeenCalled();
        expect(app.toast.mock.calls.some(([, type]) => type === 'success')).toBe(false);
        const ids = db.data.customers.map(c => c.id);
        await Customers._doImport();
        expect(db.data.customers.map(c => c.id)).toEqual(ids);
        expect(db.addCustomer).toHaveBeenCalledTimes(2);
        expect(db.flush).toHaveBeenCalledTimes(2);
        expect(Customers._importData).toBeNull();
        expect(app.toast).toHaveBeenCalledWith('成功导入 2 个客户', 'success');
    });

    test('handles a failed add without discarding the preview or duplicating earlier staged records', async () => {
        Customers._showImportPreview([importRow(), importRow({ 公司名称: 'Second Trading' })]);
        const add = db.addCustomer.getMockImplementation();
        db.addCustomer.mockImplementationOnce(add).mockReturnValueOnce(null);
        await Customers._doImport();
        expect(db.data.customers).toHaveLength(1);
        expect(db.flush).not.toHaveBeenCalled();
        expect(Customers._importData).toHaveLength(2);
        expect(app.closeModal).not.toHaveBeenCalled();
        await Customers._doImport();
        expect(db.data.customers).toHaveLength(2);
        expect(db.addCustomer).toHaveBeenCalledTimes(3);
        expect(app.toast).toHaveBeenCalledWith('成功导入 2 个客户', 'success');
    });

    test('counts duplicates as customers, including duplicates in the file, after a failed save retry', async () => {
        db.data.customers = [customer()];
        Customers._showImportPreview([
            importRow({ 公司名称: 'Sample Trading', 联系人: '' }),
            importRow({ 客户编号: 'X-1' }),
            importRow({ 客户编号: 'X-2' })
        ]);
        db.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await Customers._doImport();
        await Customers._doImport();
        expect(db.data.customers).toHaveLength(2);
        expect(app.toast).toHaveBeenCalledWith('成功导入 1 个客户，跳过 2 个重复客户', 'success');
    });

    test('rejects missing new customer/contact fields before staging any records', async () => {
        Customers._showImportPreview([importRow(), importRow({ 公司名称: 'Invalid', 邮箱: '', 电话: '' })]);
        expect(document.getElementById('modal').textContent).toContain('联系人1缺少邮箱');
        await Customers._doImport();
        expect(db.addCustomer).not.toHaveBeenCalled();
        expect(db.flush).not.toHaveBeenCalled();
        expect(Customers._importData).toHaveLength(2);
    });

    test('keeps incomplete source rows visible, rather than silently skipping them', async () => {
        Customers._showImportPreview([importRow({ 公司名称: '', 公司地址: '' })]);
        await Customers._doImport();
        expect(db.addCustomer).not.toHaveBeenCalled();
        expect(app.toast.mock.calls.at(-1)[0]).toContain('缺少公司名称');
    });
});

describe('customer Excel contacts', () => {
    test('editing contacts retains their IDs and untouched telephone text', () => {
        const original = contact({ phone: ' 000099 ', mobilePhone: ' 000012345 ' });
        db.data.customers = [customer({ contacts: [original] })];
        Customers.showEditForm('C-original');
        expect(Customers.collectContacts()).toEqual([original]);
        expect(Customers.collectContacts()[0].id).toBe('CONT-A');
    });

    test('new imports keep optional country blank rather than inventing a value', async () => {
        Customers._showImportPreview([importRow({ 国家: '' })]);
        await Customers._doImport();
        expect(db.data.customers[0].country).toBe('');
        expect(app.toast).toHaveBeenCalledWith('成功导入 1 个客户', 'success');
    });

    test('two same-name contacts round trip with distinct IDs, all six fields and original phone text', async () => {
        const contacts = [
            contact(),
            contact({
                id: 'CONT-B',
                email: 'other@example.invalid',
                phone: ' 000099 ',
                mobilePhone: '000012345',
                homeAddress: 'Home B',
                position: 'Director'
            })
        ];
        db.data.customers = [customer({ contacts })];
        Customers.exportExcel();
        const rows = XLSX.utils.json_to_sheet.mock.calls[0][0];
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({
            联系人编号: 'CONT-B',
            电话: ' 000099 ',
            手机号码: '000012345',
            邮箱: 'other@example.invalid'
        });
        const output = XLSX.writeFile.mock.calls[0][0].sheet.rows;
        db.data.customers = [];
        Customers._showImportPreview(output);
        expect(Customers._importData).toHaveLength(1);
        await Customers._doImport();
        expect(db.data.customers).toHaveLength(1);
        expect(db.data.customers[0].contacts).toEqual(contacts);
        expect(db.data.customers[0]).toMatchObject({
            company: 'Sample Trading',
            companyAddress: 'Company Address',
            code: 'CUSTOM-01',
            paymentTerms: '30 days'
        });
    });

    test('accepts English aliases and checks conflicting company fields across contact rows', async () => {
        Customers._showImportPreview([
            {
                Customer_ID: 'SRC-1',
                Company_Name: 'English Co',
                Company_Address: 'Address',
                Country: 'UK',
                Contact_Name: 'Alice',
                Position: 'Buyer',
                Email_Address: 'a@example.invalid',
                Telephone: '00123',
                Mobile_Phone: '+44 0123',
                Home_Address: 'Home'
            },
            {
                customerId: 'SRC-1',
                company: 'English Co',
                companyAddress: 'Different Address',
                country: 'UK',
                contact: 'Bob',
                position: 'Buyer',
                email: 'b@example.invalid',
                phone: '00124',
                mobile: '+44 0124'
            }
        ]);
        expect(Customers._importData).toHaveLength(1);
        expect(Customers._importData[0].contacts[0].phone).toBe('00123');
        await Customers._doImport();
        expect(db.addCustomer).not.toHaveBeenCalled();
        expect(app.toast.mock.calls.at(-1)[0]).toContain('客户资料与同一客户其他行不一致');
    });

    test('exports incomplete historical contacts and legacy top-level fields without default replacements', () => {
        db.data.customers = [
            customer({
                country: '',
                companyAddress: '',
                contacts: [],
                contact: 'Legacy Buyer',
                email: 'legacy@example.invalid',
                phone: '000100',
                mobilePhone: '000200',
                homeAddress: 'Legacy Home'
            })
        ];
        Customers.exportExcel();
        expect(XLSX.utils.json_to_sheet.mock.calls[0][0][0]).toMatchObject({
            国家: '',
            公司地址: '',
            联系人: 'Legacy Buyer',
            邮箱: 'legacy@example.invalid',
            电话: '000100',
            手机号码: '000200',
            家庭地址: 'Legacy Home'
        });
    });
});

describe('record deletion and export authority', () => {
    test.each(['customers', 'factories'])(
        'mixed %s batch skips unauthorized rows and counts successful deletion only',
        async collection => {
            const page = collection === 'customers' ? Customers : Factories;
            const make = collection === 'customers' ? customer : factory;
            db.data[collection] = [make({ id: 'allowed' }), make({ id: 'forbidden' }), make({ id: 'failed' })];
            forbidden.add('forbidden');
            const remove = collection === 'customers' ? db.deleteCustomer : db.deleteFactory;
            const implementation = remove.getMockImplementation();
            remove.mockImplementation(id => (id === 'failed' ? false : implementation(id)));
            const selection = collection === 'customers' ? page.selectedCustomers : page.selectedFactories;
            ['allowed', 'forbidden', 'failed'].forEach(id => selection.add(id));
            page.batchDelete();
            await app.showConfirm.mock.calls[0][1]();
            expect(remove.mock.calls.map(([id]) => id)).toEqual(['allowed', 'failed']);
            const label = collection === 'customers' ? '客户' : '工厂';
            expect(app.toast).toHaveBeenCalledWith(`已删除 1 个${label}，跳过 1 个无权限${label}`);
            expect(auth.canDeleteRecord.mock.calls.some(([, type]) => type === collection)).toBe(true);
        }
    );

    test.each(['customers', 'factories'])(
        'failed %s batch save never reports success or closes the confirmation',
        async collection => {
            const page = collection === 'customers' ? Customers : Factories;
            db.data[collection] = [
                collection === 'customers' ? customer({ id: 'allowed' }) : factory({ id: 'allowed' })
            ];
            const selection = collection === 'customers' ? page.selectedCustomers : page.selectedFactories;
            selection.add('allowed');
            db.flush.mockResolvedValue(false);
            page.batchDelete();
            await app.showConfirm.mock.calls[0][1]();
            expect(app.closeModal).not.toHaveBeenCalled();
            expect(app.toast.mock.calls.some(([message]) => message.startsWith('已删除'))).toBe(false);
        }
    );

    test('customer rows and details hide unauthorized delete buttons, and recheck permission at confirmation', async () => {
        db.data.customers = [customer()];
        forbidden.add('C-original');
        Customers.render(document.getElementById('pageContent'));
        expect(document.querySelector('[onclick*="Customers.deleteCustomer"]')).toBeNull();
        expect(document.querySelector('#customersTableBody input[type="checkbox"]').disabled).toBe(true);
        forbidden.clear();
        Customers.deleteCustomer('C-original');
        forbidden.add('C-original');
        await app.showConfirm.mock.calls[0][1]();
        expect(db.deleteCustomer).not.toHaveBeenCalled();
    });

    test('factory export includes operational fields and original phone text, hiding bank fields until authorized', () => {
        db.data.factories = [factory()];
        Factories.render(document.getElementById('pageContent'));
        expect(document.querySelector('[onclick="Factories.exportExcel()"]')).not.toBeNull();
        Factories.exportExcel();
        const [rows, , headers] = app.exportExcel.mock.calls[0];
        expect(rows[0]).toMatchObject({
            id: 'F-original',
            phone: '007-0123',
            mobilePhone: '+86 00123',
            address: 'Factory Address',
            products: 'Cups'
        });
        expect(headers).not.toContain('bankInfo');
        expect(rows[0]).not.toHaveProperty('bankInfo');
        auth.canSeeFinancials.mockReturnValue(true);
        Factories.exportExcel();
        expect(app.exportExcel.mock.calls[1][0][0].bankInfo).toBe('Private Bank');
    });
});

test('customer edit values cannot inject attributes or elements through quotes', () => {
    const payload = 'UK" autofocus onfocus="alert(1)" data-injected="yes"><img src=x onerror=alert(1)>';
    const id = "C-'quoted";
    db.data.customers = [
        customer({
            id,
            company: payload,
            companyAddress: payload,
            country: payload,
            contacts: [
                contact({
                    name: payload,
                    position: payload,
                    phone: payload,
                    mobilePhone: payload,
                    homeAddress: payload
                })
            ]
        })
    ];
    Customers.showEditForm(id);
    const form = document.getElementById('customerForm');
    expect(form.querySelector('[data-injected]')).toBeNull();
    expect(form.querySelector('img')).toBeNull();
    for (const name of [
        'company',
        'companyAddress',
        'country',
        'contact_name_0',
        'contact_position_0',
        'contact_phone_0',
        'contact_mobile_0',
        'contact_address_0'
    ]) {
        expect(form.elements.namedItem(name).value).toBe(payload);
    }
    const save = jest.fn();
    new Function('Customers', 'event', form.getAttribute('onsubmit'))({ saveCustomer: save }, {});
    expect(save.mock.calls[0][1]).toBe(id);
});
