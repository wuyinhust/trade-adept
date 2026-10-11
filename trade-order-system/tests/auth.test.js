/**
 * @file auth.test.js
 * Authentication module tests — full coverage
 */
import { jest } from '@jest/globals';

// Mock cloud.js
const mockCloud = {
    resetSession: jest.fn(),
    init() { return Promise.resolve({ ok: true, uid: 'mock' }); },
    isReady() { return true; },
    loadData() { return Promise.resolve(null); },
    getLastMeta() { return { version: 0 }; },
    saveData() { return Promise.resolve(true); },
    getStatus() { return { ready: true }; },
    testPermission() { return Promise.resolve({ ok: true }); },
    checkRemoteVersion() { return Promise.resolve(null); },
    _saveQueue: [],
    _saveRunning: false,
    COLLECTION: 'app_data',
    DATA_TYPE: 'gw_data',
    envId: 'mock',
    region: 'ap-shanghai',
    _lastMeta: { version: 0, updatedAt: null, updatedBy: null },
    _drainQueue() { return Promise.resolve(); }
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
    getRandomValues: (arr) => arr,
    randomUUID: () => '00000000-0000-0000-0000-000000000000'
};
Object.defineProperty(globalThis, 'crypto', {
    value: mockCrypto,
    writable: true,
    configurable: true
});

const { Auth } = await import('../js/auth.js');

// Pre-compute hashes for known test passwords
const TEST_PASSWORD = 'test123';
let TEST_HASH;
beforeAll(async () => {
    TEST_HASH = await Auth._hashPassword(TEST_PASSWORD);
});

