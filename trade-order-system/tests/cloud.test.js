/**
 * @file cloud.test.js
 * CloudBase adapter tests — pure logic methods (no SDK dependency)
 */
import { jest } from '@jest/globals';

// Mock auth.js
jest.unstable_mockModule('../js/auth.js', () => ({
    Auth: {
        currentUser: { id: 'U001', username: 'David', name: 'David' },
        users: [{ id: 'U001', username: 'David', name: 'David' }]
    }
}));

const { Cloud } = await import('../js/cloud.js');
const { CONSTANTS } = await import('../js/constants.js');
const { Auth } = await import('../js/auth.js');

describe('Cloud — _toInt', () => {
    test('converts number directly', () => {
        expect(Cloud._toInt(42)).toBe(42);
        expect(Cloud._toInt(0)).toBe(0);
        expect(Cloud._toInt(-1)).toBe(-1);
    });

    test('converts CloudBase integer object', () => {
        expect(Cloud._toInt({ $numberInt: '99' })).toBe(99);
        expect(Cloud._toInt({ $numberInt: '0' })).toBe(0);
    });

    test('converts string to int', () => {
        expect(Cloud._toInt('42')).toBe(42);
        expect(Cloud._toInt('0')).toBe(0);
    });

    test('returns 0 for non-numeric', () => {
        expect(Cloud._toInt('abc')).toBe(0);
        expect(Cloud._toInt(null)).toBe(0);
        expect(Cloud._toInt(undefined)).toBe(0);
        expect(Cloud._toInt({})).toBe(0);
    });

    test('handles empty CloudBase integer object', () => {
        expect(Cloud._toInt({ $numberInt: '' })).toBe(0);
    });
});

describe('Cloud — getStatus', () => {
    beforeEach(() => {
        Cloud._ready = true;
        Cloud._status = {
            sdkLoaded: true,
            authDone: true,
            dbReady: true,
            lastError: null,
            lastErrorTime: null
        };
        Cloud._lastMeta = { version: 5, updatedAt: '2025-01-15T10:00:00Z', updatedBy: 'David' };
    });

    test('returns status object with all fields', () => {
        const status = Cloud.getStatus();
        expect(status.ready).toBe(true);
        expect(status.sdkLoaded).toBe(true);
        expect(status.authDone).toBe(true);
        expect(status.dbReady).toBe(true);
        expect(status.envId).toBeDefined();
        expect(status.lastMeta.version).toBe(5);
    });

    test('reflects current ready state', () => {
        Cloud._ready = false;
        expect(Cloud.getStatus().ready).toBe(false);
    });

    test('returns lastError when set', () => {
        Cloud._status.lastError = 'Connection failed';
        Cloud._status.lastErrorTime = '2025-01-15T10:00:00Z';
        const status = Cloud.getStatus();
        expect(status.lastError).toBe('Connection failed');
        expect(status.lastErrorTime).toBeDefined();
    });
});

describe('Cloud — constants and config', () => {
    test('has correct environment configuration', () => {
        expect(Cloud.envId).toBeDefined();
        expect(Cloud.envId.length).toBeGreaterThan(0);
        expect(Cloud.region).toBe('ap-shanghai');
        expect(Cloud.COLLECTION).toBe('app_data');
        expect(Cloud.DATA_TYPE).toBe('gw_data');
    });
});

describe('Cloud — save queue state', () => {
    test('initial state is clean', () => {
        expect(Cloud._syncing).toBe(false);
        expect(Cloud._docId).toBeDefined(); // may be null initially
    });

    test('_lastMeta has correct structure', () => {
        expect(Cloud._lastMeta).toHaveProperty('version');
        expect(Cloud._lastMeta).toHaveProperty('updatedAt');
        expect(Cloud._lastMeta).toHaveProperty('updatedBy');
    });
});

describe('Cloud — CONSTANTS integration', () => {
    test('uses LOAD_RETRY_DELAY_MS', () => {
        expect(CONSTANTS.LOAD_RETRY_DELAY_MS).toBeGreaterThan(0);
    });
});

// ==================== State Management ====================
describe('Cloud — isReady / getLastMeta / resetSession', () => {
    const originalState = {};

    beforeAll(() => {
        originalState._ready = Cloud._ready;
        originalState._app = Cloud._app;
        originalState._db = Cloud._db;
        originalState._docId = Cloud._docId;
        originalState._lastMeta = { ...Cloud._lastMeta };
        originalState._status = { ...Cloud._status };
    });

    afterAll(() => {
        Cloud._ready = originalState._ready;
        Cloud._app = originalState._app;
        Cloud._db = originalState._db;
        Cloud._docId = originalState._docId;
        Cloud._lastMeta = originalState._lastMeta;
        Cloud._status = originalState._status;
    });

    test('isReady returns false when not initialized', () => {
        Cloud._ready = false;
        Cloud._app = null;
        Cloud._db = null;
        expect(Cloud.isReady()).toBe(false);
    });

    test('isReady returns false when only _ready is true but app/db are null', () => {
        Cloud._ready = true;
        Cloud._app = null;
        Cloud._db = null;
        expect(Cloud.isReady()).toBe(false);
    });

    test('isReady returns true when fully initialized', () => {
        Cloud._ready = true;
        Cloud._app = { database() {} };
        Cloud._db = { collection() {} };
        expect(Cloud.isReady()).toBe(true);
    });

    test('getLastMeta returns current meta snapshot', () => {
        Cloud._lastMeta = { version: 10, updatedAt: '2026-07-15T08:00:00Z', updatedBy: 'Nicole' };
        const meta = Cloud.getLastMeta();
        expect(meta.version).toBe(10);
        expect(meta.updatedBy).toBe('Nicole');
    });

    test('getLastMeta returns a reference (same object)', () => {
        const meta = Cloud.getLastMeta();
        expect(meta).toBe(Cloud._lastMeta);
    });

    test('resetSession clears all state', () => {
        Cloud._ready = true;
        Cloud._app = { database() {} };
        Cloud._db = { collection() {} };
        Cloud._docId = 'doc-123';
        Cloud._status.authDone = true;
        Cloud._lastMeta = { version: 99, updatedAt: '2026-01-01', updatedBy: 'test' };

        Cloud.resetSession();

        expect(Cloud._ready).toBe(false);
        expect(Cloud._app).toBeNull();
        expect(Cloud._db).toBeNull();
        expect(Cloud._docId).toBeNull();
        expect(Cloud._status.authDone).toBe(false);
        expect(Cloud._lastMeta.version).toBe(0);
        expect(Cloud._lastMeta.updatedAt).toBeNull();
        expect(Cloud._lastMeta.updatedBy).toBeNull();
    });
});

