import { jest } from '@jest/globals';
import { FormDrafts } from '../js/form-drafts.js';
import { escapeHtml, installBusinessModalHooks } from '../js/utils.js';

const scope = { origin: 'https://test.invalid', instance: 'instance-A', tenantId: 'T1', userId: 'U1', companyId: 'C1' };
function build({ id = 'factoryForm', name = 'Original', phone = '00123', bank = null, choices = ['A', 'B'] } = {}) {
    document.body.innerHTML = '<div id="modalContainer"></div>';
    const form = document.createElement('form');
    form.id = id;
    form.innerHTML =
        `<input name="name" value="${escapeHtml(name)}"><input name="phone" value="${escapeHtml(phone)}">` +
        `<select name="choice">${choices.map(value => `<option>${escapeHtml(value)}</option>`).join('')}</select>` +
        (bank === null ? '' : `<input name="bankInfo" value="${escapeHtml(bank)}">`);
    document.getElementById('modalContainer').append(form);
    return form;
}
function input(form, name, value) {
    const target = form.elements.namedItem(name);
    target.value = value;
    target.dispatchEvent(new Event('input', { bubbles: true }));
}
const options = (extra = {}) => ({ scope, recordId: 'record-1', ...extra });
const contacts = [
    {
        id: 'CONT-1',
        name: 'Original Buyer',
        position: 'Buyer',
        email: 'buyer@example.invalid',
        phone: '00123',
        mobilePhone: '+86 0123',
        homeAddress: 'Home'
    }
];
function renderContacts(form, values) {
    form.querySelector('#contactsContainer').innerHTML = values
        .map(
            (contact, index) =>
                `<div class="contact-card" data-contact-id="${escapeHtml(contact.id || '')}">${Object.entries({
                    name: 'name',
                    position: 'position',
                    email: 'email',
                    phone: 'phone',
                    mobilePhone: 'mobile',
                    homeAddress: 'address'
                })
                    .map(
                        ([field, suffix]) =>
                            `<input name="contact_${suffix}_${index}" value="${escapeHtml(contact[field] || '')}">`
                    )
                    .join('')}</div>`
        )
        .join('');
}
function contactForm(values = contacts) {
    const form = build({ id: 'customerForm' });
    form.insertAdjacentHTML('beforeend', '<div id="contactsContainer"></div>');
    renderContacts(form, values);
    return form;
}
const dynamic = form => ({
    capture: opts => FormDrafts.contactRows(form, opts),
    restore: values => renderContacts(form, values)
});

beforeEach(() => {
    jest.restoreAllMocks();
    sessionStorage.clear();
    document.body.innerHTML = '';
    jest.spyOn(window, 'confirm').mockReturnValue(true);
});

test('same record restores unsaved fields without changing phone text or submitting', () => {
    const form = build();
    const controller = FormDrafts.attach(form, options());
    input(form, 'name', 'Local Input');
    input(form, 'phone', ' 000099 +86 ');
    const restored = build();
    const submit = jest.fn();
    restored.addEventListener('submit', submit);
    FormDrafts.attach(restored, options());
    expect(restored.elements.name.value).toBe('Local Input');
    expect(restored.elements.phone.value).toBe(' 000099 +86 ');
    expect(submit).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(controller.key)).not.toBeNull();
});

test.each([
    { userId: 'U2' },
    { tenantId: 'T2' },
    { companyId: 'C2' },
    { instance: 'instance-B' },
    { origin: 'https://other.invalid' }
])('isolates drafts when scope changes: %j', difference => {
    const form = build();
    const old = FormDrafts.attach(form, options());
    input(form, 'name', 'Private Local Input');
    const other = build();
    const current = FormDrafts.attach(other, options({ scope: { ...scope, ...difference } }));
    expect(current.key).not.toBe(old.key);
    expect(other.elements.name.value).toBe('Original');
    expect(sessionStorage.getItem(old.key)).toContain('Private Local Input');
});

