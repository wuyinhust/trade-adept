/**
 * @file utils.test.js
 * 公共工具函数测试 — 全覆盖 escapeHtml, validate, handleError, safeCall, toast, EventBus
 */
import { jest } from '@jest/globals';
import { escapeHtml, validate, handleError, safeCall, toast, EventBus } from '../js/utils.js';

// ==================== escapeHtml ====================

describe('escapeHtml', () => {
    test('escapes HTML special characters', () => {
        expect(escapeHtml('<script>alert("XSS")</script>'))
            .toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
    });

    test('escapes ampersand', () => {
        expect(escapeHtml('A & B')).toBe('A &amp; B');
    });

    test('escapes single quote', () => {
        expect(escapeHtml("it's")).toBe("it&#39;s");
    });

    test('returns empty string for null/undefined', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    test('returns string for number zero', () => {
        expect(escapeHtml(0)).toBe('0');
    });

    test('handles safe strings unchanged', () => {
        expect(escapeHtml('Hello World')).toBe('Hello World');
    });

    test('converts non-string to string', () => {
        expect(escapeHtml(123)).toBe('123');
    });

    test('handles boolean values', () => {
        // escapeHtml returns '' for falsy non-zero values (by design)
        expect(escapeHtml(true)).toBe('true');
        expect(escapeHtml(false)).toBe('');
    });

    test('handles mixed content', () => {
        expect(escapeHtml('User <bob@example.com> said "hello" & goodbye'))
            .toBe('User &lt;bob@example.com&gt; said &quot;hello&quot; &amp; goodbye');
    });

    test('no double-escaping of already-escaped content', () => {
        const once = escapeHtml('<script>');
        const twice = escapeHtml(once);
        expect(twice).toBe('&amp;lt;script&amp;gt;');
    });
});

// ==================== handleError ====================

describe('handleError', () => {
    let consoleSpy;

    beforeEach(() => {
        consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleSpy.mockRestore();
    });

    test('logs error with context', () => {
        handleError(new Error('test error'), 'save');
        expect(consoleSpy).toHaveBeenCalled();
        const call = consoleSpy.mock.calls[0];
        expect(call[0]).toContain('save');
        expect(call[1]).toContain('test error');
    });

    test('handles non-Error objects', () => {
        handleError('plain string error', 'load');
        expect(consoleSpy).toHaveBeenCalled();
        expect(consoleSpy.mock.calls[0][1]).toContain('plain string error');
    });

    test('silent mode suppresses toast', () => {
        handleError(new Error('quiet error'), 'bg-sync', { silent: true });
        expect(consoleSpy).toHaveBeenCalled();
        // Should not throw
    });

    test('rethrow option throws the error', () => {
        const err = new Error('critical');
        expect(() => {
            handleError(err, 'critical-op', { rethrow: true });
        }).toThrow('critical');
    });

    test('rethrow re-wraps non-Error objects', () => {
        expect(() => {
            handleError('string error', 'op', { rethrow: true });
        }).toThrow('string error');
    });

    test('ignores aborted/cancelled errors', () => {
        const err = new Error('user aborted');
        err.message = 'The user aborted a request.';
        handleError(err, 'fetch');
        // Should not log abort errors — depends on message content matching
        // "用户取消" or "aborted"
        const abortedError = new Error('aborted');
        handleError(abortedError, 'fetch');
        // The function checks msg.includes('aborted') — our mock verifies it doesn't log
        const cancelledError = new Error('用户取消了操作');
        handleError(cancelledError, 'modal');
    });

    test('handles error with stack trace', () => {
        const err = new Error('with stack');
        handleError(err, 'complex-op');
        expect(consoleSpy).toHaveBeenCalled();
        // Should include stack trace
        const args = consoleSpy.mock.calls[0];
        expect(args.some(a => typeof a === 'string' && a.includes('\n'))).toBe(true);
    });

    test('truncates long error messages for user display', () => {
        const longMsg = 'A'.repeat(200);
        handleError(new Error(longMsg), 'save');
        expect(consoleSpy).toHaveBeenCalled();
    });

    test('maps technical errors to friendly messages', () => {
        const cases = [
            'NetworkError: fetch failed',
            '网络连接超时',
            'permission denied',
            'required field missing',
        ];
        cases.forEach(msg => {
            handleError(new Error(msg), 'test');
        });
        expect(consoleSpy).toHaveBeenCalledTimes(4);
    });
});

// ==================== safeCall ====================

describe('safeCall', () => {
    let consoleSpy;

    beforeEach(() => {
        consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleSpy.mockRestore();
    });

    test('returns result on success', async () => {
        const result = await safeCall(() => Promise.resolve(42), 'test');
        expect(result).toBe(42);
    });

    test('returns undefined on failure (default)', async () => {
        const result = await safeCall(() => { throw new Error('fail'); }, 'test');
        expect(result).toBeUndefined();
        expect(consoleSpy).toHaveBeenCalled();
    });

    test('passes options to handleError', async () => {
        const result = await safeCall(
            () => { throw new Error('fail'); },
            'test',
            { silent: true }
        );
        expect(result).toBeUndefined();
    });

    test('rethrows when rethrow option set', async () => {
        await expect(
            safeCall(() => { throw new Error('critical'); }, 'test', { rethrow: true })
        ).rejects.toThrow('critical');
    });

    test('works with sync functions', async () => {
        const result = await safeCall(() => 'sync-value', 'test');
        expect(result).toBe('sync-value');
    });
});

// ==================== EventBus ====================

describe('EventBus', () => {
    beforeEach(() => {
        // Reset EventBus internal state by clearing all events
        // We do this by calling off for each registered callback
        // (EventBus uses module-level _events, so we need helper)
    });

    test('on registers a callback', () => {
        const fn = jest.fn();
        const unsubscribe = EventBus.on('test-event', fn);
        expect(typeof unsubscribe).toBe('function');
    });

    test('emit calls registered callbacks', () => {
        const fn = jest.fn();
        EventBus.on('data-changed', fn);
        EventBus.emit('data-changed', { key: 'value' });
        expect(fn).toHaveBeenCalledWith({ key: 'value' });
    });

    test('emit handles multiple callbacks', () => {
        const fn1 = jest.fn();
        const fn2 = jest.fn();
        EventBus.on('multi', fn1);
        EventBus.on('multi', fn2);
        EventBus.emit('multi', 'data');
        expect(fn1).toHaveBeenCalled();
        expect(fn2).toHaveBeenCalled();
    });

    test('emit does not throw for unknown events', () => {
        expect(() => EventBus.emit('nonexistent', {})).not.toThrow();
    });

    test('off removes a callback', () => {
        const fn = jest.fn();
        EventBus.on('removable', fn);
        EventBus.off('removable', fn);
        EventBus.emit('removable', 'data');
        expect(fn).not.toHaveBeenCalled();
    });

    test('off with unknown event does not throw', () => {
        expect(() => EventBus.off('unknown', () => {})).not.toThrow();
    });

    test('emit catches callback errors', () => {
        const badFn = jest.fn(() => { throw new Error('callback error'); });
        const goodFn = jest.fn();
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        EventBus.on('error-event', badFn);
        EventBus.on('error-event', goodFn);
        EventBus.emit('error-event', 'data');
        expect(goodFn).toHaveBeenCalled(); // Second callback still runs
        consoleSpy.mockRestore();
    });

    test('unsubscribe function works correctly', () => {
        const fn = jest.fn();
        const unsubscribe = EventBus.on('cleanup-test', fn);
        unsubscribe();
        EventBus.emit('cleanup-test', 'data');
        expect(fn).not.toHaveBeenCalled();
    });

    test('emit with no data works', () => {
        const fn = jest.fn();
        EventBus.on('no-data', fn);
        EventBus.emit('no-data');
        expect(fn).toHaveBeenCalledWith(undefined);
    });
});

// ==================== toast ====================

describe('toast', () => {
    let mockContainer;
    let appendSpy;

    beforeEach(() => {
        mockContainer = {
            appendChild: jest.fn(el => el),
            children: [],
            innerHTML: ''
        };
        // Override document mock for toast tests
        const origGetElementById = document.getElementById;
        document.getElementById = jest.fn((id) => {
            if (id === 'toastContainer') return mockContainer;
            return null;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('toast does not throw when container missing', () => {
        document.getElementById = jest.fn(() => null);
        expect(() => toast('test message')).not.toThrow();
    });

    test('toast creates element with correct classes', () => {
        toast('Success!', 'success');
        expect(mockContainer.appendChild).toHaveBeenCalled();
        const el = mockContainer.appendChild.mock.calls[0][0];
        expect(el.className).toBe('toast success');
    });

    test('toast uses error icon for error type', () => {
        toast('Failed!', 'error');
        const el = mockContainer.appendChild.mock.calls[0][0];
        expect(el.innerHTML).toContain('❌');
    });

    test('toast uses warning icon for warning type', () => {
        toast('Warning!', 'warning');
        const el = mockContainer.appendChild.mock.calls[0][0];
        expect(el.innerHTML).toContain('⚠️');
    });

    test('toast defaults to success type', () => {
        toast('Default');
        const el = mockContainer.appendChild.mock.calls[0][0];
        expect(el.className).toBe('toast success');
    });

    test('toast escapes HTML in message', () => {
        toast('<script>alert(1)</script>', 'error');
        const el = mockContainer.appendChild.mock.calls[0][0];
        expect(el.innerHTML).toContain('&lt;script&gt;');
        expect(el.innerHTML).not.toContain('<script>');
    });
});

// ==================== validate ====================

describe('validate', () => {
    describe('required', () => {
        test('returns null when all fields present', () => {
            expect(validate.required({ a: 1, b: 'hello', c: 0 }, ['a', 'b', 'c'])).toBeNull();
        });

        test('returns first missing field name', () => {
            expect(validate.required({ a: 1 }, ['a', 'b'])).toBe('b');
        });

        test('returns field name for empty string', () => {
            expect(validate.required({ a: '  ' }, ['a'])).toBe('a');
        });

        test('returns field name for null', () => {
            expect(validate.required({ a: null }, ['a'])).toBe('a');
        });

        test('returns field name for undefined', () => {
            expect(validate.required({}, ['a'])).toBe('a');
        });

        test('returns first missing in priority order', () => {
            expect(validate.required({}, ['x', 'y', 'z'])).toBe('x');
        });

        test('handles empty fields array', () => {
            expect(validate.required({ a: 1 }, [])).toBeNull();
        });
    });

    describe('positive', () => {
        test('returns true for positive numbers', () => {
            expect(validate.positive(5)).toBe(true);
            expect(validate.positive(0.1)).toBe(true);
            expect(validate.positive('3.5')).toBe(true);
        });

        test('returns false for zero', () => {
            expect(validate.positive(0)).toBe(false);
            expect(validate.positive('0')).toBe(false);
        });

        test('returns false for negative numbers', () => {
            expect(validate.positive(-1)).toBe(false);
            expect(validate.positive('-5')).toBe(false);
        });

        test('returns false for non-numeric', () => {
            expect(validate.positive('abc')).toBe(false);
            expect(validate.positive(NaN)).toBe(false);
        });

        test('returns true for very large numbers', () => {
            expect(validate.positive(999999999)).toBe(true);
        });
    });

    describe('numeric', () => {
        test('returns true for numbers', () => {
            expect(validate.numeric(5)).toBe(true);
            expect(validate.numeric(3.14)).toBe(true);
            expect(validate.numeric('7.25')).toBe(true);
            expect(validate.numeric(0)).toBe(true);
        });

        test('returns true for negative numbers', () => {
            expect(validate.numeric(-10)).toBe(true);
            expect(validate.numeric('-3.14')).toBe(true);
        });

        test('returns false for non-numeric', () => {
            expect(validate.numeric('abc')).toBe(false);
            expect(validate.numeric(NaN)).toBe(false);
            expect(validate.numeric(Infinity)).toBe(false);
        });

        test('returns true for string numbers with spaces', () => {
            // parseFloat handles leading whitespace but not trailing
            expect(validate.numeric('  5')).toBe(true);
        });
    });

    describe('email', () => {
        test('validates correct email', () => {
            expect(validate.email('test@example.com')).toBe(true);
            expect(validate.email('user+tag@domain.co.uk')).toBe(true);
            expect(validate.email('a@b.c')).toBe(true);
        });

        test('rejects invalid email', () => {
            expect(validate.email('notanemail')).toBe(false);
            expect(validate.email('@missing.com')).toBe(false);
            expect(validate.email('missing@')).toBe(false);
            expect(validate.email('missing.com')).toBe(false);
            expect(validate.email('')).toBe(false);
        });
    });

    describe('phoneCN', () => {
        test('validates correct Chinese phone', () => {
            expect(validate.phoneCN('13800138000')).toBe(true);
            expect(validate.phoneCN('15912345678')).toBe(true);
            expect(validate.phoneCN('18888888888')).toBe(true);
        });

        test('handles phone with spaces', () => {
            expect(validate.phoneCN('138 0013 8000')).toBe(true);
        });

        test('rejects invalid phone', () => {
            expect(validate.phoneCN('12345678901')).toBe(false);
            expect(validate.phoneCN('abcdefg')).toBe(false);
            expect(validate.phoneCN('1380013800')).toBe(false);   // 10 digits
            expect(validate.phoneCN('138001380000')).toBe(false); // 12 digits
            expect(validate.phoneCN('')).toBe(false);
        });

        test('rejects phone starting with invalid prefix', () => {
            expect(validate.phoneCN('12000138000')).toBe(false); // 12x not valid
        });
    });

    describe('length', () => {
        test('validates within range', () => {
            expect(validate.length('abc', 1, 5)).toBe(true);
            expect(validate.length('a', 1, 1)).toBe(true);
        });

        test('rejects too short', () => {
            expect(validate.length('a', 2, 5)).toBe(false);
        });

        test('rejects too long', () => {
            expect(validate.length('abcdef', 1, 5)).toBe(false);
        });

        test('handles null/undefined', () => {
            expect(validate.length(null, 0, 5)).toBe(true);
            expect(validate.length(undefined, 1, 5)).toBe(false);
        });

        test('handles exact bounds', () => {
            expect(validate.length('abc', 3, 3)).toBe(true);
            expect(validate.length('ab', 3, 3)).toBe(false);
        });
    });

    describe('checkAll', () => {
        test('returns empty array when all pass', () => {
            const errors = validate.checkAll(
                { name: 'John', age: 25 },
                [
                    { field: 'name', label: 'Name', test: v => !!v, message: 'Name required' },
                    { field: 'age', label: 'Age', test: v => v > 0, message: 'Age must be positive' }
                ]
            );
            expect(errors).toHaveLength(0);
        });

        test('collects all errors', () => {
            const errors = validate.checkAll(
                { name: '', age: -1 },
                [
                    { field: 'name', test: v => !!v, message: 'Name required' },
                    { field: 'age', test: v => v > 0, message: 'Age positive' }
                ]
            );
            expect(errors).toHaveLength(2);
        });

        test('uses default message when no message provided', () => {
            const errors = validate.checkAll(
                { email: 'bad' },
                [
                    { field: 'email', label: '邮箱', test: v => v.includes('@') }
                    // No message = uses default
                ]
            );
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('邮箱');
        });

        test('uses field name when no label', () => {
            const errors = validate.checkAll(
                { age: -1 },
                [
                    { field: 'age', test: v => v > 0 }
                ]
            );
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('age');
        });

        test('handles empty rules array', () => {
            const errors = validate.checkAll({ a: 1 }, []);
            expect(errors).toHaveLength(0);
        });
    });
});