// ==================== Save Queue ====================
describe('Cloud — save queue configuration', () => {
    test('_saveRetryMax is 3', () => {
        expect(Cloud._saveRetryMax).toBe(3);
    });

    test('_saveRetryDelay is positive', () => {
        expect(Cloud._saveRetryDelay).toBeGreaterThan(0);
    });

    test('_saveQueue is an array', () => {
        expect(Array.isArray(Cloud._saveQueue)).toBe(true);
    });

    test('_saveRunning starts as false', () => {
        expect(Cloud._saveRunning).toBe(false);
    });
});

// ==================== _mergeMultipleDocs ====================
describe('Cloud — _mergeMultipleDocs', () => {
    const makeDoc = (payload, updatedAt) => ({
        _id: 'doc-' + (updatedAt || 'latest'),
        dataType: 'gw_data',
        payload,
        updatedAt: updatedAt || '2026-07-31T10:00:00Z',
        updatedBy: 'test',
        version: 1,
        active: true
    });

    test('returns empty structure for empty array', () => {
        const result = Cloud._mergeMultipleDocs([]);
        expect(result.customers).toEqual([]);
        expect(result.orders).toEqual([]);
        expect(result.shipments).toEqual([]);
        expect(result.invoices).toEqual([]);
        expect(result.factories).toEqual([]);
    });

    test('returns single doc data unchanged', () => {
        const doc = makeDoc({
            customers: [{ id: 'C1', company: 'Acme' }],
            orders: [{ id: 'O1', customerId: 'C1', orderAmountUSD: 100 }],
            factories: [{ id: 'F1', name: 'Factory A' }]
        });
        const result = Cloud._mergeMultipleDocs([doc]);
        expect(result.customers).toHaveLength(1);
        expect(result.customers[0].id).toBe('C1');
        expect(result.orders).toHaveLength(1);
        expect(result.factories).toHaveLength(1);
    });

    test('merges two docs — latest duplicate ID wins', () => {
        const older = makeDoc({
            customers: [{ id: 'C1', company: 'Old Name' }],
            orders: []
        }, '2026-07-30T10:00:00Z');

        const newer = makeDoc({
            customers: [{ id: 'C1', company: 'New Name' }],
            orders: [{ id: 'O1', customerId: 'C1', orderAmountUSD: 200 }]
        }, '2026-07-31T10:00:00Z');

        // newer first (descending order)
        const result = Cloud._mergeMultipleDocs([newer, older]);
        expect(result.customers).toHaveLength(1);
        expect(result.customers[0].company).toBe('New Name'); // newer wins
        expect(result.orders).toHaveLength(1);
        expect(result.orders[0].id).toBe('O1');
    });

    test('merges different entity IDs from different docs', () => {
        const docA = makeDoc({
            customers: [{ id: 'C1', company: 'Alpha' }],
            factories: [{ id: 'F1', name: 'Factory A' }]
        }, '2026-07-31T12:00:00Z');

        const docB = makeDoc({
            customers: [{ id: 'C2', company: 'Beta' }],
            factories: [{ id: 'F2', name: 'Factory B' }]
        }, '2026-07-31T10:00:00Z');

        const result = Cloud._mergeMultipleDocs([docA, docB]);
        expect(result.customers).toHaveLength(2);
        expect(result.factories).toHaveLength(2);
        expect(result.customers.map(c => c.id).sort()).toEqual(['C1', 'C2']);
    });

    test('handles docs with missing payload gracefully', () => {
        const docA = makeDoc({
            customers: [{ id: 'C1', company: 'Alpha' }]
        });
        const docB = { _id: 'broken', dataType: 'gw_data', updatedAt: '2026-07-31T08:00:00Z' }; // no payload

        const result = Cloud._mergeMultipleDocs([docA, docB]);
        expect(result.customers).toHaveLength(1);
        expect(result.customers[0].id).toBe('C1');
    });

    test('handles docs with empty payload objects', () => {
        const docA = makeDoc({});
        const docB = makeDoc({ customers: [], orders: [] });
        const result = Cloud._mergeMultipleDocs([docA, docB]);
        expect(result.customers).toEqual([]);
        expect(result.orders).toEqual([]);
    });

    test('merges shipments and invoices across docs', () => {
        const docA = makeDoc({
            shipments: [{ id: 'SHP-0001', orderId: 'O1', status: '已出运' }]
        }, '2026-07-31T12:00:00Z');

        const docB = makeDoc({
            invoices: [{ id: 'DOC-0001-PI', orderId: 'O1', docType: 'PI' }]
        }, '2026-07-31T10:00:00Z');

        const result = Cloud._mergeMultipleDocs([docA, docB]);
        expect(result.shipments).toHaveLength(1);
        expect(result.invoices).toHaveLength(1);
    });

    // ---------- Contacts merging (critical for v34 multi-user fix) ----------
    test('merges customer contacts across documents', () => {
        // David adds Amanda to C1, Nicole later saves C1 without Amanda
        const davidDoc = makeDoc({
            customers: [{
                id: 'C001',
                company: 'Lifetime Brands, Inc',
                contacts: [
                    { name: 'Amanda Wang', position: 'Manager', phone: '', email: 'amanda@example.com' }
                ]
            }]
        }, '2026-07-31T09:00:00Z');

        const nicoleDoc = makeDoc({
            customers: [{
                id: 'C001',
                company: 'Lifetime Brands, Inc',
                contacts: [
                    { name: 'Bob Smith', position: 'Director', phone: '', email: 'bob@example.com' },
                    { name: 'Carol Lee', position: 'VP', phone: '', email: 'carol@example.com' }
                ]
            }]
        }, '2026-07-31T12:00:00Z');

        const result = Cloud._mergeMultipleDocs([nicoleDoc, davidDoc]);
        expect(result.customers).toHaveLength(1);
        const customer = result.customers[0];
        // Should have all 3 contacts: Bob, Carol (from Nicole) + Amanda (from David)
        expect(customer.contacts).toHaveLength(3);
        const names = customer.contacts.map(c => c.name).sort();
        expect(names).toEqual(['Amanda Wang', 'Bob Smith', 'Carol Lee']);
    });

    test('contacts dedup by composite key (name+position+phone+email)', () => {
        const contact = { name: 'John Doe', position: 'CEO', phone: '123456', email: 'john@example.com' };

        const docA = makeDoc({
            customers: [{
                id: 'C001', company: 'TestCo',
                contacts: [{ ...contact }]
            }]
        }, '2026-07-31T10:00:00Z');

        const docB = makeDoc({
            customers: [{
                id: 'C001', company: 'TestCo',
                contacts: [{ ...contact }] // same contact in different doc
            }]
        }, '2026-07-31T12:00:00Z');

        const result = Cloud._mergeMultipleDocs([docB, docA]);
        expect(result.customers[0].contacts).toHaveLength(1); // deduped!
    });

    test('contacts with different composite keys are kept separate', () => {
        const docA = makeDoc({
            customers: [{
                id: 'C001', company: 'TestCo',
                contacts: [
                    { name: 'John Doe', position: 'CEO', phone: '111', email: 'j@t.com' }
                ]
            }]
        }, '2026-07-31T10:00:00Z');

        const docB = makeDoc({
            customers: [{
                id: 'C001', company: 'TestCo',
                contacts: [
                    { name: 'John Doe', position: 'CTO', phone: '222', email: 'j2@t.com' }
                    // Same name but different position/phone — different key!
                ]
            }]
        }, '2026-07-31T12:00:00Z');

        const result = Cloud._mergeMultipleDocs([docB, docA]);
        expect(result.customers[0].contacts).toHaveLength(2);
    });

    test('unknown contacts get _unknown_N fallback key', () => {
        const doc = makeDoc({
            customers: [{
                id: 'C001', company: 'TestCo',
                contacts: [
                    { name: '', position: '', phone: '', email: '' }
                ]
            }]
        }, '2026-07-31T10:00:00Z');

        const result = Cloud._mergeMultipleDocs([doc]);
        // The empty contact should have been stored with key '_unknown_0'
        expect(result.customers[0].contacts).toHaveLength(1);
    });

    test('identical empty contacts are deduplicated (same composite key)', () => {
        const doc = makeDoc({
            customers: [{
                id: 'C001', company: 'TestCo',
                contacts: [
                    { name: '', position: '', phone: '', email: '' },
                    { name: '', position: '', phone: '', email: '' }
                ]
            }]
        }, '2026-07-31T10:00:00Z');

        const result = Cloud._mergeMultipleDocs([doc]);
        // Both contacts have same composite key '|||' → _unknown_0, so dedup → 1
        expect(result.customers[0].contacts).toHaveLength(1);
    });

    test('contacts merge does not lose existing contacts from latest doc', () => {
        // Latest doc has 4 contacts, earlier doc has 1 different contact
        const latest = makeDoc({
            customers: [{
                id: 'C001', company: 'TestCo',
                contacts: [
                    { name: 'A', position: 'P1', phone: '', email: '' },
                    { name: 'B', position: 'P2', phone: '', email: '' },
                    { name: 'C', position: 'P3', phone: '', email: '' },
                    { name: 'D', position: 'P4', phone: '', email: '' }
                ]
            }]
        }, '2026-07-31T12:00:00Z');

        const older = makeDoc({
            customers: [{
                id: 'C001', company: 'TestCo',
                contacts: [
                    { name: 'E', position: 'P5', phone: '', email: '' }
                ]
            }]
        }, '2026-07-31T10:00:00Z');

        const result = Cloud._mergeMultipleDocs([latest, older]);
        expect(result.customers[0].contacts).toHaveLength(5);
        expect(result.customers[0].contacts.map(c => c.name).sort())
            .toEqual(['A', 'B', 'C', 'D', 'E']);
    });

    test('handles customers with no contacts array', () => {
        const doc = makeDoc({
            customers: [{ id: 'C1', company: 'NoContacts' }]
        });
        const result = Cloud._mergeMultipleDocs([doc]);
        expect(result.customers).toHaveLength(1);
        expect(result.customers[0].company).toBe('NoContacts');
    });

    test('handles customers with contacts that are not arrays', () => {
        const doc = makeDoc({
            customers: [{ id: 'C1', company: 'BadContacts', contacts: 'not-an-array' }]
        });
        // Should not crash
        const result = Cloud._mergeMultipleDocs([doc]);
        expect(result.customers).toHaveLength(1);
    });

    test('items without id are ignored', () => {
        const doc = makeDoc({
            customers: [
                { company: 'No ID' },           // no id → skipped
                { id: 'C1', company: 'Has ID' }  // has id → kept
            ]
        });
        const result = Cloud._mergeMultipleDocs([doc]);
        expect(result.customers).toHaveLength(1);
        expect(result.customers[0].id).toBe('C1');
    });

    test('items with same id across different docs — latest wins the full object', () => {
        const older = makeDoc({
            factories: [{ id: 'F1', name: 'Old Factory', contact: 'Old Person', phone: '000' }]
        }, '2026-07-30T08:00:00Z');

        const newer = makeDoc({
            factories: [{ id: 'F1', name: 'New Factory', contact: 'New Person', phone: '111' }]
        }, '2026-07-31T08:00:00Z');

        const result = Cloud._mergeMultipleDocs([newer, older]);
        expect(result.factories).toHaveLength(1);
        expect(result.factories[0].name).toBe('New Factory');
        expect(result.factories[0].phone).toBe('111');
    });

    test('complex scenario — 3 docs merge with overlapping data', () => {
        const doc1 = makeDoc({
            customers: [
                { id: 'C1', company: 'Alpha', contacts: [{ name: 'Alice', position: '', phone: '', email: '' }] },
                { id: 'C2', company: 'Beta', contacts: [] }
            ],
            orders: [{ id: 'O1', customerId: 'C1' }],
            factories: [{ id: 'F1', name: 'Factory 1' }]
        }, '2026-07-31T14:00:00Z');

        const doc2 = makeDoc({
            customers: [
                { id: 'C2', company: 'Beta Updated', contacts: [{ name: 'Bob', position: '', phone: '', email: '' }] },
                { id: 'C3', company: 'Gamma', contacts: [{ name: 'Charlie', position: '', phone: '', email: '' }] }
            ],
            orders: [{ id: 'O2', customerId: 'C2' }],
            factories: [{ id: 'F2', name: 'Factory 2' }]
        }, '2026-07-31T12:00:00Z');

        const doc3 = makeDoc({
            customers: [
                { id: 'C1', company: 'Alpha Old', contacts: [{ name: 'Zoe', position: '', phone: '', email: '' }] },
                { id: 'C4', company: 'Delta', contacts: [] }
            ],
            orders: [{ id: 'O3', customerId: 'C4' }]
        }, '2026-07-31T10:00:00Z');

        const result = Cloud._mergeMultipleDocs([doc1, doc2, doc3]);

        // Customers: C1 (from doc1, contacts merged with Zoe from doc3), C2 (from doc1), C3 (from doc2), C4 (from doc3)
        expect(result.customers).toHaveLength(4);
        expect(result.customers.map(c => c.id).sort()).toEqual(['C1', 'C2', 'C3', 'C4']);
        expect(result.customers.find(c => c.id === 'C1').company).toBe('Alpha'); // doc1 is latest for C1
        expect(result.customers.find(c => c.id === 'C2').company).toBe('Beta'); // doc1 (14:00) is latest, seen first

        // Orders: O1 (doc1), O2 (doc2), O3 (doc3)
        expect(result.orders).toHaveLength(3);

        // Factories: F1 (doc1), F2 (doc2)
        expect(result.factories).toHaveLength(2);

        // C1 contacts: Alice (doc1) + Zoe (doc3) = 2 contacts
        const c1 = result.customers.find(c => c.id === 'C1');
        expect(c1.contacts).toHaveLength(2);
        expect(c1.contacts.map(c => c.name).sort()).toEqual(['Alice', 'Zoe']);
    });

    test('all entity types merge simultaneously', () => {
        const doc = makeDoc({
            customers: [{ id: 'C1', company: 'Test' }],
            orders: [{ id: 'O1', customerId: 'C1' }],
            shipments: [{ id: 'SHP-0001', orderId: 'O1' }],
            invoices: [{ id: 'DOC-0001-PI', orderId: 'O1', docType: 'PI' }],
            factories: [{ id: 'F1', name: 'Factory' }]
        });
        const result = Cloud._mergeMultipleDocs([doc]);
        expect(result.customers).toHaveLength(1);
        expect(result.orders).toHaveLength(1);
        expect(result.shipments).toHaveLength(1);
        expect(result.invoices).toHaveLength(1);
        expect(result.factories).toHaveLength(1);
    });
});