describe('Auth module', () => {
    beforeEach(() => {
        Auth.currentUser = null;
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

        test('password hashes are 64-char hex strings', () => {
            Auth.users.forEach(u => {
                expect(u.passwordHash).toMatch(/^[a-f0-9]{64}$/);
            });
        });

        test('all users have required fields', () => {
            Auth.users.forEach(u => {
                expect(u.id).toBeTruthy();
                expect(u.username).toBeTruthy();
                expect(u.passwordHash).toBeTruthy();
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
            expect(Auth.canSeeProfit()).toBe(true);
            expect(Auth.canSeeFinancials()).toBe(true);
            expect(Auth.canSeeSettings()).toBe(true);
            expect(Auth.canDelete()).toBe(true);
        });

        test('salesperson has limited access, can delete own orders', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            expect(Auth.isSalesperson()).toBe(true);
            expect(Auth.canSeeAll()).toBeFalsy();
            expect(Auth.canSeeProfit()).toBe(true);
            expect(Auth.canSeeFinancials()).toBe(true);
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

        test('salesperson sees orders, customers, factories, shipping, profit', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Michale');
            const pages = Auth.getVisiblePages();
            expect(pages).toContain('orders');
            expect(pages).toContain('factories');
            expect(pages).toContain('profit');
            expect(pages).not.toContain('settings');
        });

        test('document cannot see profit or customers or settings', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Anna');
            const pages = Auth.getVisiblePages();
            expect(pages).not.toContain('profit');
            expect(pages).not.toContain('customers');
            expect(pages).not.toContain('settings');
            expect(pages).toContain('orders');
            expect(pages).toContain('factories');
            expect(pages).toContain('shipping');
        });

        test('manager sees team-related pages + profit + settings', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'Vivian');
            const pages = Auth.getVisiblePages();
            expect(pages).toContain('profit');
            expect(pages).toContain('settings');
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

    // ==================== session management ====================

    describe('session management', () => {
        test('init returns false when no session', () => {
            const result = Auth.init();
            expect(result).toBe(false);
            expect(Auth.currentUser).toBeNull();
        });

        test('init restores session from sessionStorage', () => {
            sessionStorage.setItem(Auth.SESSION_KEY, JSON.stringify({ userId: 'U001' }));
            const result = Auth.init();
            expect(result).toBe(true);
            expect(Auth.currentUser).toBeTruthy();
            expect(Auth.currentUser.id).toBe('U001');
            expect(Auth.currentUser.username).toBe('David');
        });

        test('init returns false for invalid userId in session', () => {
            sessionStorage.setItem(Auth.SESSION_KEY, JSON.stringify({ userId: 'INVALID' }));
            const result = Auth.init();
            expect(result).toBe(false);
            expect(Auth.currentUser).toBeNull();
        });

        test('init handles corrupt session data gracefully', () => {
            sessionStorage.setItem(Auth.SESSION_KEY, '{corrupt:json');
            const result = Auth.init();
            expect(result).toBe(false);
            expect(Auth.currentUser).toBeNull();
        });

        test('logout clears currentUser and session', () => {
            Auth.currentUser = Auth.users.find(u => u.username === 'David');
            sessionStorage.setItem(Auth.SESSION_KEY, JSON.stringify({ userId: 'U001' }));
            Auth.logout();
            expect(Auth.currentUser).toBeNull();
            expect(sessionStorage.getItem(Auth.SESSION_KEY)).toBeNull();
            expect(mockCloud.resetSession).toHaveBeenCalled();
        });
    });

    // ==================== password hashing ====================

    describe('password hashing', () => {
        test('_hashPassword returns 64-char hex', async () => {
            const hash = await Auth._hashPassword('test123');
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });

        test('_hashPassword is deterministic', async () => {
            const h1 = await Auth._hashPassword('hello');
            const h2 = await Auth._hashPassword('hello');
            expect(h1).toBe(h2);
        });

        test('_hashPassword different inputs yield different hashes', async () => {
            const h1 = await Auth._hashPassword('abc');
            const h2 = await Auth._hashPassword('def');
            expect(h1).not.toBe(h2);
        });

        test('_hashPassword handles empty string', async () => {
            const hash = await Auth._hashPassword('');
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });

        test('_hashPassword handles special characters', async () => {
            const hash = await Auth._hashPassword('!@#$%^&*()');
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });
    });

    // ==================== login flow ====================

    describe('login flow', () => {
        test('login fails with empty credentials', async () => {
            const result = await Auth.login('', '');
            expect(result.success).toBe(false);
            expect(result.error).toBeTruthy();
        });

        test('login fails with wrong password', async () => {
            const result = await Auth.login('David', 'wrongpassword');
            expect(result.success).toBe(false);
        });

        test('login fails with nonexistent user', async () => {
            const result = await Auth.login('Nobody', 'password');
            expect(result.success).toBe(false);
        });

        test('login succeeds with correct password (mocked hash)', async () => {
            // Create a temp user with known password hash
            const originalUsers = Auth.users;
            Auth.users = [
                { id: 'TEST', username: 'testuser', passwordHash: TEST_HASH, name: 'Test', role: 'admin', teamId: null },
                ...originalUsers
            ];
            const result = await Auth.login('testuser', TEST_PASSWORD);
            expect(result.success).toBe(true);
            expect(result.user.username).toBe('testuser');
            expect(Auth.currentUser.username).toBe('testuser');
            expect(sessionStorage.getItem(Auth.SESSION_KEY)).toBeTruthy();
            // Restore
            Auth.users = originalUsers;
            Auth.currentUser = null;
        });

        test('login sets sessionStorage on success', async () => {
            const originalUsers = Auth.users;
            Auth.users = [
                { id: 'TEST2', username: 'testuser2', passwordHash: TEST_HASH, name: 'Test2', role: 'salesperson', teamId: 'TEAM-A' },
                ...originalUsers
            ];
            await Auth.login('testuser2', TEST_PASSWORD);
            const session = JSON.parse(sessionStorage.getItem(Auth.SESSION_KEY));
            expect(session.userId).toBe('TEST2');
            Auth.users = originalUsers;
            Auth.currentUser = null;
        });
    });

    // ==================== login lockout ====================

    describe('login lockout', () => {
        beforeEach(() => {
            sessionStorage.removeItem(Auth.LOCKOUT_KEY);
            Auth.currentUser = null;
        });

        test('_getLockoutState returns null when no lockout', () => {
            expect(Auth._getLockoutState()).toBeNull();
        });

        test('_setLockoutState and _getLockoutState roundtrip', () => {
            Auth._setLockoutState({ attempts: 2, lockedUntil: null });
            const state = Auth._getLockoutState();
            expect(state.attempts).toBe(2);
        });

        test('_clearLockout removes lockout state', () => {
            Auth._setLockoutState({ attempts: 3, lockedUntil: Date.now() + 60000 });
            Auth._clearLockout();
            expect(Auth._getLockoutState()).toBeNull();
        });

        test('failed login increments attempt counter', async () => {
            await Auth.login('David', 'wrong');
            const state = Auth._getLockoutState();
            expect(state.attempts).toBe(1);
            expect(state.lockedUntil).toBeFalsy();
        });

        test('non-existent user also increments counter (timing-safe)', async () => {
            await Auth.login('Nobody', 'pass');
            const state = Auth._getLockoutState();
            expect(state.attempts).toBe(1);
        });

        test('locks out after MAX_LOGIN_ATTEMPTS failed attempts', async () => {
            for (let i = 0; i < 5; i++) {
                await Auth.login('David', 'wrong');
            }
            const state = Auth._getLockoutState();
            expect(state.attempts).toBe(5);
            expect(state.lockedUntil).toBeGreaterThan(Date.now());
        });

        test('locked out login returns remaining time error', async () => {
            // Force lockout state
            Auth._setLockoutState({
                attempts: 5,
                lockedUntil: Date.now() + 5 * 60 * 1000 // 5 minutes
            });
            const result = await Auth.login('David', 'wrong');
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/分钟后重试/);
        });

        test('expired lockout allows login again', async () => {
            Auth._setLockoutState({
                attempts: 5,
                lockedUntil: Date.now() - 1000 // expired 1 second ago
            });
            const result = await Auth.login('David', 'wrong');
            expect(result.success).toBe(false);
            // Should have attempted (not locked), so lockout state is cleared
            // and a new attempt was recorded
            const state = Auth._getLockoutState();
            expect(state.attempts).toBe(1);
        });

        test('successful login clears lockout counter', async () => {
            // Pre-set some failed attempts
            Auth._setLockoutState({ attempts: 3, lockedUntil: null });

            const originalUsers = Auth.users;
            Auth.users = [
                { id: 'T3', username: 't3', passwordHash: TEST_HASH, name: 'T3', role: 'admin', teamId: null },
                ...originalUsers
            ];
            await Auth.login('t3', TEST_PASSWORD);
            expect(Auth._getLockoutState()).toBeNull();

            Auth.users = originalUsers;
            Auth.currentUser = null;
        });

        test('empty credentials do not count as attempt', async () => {
            await Auth.login('', '');
            expect(Auth._getLockoutState()).toBeNull();
        });
    });
});
