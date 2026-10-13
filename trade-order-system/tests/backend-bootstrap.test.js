import { jest } from '@jest/globals';

const clone = value => JSON.parse(JSON.stringify(value));
const session = {
    user: { id: 'U1', tenantId: 'tenant-A', role: 'admin' },
    companies: [{ id: 'CN-A', settlementCurrency: 'CNY' }],
    tenant: { name: 'Enterprise' },
    roles: {},
    teams: {},
    users: []
};
const api = {
    session: jest.fn(async () => clone(session)),
    getLastMeta: jest.fn(() => ({ version: 9, updatedAt: '2026-10-13T00:00:00Z' }))
};
const DB = {
    companies: session.companies,
    data: { customers: [], orders: [], factories: [], shipments: [], invoices: [] },
    exchangeRates: {},
    rateMetas: {},
    liveExchangeRates: {},
    liveRateMetas: {},
    _cloudReady: true
};
const Exchange = { stopAutoRefresh: jest.fn(), fetchRate: jest.fn(async () => ({ success: true })) };
const App = {
    _pageModulePaths: {},
    init: jest.fn(async () => {}),
    updateCloudStatus: jest.fn(),
    handleLogout: jest.fn(),
    renderCompanySelect: jest.fn(),
    updateCompanyDisplay: jest.fn(),
    updateUserDisplay: jest.fn(),
    updateSidebarVisibility: jest.fn(),
    updateExchangeRateDisplay: jest.fn()
};
const Auth = {
    configureProvider: jest.fn(provider => {
        Auth.provider = provider;
    })
};

jest.unstable_mockModule('../js/app.js', () => ({ App }));
jest.unstable_mockModule('../js/auth.js', () => ({ Auth }));
jest.unstable_mockModule('../js/data.js', () => ({ DB }));
jest.unstable_mockModule('../js/exchange.js', () => ({ Exchange }));
jest.unstable_mockModule('../js/cloud.js', () => ({ Cloud: { configure: jest.fn() } }));
jest.unstable_mockModule('../js/api-client.js', () => ({
    BusinessAPIClient: class {
        constructor() {
            return api;
        }
    },
    workspaceDraftKey: () => 'draft-key'
}));
jest.unstable_mockModule('../js/utils.js', () => ({ escapeHtml: String, toast: jest.fn() }));

document.body.innerHTML = '<form id="loginForm"></form><span class="brand-caption"></span>';
await import('../js/backend-bootstrap.js');

beforeEach(() => {
    document.getElementById('enterpriseAuthPanel')?.remove();
    document.getElementById('loginTenant')?.remove();
    jest.clearAllMocks();
    sessionStorage.clear();
    DB.companies = clone(session.companies);
    DB._cloudReady = DB._cloudConnected = true;
    DB.liveExchangeRates = { 'CN-A': 7.26 };
    DB.liveRateMetas = { 'CN-A': { nextUpdateAt: '2026-10-14T00:00:00Z', stale: false } };
    api.session.mockResolvedValue(clone(session));
});

test('password setup bypasses an existing server session on initial load', async () => {
    const panel = document.createElement('div');
    panel.id = 'enterpriseAuthPanel';
    panel.dataset.mode = 'set-password';
    document.body.append(panel);
    expect(await Auth.provider.restoreSession()).toBeNull();
    expect(api.session).not.toHaveBeenCalled();
});

test('password link arriving during session restoration wins the race', async () => {
    let resolveSession;
    api.session.mockImplementationOnce(
        () =>
            new Promise(resolve => {
                resolveSession = resolve;
            })
    );
    const restoring = Auth.provider.restoreSession();
    const panel = document.createElement('div');
    panel.id = 'enterpriseAuthPanel';
    panel.dataset.mode = 'set-password';
    document.body.append(panel);
    resolveSession(clone(session));
    expect(await restoring).toBeNull();
    expect(Exchange.stopAutoRefresh).not.toHaveBeenCalled();
});