// ==================== Delete-wins Strategy ====================
describe('Cloud — _mergeMultipleDocs delete-wins', () => {
    const makeDoc = (payload, updatedAt) => ({
        _id: 'doc-' + (updatedAt || 'latest'),
        dataType: 'gw_data',
        payload,
        updatedAt: updatedAt || '2026-07-31T10:00:00Z',
        updatedBy: 'test',
        version: 1,
        active: true
    });

    test('deleted item in older doc stays deleted in merge', () => {
        const oldDoc = makeDoc({
            customers: [{ id: 'C1', company: 'Old', deleted: true, deletedAt: '2026-07-30T10:00:00Z' }]
        }, '2026-07-30T10:00:00Z');

        const newDoc = makeDoc({
            customers: [{ id: 'C1', company: 'New' }] // no deleted flag
        }, '2026-07-31T10:00:00Z');

        const result = Cloud._mergeMultipleDocs([newDoc, oldDoc]);
        expect(result.customers).toHaveLength(1);
        expect(result.customers[0].deleted).toBe(true);
    });

    test('deleted item in newer doc stays deleted', () => {
        const oldDoc = makeDoc({
            customers: [{ id: 'C1', company: 'Old' }]
        }, '2026-07-30T10:00:00Z');

        const newDoc = makeDoc({
            customers: [{ id: 'C1', company: 'New', deleted: true, deletedAt: '2026-07-31T10:00:00Z' }]
        }, '2026-07-31T10:00:00Z');

        const result = Cloud._mergeMultipleDocs([newDoc, oldDoc]);
        expect(result.customers).toHaveLength(1);
        expect(result.customers[0].deleted).toBe(true);
    });

    test('non-deleted item in both docs is not marked deleted', () => {
        const doc1 = makeDoc({
            customers: [{ id: 'C1', company: 'A' }]
        }, '2026-07-31T12:00:00Z');
        const doc2 = makeDoc({
            customers: [{ id: 'C1', company: 'B' }]
        }, '2026-07-31T10:00:00Z');

        const result = Cloud._mergeMultipleDocs([doc1, doc2]);
        expect(result.customers[0].deleted).toBeUndefined();
    });

    test('delete-wins applies to all entity types', () => {
        const oldDoc = makeDoc({
            orders: [{ id: 'O1', deleted: true, deletedAt: '2026-07-30T10:00:00Z' }],
            factories: [{ id: 'F1', deleted: true, deletedAt: '2026-07-30T10:00:00Z' }],
            shipments: [{ id: 'S1', deleted: true, deletedAt: '2026-07-30T10:00:00Z' }],
            invoices: [{ id: 'I1', deleted: true, deletedAt: '2026-07-30T10:00:00Z' }]
        }, '2026-07-30T10:00:00Z');

        const newDoc = makeDoc({
            orders: [{ id: 'O1' }],
            factories: [{ id: 'F1' }],
            shipments: [{ id: 'S1' }],
            invoices: [{ id: 'I1' }]
        }, '2026-07-31T10:00:00Z');

        const result = Cloud._mergeMultipleDocs([newDoc, oldDoc]);
        expect(result.orders[0].deleted).toBe(true);
        expect(result.factories[0].deleted).toBe(true);
        expect(result.shipments[0].deleted).toBe(true);
        expect(result.invoices[0].deleted).toBe(true);
    });
});