test('different record and different business form cannot consume another draft', () => {
    const form = build();
    FormDrafts.attach(form, options());
    input(form, 'name', 'Local Input');
    const otherRecord = build();
    FormDrafts.attach(otherRecord, options({ recordId: 'record-2' }));
    expect(otherRecord.elements.name.value).toBe('Original');
    const otherForm = build({ id: 'shipmentForm' });
    FormDrafts.attach(otherForm, options());
    expect(otherForm.elements.name.value).toBe('Original');
});

test('a cancelled modal replacement cannot relabel existing DOM input as another record', () => {
    const form = build();
    const original = FormDrafts.attach(form, options());
    input(form, 'name', 'Record One Draft');
    const refused = FormDrafts.attach(form, options({ recordId: 'record-2' }));
    expect(refused.key).toBe(original.key);
    expect(sessionStorage.getItem(original.key)).toContain('Record One Draft');
    expect(sessionStorage.length).toBe(1);
});

test('an open form cannot submit into a different account or company context', () => {
    let current = { ...scope };
    const form = build();
    const controller = FormDrafts.attach(form, options({ getScope: () => current }));
    input(form, 'name', 'Original Company Draft');
    current = { ...scope, companyId: 'C2', userId: 'U2' };
    expect(FormDrafts.canSubmit(form)).toBe(false);
    expect(sessionStorage.getItem(controller.key)).toContain('Original Company Draft');
    expect(form.querySelector('[data-form-draft-notice] button').disabled).toBe(true);
});

test('dynamic new/removed contacts restore stable IDs, incomplete rows and exact telephone strings', () => {
    const form = contactForm();
    FormDrafts.attach(form, options({ dynamic: dynamic(form) }));
    renderContacts(form, [
        ...contacts,
        { name: '', position: 'Incomplete', phone: ' 0000123 ', mobilePhone: '+86 00123' }
    ]);
    FormDrafts.persist(form);
    const id = form.querySelectorAll('.contact-card')[1].dataset.contactId;
    expect(id).toMatch(/^CONT-[0-9a-f-]{36}$/);
    form.querySelector('.contact-card').remove();
    FormDrafts.persist(form);
    const restored = contactForm();
    FormDrafts.attach(restored, options({ dynamic: dynamic(restored) }));
    const rows = FormDrafts.contactRows(restored);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
        id,
        name: '',
        position: 'Incomplete',
        phone: ' 0000123 ',
        mobilePhone: '+86 00123'
    });
});

test('remote changes preserve server fields, safely restore independent edits and retain conflicts across refresh', () => {
    const form = build();
    const old = FormDrafts.attach(form, options());
    input(form, 'name', 'Local Name');
    input(form, 'phone', 'Local Phone');
    const server = build({ name: 'Server Name' });
    FormDrafts.attach(server, options());
    expect(server.elements.name.value).toBe('Server Name');
    expect(server.elements.phone.value).toBe('Local Phone');
    expect(FormDrafts.canSubmit(server)).toBe(false);
    expect(server.querySelector('[role="alert"]').textContent).toContain('未覆盖当前资料');
    const stored = JSON.parse(sessionStorage.getItem(old.key));
    expect(stored.retained.name[0].value).toBe('Local Name');
    input(server, 'phone', 'Second Local Phone');
    const again = build({ name: 'Server Name' });
    FormDrafts.attach(again, options());
    expect(again.elements.name.value).toBe('Server Name');
    expect(again.elements.phone.value).toBe('Second Local Phone');
    const event = new Event('submit', { cancelable: true });
    again.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    again.querySelector('[data-form-draft-notice] button').click();
    expect(FormDrafts.canSubmit(again)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(old.key)).retained).toEqual({});
});

test('server contact changes cannot be overwritten by an old dynamic contact draft', () => {
    const form = contactForm();
    FormDrafts.attach(form, options({ dynamic: dynamic(form) }));
    input(form, 'contact_name_0', 'Local Buyer');
    const server = contactForm([{ ...contacts[0], name: 'Server Buyer' }]);
    const controller = FormDrafts.attach(server, options({ dynamic: dynamic(server) }));
    expect(FormDrafts.contactRows(server)[0].name).toBe('Server Buyer');
    expect(JSON.parse(sessionStorage.getItem(controller.key)).retained.dynamic[0].name).toBe('Local Buyer');
    expect(FormDrafts.canSubmit(server)).toBe(false);
});

