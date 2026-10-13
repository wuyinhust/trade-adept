/**
 * @file auth.test.js
 * Authentication module tests — full coverage
 */
import { jest } from '@jest/globals';

// Mock cloud.js
const mockCloud = {
    resetSession: jest.fn(),
    init() {
        return Promise.resolve({ ok: true, uid: 'mock' });
    },
    isReady() {
        return true;
    },
    loadData() {
        return Promise.resolve(null);
    },
    getLastMeta() {
        return { version: 0 };
    },
    saveData() {
        return Promise.resolve(true);
    },
    getStatus() {
        return { ready: true };
    },
    testPermission() {
        return Promise.resolve({ ok: true });
    },
    checkRemoteVersion() {
        return Promise.resolve(null);
    },
    _saveQueue: [],
    _saveRunning: false,
    COLLECTION: 'app_data',
    DATA_TYPE: 'gw_data',
    envId: 'mock',
    region: 'ap-shanghai',
    _lastMeta: { version: 0, updatedAt: null, updatedBy: null },
    _drainQueue() {
        return Promise.resolve();
    }
};

jest.unstable_mockModule('../js/cloud.js', () => ({
    Cloud: mockCloud
}));

// Override crypto before module import
import { createHash } from 'node:crypto';
const mockCrypto = {
    subtle: {
        async digest(algorithm, data) {
            const buf = Buffer.from(data);
            const hash = createHash('sha256').update(buf).digest();
            return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
        }
    },
    getRandomValues: arr => arr,
    randomUUID: () => '00000000-0000-0000-0000-000000000000'
};
Object.defineProperty(globalThis, 'crypto', {
    value: mockCrypto,
    writable: true,
    configurable: true
});

const { Auth } = await import('../js/auth.js');
const { DemoProfile } = await import('../js/demo-profile.js');
Auth.users = DemoProfile.users;
Auth.teams = DemoProfile.teams;