test('management session refresh retains the ready connection, live rate, and refresh schedule', async () => {
    const rates = DB.liveExchangeRates;
    const metadata = DB.liveRateMetas;

    await window.Workspace.refreshSession();

    expect(DB._cloudReady).toBe(true);
    expect(DB._cloudConnected).toBe(true);
    expect(DB.liveExchangeRates).toBe(rates);
    expect(DB.liveRateMetas).toBe(metadata);
    expect(DB.liveExchangeRates['CN-A']).toBe(7.26);
    expect(DB._cloudVersion).toBe(9);
    expect(Exchange.stopAutoRefresh).not.toHaveBeenCalled();
    expect(Exchange.fetchRate).not.toHaveBeenCalled();
    expect(App.updateSidebarVisibility).toHaveBeenCalledTimes(1);
    expect(App.updateExchangeRateDisplay).toHaveBeenCalledTimes(1);
});

test('historical ownership refresh stays separate from active members', async () => {
    api.session.mockResolvedValue({ ...clone(session), historicalOwners: { retired: { teamId: 'team-A' } } });
    await window.Workspace.refreshSession();
    expect(Auth.historicalOwners).toEqual({ retired: { teamId: 'team-A' } });
    expect(Auth.users).toEqual([]);
});

test('switching enterprise clears historical owners absent from the next session', async () => {
    Auth.historicalOwners = { retired: { teamId: 'team-A' } };
    api.session.mockResolvedValue({ ...clone(session), user: { ...session.user, tenantId: 'tenant-B' } });
    await Auth.provider.restoreSession();
    expect(Auth.currentUser.tenantId).toBe('tenant-B');
    expect(Auth.historicalOwners).toEqual({});
});

test('logout clears the historical ownership directory', async () => {
    Auth.historicalOwners = { retired: { teamId: 'team-A' } };
    api.logout = jest.fn(async () => ({}));
    await Auth.provider.logout();
    expect(Auth.historicalOwners).toEqual({});
    expect(Auth._serverDataAuthorized).toBe(false);
});

test('adding a CNY company refreshes rates while retaining the existing business connection', async () => {
    api.session.mockResolvedValue({
        ...clone(session),
        companies: [...session.companies, { id: 'CN-B', settlementCurrency: 'CNY' }]
    });
    Exchange.fetchRate.mockImplementationOnce(async () => {
        DB.liveExchangeRates['CN-B'] = 7.26;
        return { success: true };
    });

    await window.Workspace.refreshSession();

    expect(DB._cloudReady).toBe(true);
    expect(DB.liveExchangeRates['CN-A']).toBe(7.26);
    expect(DB.liveExchangeRates['CN-B']).toBe(7.26);
    expect(Exchange.fetchRate).toHaveBeenCalledWith({ updateDisplay: false });
    expect(Exchange.stopAutoRefresh).not.toHaveBeenCalled();
});

test('a new authenticated session resets runtime rates and waits for business data initialization', async () => {
    const { login } = Auth.provider;
    api.login = jest.fn(async () => ({}));
    expect(document.getElementById('loginTenant')).toBeNull();

    await login('Admin@Company.com', 'not-retained');
    expect(api.login).toHaveBeenCalledWith({ email: 'admin@company.com', password: 'not-retained' });

    expect(DB._cloudReady).toBe(false);
    expect(DB.liveExchangeRates).toEqual({});
    expect(DB.liveRateMetas).toEqual({});
    expect(Exchange.stopAutoRefresh).toHaveBeenCalledTimes(1);
});

test('explicit demo selection sends the chosen tenant and preserves original account name', async () => {
    const select = document.createElement('select');
    select.id = 'loginTenant';
    select.innerHTML =
        '<option value="grandware">grandware</option><option value="example-company">example-company</option>';
    document.body.append(select);
    api.login = jest.fn(async () => ({}));
    await Auth.provider.login('David', 'not-retained');
    expect(api.login).toHaveBeenLastCalledWith({ tenantId: 'grandware', username: 'David', password: 'not-retained' });
    select.value = 'example-company';
    await Auth.provider.login('demo-admin', 'not-retained');
    expect(api.login).toHaveBeenLastCalledWith({
        tenantId: 'example-company',
        username: 'demo-admin',
        password: 'not-retained'
    });
});