test('a server change while the form stays open blocks stale submission and retains the original base', () => {
    let record = { name: 'Original' };
    const form = build();
    const controller = FormDrafts.attach(form, options({ getRecord: () => record }));
    input(form, 'name', 'Local Name');
    record = { name: 'Server Name' };
    expect(FormDrafts.canSubmit(form)).toBe(false);
    expect(form.elements.name.value).toBe('Local Name');
    expect(form.querySelector('[data-form-draft-notice] button').disabled).toBe(true);
    const entry = JSON.parse(sessionStorage.getItem(controller.key));
    expect(entry.base.fields.name[0].value).toBe('Original');
    expect(entry.state.fields.name[0].value).toBe('Local Name');
});

test('own staged DB edits are retryable after failure while a subsequent remote change remains blocked', () => {
    let record = { name: 'Original' };
    const form = build();
    const controller = FormDrafts.attach(form, options({ getRecord: () => record }));
    input(form, 'name', 'Local Name');
    expect(FormDrafts.canSubmit(form)).toBe(true);
    record = { name: 'Local Name' };
    FormDrafts.stageRecord(form);
    expect(FormDrafts.canSubmit(form)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(controller.key)).base.fields.name[0].value).toBe('Original');
    record = { name: 'Server Name' };
    expect(FormDrafts.canSubmit(form)).toBe(false);
});

test('revoked financial fields are neither resurrected nor retained in the new form draft', () => {
    const form = build({ bank: 'Server Bank' });
    const controller = FormDrafts.attach(form, options());
    input(form, 'bankInfo', 'Authorized Bank Draft');
    const reduced = build();
    FormDrafts.attach(reduced, options());
    expect(reduced.elements.namedItem('bankInfo')).toBeNull();
    expect(sessionStorage.getItem(controller.key)).not.toContain('Authorized Bank Draft');
});

test('a removed select option becomes an explicit conflict rather than an unauthorized restored option', () => {
    const form = build();
    FormDrafts.attach(form, options());
    input(form, 'choice', 'B');
    const reduced = build({ choices: ['A'] });
    FormDrafts.attach(reduced, options());
    expect(reduced.elements.choice.value).toBe('A');
    expect(reduced.elements.choice.options).toHaveLength(1);
    expect(FormDrafts.canSubmit(reduced)).toBe(false);
});

test('passwords, files, tokens and non-business forms never enter storage', () => {
    const form = build();
    form.insertAdjacentHTML(
        'beforeend',
        '<input type="password" name="password" value="NEVER-STORE"><input name="apiToken" value="NEVER-STORE"><input type="hidden" name="sid" value="NEVER-STORE"><input type="file" name="attachment">'
    );
    const controller = FormDrafts.attach(form, options());
    input(form, 'name', 'Local Name');
    expect(sessionStorage.getItem(controller.key)).not.toContain('NEVER-STORE');
    for (const id of ['administratorForm', 'loginForm', 'paymentForm']) {
        const forbidden = build({ id });
        expect(FormDrafts.attach(forbidden, options())).toBeNull();
    }
    expect(sessionStorage.length).toBe(1);
});

