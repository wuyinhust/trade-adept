/**
 * @file exchange.test.js
 * Exchange rate and profit calculation module tests — full coverage
 */
import { jest } from '@jest/globals';

let mockSave, mockDB, mockHandleError;

// Default mockDB — must be initialized before the mock module factory runs
mockSave = jest.fn(() => Promise.resolve(true));
mockHandleError = jest.fn();
mockDB = {
    currentCompanyId: 'CO-GR',
    companies: [
        { id: 'CO-GR', settlementCurrency: 'CNY' },
        { id: 'CO-WY', settlementCurrency: 'CNY' },
        { id: 'CO-GW', settlementCurrency: 'USD' },
        { id: 'CO-LK', settlementCurrency: 'USD' }
    ],
    _businessAPI: null,
    exchangeRates: { 'CO-GR': 7.25, 'CO-WY': 7.25, 'CO-GW': 7.8, 'CO-LK': 7.8 },
    liveExchangeRates: {},
    rateMetas: {
        'CO-GR': { source: 'manual', updateTime: null, isAuto: false },
        'CO-WY': { source: 'manual', updateTime: null, isAuto: false },
        'CO-GW': { source: 'manual', updateTime: null, isAuto: false },
        'CO-LK': { source: 'manual', updateTime: null, isAuto: false }
    },
    getExchangeRate(cid) {
        const id = cid || this.currentCompanyId;
        return this.exchangeRates[id] || 7.25;
    },
    getRateMeta(cid) {
        const id = cid || this.currentCompanyId;
        if (this._businessAPI && this.liveRateMetas[id]) return this.liveRateMetas[id];
        return this.rateMetas[id] || { source: 'manual', updateTime: null, isAuto: false };
    },
    _overlayLiveExchangeData() {
        Object.assign(this.exchangeRates, this.liveExchangeRates);
        Object.assign(this.rateMetas, this.liveRateMetas);
    },
    save: mockSave,
    data: { orders: [] }
};

/** Reset mockDB to fresh state for tests */
function setupMocks(exchangeRates, rateMetas, orders) {
    mockDB.currentCompanyId = 'CO-GR';
    mockDB.companies = [
        { id: 'CO-GR', settlementCurrency: 'CNY' },
        { id: 'CO-WY', settlementCurrency: 'CNY' },
        { id: 'CO-GW', settlementCurrency: 'USD' },
        { id: 'CO-LK', settlementCurrency: 'USD' }
    ];
    mockDB._businessAPI = null;
    mockDB.liveExchangeRates = {};
    mockDB.liveRateMetas = {};
    mockDB.exchangeRates = exchangeRates || { 'CO-GR': 7.25, 'CO-WY': 7.25, 'CO-GW': 7.8, 'CO-LK': 7.8 };
    mockDB.rateMetas = rateMetas || {
        'CO-GR': { source: 'manual', updateTime: null, isAuto: false },
        'CO-WY': { source: 'manual', updateTime: null, isAuto: false },
        'CO-GW': { source: 'manual', updateTime: null, isAuto: false },
        'CO-LK': { source: 'manual', updateTime: null, isAuto: false }
    };
    mockDB.data = { orders: orders || [] };
    mockSave.mockClear();
    mockHandleError.mockClear();
}

jest.unstable_mockModule('../js/data.js', () => ({
    get DB() {
        return mockDB;
    }
}));

jest.unstable_mockModule('../js/utils.js', () => ({
    escapeHtml: s => String(s || ''),
    handleError: (...args) => mockHandleError(...args),
    toast: () => {},
    safeCall: async fn => fn(),
    validate: {
        required: () => null,
        positive: () => true,
        numeric: () => true,
        email: () => true,
        phoneCN: () => true,
        length: () => true,
        checkAll: () => []
    },
    EventBus: { on() {}, off() {}, emit() {} }
}));

const { Exchange } = await import('../js/exchange.js');
const { CONSTANTS } = await import('../js/constants.js');

