import { jest } from '@jest/globals';
import { workspaceDraftKey } from '../js/api-client.js';

const user = { id: 'U1', tenantId: 'tenant-a', role: 'admin' };
const cloud = {
    saveData: jest.fn(),
    loadData: jest.fn(),
    getLastMeta: () => ({ version: 2 }),
    checkRemoteVersion: jest.fn(),
    _drainQueue: async () => {},
    _saveQueue: []
};
const exchange = {
    isDomestic: () => true,
    calcOrderProfit: () => 0,
    fetchRate: jest.fn(async () => ({ success: false, error: '测试环境未配置实时汇率' })),
    startAutoRefresh: jest.fn()
};
const auth = { currentUser: user, users: [], getVisibleCompanyIds: () => null };
jest.unstable_mockModule('../js/cloud.js', () => ({ Cloud: cloud }));
jest.unstable_mockModule('../js/auth.js', () => ({ Auth: auth }));
jest.unstable_mockModule('../js/exchange.js', () => ({ Exchange: exchange }));
jest.unstable_mockModule('../js/app.js', () => ({
    App: { updateSaveStatus() {}, updateCloudStatus() {}, updateExchangeRateDisplay() {}, router: jest.fn() }
}));
jest.unstable_mockModule('../js/utils.js', () => ({ toast() {}, handleError() {}, escapeHtml: String, validate: {} }));
const { DB } = await import('../js/data.js');
const clone = value => JSON.parse(JSON.stringify(value));
const initial = () => ({
    customers: [],
    orders: [{ id: 'O1', notes: 'old' }],
    factories: [],
    shipments: [],
    invoices: []
});

beforeEach(() => {
    document.body.innerHTML = '<div id="modalContainer"></div>';
    localStorage.clear();
    DB._BACKUP_KEY = 'test-tenant-actor-draft';
    DB._saveConflict = false;
    DB._draftBaseVersion = undefined;
    DB._draftSequence = 0;
    DB._businessAPI = { hasChanges: () => true, bindWorkingData: jest.fn() };
    DB._cloudVersion = 1;
    DB._cloudReady = true;
    DB._startPolling = jest.fn();
    DB.data = initial();
    DB.exchangeRates = {};
    DB.rateMetas = {};
    cloud.saveData.mockReset();
    cloud.loadData.mockReset();
    cloud.checkRemoteVersion.mockReset();
});

test('an open form holds the current version even before its inputs become DB changes', async () => {
    DB._businessAPI.hasChanges = () => false;
    document.getElementById('modalContainer').innerHTML = '<div class="modal-overlay"><form></form></div>';
    await DB._checkRemoteUpdates();
    expect(cloud.checkRemoteVersion).not.toHaveBeenCalled();
    expect((await DB.refreshFromCloud()).ok).toBe(false);
    expect(DB._cloudVersion).toBe(1);
});

test('API polling accepts authorized deletion of the last record instead of reviving it', async () => {
    DB._businessAPI.hasChanges = () => false;
    DB._lastSaveTime = 0;
    DB._cloudUpdatedAt = 'old';
    cloud.checkRemoteVersion.mockResolvedValue({ version: 2, updatedAt: 'new' });
    cloud.loadData.mockResolvedValue({
        data: { customers: [], orders: [], factories: [], shipments: [], invoices: [] },
        exchangeRates: {},
        rateMetas: {},
        meta: { version: 2, updatedAt: 'new' }
    });
    await DB._checkRemoteUpdates();
    expect(DB.data.orders).toEqual([]);
    expect(DB._cloudVersion).toBe(2);
    expect(DB._businessAPI.bindWorkingData).toHaveBeenCalled();
});

test('an old save ACK cannot erase a newer draft', async () => {
    let resolve;
    cloud.saveData.mockImplementation(
        () =>
            new Promise(r => {
                resolve = r;
            })
    );
    DB._backupToLocal();
    const saving = DB._doCloudSave();
    DB.data.orders[0].notes = 'edited while request was running';
    DB._backupToLocal();
    const newer = localStorage.getItem(DB._BACKUP_KEY);
    resolve(true);
    expect(await saving).toBe(true);
    expect(localStorage.getItem(DB._BACKUP_KEY)).toBe(newer);
});