describe('server-authorized record deletion', () => {
    beforeEach(() => {
        Auth._serverDataAuthorized = true;
        Auth.roles = { operations: { readScopes: { factories: 'entities' } } };
        Auth.currentUser = {
            id: 7,
            tenantId: 'TENANT',
            role: 'operations',
            scope: 'self',
            teamId: 'TEAM',
            visibleCompanyIds: ['CO-A'],
            permissions: ['read', 'delete']
        };
        Auth.users = [
            { id: 'colleague', teamId: 'TEAM' },
            { id: 'outsider', teamId: 'OTHER' }
        ];
        Auth.historicalOwners = {};
    });
    afterEach(() => {
        Auth._serverDataAuthorized = false;
        Auth.currentUser = null;
        Auth.roles = {};
        Auth.users = DemoProfile.users;
        Auth.historicalOwners = {};
        Auth.teams = DemoProfile.teams;
    });

    test('shared reads do not permit deleting another owner, while String IDs recognize owned records', () => {
        const own = { tenantId: 'TENANT', companyId: 'CO-A', createdBy: '7' };
        expect(Auth.canDeleteRecord(own, 'customers')).toBe(true);
        expect(Auth.canDeleteRecord({ ...own, createdBy: 'colleague' }, 'factories')).toBe(false);
        expect(Auth.canDeleteRecord({ ...own, createdBy: null, ownerId: 7 }, 'factories')).toBe(true);
        expect(Auth.canDeleteOrder({ ...own, createdBy: null, salespersonId: '7' })).toBe(true);
    });

    test('tenant scope still needs delete, tenant identity and explicit company grants', () => {
        Auth.currentUser.scope = 'tenant';
        const visible = { tenantId: 'TENANT', companyId: 'CO-A', createdBy: 'outsider' };
        expect(Auth.canDeleteRecord(visible)).toBe(true);
        expect(Auth.canDeleteRecord({ ...visible, tenantId: 'OTHER' })).toBe(false);
        expect(Auth.canDeleteRecord({ ...visible, companyId: 'CO-B' })).toBe(false);
        expect(Auth.canDeleteRecord({ ...visible, companyId: null })).toBe(false);
        expect(Auth.canDeleteRecord({ ...visible, deleted: true })).toBe(false);
        Auth.currentUser.permissions = ['read'];
        expect(Auth.canDeleteRecord(visible)).toBe(false);
    });

    test('team scope follows the supplied member directory and refuses missing or invalid teams', () => {
        Auth.currentUser.scope = 'team';
        const record = { tenantId: 'TENANT', companyId: 'CO-A', createdBy: 'colleague' };
        expect(Auth.canDeleteRecord(record, 'customers')).toBe(true);
        Auth.teams = { TEAM: { memberIds: ['outsider'] } };
        expect(Auth.canDeleteRecord({ ...record, createdBy: 'outsider' }, 'customers')).toBe(false);
        Auth.currentUser.teamId = null;
        expect(Auth.canDeleteRecord(record)).toBe(false);
        Auth.currentUser.scope = 'entities';
        expect(Auth.canDeleteRecord(record)).toBe(false);
    });

    test('module restrictions are preserved even when the role has generic deletion permission', () => {
        Auth.roles.operations.collections = ['orders'];
        const own = { tenantId: 'TENANT', companyId: 'CO-A', createdBy: '7' };
        expect(Auth.canDeleteRecord(own)).toBe(true);
        expect(Auth.canDeleteRecord(own, 'customers')).toBe(false);
        expect(Auth.canDeleteRecord(own, 'factories')).toBe(false);
    });

    test('team managers can delete records of a stopped owner in the same historical team', () => {
        Auth.currentUser.scope = 'team';
        Auth.historicalOwners = { stopped: { teamId: 'TEAM' } };
        const record = { tenantId: 'TENANT', companyId: 'CO-A', createdBy: 'stopped' };
        expect(Auth.getRecordOwner('stopped')).toEqual({ id: 'stopped', teamId: 'TEAM' });
        expect(Auth.canDeleteRecord(record, 'customers')).toBe(true);
        expect(Auth.canDeleteRecord(record, 'factories')).toBe(true);
        expect(Auth.users.some(user => user.id === 'stopped')).toBe(false);
        Auth.currentUser = null;
        expect(Auth.canDeleteRecord(record)).toBe(false);
    });

    test('a historical display name never makes the stopped owner an active assignment candidate', () => {
        Auth.historicalOwners = {
            stopped: {
                teamId: 'TEAM',
                name: 'Historical colleague',
                username: 'private-login',
                email: 'private@example.invalid'
            }
        };
        expect(Auth.getRecordOwner('stopped')).toEqual({ id: 'stopped', teamId: 'TEAM', name: 'Historical colleague' });
        expect(Auth.users.some(user => user.id === 'stopped')).toBe(false);
    });

    test('historical owners in other teams and absent history cannot grant team deletion', () => {
        Auth.currentUser.scope = 'team';
        Auth.historicalOwners = { stopped: { teamId: 'OTHER' }, unassigned: {} };
        const record = { tenantId: 'TENANT', companyId: 'CO-A' };
        expect(Auth.canDeleteRecord({ ...record, createdBy: 'stopped' })).toBe(false);
        expect(Auth.canDeleteRecord({ ...record, ownerId: 'unassigned' })).toBe(false);
        expect(Auth.canDeleteRecord({ ...record, salespersonId: 'unknown' })).toBe(false);
        Auth.historicalOwners = {};
        expect(Auth.canDeleteRecord({ ...record, createdBy: 'stopped' })).toBe(false);
        Auth.historicalOwners = null;
        expect(Auth.canDeleteRecord({ ...record, createdBy: 'stopped' })).toBe(false);
    });

    test('active owners current teams take precedence over stale historical entries with String IDs', () => {
        Auth.currentUser.scope = 'team';
        Auth.users = [
            { id: 42, teamId: 'OTHER' },
            { id: '43', teamId: 'TEAM' }
        ];
        Auth.historicalOwners = { 42: { teamId: 'TEAM' }, 43: { teamId: 'OTHER' } };
        const record = { tenantId: 'TENANT', companyId: 'CO-A' };
        expect(Auth.getRecordOwner('42')).toBe(Auth.users[0]);
        expect(Auth.canDeleteRecord({ ...record, createdBy: '42' })).toBe(false);
        expect(Auth.canDeleteRecord({ ...record, createdBy: 43 })).toBe(true);
        expect(Auth.getRecordOwner(null)).toBeNull();
    });
});