// ==================== Login Type Helpers ====================
describe('Cloud — getLoginType / isCustomLogin', () => {
    afterEach(() => {
        Cloud._loginType = 'none';
    });

    test('getLoginType returns current login type', () => {
        Cloud._loginType = 'anonymous';
        expect(Cloud.getLoginType()).toBe('anonymous');
    });

    test('getLoginType returns custom', () => {
        Cloud._loginType = 'custom';
        expect(Cloud.getLoginType()).toBe('custom');
    });

    test('isCustomLogin returns true for custom', () => {
        Cloud._loginType = 'custom';
        expect(Cloud.isCustomLogin()).toBe(true);
    });

    test('isCustomLogin returns false for anonymous', () => {
        Cloud._loginType = 'anonymous';
        expect(Cloud.isCustomLogin()).toBe(false);
    });

    test('isCustomLogin returns false for none', () => {
        Cloud._loginType = 'none';
        expect(Cloud.isCustomLogin()).toBe(false);
    });
});

// ==================== _ensureSDK ====================
describe('Cloud — _ensureSDK', () => {
    afterEach(() => {
        Cloud._app = null;
        Cloud._db = null;
        Cloud._status.sdkLoaded = false;
        delete global.cloudbase;
        delete global.tcb;
    });

    test('throws when SDK is not loaded', () => {
        Cloud._app = null;
        expect(() => Cloud._ensureSDK()).toThrow('SDK 未加载');
        expect(Cloud._status.lastError).toContain('SDK 未加载');
    });

    test('initializes app from global cloudbase', () => {
        const mockDb = { collection: () => {} };
        global.cloudbase = {
            init: jest.fn(() => ({ database: () => mockDb }))
        };
        Cloud._app = null;
        Cloud._ensureSDK();
        expect(Cloud._app).toBeTruthy();
        expect(Cloud._db).toBe(mockDb);
        expect(Cloud._status.sdkLoaded).toBe(true);
    });

    test('uses tcb as fallback when cloudbase is not available', () => {
        const mockDb = { collection: () => {} };
        global.tcb = {
            init: jest.fn(() => ({ database: () => mockDb }))
        };
        Cloud._app = null;
        Cloud._ensureSDK();
        expect(Cloud._app).toBeTruthy();
        expect(Cloud._db).toBe(mockDb);
    });

    test('does not re-initialize if _app already set', () => {
        const existing = { database: () => ({}) };
        Cloud._app = existing;
        global.cloudbase = { init: jest.fn() };
        Cloud._ensureSDK();
        expect(global.cloudbase.init).not.toHaveBeenCalled();
        expect(Cloud._app).toBe(existing);
    });
});