test('failed save leaves the only draft intact', async () => {
    DB._backupToLocal();
    const raw = localStorage.getItem(DB._BACKUP_KEY);
    cloud.saveData.mockResolvedValue(false);
    expect(await DB._doCloudSave()).toBe(false);
    expect(localStorage.getItem(DB._BACKUP_KEY)).toBe(raw);
});

test('conflict is retained and further saves/polling cannot overwrite it', async () => {
    cloud.saveData.mockRejectedValue(Object.assign(new Error('stale'), { code: 'CONFLICT' }));
    DB._backupToLocal();
    expect(await DB._doCloudSave()).toBe(false);
    expect(DB._saveConflict).toBe(true);
    expect(JSON.parse(localStorage.getItem(DB._BACKUP_KEY)).conflict).toBe(true);
    expect(await DB.flush()).toBe(false);
    await DB._checkRemoteUpdates();
    expect(cloud.saveData).toHaveBeenCalledTimes(1);
    expect(cloud.checkRemoteVersion).not.toHaveBeenCalled();
});

test('stale recovered draft remains stale across repeated reloads', async () => {
    DB.data.orders[0].notes = 'unsaved stale edit';
    DB._backupToLocal();
    cloud.loadData.mockResolvedValue({ data: initial(), exchangeRates: {}, rateMetas: {}, meta: { version: 2 } });
    await DB._initFromBusinessAPI();
    expect(DB._saveConflict).toBe(true);
    expect(DB.data.orders[0].notes).toBe('unsaved stale edit');
    expect(JSON.parse(localStorage.getItem(DB._BACKUP_KEY)).baseVersion).toBe(1);
    await DB._initFromBusinessAPI();
    expect(DB._saveConflict).toBe(true);
    expect(JSON.parse(localStorage.getItem(DB._BACKUP_KEY)).baseVersion).toBe(1);
    expect(cloud.saveData).not.toHaveBeenCalled();
});

test('another tenant or actor draft is never restored', async () => {
    localStorage.setItem(
        DB._BACKUP_KEY,
        JSON.stringify({
            tenantId: 'tenant-b',
            actorId: user.id,
            baseVersion: 1,
            data: { ...initial(), orders: [{ id: 'foreign' }] }
        })
    );
    cloud.loadData.mockResolvedValue({ data: initial(), exchangeRates: {}, rateMetas: {}, meta: { version: 1 } });
    await DB._initFromBusinessAPI();
    expect(DB.data.orders[0].id).toBe('O1');
});

test('API initialization preserves imported financial values instead of migrating on read', async () => {
    const data = initial();
    data.orders[0].profitRMB = 123.45;
    cloud.loadData.mockResolvedValue({ data: clone(data), exchangeRates: {}, rateMetas: {}, meta: { version: 1 } });
    await DB._initFromBusinessAPI();
    expect(DB.data.orders[0].profitRMB).toBe(123.45);
    expect(cloud.saveData).not.toHaveBeenCalled();
});

test('old SQLite drafts remain stored without being replayed into the native workspace', async () => {
    const authorization = encodeURIComponent(
        JSON.stringify([user.role, user.scope, user.permissions, user.visibleCompanyIds])
    );
    const oldKey = `trade_api_draft_v1:https://example.test:${user.tenantId}:${user.id}:${authorization}`;
    const oldDraft = JSON.stringify({
        tenantId: user.tenantId,
        actorId: user.id,
        baseVersion: 1,
        data: { ...initial(), orders: [{ id: 'old-backend-row' }] }
    });
    localStorage.setItem(oldKey, oldDraft);
    DB._BACKUP_KEY = workspaceDraftKey(
        { user, backendIdentity: 'tenant-a.site:new-native-instance' },
        'https://example.test'
    );
    cloud.loadData.mockResolvedValue({ data: initial(), exchangeRates: {}, rateMetas: {}, meta: { version: 1 } });
    await DB._initFromBusinessAPI();
    expect(DB.data.orders[0].id).toBe('O1');
    expect(DB._saveConflict).toBe(false);
    expect(localStorage.getItem(oldKey)).toBe(oldDraft);
    expect(cloud.saveData).not.toHaveBeenCalled();
});
