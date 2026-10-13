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
    jest.clearAllMocks();
    sessionStorage.clear();
    DB.companies = clone(session.companies);
    DB._cloudReady = DB._cloudConnected = true;
    DB.liveExchangeRates = { 'CN-A': 7.26 };
    DB.liveRateMetas = { 'CN-A': { nextUpdateAt: '2026-10-14T00:00:00Z', stale: false } };
    api.session.mockResolvedValue(clone(session));
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
    document.getElementById('loginTenant').value = 'tenant-A';

    await login('admin', 'not-retained');

    expect(DB._cloudReady).toBe(false);
    expect(DB.liveExchangeRates).toEqual({});
    expect(DB.liveRateMetas).toEqual({});
    expect(Exchange.stopAutoRefresh).toHaveBeenCalledTimes(1);
});
