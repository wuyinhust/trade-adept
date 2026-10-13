import { jest } from '@jest/globals';

const liveRate = overrides => ({
    base: 'USD',
    quote: 'CNY',
    rawRate: 6.7313,
    adjustment: -0.02,
    adjustedRate: 6.7113,
    provider: 'ExchangeRate-API',
    source: 'open.er-api.com',
    publishedAt: '2026-10-12T00:02:31.000Z',
    fetchedAt: '2026-10-12T00:05:00.000Z',
    nextUpdateAt: '2026-10-13T00:02:31.000Z',
    systemNextCheckAt: '2026-10-13T00:02:31.000Z',
    cached: false,
    stale: false,
    ...overrides
});

const db = {
    _cloudVersion: 12,
    companies: [
        { id: 'CO-CN', name: 'Demo China', settlementCurrency: 'CNY' },
        { id: 'CO-US', name: 'Demo USD', settlementCurrency: 'USD' }
    ],
    getExchangeRate: jest.fn(companyId => (companyId === 'CO-US' ? 1 : 6.7)),
    fetchExchangeRate: jest.fn(),
    data: {},
    exchangeRates: {},
    rateMetas: {}
};
const auth = {
    currentUser: { tenantId: 'demo-tenant' },
    hasCapability: jest.fn(() => false)
};
const app = {
    updateExchangeRateDisplay: jest.fn(),
    updateSaveStatus: jest.fn(),
    showConfirm: jest.fn()
};
const toast = jest.fn();
const backendPanel = { render: jest.fn().mockResolvedValue(undefined) };
const escapeHtml = value =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

jest.unstable_mockModule('../js/data.js', () => ({ DB: db }));
jest.unstable_mockModule('../js/auth.js', () => ({ Auth: auth }));
jest.unstable_mockModule('../js/app.js', () => ({ App: app }));
jest.unstable_mockModule('../js/utils.js', () => ({ escapeHtml, toast }));
jest.unstable_mockModule('../js/erpnext-panel.js', () => ({ BusinessBackendPanel: backendPanel }));

const { Settings, formatRate, rateState } = await import('../js/workspace-settings.js');

beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '<main id="pageContent"></main>';
    Settings._lastLiveRate = null;
    Settings._rateRequest = null;
    auth.hasCapability.mockReturnValue(false);
    db.getExchangeRate.mockImplementation(companyId => (companyId === 'CO-US' ? 1 : 6.7));
    db.fetchExchangeRate.mockResolvedValue(liveRate());
    window.Workspace = {
        api: {
            listSnapshots: jest.fn().mockResolvedValue([]),
            hasChanges: jest.fn(() => false),
            restore: jest.fn()
        }
    };
});

afterEach(() => {
    if (Settings._liveRateTimer) clearTimeout(Settings._liveRateTimer);
    Settings._liveRateTimer = null;
    jest.useRealTimers();
});

describe('workspace live exchange-rate settings', () => {
    test('read-only rendering shows the live reference and effective rate without manual controls', async () => {
        await Settings.render();

        expect(db.fetchExchangeRate).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[data-live-rate-raw]').textContent).toBe('6.7313');
        expect(document.querySelector('[data-live-rate-effective]').textContent).toBe('6.7113');
        expect(document.getElementById('liveRateStateBadge').textContent).toBe('已获取最新发布');
        expect(document.getElementById('workspaceLiveRate').textContent).toContain(
            'Rates By Exchange Rate API · open.er-api.com'
        );
        expect(document.querySelector('#workspaceLiveRate a[href="https://www.exchangerate-api.com"]')).not.toBeNull();
        expect(document.getElementById('workspaceLiveRate').textContent).toContain('供应商预计发布时间');
        expect(document.getElementById('workspaceLiveRate').textContent).toContain('系统下次检查');
        expect(document.querySelector('[data-company-live-rate="CO-CN"]').textContent).toBe('6.7113');
        expect(document.getElementById('pageContent').textContent).toContain('USD 结算，无需 USD → CNY 换算');
        expect(document.querySelector('[data-rate-company]')).toBeNull();
        expect(document.getElementById('saveWorkspaceRates')).toBeNull();
        expect(app.updateExchangeRateDisplay).toHaveBeenCalledTimes(1);
    });

    test('checking before the next publication reuses cache and explains that no upstream request was needed', async () => {
        await Settings.render();
        db.fetchExchangeRate.mockResolvedValueOnce(liveRate({ cached: true }));

        const button = document.getElementById('checkLiveRate');
        button.click();
        expect(button.disabled).toBe(true);
        await Settings._rateRequest;

        expect(db.fetchExchangeRate).toHaveBeenCalledTimes(2);
        expect(document.getElementById('workspaceLiveRate').dataset.rateLastResult).toBe('cached');
        expect(document.getElementById('liveRateStateBadge').textContent).toBe('缓存有效');
        expect(document.getElementById('workspaceLiveRate').textContent).toContain('没有重复请求上游');
        expect(toast).toHaveBeenCalledWith('尚未到下一次更新时间，当前有效缓存已是最新版本', 'info');
        expect(button.disabled).toBe(false);
        expect(button.textContent).toBe('检查更新');
    });

    test('an expired fallback is clearly marked as stale instead of presented as current', async () => {
        db.fetchExchangeRate.mockResolvedValueOnce(
            liveRate({
                cached: true,
                stale: true,
                nextUpdateAt: '2026-10-11T00:02:31.000Z',
                systemNextCheckAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
            })
        );
        await Settings.render();

        expect(document.getElementById('workspaceLiveRate').dataset.rateLastResult).toBe('stale');
        expect(document.getElementById('liveRateStateBadge').textContent).toBe('缓存已过期');
        expect(document.getElementById('workspaceLiveRate').textContent).toContain('供应商尚未发布新版本');
        expect(document.getElementById('workspaceLiveRate').textContent).toContain('已过，等待新发布');
    });

    test('an unavailable first read does not silently fall back to an editable stored rate', async () => {
        db.fetchExchangeRate.mockResolvedValueOnce({
            success: false,
            error: 'Live exchange rate is temporarily unavailable'
        });
        await Settings.render();

        const target = document.getElementById('workspaceLiveRate');
        expect(target.dataset.rateLastResult).toBe('error');
        expect(target.textContent).toContain('暂时无法读取实时汇率');
        expect(target.textContent).toContain('系统不会用手工汇率覆盖');
        expect(document.querySelector('[data-rate-company]')).toBeNull();
        expect(document.getElementById('checkLiveRate').disabled).toBe(false);
    });

    test('an open settings page checks once when the system schedule becomes due', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-10-12T00:00:00.000Z'));
        db.fetchExchangeRate
            .mockResolvedValueOnce(liveRate({ systemNextCheckAt: '2026-10-12T00:01:00.000Z' }))
            .mockResolvedValueOnce(
                liveRate({
                    cached: false,
                    fetchedAt: '2026-10-12T00:01:00.000Z',
                    systemNextCheckAt: '2026-10-13T00:01:00.000Z'
                })
            );

        await Settings.render();
        expect(db.fetchExchangeRate).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(60 * 1000);

        expect(db.fetchExchangeRate).toHaveBeenCalledTimes(2);
        expect(document.getElementById('workspaceLiveRate').dataset.rateLastResult).toBe('fresh');
    });

    test('formatters reject invalid rates and prioritize stale state over cache state', () => {
        expect(formatRate('invalid')).toBe('—');
        expect(formatRate(6.7)).toBe('6.7000');
        expect(rateState({ cached: true, stale: true }).label).toBe('缓存已过期');
    });
});