// Pre-compute hashes for known test passwords
const TEST_PASSWORD = 'test123';
let TEST_HASH;
beforeAll(async () => {
    TEST_HASH = await Auth._hashPassword(TEST_PASSWORD);
});

describe('Auth module', () => {
    beforeEach(() => {
        Auth.currentUser = null;
        Auth._serverDataAuthorized = false;
        Auth.configureProvider(null);
        sessionStorage.clear();
        jest.clearAllMocks();
    });

    // ==================== user database ====================

    describe('user database', () => {
        test('contains expected users', () => {
            expect(Auth.users.length).toBeGreaterThanOrEqual(9);
            expect(Auth.users.find(u => u.username === 'David')).toBeTruthy();
            expect(Auth.users.find(u => u.username === 'Lily')).toBeTruthy();
        });

        test('admin user has correct role', () => {
            const admin = Auth.users.find(u => u.username === 'David');
            expect(admin.role).toBe('admin');
            expect(admin.teamId).toBeNull();
        });

        test('public directory contains no credentials', () => {
            Auth.users.forEach(u => {
                expect(u.passwordHash).toBeUndefined();
            });
        });

        test('all users have required fields', () => {
            Auth.users.forEach(u => {
                expect(u.id).toBeTruthy();
                expect(u.username).toBeTruthy();
                expect(u.passwordHash).toBeUndefined();
                expect(u.name).toBeTruthy();
                expect(u.role).toBeTruthy();
            });
        });

        test('contains users with all roles', () => {
            const roles = new Set(Auth.users.map(u => u.role));
            expect(roles.has('admin')).toBe(true);
            expect(roles.has('finance')).toBe(true);
            expect(roles.has('manager')).toBe(true);
            expect(roles.has('salesperson')).toBe(true);
            expect(roles.has('document')).toBe(true);
        });
    });

    // ==================== team definitions ====================

    describe('team definitions', () => {
        test('TEAM-A has manager Vivian', () => {
            expect(Auth.teams['TEAM-A'].managerId).toBe('U003');
            expect(Auth.teams['TEAM-A'].memberIds.length).toBeGreaterThanOrEqual(3);
            expect(Auth.teams['TEAM-A'].visibleCompanyIds).toBeNull();
        });

        test('TEAM-B has manager Galen', () => {
            expect(Auth.teams['TEAM-B'].managerId).toBe('U004');
            expect(Auth.teams['TEAM-B'].visibleCompanyIds).toEqual(['CO-WY', 'CO-GW']);
        });
    });

    // ==================== role checks (unauthenticated) ====================

    describe('role checks (unauthenticated)', () => {
        test('all role checks return falsy when no user', () => {
            expect(Auth.isAdmin()).toBeFalsy();
            expect(Auth.isFinance()).toBeFalsy();
            expect(Auth.isManager()).toBeFalsy();
            expect(Auth.isSalesperson()).toBeFalsy();
            expect(Auth.isDocument()).toBeFalsy();
            expect(Auth.canSeeAll()).toBeFalsy();
            expect(Auth.canSeeProfit()).toBeFalsy();
            expect(Auth.canSeeFinancials()).toBeFalsy();
            expect(Auth.canSeeSettings()).toBeFalsy();
            expect(Auth.canDelete()).toBeFalsy();
            expect(Auth.canEdit()).toBe(true); // canEdit always true
        });

        test('getVisibleCompanyIds returns empty array when no user', () => {
            expect(Auth.getVisibleCompanyIds()).toEqual([]);
        });

        test('getVisibleSalespersonIds returns empty array when no user', () => {
            expect(Auth.getVisibleSalespersonIds()).toEqual([]);
        });
    });

    // ==================== role checks (authenticated) ====================

    describe('role checks (authenticated)', () => {
        test('admin can do everything', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            expect(Auth.isAdmin()).toBe(true);
            expect(Auth.canSeeAll()).toBe(true);
            expect(Auth.canSeeProfit()).toBe(true);
            expect(Auth.canSeeFinancials()).toBe(true);
            expect(Auth.canSeeSettings()).toBe(true);
            expect(Auth.canDelete()).toBe(true);
            expect(Auth.canEdit()).toBe(true);
        });

        test('finance can see all financial data', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Lily');
            expect(Auth.isFinance()).toBe(true);
            expect(Auth.canSeeAll()).toBe(true);
            expect(Auth.canSeeProfit()).toBe(true);
            expect(Auth.canSeeFinancials()).toBe(true);
            expect(Auth.canSeeSettings()).toBe(true);
            expect(Auth.canDelete()).toBe(false);
        });

        test('manager can see profit and settings, can delete orders', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Vivian');
            expect(Auth.isManager()).toBe(true);
            expect(Auth.canSeeAll()).toBeFalsy();
            expect(Auth.canSeeProfit()).toBe(false);
            expect(Auth.canSeeFinancials()).toBe(false);
            expect(Auth.canSeeSettings()).toBe(false);
            expect(Auth.canDelete()).toBe(true);
        });

        test('salesperson has limited access, can delete own orders', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            expect(Auth.isSalesperson()).toBe(true);
            expect(Auth.canSeeAll()).toBeFalsy();
            expect(Auth.canSeeProfit()).toBe(false);
            expect(Auth.canSeeFinancials()).toBe(false);
            expect(Auth.canSeeSettings()).toBeFalsy();
            expect(Auth.canDelete()).toBe(true);
        });

        test('document cannot see profit', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Anna');
            expect(Auth.isDocument()).toBe(true);
            expect(Auth.canSeeProfit()).toBeFalsy();
            expect(Auth.canSeeFinancials()).toBeFalsy();
            expect(Auth.canSeeSettings()).toBeFalsy();
        });

        test('canSeeInvoices always returns false (module removed)', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            expect(Auth.canSeeInvoices()).toBe(false);
        });
    });

    // ==================== canDeleteOrder ====================

    describe('canDeleteOrder', () => {
        test('admin can delete any order', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            expect(Auth.canDeleteOrder({ id: 'O1', salespersonId: 'U005' })).toBe(true);
            expect(Auth.canDeleteOrder(null)).toBe(false);
        });

        test('manager can delete any visible order', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Vivian');
            expect(Auth.canDeleteOrder({ id: 'O1', salespersonId: 'U005' })).toBe(true);
            expect(Auth.canDeleteOrder({ id: 'O2', salespersonId: 'U006' })).toBe(true);
        });

        test('salesperson can delete own orders only', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale'); // U005
            const own = { id: 'O1', salespersonId: 'U005', createdBy: 'U005' };
            const ownByCreatedBy = { id: 'O2', salespersonId: 'U007', createdBy: 'U005' };
            const others = { id: 'O3', salespersonId: 'U006', createdBy: 'U006' };
            const noOwner = { id: 'O4' };
            expect(Auth.canDeleteOrder(own)).toBe(true);
            expect(Auth.canDeleteOrder(ownByCreatedBy)).toBe(true);
            expect(Auth.canDeleteOrder(others)).toBe(false);
            expect(Auth.canDeleteOrder(noOwner)).toBe(false);
            expect(Auth.canDeleteOrder(null)).toBe(false);
        });

        test('finance and document cannot delete', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Lily');
            expect(Auth.canDeleteOrder({ id: 'O1', salespersonId: 'U005' })).toBe(false);
            Auth.currentUser = Auth.users.find(u => u.username === 'Anna');
            expect(Auth.canDeleteOrder({ id: 'O1', salespersonId: 'U005' })).toBe(false);
        });
    });

    // ==================== page visibility ====================

    describe('getVisiblePages', () => {
        test('admin and finance see all pages', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            expect(Auth.getVisiblePages()).toContain('profit');
            expect(Auth.getVisiblePages()).toContain('settings');
            expect(Auth.getVisiblePages()).toContain('customers');
        });

        test('salesperson sees operational pages without profit', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            const pages = Auth.getVisiblePages();
            expect(pages).toContain('orders');
            expect(pages).toContain('factories');
            expect(pages).not.toContain('profit');
            expect(pages).not.toContain('settings');
        });

        test('document sees customers but no financial settings', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Anna');
            const pages = Auth.getVisiblePages();
            expect(pages).not.toContain('profit');
            expect(pages).toContain('customers');
            expect(pages).not.toContain('settings');
            expect(pages).toContain('orders');
            expect(pages).toContain('factories');
            expect(pages).toContain('shipping');
        });

        test('manager sees team-related operational pages', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Vivian');
            const pages = Auth.getVisiblePages();
            expect(pages).not.toContain('profit');
            expect(pages).not.toContain('settings');
        });
    });

    // ==================== data filtering ====================

    describe('getVisibleSalespersonIds', () => {
        test('returns null for admin (all visible)', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            expect(Auth.getVisibleSalespersonIds()).toBeNull();
        });

        test('returns self ID for salesperson', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            const ids = Auth.getVisibleSalespersonIds();
            expect(ids).toEqual(['U005']);
        });

        test('returns team salesperson IDs + manager for manager', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Vivian');
            const ids = Auth.getVisibleSalespersonIds();
            expect(ids).toContain('U003'); // manager herself
            expect(ids).toContain('U005'); // Michale (salesperson)
            expect(ids).toContain('U006'); // Alex (salesperson)
            expect(ids).toContain('U011'); // Sue (salesperson)
            expect(ids).not.toContain('U007'); // Anna (document, not salesperson)
        });

        test('returns team salesperson IDs for document', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Anna');
            const ids = Auth.getVisibleSalespersonIds();
            expect(ids).toContain('U005');
            expect(ids).toContain('U006');
            // Document does NOT include manager unless manager is salesperson
        });

        test('returns empty array when no team found for manager', () => {
            // Create a user with no team
            const soloUser = { ...Auth.users.find(u => u.username === 'David') };
            soloUser.role = 'manager';
            soloUser.teamId = null;
            Auth.currentUser = soloUser;
            expect(Auth.getVisibleSalespersonIds()).toEqual([]);
        });
    });

    describe('filterOrders', () => {
        const orders = [
            { id: 1, salespersonId: 'U005' },
            { id: 2, salespersonId: 'U008' },
            { id: 3, salespersonId: 'U006' }
        ];

        test('admin sees all orders', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            expect(Auth.filterOrders(orders)).toHaveLength(3);
        });

        test('salesperson sees only own orders', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            const filtered = Auth.filterOrders(orders);
            expect(filtered).toHaveLength(1);
            expect(filtered[0].id).toBe(1);
        });

        test('manager sees team orders', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Vivian');
            const filtered = Auth.filterOrders(orders);
            expect(filtered).toHaveLength(2); // U005 and U006 are both TEAM-A
        });
    });

    describe('filterShipments', () => {
        const orders = [
            { id: 'O1', salespersonId: 'U005' },
            { id: 'O2', salespersonId: 'U008' }
        ];
        const shipments = [
            { id: 'S1', orderId: 'O1' },
            { id: 'S2', orderId: 'O2' },
            { id: 'S3', orderId: 'O3' } // orphan shipment
        ];

        test('admin sees all shipments', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            expect(Auth.filterShipments(shipments, orders)).toHaveLength(3);
        });

        test('salesperson sees only own shipments', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            const filtered = Auth.filterShipments(shipments, orders);
            expect(filtered).toHaveLength(1);
            expect(filtered[0].id).toBe('S1');
        });
    });

    describe('filterInvoices', () => {
        const orders = [
            { id: 'O1', salespersonId: 'U005' },
            { id: 'O2', salespersonId: 'U008' }
        ];
        const invoices = [
            { id: 'I1', orderId: 'O1', type: 'CI' },
            { id: 'I2', orderId: 'O2', type: 'PL' }
        ];

        test('admin sees all invoices', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            expect(Auth.filterInvoices(invoices, orders)).toHaveLength(2);
        });

        test('salesperson sees only own invoices', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            const filtered = Auth.filterInvoices(invoices, orders);
            expect(filtered).toHaveLength(1);
            expect(filtered[0].id).toBe('I1');
        });
    });

    describe('filterCustomers', () => {
        const orders = [
            { id: 'O1', salespersonId: 'U005', customerId: 'C1' },
            { id: 'O2', salespersonId: 'U008', customerId: 'C2' }
        ];
        const customers = [
            { id: 'C1', name: 'Customer 1', salespersonId: 'U005' },
            { id: 'C2', name: 'Customer 2', salespersonId: 'U008' },
            { id: 'C3', name: 'Customer 3', salespersonId: null }, // unassigned
            { id: 'C4', name: 'Customer 4', salespersonId: 'U005' } // same salesperson
        ];

        test('admin sees all customers', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            expect(Auth.filterCustomers(customers, orders)).toHaveLength(4);
        });

        test('salesperson sees own customers', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            const filtered = Auth.filterCustomers(customers, orders);
            // Should see C1 (order), C4 (same salesperson), but not C3 (null salesperson, not manager)
            expect(filtered.map(c => c.id)).toContain('C1');
            expect(filtered.map(c => c.id)).toContain('C4');
            expect(filtered.map(c => c.id)).not.toContain('C2');
        });

        test('manager sees unassigned customers', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Vivian');
            const filtered = Auth.filterCustomers(customers, orders);
            // Manager should see C3 (unassigned because isManager() is true)
            expect(filtered.map(c => c.id)).toContain('C3');
        });

        test('salesperson does not see unassigned customers', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            const filtered = Auth.filterCustomers(customers, orders);
            expect(filtered.map(c => c.id)).not.toContain('C3');
        });
    });

    describe('getVisibleCustomerIds', () => {
        const orders = [
            { id: 'O1', salespersonId: 'U005', customerId: 'C1' },
            { id: 'O2', salespersonId: 'U008', customerId: 'C2' }
        ];

        test('returns null for admin', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            expect(Auth.getVisibleCustomerIds(orders)).toBeNull();
        });

        test('returns customer IDs visible to salesperson', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            const ids = Auth.getVisibleCustomerIds(orders);
            expect(ids).toBeInstanceOf(Set);
            expect(ids.has('C1')).toBe(true);
            expect(ids.has('C2')).toBe(false);
        });
    });

    describe('canViewOrder', () => {
        const orders = [
            { id: 'O1', salespersonId: 'U005' },
            { id: 'O2', salespersonId: 'U008' }
        ];

        test('admin can view any order', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            expect(Auth.canViewOrder('O1', orders)).toBe(true);
            expect(Auth.canViewOrder('O2', orders)).toBe(true);
            expect(Auth.canViewOrder('NONEXISTENT', orders)).toBe(true);
        });

        test('salesperson can view own order', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            expect(Auth.canViewOrder('O1', orders)).toBe(true);
            expect(Auth.canViewOrder('O2', orders)).toBe(false);
        });

        test('returns false when not authenticated', () => {
            expect(Auth.canViewOrder('O1', orders)).toBe(false);
        });

        test('returns false for non-existent order (salesperson)', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            expect(Auth.canViewOrder('NONEXISTENT', orders)).toBe(false);
        });
    });

    // ==================== visible companies ====================

    describe('getVisibleCompanyIds', () => {
        test('admin sees all companies (null)', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            expect(Auth.getVisibleCompanyIds()).toBeNull();
        });

        test('finance sees all companies (null)', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Lily');
            expect(Auth.getVisibleCompanyIds()).toBeNull();
        });

        test('Alex can only see CO-WY and CO-GW', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Alex');
            const ids = Auth.getVisibleCompanyIds();
            expect(ids).toContain('CO-WY');
            expect(ids).toContain('CO-GW');
            expect(ids).not.toContain('CO-GR');
            expect(ids).not.toContain('CO-LK');
        });

        test('Sue can only see CO-LK', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Sue');
            const ids = Auth.getVisibleCompanyIds();
            expect(ids).toEqual(['CO-LK']);
        });

        test('Vivian (TEAM-A manager) sees all companies (team unrestricted)', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Vivian');
            // TEAM-A has visibleCompanyIds: null
            expect(Auth.getVisibleCompanyIds()).toBeNull();
        });

        test('Galen (TEAM-B manager) sees only CO-WY and CO-GW', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Galen');
            const ids = Auth.getVisibleCompanyIds();
            expect(ids).toEqual(['CO-WY', 'CO-GW']);
        });

        test('returns empty array when no current user', () => {
            expect(Auth.getVisibleCompanyIds()).toEqual([]);
        });
    });

    describe('server session boundary', () => {
        test('a forged administrator in sessionStorage never authenticates', async () => {
            sessionStorage.setItem(Auth.SESSION_KEY, JSON.stringify({ userId: 'U001' }));
            expect(await Auth.init()).toBe(false);
            expect(Auth.currentUser).toBeNull();
        });
        test('server-confirmed identity is used instead of local userId', async () => {
            const user = { id: 'remote', role: 'salesperson' };
            sessionStorage.setItem(Auth.SESSION_KEY, JSON.stringify({ userId: 'U001' }));
            Auth.configureProvider({ restoreSession: async () => user });
            expect(await Auth.init()).toBe(true);
            expect(Auth.currentUser).toEqual(user);
        });
        test('unavailable server never falls back to a local account', async () => {
            Auth.configureProvider({
                restoreSession: async () => {
                    throw new Error('offline');
                }
            });
            expect(await Auth.init()).toBe(false);
            expect(Auth.currentUser).toBeNull();
        });
        test('login requires a provider and does not compare public hashes', async () => {
            expect((await Auth.login('David', 'anything')).success).toBe(false);
            const user = { id: 'server', role: 'finance' };
            const login = jest.fn(async () => user);
            Auth.configureProvider({ login });
            expect((await Auth.login('server', 'secret')).user).toEqual(user);
            expect(login).toHaveBeenCalledWith('server', 'secret');
            expect(sessionStorage.getItem(Auth.SESSION_KEY)).toBeNull();
        });
        test('logout revokes the provider session', async () => {
            const logout = jest.fn(async () => {});
            Auth.configureProvider({ logout });
            Auth.currentUser = { id: 'server' };
            await Auth.logout();
            expect(logout).toHaveBeenCalledTimes(1);
            expect(Auth.currentUser).toBeNull();
        });
        test('logout clears the catalog before waiting for the server', async () => {
            let finish;
            const originalCatalog = globalThis.ItemCatalog;
            const clear = jest.fn();
            globalThis.ItemCatalog = { clear };
            Auth.configureProvider({
                logout: () =>
                    new Promise(resolve => {
                        finish = resolve;
                    })
            });
            Auth.currentUser = { id: 'server' };
            try {
                const pending = Auth.logout();
                expect(clear).toHaveBeenCalledTimes(1);
                expect(Auth.currentUser.id).toBe('server');
                finish();
                await pending;
                expect(Auth.currentUser).toBeNull();
            } finally {
                globalThis.ItemCatalog = originalCatalog;
            }
        });
        test('configured capabilities override template visibility', () => {
            Auth.currentUser = { role: 'analyst', permissions: ['finance.read'] };
            expect(Auth.canSeeFinancials()).toBe(true);
            expect(Auth.canSeeProfit()).toBe(true);
            Auth.currentUser = { role: 'admin', permissions: [] };
            expect(Auth.canSeeProfit()).toBe(false);
        });
        test('configured roles and server-authorized reads are not filtered again by legacy role names', () => {
            Auth._serverDataAuthorized = true;
            Auth.currentUser = {
                id: 'custom',
                role: 'operations',
                baseRole: 'document',
                scope: 'self',
                visibleCompanyIds: ['CUSTOM-ENTITY'],
                permissions: ['read', 'edit'],
                pages: ['dashboard', 'orders']
            };
            const authorized = [{ id: 'assigned', createdBy: 'another-user' }];
            expect(Auth.isDocument()).toBe(true);
            expect(Auth.getVisibleCompanyIds()).toEqual(['CUSTOM-ENTITY']);
            expect(Auth.filterOrders(authorized)).toBe(authorized);
            expect(Auth.filterCustomers(authorized, [])).toBe(authorized);
            expect(Auth.canViewOrder('assigned', authorized)).toBe(true);
            expect(Auth.canViewOrder('unloaded-id', authorized)).toBe(false);
            expect(Auth.getVisiblePages()).toEqual(['dashboard', 'orders']);
            expect(Auth.canEdit()).toBe(true);
            expect(Auth.canDeleteOrder(authorized[0])).toBe(false);
        });
        test('enterprise management is a separate server-authorized page', () => {
            Auth._serverDataAuthorized = true;
            Auth.currentUser = {
                id: 'owner',
                role: 'owner',
                scope: 'tenant',
                visibleCompanyIds: [],
                permissions: ['read', 'accounts.configure'],
                pages: ['dashboard', 'settings']
            };
            expect(Auth.getVisiblePages()).toEqual(['dashboard', 'admin', 'onboarding']);
            expect(Auth.canManageEnterprise()).toBe(true);
        });
    });
});
