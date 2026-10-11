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
    exchangeRates: { 'CO-GR': 7.25, 'CO-WY': 7.25, 'CO-GW': 7.80, 'CO-LK': 7.80 },
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
        return this.rateMetas[id] || { source: 'manual', updateTime: null, isAuto: false };
    },
    save: mockSave,
    data: { orders: [] }
};

/** Reset mockDB to fresh state for tests */
function setupMocks(exchangeRates, rateMetas, orders) {
    mockDB.exchangeRates = exchangeRates || { 'CO-GR': 7.25, 'CO-WY': 7.25, 'CO-GW': 7.80, 'CO-LK': 7.80 };
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
    get DB() { return mockDB; }
}));

jest.unstable_mockModule('../js/utils.js', () => ({
    escapeHtml: (s) => String(s || ''),
    handleError: (...args) => mockHandleError(...args),
    toast: () => {},
    safeCall: async (fn) => fn(),
    validate: { required: () => null, positive: () => true, numeric: () => true, email: () => true, phoneCN: () => true, length: () => true, checkAll: () => [] },
    EventBus: { on() {}, off() {}, emit() {} }
}));

const { Exchange } = await import('../js/exchange.js');
const { CONSTANTS } = await import('../js/constants.js');

describe('Exchange module', () => {
    beforeEach(() => {
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
            expect(profit).toBeCloseTo(3701.10, 0);
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
                { id: 'O1', companyId: 'CO-GR', orderAmountUSD: 1000, factoryCostRMB: 5000,
                  freightCostUSD: 200, insuranceCostUSD: 13, otherCostUSD: 100,
                  orderAmountRMB: 0, profitRMB: 0, profitRate: 0 },
                { id: 'O2', companyId: 'CO-GW', orderAmountUSD: 1000, factoryCostRMB: 500,
                  freightCostUSD: 0, insuranceCostUSD: 0, otherCostUSD: 50,
                  orderAmountRMB: 0, profitRMB: 0, profitRate: 0 }
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
                { id: 'O4', companyId: 'CO-GR', orderAmountUSD: 0, factoryCostRMB: 0,
                  freightCostUSD: 0, insuranceCostUSD: 0, otherCostUSD: 0,
                  orderAmountRMB: 0, profitRMB: 0, profitRate: 0 }
            ]);
            Exchange.recalcAllOrders();
            expect(mockDB.data.orders[0].profitRate).toBe(0);
        });

        test('rounds values to 2 decimal places', () => {
            setupMocks(null, null, [
                { id: 'O5', companyId: 'CO-GR', orderAmountUSD: 1234.56, factoryCostRMB: 5678.90,
                  freightCostUSD: 123.45, insuranceCostUSD: 13, otherCostUSD: 67.89,
                  orderAmountRMB: 0, profitRMB: 0, profitRate: 0 }
            ]);
            Exchange.recalcAllOrders();
            const o = mockDB.data.orders[0];
            expect(o.profitRMB.toString()).toMatch(/^\d+(\.\d{1,2})?$/);
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
            global.fetch = jest.fn(() => Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ rates: { CNY: 7.28 } })
            }));
            const result = await Exchange.fetchRate();
            expect(result.success).toBe(true);
            expect(result.rate).toBeCloseTo(7.26, 2);
            expect(result.source).toBe('ExchangeRate-API');
            // Verify rate was saved
            expect(mockDB.exchangeRates['CO-GR']).toBeCloseTo(7.26, 2);
        });

        test('fetchRate tries second API if first fails', async () => {
            global.fetch = jest.fn()
                .mockImplementationOnce(() => Promise.reject(new Error('Network error')))
                .mockImplementationOnce(() => Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 7.30 } })
                }));
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
            global.fetch = jest.fn()
                .mockImplementationOnce(() => Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 1.5 } })
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 2.0 } })
                }));
            const result = await Exchange.fetchRate();
            expect(result.success).toBe(false);
            expect(result.error).toContain('不可用');
        });

        test('fetchRate handles non-ok HTTP responses', async () => {
            global.fetch = jest.fn()
                .mockImplementationOnce(() => Promise.resolve({ ok: false }))
                .mockImplementationOnce(() => Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 7.25 } })
                }));
            const result = await Exchange.fetchRate();
            expect(result.success).toBe(true);
        });

        test('fetchRate saves rate meta on success', async () => {
            global.fetch = jest.fn(() => Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ rates: { CNY: 7.25 } })
            }));
            await Exchange.fetchRate();
            const meta = mockDB.rateMetas['CO-GR'];
            expect(meta.isAuto).toBe(true);
            expect(meta.source).toBe('实时汇率');
            expect(meta.updateTime).toBeTruthy();
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
            global.fetch = jest.fn(() => Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ rates: { CNY: 7.28 } })
            }));
            await Exchange.autoFetchIfStale();
            // Should have fetched (rate was saved)
            expect(mockDB.exchangeRates['CO-GR']).toBeCloseTo(7.26, 2);
        });

        test('fetches when rate is older than 1 hour', async () => {
            mockDB.rateMetas['CO-GR'] = {
                updateTime: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
                isAuto: true
            };
            global.fetch = jest.fn(() => Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ rates: { CNY: 7.30 } })
            }));
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

        beforeEach(() => { origFetch = global.fetch; });
        afterEach(() => { global.fetch = origFetch; });

        test('returns rate data on success', async () => {
            global.fetch = jest.fn(() => Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ rates: { CNY: 7.28 } })
            }));
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
            global.fetch = jest.fn()
                .mockImplementationOnce(() => Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 999 } }) // out of bounds
                }))
                .mockImplementationOnce(() => Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ rates: { CNY: 7.28 } })
                }));
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
        afterEach(() => { global.fetch = origFetch; });

        test('applies rate to all domestic companies', async () => {
            global.fetch = jest.fn(() => Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ rates: { CNY: 7.35 } })
            }));
            await Exchange._autoRefreshAll();
            // Both domestic companies should have the new rate
            expect(mockDB.exchangeRates['CO-GR']).toBeCloseTo(7.33, 2);
            expect(mockDB.exchangeRates['CO-WY']).toBeCloseTo(7.33, 2);
            // HK companies should remain unchanged
            expect(mockDB.exchangeRates['CO-GW']).toBe(7.80);
            expect(mockDB.exchangeRates['CO-LK']).toBe(7.80);
        });

        test('sets meta for all domestic companies', async () => {
            global.fetch = jest.fn(() => Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ rates: { CNY: 7.30 } })
            }));
            await Exchange._autoRefreshAll();
            expect(mockDB.rateMetas['CO-GR'].isAuto).toBe(true);
            expect(mockDB.rateMetas['CO-GR'].source).toBe('自动刷新');
            expect(mockDB.rateMetas['CO-WY'].isAuto).toBe(true);
            expect(mockDB.rateMetas['CO-WY'].source).toBe('自动刷新');
        });

        test('recalculates all orders after refresh', async () => {
            setupMocks(null, null, [
                { id: 'O1', companyId: 'CO-GR', orderAmountUSD: 1000, factoryCostRMB: 5000,
                  freightCostUSD: 200, insuranceCostUSD: 13, otherCostUSD: 100,
                  orderAmountRMB: 0, profitRMB: 0, profitRate: 0 }
            ]);
            global.fetch = jest.fn(() => Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ rates: { CNY: 7.25 } })
            }));
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
            global.fetch = jest.fn(() => Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ rates: { CNY: 7.20 } })
            }));
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