// ==================== _tryCustomLogin ====================
describe('Cloud — _tryCustomLogin', () => {
    const originalConfig = { CLOUD_FN_URL: '', CLOUD_SECRET: '' };

    beforeEach(() => {
        Cloud._customLoginTried = false;
        Cloud.CLOUD_FN_URL = '';
        Cloud.CLOUD_SECRET = '';
        Cloud._app = { auth: () => ({}) };
    });

    afterEach(() => {
        Cloud.CLOUD_FN_URL = originalConfig.CLOUD_FN_URL;
        Cloud.CLOUD_SECRET = originalConfig.CLOUD_SECRET;
        Cloud._customLoginTried = false;
        Cloud._app = null;
    });

    test('skips when CLOUD_FN_URL and CLOUD_SECRET not configured', async () => {
        const result = await Cloud._tryCustomLogin();
        expect(result.ok).toBe(false);
        expect(result.skipped).toBe(true);
    });

    test('skips when user not logged in', async () => {
        Cloud.CLOUD_SECRET = 'secret123';
        // Temporarily null out currentUser
        const origUser = Auth.currentUser;
        Auth.currentUser = null;
        const result = await Cloud._tryCustomLogin();
        Auth.currentUser = origUser;
        expect(result.ok).toBe(false);
        expect(result.skipped).toBe(true);
    });

    test('sets _customLoginTried to true', async () => {
        await Cloud._tryCustomLogin();
        expect(Cloud._customLoginTried).toBe(true);
    });
});