describe('Exchange module', () => {
    beforeEach(() => {
        Exchange.stopAutoRefresh();
        setupMocks();
        delete window.App;
    });

    describe('isDomestic', () => {
        test('returns true for domestic companies', () => {
            expect(Exchange.isDomestic('CO-GR')).toBe(true);
            expect(Exchange.isDomestic('CO-WY')).toBe(true);
        });

        test('returns false for HK companies', () => {
            expect(Exchange.isDomestic('CO-GW')).toBe(false);
            expect(Exchange.isDomestic('CO-LK')).toBe(false);
        });

        test('returns false for unknown company', () => {
            expect(Exchange.isDomestic('CO-UNKNOWN')).toBe(false);
        });
    });

    describe('currency conversion', () => {
        test('converts USD to RMB correctly', () => {
            expect(Exchange.usdToRmb(100, 'CO-GR')).toBeCloseTo(725, 2);
            expect(Exchange.usdToRmb(100, 'CO-GW')).toBeCloseTo(780, 2);
        });

        test('converts RMB to USD correctly', () => {
            expect(Exchange.rmbToUsd(725, 'CO-GR')).toBeCloseTo(100, 2);
            expect(Exchange.rmbToUsd(780, 'CO-GW')).toBeCloseTo(100, 2);
        });

        test('converts zero amounts', () => {
            expect(Exchange.usdToRmb(0, 'CO-GR')).toBe(0);
            expect(Exchange.rmbToUsd(0, 'CO-GR')).toBe(0);
        });

        test('handles large amounts', () => {
            expect(Exchange.usdToRmb(100000, 'CO-GR')).toBeCloseTo(725000, 1);
        });
    });

    describe('currentRate', () => {
        test('returns DB exchange rate', () => {
            expect(Exchange.currentRate()).toBe(7.25);
        });
    });

    describe('calcOrderProfit', () => {
        test('calculates domestic profit with tax rebate (CO-GR)', () => {
            const profit = Exchange.calcOrderProfit(1000, 5000, 200, 13, 100, 'CO-GR');
            // revenue 7250 - factory 5000 - freight 1450 - insurance 94.25 - other 725 + rebate 575.22 = 555.97
            expect(profit).toBeCloseTo(555.97, 0);
        });

        test('calculates domestic profit with tax rebate (CO-WY)', () => {
            const profit = Exchange.calcOrderProfit(2000, 8000, 300, 13, 200, 'CO-WY');
            // revenue 14500 - factory 8000 - freight 2175 - insurance 94.25 - other 1450 + rebate 920.35 = 3701.10
            expect(profit).toBeCloseTo(3701.1, 0);
        });

        test('calculates HK profit without tax rebate (CO-GW)', () => {
            const profit = Exchange.calcOrderProfit(1000, 500, 0, 0, 50, 'CO-GW');
            expect(profit).toBeCloseTo(450, 2);
        });

        test('calculates HK profit without tax rebate (CO-LK)', () => {
            const profit = Exchange.calcOrderProfit(500, 200, 0, 0, 30, 'CO-LK');
            expect(profit).toBeCloseTo(270, 2);
        });

        test('returns zero for zero amounts', () => {
            const profit = Exchange.calcOrderProfit(0, 0, 0, 0, 0, 'CO-GR');
            expect(profit).toBe(0);
        });

        test('handles minimal amounts', () => {
            const profit = Exchange.calcOrderProfit(100, 50, 10, 13, 5, 'CO-GR');
            expect(typeof profit).toBe('number');
            expect(profit).not.toBeNaN();
        });

        test('domestic profit differs from HK for same inputs', () => {
            const domestic = Exchange.calcOrderProfit(1000, 5000, 200, 13, 100, 'CO-GR');
            const hk = Exchange.calcOrderProfit(1000, 5000, 200, 13, 100, 'CO-GW');
            expect(domestic).not.toBe(hk);
        });
    });

    describe('recalcAllOrders', () => {
        test('handles empty orders list', () => {
            expect(() => Exchange.recalcAllOrders()).not.toThrow();
        });

        test('recalculates profit for domestic and HK orders', () => {
            setupMocks(null, null, [
                {
                    id: 'O1',
                    companyId: 'CO-GR',
                    orderAmountUSD: 1000,
                    factoryCostRMB: 5000,
                    freightCostUSD: 200,
                    insuranceCostUSD: 13,
                    otherCostUSD: 100,
                    orderAmountRMB: 0,
                    profitRMB: 0,
                    profitRate: 0
                },
                {
                    id: 'O2',
                    companyId: 'CO-GW',
                    orderAmountUSD: 1000,
                    factoryCostRMB: 500,
                    freightCostUSD: 0,
                    insuranceCostUSD: 0,
                    otherCostUSD: 50,
                    orderAmountRMB: 0,
                    profitRMB: 0,
                    profitRate: 0
                }
            ]);
            Exchange.recalcAllOrders();
            const orders = mockDB.data.orders;
            expect(orders[0].profitRMB).not.toBe(0);
            expect(orders[0].orderAmountRMB).toBeGreaterThan(0);
            expect(orders[1].profitRMB).not.toBe(0);
            expect(orders[0].profitRate).not.toBe(0);
        });

        test('profit rate is zero when denominator is zero', () => {
            setupMocks(null, null, [
                {
                    id: 'O4',
                    companyId: 'CO-GR',
                    orderAmountUSD: 0,
                    factoryCostRMB: 0,
                    freightCostUSD: 0,
                    insuranceCostUSD: 0,
                    otherCostUSD: 0,
                    orderAmountRMB: 0,
                    profitRMB: 0,
                    profitRate: 0
                }
            ]);
            Exchange.recalcAllOrders();
            expect(mockDB.data.orders[0].profitRate).toBe(0);
        });

        test('rounds values to 2 decimal places', () => {
            setupMocks(null, null, [
                {
                    id: 'O5',
                    companyId: 'CO-GR',
                    orderAmountUSD: 1234.56,
                    factoryCostRMB: 5678.9,
                    freightCostUSD: 123.45,
                    insuranceCostUSD: 13,
                    otherCostUSD: 67.89,
                    orderAmountRMB: 0,
                    profitRMB: 0,
                    profitRate: 0
                }
            ]);
            Exchange.recalcAllOrders();
            const o = mockDB.data.orders[0];
            expect(o.profitRMB.toString()).toMatch(/^\d+(\.\d{1,2})?$/);
        });

        test('keeps formal and historical orders frozen when the live rate changes', () => {
            setupMocks(null, null, [
                {
                    id: 'FORMAL',
                    stage: 'native',
                    exchangeRateUsed: 6.8,
                    companyId: 'CO-GR',
                    orderAmountUSD: 1000,
                    factoryCostRMB: 5000,
                    freightCostUSD: 0,
                    insuranceCostUSD: 0,
                    otherCostUSD: 0,
                    orderAmountRMB: 6800,
                    profitRMB: 1800,
                    profitRate: 26.47
                },
                {
                    id: 'BRIEF',
                    stage: 'brief',
                    companyId: 'CO-GR',
                    orderAmountUSD: 1000,
                    factoryCostRMB: 5000,
                    freightCostUSD: 0,
                    insuranceCostUSD: 0,
                    otherCostUSD: 0,
                    orderAmountRMB: 0,
                    profitRMB: 0,
                    profitRate: 0
                }
            ]);

            const changed = Exchange.recalcAllOrders({ persist: false });

            expect(changed).toBe(1);
            expect(mockDB.data.orders[0]).toMatchObject({ orderAmountRMB: 6800, profitRMB: 1800 });
            expect(mockDB.data.orders[1].orderAmountRMB).toBe(7250);
            expect(mockSave).not.toHaveBeenCalled();
        });
    });

    describe('updateDisplay', () => {
        test('calls App.updateExchangeRateDisplay when App exists', () => {
            window.App = { updateExchangeRateDisplay: jest.fn() };
            Exchange.updateDisplay();
            expect(window.App.updateExchangeRateDisplay).toHaveBeenCalled();
        });

        test('does not throw when App does not exist', () => {
            expect(() => Exchange.updateDisplay()).not.toThrow();
        });
    });

    describe('CONSTANTS integration', () => {
        test('exchange rate bounds are imported', () => {
            expect(CONSTANTS.EXCHANGE_RATE_MIN).toBe(5);
            expect(CONSTANTS.EXCHANGE_RATE_MAX).toBe(10);
            expect(CONSTANTS.EXCHANGE_RATE_ADJUST).toBe(0.02);
        });
    });

    describe('fetchRate', () => {
        let origFetch;

        beforeEach(() => {
            origFetch = global.fetch;
        });

        afterEach(() => {
            global.fetch = origFetch;
        });

        test('fetchRate resolves with success when API returns valid rate', async () => {
            global.fetch = jest.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 7.28 } })
                })
            );
            const result = await Exchange.fetchRate();
            expect(result.success).toBe(true);
            expect(result.rate).toBeCloseTo(7.26, 2);
            expect(result.source).toBe('ExchangeRate-API');
            // Verify rate was saved
            expect(mockDB.exchangeRates['CO-GR']).toBeCloseTo(7.26, 2);
        });

        test('fetchRate tries second API if first fails', async () => {
            global.fetch = jest
                .fn()
                .mockImplementationOnce(() => Promise.reject(new Error('Network error')))
                .mockImplementationOnce(() =>
                    Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ rates: { CNY: 7.3 } })
                    })
                );
            const result = await Exchange.fetchRate();
            expect(result.success).toBe(true);
            expect(result.source).toBe('Open Exchange Rates');
        });

        test('fetchRate returns failure when all APIs fail', async () => {
            global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));
            const result = await Exchange.fetchRate();
            expect(result.success).toBe(false);
            expect(result.error).toContain('不可用');
        });

        test('fetchRate rejects invalid rates (out of bounds)', async () => {
            global.fetch = jest
                .fn()
                .mockImplementationOnce(() =>
                    Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ rates: { CNY: 1.5 } })
                    })
                )
                .mockImplementationOnce(() =>
                    Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ rates: { CNY: 2.0 } })
                    })
                );
            const result = await Exchange.fetchRate();
            expect(result.success).toBe(false);
            expect(result.error).toContain('不可用');
        });

        test('fetchRate handles non-ok HTTP responses', async () => {
            global.fetch = jest
                .fn()
                .mockImplementationOnce(() => Promise.resolve({ ok: false }))
                .mockImplementationOnce(() =>
                    Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ rates: { CNY: 7.25 } })
                    })
                );
            const result = await Exchange.fetchRate();
            expect(result.success).toBe(true);
        });

        test('fetchRate saves rate meta on success', async () => {
            global.fetch = jest.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 7.25 } })
                })
            );
            await Exchange.fetchRate();
            const meta = mockDB.rateMetas['CO-GR'];
            expect(meta.isAuto).toBe(true);
            expect(meta.source).toBe('实时汇率');
            expect(meta.updateTime).toBeTruthy();
        });
    });

    describe('BusinessAPI live rate', () => {
        const livePayload = overrides => ({
            base: 'USD',
            quote: 'CNY',
            rawRate: 7.28,
            adjustment: -0.02,
            adjustedRate: 7.26,
            provider: 'ExchangeRate-API',
            source: 'open.er-api.com',
            publishedAt: '2026-10-12T00:00:00.000Z',
            fetchedAt: '2026-10-12T01:00:00.000Z',
            nextUpdateAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            cached: false,
            stale: false,
            ...overrides
        });

        beforeEach(() => {
            mockDB.currentCompanyId = 'CN-A';
            mockDB.companies = [
                { id: 'CN-A', settlementCurrency: 'CNY' },
                { id: 'USD-B', settlementCurrency: 'USD' }
            ];
            mockDB.exchangeRates = { 'CN-A': 6.5, 'USD-B': 1 };
            mockDB.rateMetas = {};
            mockDB._businessAPI = { getExchangeRate: jest.fn(() => Promise.resolve(livePayload())) };
        });

        afterEach(() => {
            Exchange.stopAutoRefresh();
            jest.useRealTimers();
        });

        test('uses the same-origin service and applies the effective rate only to CNY companies', async () => {
            const result = await Exchange.fetchRate({ recalculate: false });

            expect(mockDB._businessAPI.getExchangeRate).toHaveBeenCalledTimes(1);
            expect(result).toMatchObject({
                success: true,
                rate: 7.26,
                rawRate: 7.28,
                adjustedRate: 7.26,
                source: 'open.er-api.com',
                cached: false,
                stale: false
            });
            expect(mockDB.liveExchangeRates['CN-A']).toBe(7.26);
            expect(mockDB.exchangeRates['CN-A']).toBe(7.26);
            expect(mockDB.exchangeRates['USD-B']).toBe(1);
            expect(mockDB.liveRateMetas['CN-A']).toMatchObject({
                publishedAt: '2026-10-12T00:00:00.000Z',
                fetchedAt: '2026-10-12T01:00:00.000Z',
                provider: 'ExchangeRate-API',
                source: 'open.er-api.com',
                effectiveRate: 7.26,
                stale: false
            });
            expect(mockSave).not.toHaveBeenCalled();
        });

        test('refreshes brief projections but leaves native order amounts frozen', async () => {
            mockDB.data.orders = [
                {
                    id: 'NATIVE',
                    stage: 'native',
                    exchangeRateUsed: 6.5,
                    companyId: 'CN-A',
                    orderAmountUSD: 1000,
                    factoryCostRMB: 5000,
                    freightCostUSD: 0,
                    insuranceCostUSD: 0,
                    otherCostUSD: 0,
                    orderAmountRMB: 6500,
                    profitRMB: 1500,
                    profitRate: 23.08
                },
                {
                    id: 'BRIEF',
                    stage: 'brief',
                    companyId: 'CN-A',
                    orderAmountUSD: 1000,
                    factoryCostRMB: 5000,
                    freightCostUSD: 0,
                    insuranceCostUSD: 0,
                    otherCostUSD: 0,
                    orderAmountRMB: 0,
                    profitRMB: 0,
                    profitRate: 0
                }
            ];

            await Exchange.fetchRate();

            expect(mockDB.data.orders[0]).toMatchObject({ orderAmountRMB: 6500, profitRMB: 1500 });
            expect(mockDB.data.orders[1].orderAmountRMB).toBe(7260);
            expect(mockSave).not.toHaveBeenCalled();
        });

        test('rejects a response whose effective rate does not equal raw rate minus 0.02', async () => {
            mockDB._businessAPI.getExchangeRate.mockResolvedValue(livePayload({ adjustedRate: 7.2 }));

            const result = await Exchange.fetchRate({ recalculate: false });

            expect(result.success).toBe(false);
            expect(result.stale).toBe(true);
            expect(mockDB.exchangeRates['CN-A']).toBe(6.5);
            expect(mockDB.liveRateMetas['CN-A'].error).toContain('口径无效');
        });

        test('does not request again before nextUpdateAt', async () => {
            await Exchange.fetchRate({ recalculate: false });
            mockDB._businessAPI.getExchangeRate.mockClear();

            const result = await Exchange.autoFetchIfStale();

            expect(mockDB._businessAPI.getExchangeRate).not.toHaveBeenCalled();
            expect(result).toMatchObject({ success: true, rate: 7.26, cached: true, rawRate: 7.28 });
        });

        test('schedules one refresh at nextUpdateAt instead of hourly polling', async () => {
            jest.useFakeTimers();
            const nextUpdateAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
            mockDB._businessAPI.getExchangeRate.mockResolvedValue(livePayload({ nextUpdateAt }));
            await Exchange.fetchRate({ recalculate: false });
            mockDB._businessAPI.getExchangeRate.mockClear();

            Exchange.startAutoRefresh({ skipInitial: true });
            expect(Exchange.getNextRefreshTime()).toBe(nextUpdateAt);
            await jest.advanceTimersByTimeAsync(CONSTANTS.ONE_HOUR_MS);
            expect(mockDB._businessAPI.getExchangeRate).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(CONSTANTS.ONE_HOUR_MS);
            expect(mockDB._businessAPI.getExchangeRate).toHaveBeenCalledTimes(1);
        });

        test('backs off five minutes when a stale publication has an expired nextUpdateAt', async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-10-12T08:00:00.000Z'));
            const expiredProviderTime = '2026-10-12T07:00:00.000Z';
            mockDB._businessAPI.getExchangeRate.mockResolvedValue(
                livePayload({ cached: true, stale: true, nextUpdateAt: expiredProviderTime })
            );

            const first = await Exchange.fetchRate({ recalculate: false });
            const expectedRetry = '2026-10-12T08:05:00.000Z';
            expect(first.nextUpdateAt).toBe(expiredProviderTime);
            expect(first.scheduledRefreshAt).toBe(expectedRetry);
            expect(first.systemNextCheckAt).toBe(expectedRetry);
            mockDB._businessAPI.getExchangeRate.mockClear();

            Exchange.startAutoRefresh({ skipInitial: true });
            expect(Exchange.getNextRefreshTime()).toBe(expectedRetry);
            await jest.advanceTimersByTimeAsync(CONSTANTS.EXCHANGE_REFRESH_MIN_DELAY_MS);
            expect(mockDB._businessAPI.getExchangeRate).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(
                CONSTANTS.EXCHANGE_FAILURE_RETRY_MS - CONSTANTS.EXCHANGE_REFRESH_MIN_DELAY_MS
            );
            expect(mockDB._businessAPI.getExchangeRate).toHaveBeenCalledTimes(1);
        });
    });

    describe('autoFetchIfStale', () => {
        let origFetch;

        beforeEach(() => {
            origFetch = global.fetch;
        });

        afterEach(() => {
            global.fetch = origFetch;
        });

        test('fetches when there is no previous rate meta', async () => {
            mockDB.rateMetas = {};
            global.fetch = jest.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 7.28 } })
                })
            );
            await Exchange.autoFetchIfStale();
            // Should have fetched (rate was saved)
            expect(mockDB.exchangeRates['CO-GR']).toBeCloseTo(7.26, 2);
        });

        test('fetches when rate is older than 1 hour', async () => {
            mockDB.rateMetas['CO-GR'] = {
                updateTime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
                isAuto: true
            };
            global.fetch = jest.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 7.3 } })
                })
            );
            await Exchange.autoFetchIfStale();
            expect(mockDB.exchangeRates['CO-GR']).toBeCloseTo(7.28, 2);
        });

        test('skips fetch when rate is fresh (less than 1 hour old)', async () => {
            mockDB.rateMetas['CO-GR'] = {
                updateTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
                isAuto: true
            };
            const fetchSpy = jest.fn();
            global.fetch = fetchSpy;
            await Exchange.autoFetchIfStale();
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });

    describe('recalcAllOrders edge', () => {
        test('handles DB.save failure gracefully', () => {
            const originalSave = mockDB.save;
            const saveError = new Error('保存失败');
            mockDB.save = jest.fn(() => Promise.reject(saveError));

            // Should not throw
            expect(() => Exchange.recalcAllOrders()).not.toThrow();

            mockDB.save = originalSave;
        });
    });

    // ==================== 自动刷新功能测试 ====================

    describe('_fetchRawRate', () => {
        let origFetch;

        beforeEach(() => {
            origFetch = global.fetch;
        });
        afterEach(() => {
            global.fetch = origFetch;
        });

        test('returns rate data on success', async () => {
            global.fetch = jest.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 7.28 } })
                })
            );
            const result = await Exchange._fetchRawRate();
            expect(result).toBeTruthy();
            expect(result.rawRate).toBe(7.28);
            expect(result.adjustedRate).toBeCloseTo(7.26, 2);
            expect(result.source).toBe('ExchangeRate-API');
        });

        test('returns null when all APIs fail', async () => {
            global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));
            const result = await Exchange._fetchRawRate();
            expect(result).toBeNull();
        });

        test('skips invalid rates and tries next API', async () => {
            global.fetch = jest
                .fn()
                .mockImplementationOnce(() =>
                    Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ rates: { CNY: 999 } }) // out of bounds
                    })
                )
                .mockImplementationOnce(() =>
                    Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ rates: { CNY: 7.28 } })
                    })
                );
            const result = await Exchange._fetchRawRate();
            expect(result).toBeTruthy();
            expect(result.source).toBe('Open Exchange Rates');
        });
    });

    describe('_autoRefreshAll', () => {
        let origFetch;

        beforeEach(() => {
            origFetch = global.fetch;
            setupMocks();
        });
        afterEach(() => {
            global.fetch = origFetch;
        });

        test('applies rate to all domestic companies', async () => {
            global.fetch = jest.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 7.35 } })
                })
            );
            await Exchange._autoRefreshAll();
            // Both domestic companies should have the new rate
            expect(mockDB.exchangeRates['CO-GR']).toBeCloseTo(7.33, 2);
            expect(mockDB.exchangeRates['CO-WY']).toBeCloseTo(7.33, 2);
            // HK companies should remain unchanged
            expect(mockDB.exchangeRates['CO-GW']).toBe(7.8);
            expect(mockDB.exchangeRates['CO-LK']).toBe(7.8);
        });

        test('sets meta for all domestic companies', async () => {
            global.fetch = jest.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 7.3 } })
                })
            );
            await Exchange._autoRefreshAll();
            expect(mockDB.rateMetas['CO-GR'].isAuto).toBe(true);
            expect(mockDB.rateMetas['CO-GR'].source).toBe('自动刷新');
            expect(mockDB.rateMetas['CO-WY'].isAuto).toBe(true);
            expect(mockDB.rateMetas['CO-WY'].source).toBe('自动刷新');
        });

        test('recalculates all orders after refresh', async () => {
            setupMocks(null, null, [
                {
                    id: 'O1',
                    companyId: 'CO-GR',
                    orderAmountUSD: 1000,
                    factoryCostRMB: 5000,
                    freightCostUSD: 200,
                    insuranceCostUSD: 13,
                    otherCostUSD: 100,
                    orderAmountRMB: 0,
                    profitRMB: 0,
                    profitRate: 0
                }
            ]);
            global.fetch = jest.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 7.25 } })
                })
            );
            await Exchange._autoRefreshAll();
            expect(mockDB.data.orders[0].profitRMB).not.toBe(0);
        });

        test('returns failure when all APIs fail', async () => {
            global.fetch = jest.fn(() => Promise.reject(new Error('Network error')));
            const result = await Exchange._autoRefreshAll();
            expect(result.success).toBe(false);
            expect(result.error).toContain('不可用');
        });

        test('updates _lastAutoRefresh timestamp', async () => {
            global.fetch = jest.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 7.2 } })
                })
            );
            const before = Date.now();
            await Exchange._autoRefreshAll();
            expect(Exchange._lastAutoRefresh).toBeGreaterThanOrEqual(before);
        });
    });

    describe('startAutoRefresh / stopAutoRefresh', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            Exchange.stopAutoRefresh(); // ensure clean state
            setupMocks();
        });
        afterEach(() => {
            jest.useRealTimers();
            Exchange.stopAutoRefresh();
        });

        test('startAutoRefresh activates auto-refresh', () => {
            Exchange.startAutoRefresh();
            expect(Exchange.isAutoRefreshActive()).toBe(true);
            expect(Exchange._autoRefreshTimer).toBeTruthy();
        });

        test('stopAutoRefresh deactivates auto-refresh', () => {
            Exchange.startAutoRefresh();
            Exchange.stopAutoRefresh();
            expect(Exchange.isAutoRefreshActive()).toBe(false);
            expect(Exchange._autoRefreshTimer).toBeNull();
        });

        test('startAutoRefresh prevents duplicate timers', () => {
            Exchange.startAutoRefresh();
            const firstTimer = Exchange._autoRefreshTimer;
            Exchange.startAutoRefresh(); // second call
            const secondTimer = Exchange._autoRefreshTimer;
            expect(firstTimer).not.toBe(secondTimer); // old timer cleared, new one created
            expect(Exchange.isAutoRefreshActive()).toBe(true);
        });

        test('getNextRefreshTime returns null when not active', () => {
            Exchange.stopAutoRefresh();
            Exchange._lastAutoRefresh = null;
            expect(Exchange.getNextRefreshTime()).toBeNull();
        });

        test('getNextRefreshTime returns ~1 hour from last refresh', () => {
            Exchange._lastAutoRefresh = Date.now();
            Exchange._autoRefreshTimer = { _idleTimeout: 123 }; // mock non-null timer
            const nextTime = Exchange.getNextRefreshTime();
            const expected = Date.now() + CONSTANTS.ONE_HOUR_MS;
            expect(Math.abs(new Date(nextTime).getTime() - expected)).toBeLessThan(1000);
        });

        test('stopAutoRefresh is idempotent', () => {
            Exchange._autoRefreshTimer = null;
            expect(() => Exchange.stopAutoRefresh()).not.toThrow();
        });
    });

    describe('autoFetchIfStale (behavior unchanged)', () => {
        test('returns cached:true when rate is fresh', async () => {
            mockDB.rateMetas['CO-GR'] = {
                updateTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
                isAuto: true
            };
            const fetchSpy = jest.fn();
            global.fetch = fetchSpy;
            const result = await Exchange.autoFetchIfStale();
            expect(result.success).toBe(true);
            expect(result.cached).toBe(true);
        });
    });
});