test('failed saves retain pending identity; only explicit acknowledgement clears the draft', () => {
    const form = build();
    const controller = FormDrafts.attach(form, options({ recordId: 'new', pendingExists: id => id === 'F-PENDING' }));
    input(form, 'name', 'New Factory');
    form.dataset.pendingRecordId = 'F-PENDING';
    FormDrafts.persist(form);
    expect(FormDrafts.pendingFor('factoryForm', options({ recordId: 'new' }))).toBe('F-PENDING');
    expect(
        FormDrafts.pendingFor('factoryForm', options({ recordId: 'new', scope: { ...scope, companyId: 'C2' } }))
    ).toBeNull();
    const afterFailure = build();
    FormDrafts.attach(afterFailure, options({ recordId: 'new', pendingExists: id => id === 'F-PENDING' }));
    expect(afterFailure.dataset.pendingRecordId).toBe('F-PENDING');
    expect(sessionStorage.getItem(controller.key)).not.toBeNull();
    FormDrafts.stageRecord(afterFailure);
    expect(FormDrafts.acknowledgeStaged(afterFailure)).toBe(true);
    expect(sessionStorage.getItem(controller.key)).toBeNull();
    const event = { preventDefault: jest.fn(), returnValue: null };
    expect(FormDrafts.protectUnload(event)).toBe(false);
});

test('a missing pending record requires an explicit decision before recreating it', () => {
    const form = build();
    FormDrafts.attach(form, options({ recordId: 'new' }));
    input(form, 'name', 'New Factory');
    form.dataset.pendingRecordId = 'F-PENDING';
    FormDrafts.persist(form);
    const restored = build();
    FormDrafts.attach(restored, options({ recordId: 'new', pendingExists: () => false }));
    expect(restored.dataset.pendingRecordId).toBeUndefined();
    expect(FormDrafts.canSubmit(restored)).toBe(false);
    const again = build();
    FormDrafts.attach(again, options({ recordId: 'new', pendingExists: () => false }));
    expect(FormDrafts.canSubmit(again)).toBe(false);
});

test('ordinary close preserves drafts, explicit cancel clears them, and dirty unload is guarded', () => {
    const form = build();
    const controller = FormDrafts.attach(form, options());
    input(form, 'name', 'Local Name');
    const event = { preventDefault: jest.fn(), returnValue: null };
    expect(FormDrafts.protectUnload(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe('');
    window.confirm.mockReturnValueOnce(false);
    expect(FormDrafts.leave(form)).toBe(false);
    expect(FormDrafts.leave(form)).toBe(true);
    expect(sessionStorage.getItem(controller.key)).not.toBeNull();
    const restored = build();
    FormDrafts.attach(restored, options());
    expect(FormDrafts.leave(restored, { discard: true })).toBe(true);
    expect(sessionStorage.getItem(controller.key)).toBeNull();
});

test('a browser storage failure is explicit and cannot silently discard dirty registered input', () => {
    const form = build();
    FormDrafts.attach(form, options());
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Storage unavailable');
    });
    input(form, 'name', 'Local Input');
    expect(form.querySelector('[data-draft-storage-error]').textContent).toContain('无法保存输入草稿');
    expect(FormDrafts.leave(form)).toBe(false);
    expect(form.elements.name.value).toBe('Local Input');
});

test('an ACK adopts the submitted base and assigned server values while retaining later input', () => {
    let record = { name: 'Original', phone: '00123', operationNo: 'UNASSIGNED' };
    const form = build();
    const controller = FormDrafts.attach(form, options({ getRecord: () => record }));
    input(form, 'name', 'Submitted');
    record = { ...record, name: 'Submitted' };
    FormDrafts.stageRecord(form);
    input(form, 'name', 'Typed While Saving');
    record = { ...record, operationNo: 'ACK-1' };
    expect(FormDrafts.acknowledgeStaged(form)).toBe(false);
    expect(FormDrafts.canSubmit(form)).toBe(true);
    const saved = JSON.parse(sessionStorage.getItem(controller.key));
    expect(saved.base.fields.name[0].value).toBe('Submitted');
    expect(saved.state.fields.name[0].value).toBe('Typed While Saving');
    expect(form.elements.name.value).toBe('Typed While Saving');
    // A second success can acknowledge only its own submitted input.
    expect(FormDrafts.acknowledgeStaged(form)).toBe(false);
    record = { ...record, name: 'Typed While Saving' };
    FormDrafts.stageRecord(form);
    expect(FormDrafts.acknowledgeStaged(form)).toBe(true);
    expect(sessionStorage.getItem(controller.key)).toBeNull();
});

