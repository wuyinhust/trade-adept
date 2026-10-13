import { jest } from '@jest/globals';
import { showContactConflicts } from '../js/contact-conflicts.js';
const preview = () => ({
    id: 1,
    baseVersion: 4,
    serverVersion: 5,
    customers: [
        {
            id: 'C1',
            name: '<img src=x onerror=alert(1)>',
            plan: {
                issues: [],
                proposal: [{ id: 'CT1', name: '<script>private</script>' }],
                conflicts: [
                    {
                        id: 'phone',
                        contactId: 'CT1',
                        kind: 'field-conflict',
                        field: 'phone',
                        local: { present: true, value: '00123' },
                        server: { present: true, value: '00999' }
                    }
                ]
            }
        }
    ]
});
let api, DB, App, drafts, onSaved;
beforeEach(() => {
    document.body.innerHTML = '<div id="modalContainer"></div>';
    localStorage.clear();
    DB = {
        _BACKUP_KEY: 'test-contact-draft',
        _draftBaseVersion: 4,
        _saveConflict: true,
        data: { customers: [{ id: 'C1', contacts: [{ id: 'CT1', phone: '00123' }] }] },
        _handleSaveFailure: jest.fn(),
        _clearLocalBackup: jest.fn()
    };
    api = {
        lastMeta: { version: 4 },
        prepareContactMerge: jest.fn(async () => preview()),
        applyContactMerge: jest.fn(async () => ({
            data: {
                customers: [
                    {
                        id: 'C1',
                        contacts: [
                            { id: 'CT1', phone: '00123' },
                            { id: 'CT2', name: 'New server person' }
                        ]
                    }
                ]
            },
            exchangeRates: {},
            rateMetas: {},
            meta: { version: 6 }
        })),
        bindWorkingData: jest.fn()
    };
    App = {
        closeModal: jest.fn(() => document.getElementById('modalContainer').replaceChildren()),
        showModal: jest.fn((title, body, options) => {
            document.getElementById('modalContainer').innerHTML = body + options.footer;
        }),
        toast: jest.fn(),
        updateSaveStatus: jest.fn(),
        router: jest.fn(async () => {})
    };
    drafts = { acknowledgeStaged: jest.fn(() => true) };
    onSaved = jest.fn();
});

test('renders escaped differences and sends only explicitly selected choices', async () => {
    localStorage.setItem(DB._BACKUP_KEY, 'original draft');
    expect(await showContactConflicts({ api, DB, App, drafts, onSaved })).toBe(true);
    expect(document.querySelector('#contactMergeReview img')).toBeNull();
    expect(document.querySelector('#contactMergeReview script')).toBeNull();
    document.querySelector('[data-contact-choice]').value = 'local';
    await document.getElementById('confirmContactMerge').onclick();
    expect(api.applyContactMerge).toHaveBeenCalledWith(1, { 'C1:phone': 'local' });
    expect(DB._saveConflict).toBe(false);
    expect(DB._cloudVersion).toBe(6);
    expect(DB.data.customers[0].contacts).toHaveLength(2);
    expect(DB._clearLocalBackup).toHaveBeenCalledWith('original draft');
    expect(onSaved).toHaveBeenCalledTimes(1);
});

test('failure keeps original working data and the review open', async () => {
    const before = DB.data;
    api.applyContactMerge.mockRejectedValue(new Error('服务器版本又已变化'));
    await showContactConflicts({ api, DB, App, drafts, onSaved });
    await document.getElementById('confirmContactMerge').onclick();
    expect(DB.data).toBe(before);
    expect(DB._saveConflict).toBe(true);
    expect(DB._clearLocalBackup).not.toHaveBeenCalled();
    expect(document.getElementById('contactMergeReview')).not.toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
});

test('invalid identities require manual review and cannot enable submit', async () => {
    const value = preview();
    value.customers[0].plan.issues.push({ message: '联系人缺少稳定编号' });
    api.prepareContactMerge.mockResolvedValue(value);
    await showContactConflicts({ api, DB, App, drafts, onSaved });
    expect(document.getElementById('confirmContactMerge').disabled).toBe(true);
    expect(document.getElementById('contactMergeReview').textContent).toContain('人工核对');
    expect(api.applyContactMerge).not.toHaveBeenCalled();
});

test('refusing to close an active input form avoids any remote read', async () => {
    App.closeModal.mockReturnValue(false);
    expect(await showContactConflicts({ api, DB, App, drafts, onSaved })).toBe(false);
    expect(api.prepareContactMerge).not.toHaveBeenCalled();
});

test('merged customer acknowledgement uses the guarded detached-form path', async () => {
    document.getElementById('modalContainer').innerHTML = '<form id="customerForm"></form>';
    const form = document.getElementById('customerForm');
    drafts.acknowledgeStaged.mockReturnValue(false);
    await showContactConflicts({ api, DB, App, drafts, onSaved });
    await document.getElementById('confirmContactMerge').onclick();
    expect(drafts.acknowledgeStaged).toHaveBeenCalledWith(form, { allowDetached: true });
    expect(form.isConnected).toBe(false);
});