// ==================== init ====================
describe('Cloud — init', () => {
    afterEach(() => {
        Cloud._ready = false;
        Cloud._app = null;
        Cloud._db = null;
        Cloud._loginType = 'none';
        Cloud._customLoginTried = false;
    });

    test('returns cached result when already initialized', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        Cloud._db = {};
        const result = await Cloud.init();
        expect(result.ok).toBe(true);
        expect(result.uid).toBe('cached');
    });

    test('returns error when SDK not loaded', async () => {
        Cloud._ready = false;
        Cloud._app = null;
        Cloud._customLoginTried = true; // skip custom login
        const result = await Cloud.init();
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('sdk_failed');
    });
});

// ==================== loadData ====================
describe('Cloud — loadData', () => {
    const mockColl = (docs) => ({
        where: () => ({
            orderBy: () => ({
                limit: () => ({
                    get: () => Promise.resolve({ data: docs })
                })
            })
        }),
        add: jest.fn(),
        doc: jest.fn()
    });

    afterEach(() => {
        Cloud._ready = false;
        Cloud._app = null;
        Cloud._db = null;
        Cloud._docId = null;
    });

    test('returns null when not ready', async () => {
        Cloud._ready = false;
        const result = await Cloud.loadData();
        expect(result).toBeNull();
    });

    test('returns null for empty collection', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        Cloud._db = {
            collection: () => mockColl([])
        };
        const result = await Cloud.loadData();
        expect(result).toBeNull();
    });

    test('loads and merges single doc', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        const doc = {
            _id: 'doc1',
            dataType: 'gw_data',
            payload: {
                customers: [{ id: 'C1', company: 'Test' }],
                orders: [],
                factories: []
            },
            updatedAt: '2026-07-31T10:00:00Z',
            updatedBy: 'David',
            version: 5,
            active: true
        };
        Cloud._db = { collection: () => mockColl([doc]) };
        const result = await Cloud.loadData();
        expect(result).toBeTruthy();
        expect(result.data.customers).toHaveLength(1);
        expect(result.meta.version).toBe(5);
        expect(result.meta.updatedBy).toBe('David');
        expect(Cloud._docId).toBe('doc1');
    });

    test('returns null when docs have no valid payload', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        const doc = { _id: 'x', dataType: 'gw_data', updatedAt: '2026-01-01', active: true };
        Cloud._db = { collection: () => mockColl([doc]) };
        const result = await Cloud.loadData();
        expect(result).toBeNull();
    });

    test('handles permission error', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        Cloud._db = {
            collection: () => {
                throw new Error('permission denied: 403');
            }
        };
        const result = await Cloud.loadData();
        expect(result).toBeNull();
        expect(Cloud._status.lastError).toContain('权限不足');
    });

    test('handles generic error', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        Cloud._db = {
            collection: () => {
                throw new Error('Something went wrong');
            }
        };
        const result = await Cloud.loadData();
        expect(result).toBeNull();
        expect(Cloud._status.lastError).toBe('Something went wrong');
    });
});

// ==================== checkRemoteVersion ====================
describe('Cloud — checkRemoteVersion', () => {
    afterEach(() => {
        Cloud._ready = false;
        Cloud._app = null;
        Cloud._db = null;
    });

    test('returns null when not ready', async () => {
        Cloud._ready = false;
        const result = await Cloud.checkRemoteVersion();
        expect(result).toBeNull();
    });

    test('returns version meta when doc exists', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        Cloud._db = {
            collection: () => ({
                where: () => ({
                    orderBy: () => ({
                        limit: () => ({
                            get: () => Promise.resolve({
                                data: [{
                                    _id: 'd1',
                                    dataType: 'gw_data',
                                    payload: { customers: [] },
                                    version: 42,
                                    updatedAt: '2026-07-31T10:00:00Z',
                                    updatedBy: 'Nicole'
                                }]
                            })
                        })
                    })
                })
            })
        };
        const result = await Cloud.checkRemoteVersion();
        expect(result).toBeTruthy();
        expect(result.version).toBe(42);
        expect(result.updatedBy).toBe('Nicole');
    });

    test('returns null when no docs found', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        Cloud._db = {
            collection: () => ({
                where: () => ({
                    orderBy: () => ({
                        limit: () => ({
                            get: () => Promise.resolve({ data: [] })
                        })
                    })
                })
            })
        };
        const result = await Cloud.checkRemoteVersion();
        expect(result).toBeNull();
    });

    test('returns null on error', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        Cloud._db = {
            collection: () => {
                throw new Error('Network error');
            }
        };
        const result = await Cloud.checkRemoteVersion();
        expect(result).toBeNull();
    });
});