test('a non-staged acknowledgement cannot erase dynamic input or a retained conflict', () => {
    const form = contactForm();
    const controller = FormDrafts.attach(form, options({ dynamic: dynamic(form) }));
    input(form, 'contact_phone_0', ' 000099 +86 ');
    expect(FormDrafts.acknowledgeStaged(form)).toBe(false);
    expect(sessionStorage.getItem(controller.key)).toContain(' 000099 +86 ');
    FormDrafts.stageRecord(form);
    renderContacts(form, [...FormDrafts.contactRows(form), { ...contacts[0], id: 'CONT-2', name: 'New Buyer' }]);
    expect(FormDrafts.acknowledgeStaged(form)).toBe(false);
    const saved = JSON.parse(sessionStorage.getItem(controller.key));
    expect(saved.base.dynamic).toHaveLength(1);
    expect(saved.state.dynamic).toHaveLength(2);
    expect(saved.state.dynamic[1].id).toBe('CONT-2');
    expect(FormDrafts.canSubmit(form)).toBe(true);
});

test('an old request ACK cannot delete a newly reopened form using the same draft key', () => {
    const original = build();
    const controller = FormDrafts.attach(original, options());
    input(original, 'name', 'Submitted');
    FormDrafts.stageRecord(original);
    const reopened = build();
    FormDrafts.attach(reopened, options());
    input(reopened, 'name', 'Input in Reopened Form');
    expect(FormDrafts.acknowledgeStaged(original, { allowDetached: true })).toBe(false);
    const saved = JSON.parse(sessionStorage.getItem(controller.key));
    expect(saved.base.fields.name[0].value).toBe('Submitted');
    expect(saved.state.fields.name[0].value).toBe('Input in Reopened Form');
    expect(reopened.elements.name.value).toBe('Input in Reopened Form');
});

test('explicit merge ACK can clear a detached original only while its staged draft remains latest', () => {
    const original = build();
    const controller = FormDrafts.attach(original, options());
    input(original, 'name', 'Submitted');
    FormDrafts.stageRecord(original);
    original.remove();
    expect(FormDrafts.acknowledgeStaged(original, { allowDetached: true })).toBe(true);
    expect(sessionStorage.getItem(controller.key)).toBeNull();

    const later = build();
    const laterController = FormDrafts.attach(later, options());
    input(later, 'name', 'Submitted Again');
    FormDrafts.stageRecord(later);
    input(later, 'name', 'Later Input');
    later.remove();
    expect(FormDrafts.acknowledgeStaged(later, { allowDetached: true })).toBe(false);
    const saved = JSON.parse(sessionStorage.getItem(laterController.key));
    expect(saved.base.fields.name[0].value).toBe('Submitted Again');
    expect(saved.state.fields.name[0].value).toBe('Later Input');
});

test('unregistered order forms get close/unload protection without pretending to persist dynamic factories', () => {
    const app = {
        showModal: jest.fn((title, html) => {
            document.body.innerHTML = `<div id="modalContainer">${html}</div>`;
        }),
        closeModal: jest.fn(() => {
            document.getElementById('modalContainer').innerHTML = '';
        })
    };
    installBusinessModalHooks(app, FormDrafts);
    app.showModal('Order', '<form id="orderForm"><input name="customerOrderNo" value="Original"></form>');
    input(document.getElementById('orderForm'), 'customerOrderNo', 'Changed');
    window.confirm.mockReturnValueOnce(false);
    app.closeModal();
    expect(document.getElementById('orderForm')).not.toBeNull();
    expect(app.closeModal).not.toHaveBeenCalled();
    const event = { preventDefault: jest.fn() };
    expect(FormDrafts.protectUnload(event)).toBe(true);
    expect(sessionStorage.length).toBe(0);
});

