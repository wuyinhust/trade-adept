/**
 * @file constants.test.js
 * 全局常量定义测试
 */
import { CONSTANTS } from '../js/constants.js';

describe('CONSTANTS', () => {
    test('default exchange rates', () => {
        expect(CONSTANTS.DEFAULT_EXCHANGE_RATE).toBe(7.25);
        expect(CONSTANTS.HK_EXCHANGE_RATE).toBe(7.80);
    });

    test('time constants in milliseconds', () => {
        expect(CONSTANTS.INIT_TIMEOUT_MS).toBe(10000);
        expect(CONSTANTS.POLL_INTERVAL_MS).toBe(10000);
        expect(CONSTANTS.POLL_SKIP_WINDOW_MS).toBe(3000);
        expect(CONSTANTS.SAVE_DEBOUNCE_MS).toBe(500);
        expect(CONSTANTS.ONE_HOUR_MS).toBe(3600000);
    });

    test('exchange rate validation bounds', () => {
        expect(CONSTANTS.EXCHANGE_RATE_MIN).toBe(5);
        expect(CONSTANTS.EXCHANGE_RATE_MAX).toBe(10);
        expect(CONSTANTS.EXCHANGE_RATE_ADJUST).toBe(0.02);
    });

    test('company codes', () => {
        expect(CONSTANTS.COMPANY_DOMESTIC).toContain('CO-GR');
        expect(CONSTANTS.COMPANY_DOMESTIC).toContain('CO-WY');
        expect(CONSTANTS.COMPANY_HK).toContain('CO-GW');
        expect(CONSTANTS.COMPANY_HK).toContain('CO-LK');
    });

    test('security constants', () => {
        expect(CONSTANTS.MAX_LOGIN_ATTEMPTS).toBe(5);
        expect(CONSTANTS.LOCKOUT_DURATION_MS).toBe(15 * 60 * 1000);
    });

    test('data limits', () => {
        expect(CONSTANTS.MAX_BACKUP_AGE_DAYS).toBe(7);
        expect(CONSTANTS.IMPORT_PREVIEW_LIMIT).toBe(20);
        expect(CONSTANTS.DEFAULT_PAGE_SIZE).toBe(50);
    });

    test('legacy rate for migration', () => {
        expect(CONSTANTS.LEGACY_DEFAULT_RATE).toBe(7.2);
    });
});