// ==================== testPermission ====================
describe('Cloud — testPermission', () => {
    afterEach(() => {
        Cloud._ready = false;
        Cloud._app = null;
        Cloud._db = null;
    });

    test('returns not ok when not ready', async () => {
        Cloud._ready = false;
        const result = await Cloud.testPermission();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('未连接');
    });

    test('returns ok when write and delete succeed', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        const removeMock = jest.fn(() => Promise.resolve());
        Cloud._db = {
            collection: () => ({
                add: jest.fn(() => Promise.resolve({ id: 'test-doc-id' })),
                doc: () => ({ remove: removeMock })
            })
        };
        const result = await Cloud.testPermission();
        expect(result.ok).toBe(true);
        expect(removeMock).toHaveBeenCalled();
    });

    test('returns not ok when write returns no id', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        Cloud._db = {
            collection: () => ({
                add: jest.fn(() => Promise.resolve({}))
            })
        };
        const result = await Cloud.testPermission();
        expect(result.ok).toBe(false);
    });

    test('returns not ok on write error', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        Cloud._db = {
            collection: () => ({
                add: jest.fn(() => Promise.reject(new Error('Permission denied')))
            })
        };
        const result = await Cloud.testPermission();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('Permission denied');
    });
});

// ==================== saveData / _processQueue ====================
describe('Cloud — saveData / _processQueue', () => {
    const originalState = {};

    beforeEach(() => {
        originalState._saveQueue = Cloud._saveQueue.slice();
        originalState._saveRunning = Cloud._saveRunning;
        originalState._ready = Cloud._ready;
        originalState._app = Cloud._app;
        originalState._db = Cloud._db;
        originalState._lastMeta = { ...Cloud._lastMeta };
        Cloud._saveQueue = [];
        Cloud._saveRunning = false;
        Cloud._lastMeta = { version: 0, updatedAt: null, updatedBy: null };
    });

    afterEach(() => {
        Cloud._saveQueue = originalState._saveQueue;
        Cloud._saveRunning = originalState._saveRunning;
        Cloud._ready = originalState._ready;
        Cloud._app = originalState._app;
        Cloud._db = originalState._db;
        Cloud._lastMeta = originalState._lastMeta;
    });

    test('saveData returns a promise', () => {
        Cloud._ready = false; // will reject
        const p = Cloud.saveData({ customers: [] }, {}, {});
        expect(p).toBeInstanceOf(Promise);
        // Catch to avoid unhandled rejection
        p.catch(() => {});
    });

    test('_processQueue rejects all when not ready', async () => {
        Cloud._ready = false;
        Cloud._saveQueue = [
            { data: {}, resolve: jest.fn(), reject: jest.fn() },
            { data: {}, resolve: jest.fn(), reject: jest.fn() }
        ];
        await Cloud._processQueue();
        expect(Cloud._saveQueue).toHaveLength(0);
    });

    test('_processQueue does nothing when queue is empty and not running', async () => {
        Cloud._ready = true;
        Cloud._saveRunning = false;
        Cloud._saveQueue = [];
        await Cloud._processQueue();
        expect(Cloud._saveRunning).toBe(false);
    });

    test('_processQueue saves via append mode on success', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        const addMock = jest.fn(() => Promise.resolve({ id: 'new-doc-id' }));
        Cloud._db = {
            collection: () => ({
                add: addMock,
                where: () => ({
                    orderBy: () => ({
                        limit: () => ({ get: () => Promise.resolve({ data: [] }) })
                    })
                }),
                doc: () => ({ update: jest.fn(() => Promise.resolve()) })
            })
        };

        const resolveFn = jest.fn();
        const rejectFn = jest.fn();
        Cloud._saveQueue = [{
            data: { customers: [{ id: 'C1' }] },
            exchangeRatesData: { GR: 7.25 },
            rateMetasData: {},
            options: {},
            resolve: resolveFn,
            reject: rejectFn
        }];

        await Cloud._processQueue();

        expect(addMock).toHaveBeenCalled();
        const savedDoc = addMock.mock.calls[0][0];
        expect(savedDoc.active).toBe(true);
        expect(savedDoc.dataType).toBe('gw_data');
        expect(savedDoc.payload).toEqual({ customers: [{ id: 'C1' }] });
        expect(resolveFn).toHaveBeenCalledWith(true);
        expect(Cloud._docId).toBe('new-doc-id');
        expect(Cloud._lastMeta.version).toBe(1);
    });

    test('_processQueue merges multiple queued tasks', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        const addMock = jest.fn(() => Promise.resolve({ id: 'merged-doc' }));
        Cloud._db = {
            collection: () => ({
                add: addMock,
                where: () => ({ orderBy: () => ({ limit: () => ({ get: () => Promise.resolve({ data: [] }) }) }) }),
                doc: () => ({ update: jest.fn(() => Promise.resolve()) })
            })
        };

        const r1 = jest.fn(), r2 = jest.fn(), r3 = jest.fn();
        Cloud._saveQueue = [
            { data: { v: 1 }, resolve: r1, reject: jest.fn() },
            { data: { v: 2 }, resolve: r2, reject: jest.fn() },
            { data: { v: 3 }, resolve: r3, reject: jest.fn() }
        ];

        await Cloud._processQueue();

        // Only the last task's data should be saved
        expect(addMock).toHaveBeenCalledTimes(1);
        const savedDoc = addMock.mock.calls[0][0];
        expect(savedDoc.payload).toEqual({ v: 3 });
        // All tasks should be resolved
        expect(r1).toHaveBeenCalledWith(true);
        expect(r2).toHaveBeenCalledWith(true);
        expect(r3).toHaveBeenCalledWith(true);
    });

    test('_processQueue retries on failure then succeeds', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        let attempts = 0;
        const addMock = jest.fn(() => {
            attempts++;
            if (attempts < 3) return Promise.reject(new Error('Network error'));
            return Promise.resolve({ id: 'retry-success' });
        });
        Cloud._db = {
            collection: () => ({
                add: addMock,
                where: () => ({ orderBy: () => ({ limit: () => ({ get: () => Promise.resolve({ data: [] }) }) }) }),
                doc: () => ({ update: jest.fn(() => Promise.resolve()) })
            })
        };

        const resolveFn = jest.fn();
        const rejectFn = jest.fn();
        Cloud._saveQueue = [{
            data: { customers: [] },
            resolve: resolveFn,
            reject: rejectFn
        }];

        await Cloud._processQueue();

        expect(attempts).toBe(3);
        expect(resolveFn).toHaveBeenCalledWith(true);
    });

    test('_processQueue rejects after max retries', async () => {
        Cloud._ready = true;
        Cloud._app = {};
        const addMock = jest.fn(() => Promise.reject(new Error('Always fails')));
        Cloud._db = {
            collection: () => ({ add: addMock })
        };

        const resolveFn = jest.fn();
        const rejectFn = jest.fn();
        Cloud._saveQueue = [{
            data: { customers: [] },
            resolve: resolveFn,
            reject: rejectFn
        }];

        await Cloud._processQueue();

        expect(addMock).toHaveBeenCalledTimes(Cloud._saveRetryMax);
        expect(rejectFn).toHaveBeenCalled();
        expect(resolveFn).not.toHaveBeenCalled();
    });
});