test('dynamic sanitizers and static field policy remove revoked amounts from base, state and retained drafts', () => {
    let financial = true;
    let rows = [{ draftId: 'ROW-1', factoryId: 'F1', quantity: '10', amount: '700' }];
    const adapter = {
        capture: () => rows,
        sanitize: values =>
            values.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => financial || key !== 'amount'))),
        restore: values => {
            rows = values;
        }
    };
    const form = build({ id: 'orderForm', bank: 'Original Bank' });
    const controller = FormDrafts.attach(
        form,
        options({ dynamic: adapter, allowField: input => financial || input.name !== 'bankInfo' })
    );
    rows = [{ ...rows[0], quantity: '11', amount: '800' }];
    input(form, 'bankInfo', 'Private Bank Draft');
    controller.retained.dynamic = rows;
    financial = false;
    FormDrafts.persist(form);
    const entry = sessionStorage.getItem(controller.key);
    expect(entry).not.toContain('"amount"');
    expect(entry).not.toContain('Private Bank Draft');
    expect(entry).not.toContain('Original Bank');
    const saved = JSON.parse(entry);
    expect(saved.state.dynamic[0].quantity).toBe('11');
    expect(saved.retained.dynamic[0]).not.toHaveProperty('amount');
});

test('dynamic validation checks newly selected references again at submission time', () => {
    const available = new Set(['F1', 'F2']);
    const form = build({ id: 'orderForm' });
    form.insertAdjacentHTML('beforeend', '<div data-draft-dynamic><input name="factoryId" value="F1"></div>');
    const adapter = {
        capture: () => [{ factoryId: form.elements.factoryId.value }],
        restore: values => {
            form.elements.factoryId.value = values[0].factoryId;
        },
        validate: values => (values.every(row => available.has(row.factoryId)) ? '' : '工厂已不可用，请重新选择')
    };
    const controller = FormDrafts.attach(form, options({ dynamic: adapter }));
    input(form, 'factoryId', 'F2');
    available.delete('F2');
    expect(FormDrafts.canSubmit(form)).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(controller.key)).retained.dynamicReason).toContain('工厂已不可用');
    form.querySelector('[data-form-draft-notice] button').click();
    expect(FormDrafts.canSubmit(form)).toBe(false);
    input(form, 'factoryId', 'F1');
    expect(FormDrafts.canSubmit(form)).toBe(true);
});

test('dynamic equality can ignore UI-only IDs while restoring the original draft identity', () => {
    let rows = [{ draftId: 'INITIAL', factoryId: 'F1', quantity: '10' }];
    const adapter = {
        capture: () => rows,
        restore: values => {
            rows = values;
        },
        equal: (a, b) =>
            JSON.stringify(a.map(({ draftId, ...data }) => data)) ===
            JSON.stringify(b.map(({ draftId, ...data }) => data))
    };
    const form = build({ id: 'orderForm' });
    FormDrafts.attach(form, options({ recordId: 'new', dynamic: adapter, pendingExists: () => true }));
    rows = [{ draftId: 'STABLE-LOCAL', factoryId: 'F1', quantity: '20' }];
    form.dataset.pendingRecordId = 'ORDER-PENDING';
    FormDrafts.persist(form);
    const reopened = build({ id: 'orderForm' });
    rows = [{ draftId: 'NEW-UI-ID', factoryId: 'F1', quantity: '20' }];
    FormDrafts.attach(reopened, options({ recordId: 'new', dynamic: adapter, pendingExists: () => true }));
    expect(rows[0].draftId).toBe('STABLE-LOCAL');
    expect(FormDrafts.canSubmit(reopened)).toBe(true);
    expect(reopened.dataset.pendingRecordId).toBe('ORDER-PENDING');
});

test('dismiss on login preserves the prior user draft without leaving private form listeners active', () => {
    let current = { ...scope };
    const form = build();
    const controller = FormDrafts.attach(form, options({ getScope: () => current }));
    input(form, 'name', 'Old User Draft');
    const before = sessionStorage.getItem(controller.key);
    current = { ...scope, userId: 'NEW-USER' };
    expect(FormDrafts.dismissAll()).toBe(true);
    expect(sessionStorage.getItem(controller.key)).toBe(before);
    const event = { preventDefault: jest.fn() };
    expect(FormDrafts.protectUnload(event)).toBe(false);
});