// ==================== _drainQueue ====================
describe('Cloud — _drainQueue', () => {
    beforeEach(() => {
        Cloud._saveQueue = [];
        Cloud._saveRunning = false;
    });

    test('resolves immediately when queue is empty and not running', async () => {
        await Cloud._drainQueue();
        expect(Cloud._saveQueue).toHaveLength(0);
    });

    test('waits until queue is drained', async () => {
        Cloud._saveRunning = true;
        let drained = false;
        // Simulate save finishing after a short delay
        setTimeout(() => {
            Cloud._saveRunning = false;
            drained = true;
        }, 50);

        await Cloud._drainQueue();
        expect(drained).toBe(true);
    });
});

// ==================== _cleanupOldDocs ====================
describe('Cloud — _cleanupOldDocs', () => {
    beforeEach(() => {
        Cloud._cleaning = false;
        Cloud._ready = true;
        Cloud._app = {};
        Cloud._docId = 'current-doc';
    });

    afterEach(() => {
        Cloud._ready = false;
        Cloud._app = null;
        Cloud._db = null;
        Cloud._docId = null;
        Cloud._cleaning = false;
    });

    test('returns early when not ready', async () => {
        Cloud._ready = false;
        await Cloud._cleanupOldDocs();
        // No error thrown, just returns
    });

    test('skips when already cleaning', async () => {
        Cloud._cleaning = true;
        Cloud._db = { collection: () => ({ where: () => { throw new Error('should not reach'); } }) };
        await Cloud._cleanupOldDocs();
    });

    test('cleans up old active documents', async () => {
        const updateMock = jest.fn(() => Promise.resolve());
        const oldDocs = [
            { _id: 'old-1', dataType: 'gw_data' },
            { _id: 'old-2', dataType: 'gw_data' }
            // current-doc is excluded
        ];
        Cloud._db = {
            collection: () => ({
                where: () => ({
                    limit: () => ({
                        get: () => Promise.resolve({ data: oldDocs })
                    })
                }),
                doc: id => ({ update: updateMock })
            }),
            command: { lt: () => ({}) }
        };

        await Cloud._cleanupOldDocs();

        expect(updateMock).toHaveBeenCalledTimes(2);
    });

    test('does nothing when no old docs found', async () => {
        Cloud._db = {
            collection: () => ({
                where: () => ({
                    limit: () => ({
                        get: () => Promise.resolve({ data: [] })
                    })
                })
            }),
            command: { lt: () => ({}) }
        };

        await Cloud._cleanupOldDocs();
        // Should not throw, and _cleaning should be reset
        expect(Cloud._cleaning).toBe(false);
    });

    test('handles cleanup error gracefully', async () => {
        Cloud._db = {
            collection: () => {
                throw new Error('Database error');
            },
            command: { lt: () => ({}) }
        };

        await Cloud._cleanupOldDocs();
        expect(Cloud._cleaning).toBe(false);
    });

    test('handles individual doc update failure', async () => {
        const updateMock = jest.fn(() => Promise.reject(new Error('update failed')));
        Cloud._db = {
            collection: () => ({
                where: () => ({
                    limit: () => ({
                        get: () => Promise.resolve({ data: [{ _id: 'old-1' }] })
                    })
                }),
                doc: () => ({ update: updateMock })
            }),
            command: { lt: () => ({}) }
        };

        await Cloud._cleanupOldDocs();
        expect(Cloud._cleaning).toBe(false); // finally block resets
    });
});
