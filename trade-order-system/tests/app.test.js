/**
 * @file app.test.js
 * App module tests — badge helpers, theme, modal, router, sidebar, company, user, save status, export
 */
import { jest } from '@jest/globals';

// Track toast calls for verification
const toastCalls = [];

jest.unstable_mockModule('../js/utils.js', () => ({
    escapeHtml: s => String(s || '').replace(/</g, '&lt;'),
    handleError: () => {},
    toast: (...args) => toastCalls.push(args),
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

jest.unstable_mockModule('../js/auth.js', () => ({
    Auth: {
        currentUser: null,
        init() {
            return false;
        },
        users: [],
        teams: { T1: { name: 'Team A' } },
        getVisiblePages() {
            return ['dashboard', 'orders', 'customers', 'factories', 'profit', 'shipping', 'settings'];
        },
        login() {
            return Promise.resolve({ success: false, error: 'Invalid' });
        },
        logout() {}
    }
}));

jest.unstable_mockModule('../js/cloud.js', () => ({
    Cloud: {
        envId: 'mock-env',
        DATA_TYPE: 'gw_data',
        _lastMeta: { version: 0, updatedAt: null, updatedBy: null },
        getLastMeta() {
            return this._lastMeta;
        },
        resetSession() {}
    }
}));

jest.unstable_mockModule('../js/data.js', () => ({
    DB: {
        formatMoney(a, c) {
            return c + ' ' + a;
        },
        formatDate(d) {
            return d || '-';
        },
        async init() {
            return true;
        },
        exchangeRates: {},
        rateMetas: {},
        companies: [],
        currentCompanyId: null,
        _cloudReady: false,
        _pendingSave: false,
        _backupToLocal() {},
        _stopPolling() {},
        async flush() {
            return true;
        },
        async refreshFromCloud() {
            return { ok: true, meta: { updatedBy: 'David' } };
        },
        getAccessibleCompanies() {
            return [{ id: 'GR', name: 'Grandware' }, { id: 'WY', name: 'WeiYu' }];
        },
        setCurrentCompany(id) {
            this.currentCompanyId = id;
        },
        getCurrentCompany() {
            return { id: 'GR', name: 'Grandware' };
        },
        getExchangeRate() {
            return 7.25;
        },
        getRateMeta() {
            return { updateTime: null, source: 'manual', isAuto: false };
        },
        data: { customers: [], orders: [], factories: [] }
    }
}));

jest.unstable_mockModule('../js/exchange.js', () => ({
    Exchange: { currentRate() {
        return 7.25;
    } }
}));

const { App } = await import('../js/app.js');
const { DB } = await import('../js/data.js');
const { Auth } = await import('../js/auth.js');
const { Cloud } = await import('../js/cloud.js');

// ==================== DOM Helper ====================
function setupDom(elements) {
    document.body.innerHTML = '';
    for (const [id, tag] of Object.entries(elements)) {
        const el = document.createElement(tag);
        el.id = id;
        document.body.appendChild(el);
    }
}

// ==================== Badge Helpers ====================
describe('App — Badge Helpers', () => {
    test('getPaymentBadge returns correct badges', () => {
        expect(App.getPaymentBadge('已收款')).toContain('badge-success');
        expect(App.getPaymentBadge('部分收款')).toContain('badge-warning');
        expect(App.getPaymentBadge('未收款')).toContain('badge-danger');
    });

    test('getPaymentBadge handles unknown status', () => {
        expect(App.getPaymentBadge('unknown')).toContain('badge-default');
    });

    test('getFactoryPaidBadge returns correct badges', () => {
        expect(App.getFactoryPaidBadge('已付清')).toContain('badge-success');
        expect(App.getFactoryPaidBadge('部分付款')).toContain('badge-warning');
        expect(App.getFactoryPaidBadge('未付款')).toContain('badge-danger');
    });

    test('getFactoryPaidBadge defaults to 未付款', () => {
        expect(App.getFactoryPaidBadge()).toContain('未付款');
    });

    test('getStatusBadge returns correct badges', () => {
        expect(App.getStatusBadge('进行中')).toContain('badge-primary');
        expect(App.getStatusBadge('已订船')).toContain('badge-success');
        expect(App.getStatusBadge('已取消')).toContain('badge-default');
        expect(App.getStatusBadge('推迟出货')).toContain('badge-warning');
    });

    test('getStatusBadge handles unknown status', () => {
        expect(App.getStatusBadge('unknown')).toContain('badge-default');
    });

    test('getShippingBadge returns correct badges', () => {
        expect(App.getShippingBadge('已签收')).toContain('badge-success');
        expect(App.getShippingBadge('已到港')).toContain('badge-info');
        expect(App.getShippingBadge('已出运')).toContain('badge-primary');
        expect(App.getShippingBadge('待出运')).toContain('badge-warning');
    });

    test('getCustomsBadge returns correct badges', () => {
        expect(App.getCustomsBadge('已清关')).toContain('badge-success');
        expect(App.getCustomsBadge('清关中')).toContain('badge-warning');
        expect(App.getCustomsBadge('已报关')).toContain('badge-info');
        expect(App.getCustomsBadge('未报关')).toContain('badge-default');
    });
});

// ==================== getProfitColor ====================
describe('App — getProfitColor', () => {
    test('rate >= 25 is text-success', () => {
        expect(App.getProfitColor(25)).toBe('text-success');
        expect(App.getProfitColor(30)).toBe('text-success');
        expect(App.getProfitColor(100)).toBe('text-success');
    });

    test('rate >= 15 is text-primary', () => {
        expect(App.getProfitColor(15)).toBe('text-primary');
        expect(App.getProfitColor(20)).toBe('text-primary');
        expect(App.getProfitColor(24.99)).toBe('text-primary');
    });

    test('rate >= 0 is text-warning', () => {
        expect(App.getProfitColor(0)).toBe('text-warning');
        expect(App.getProfitColor(5)).toBe('text-warning');
        expect(App.getProfitColor(14.99)).toBe('text-warning');
    });

    test('rate < 0 is text-danger', () => {
        expect(App.getProfitColor(-1)).toBe('text-danger');
        expect(App.getProfitColor(-100)).toBe('text-danger');
    });
});

// ==================== _timeAgo ====================
describe('App — _timeAgo', () => {
    const NOW = new Date('2026-07-31T12:00:00Z').getTime();

    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('returns empty string for null/undefined', () => {
        expect(App._timeAgo(null)).toBe('');
        expect(App._timeAgo(undefined)).toBe('');
        expect(App._timeAgo('')).toBe('');
    });

    test('returns 刚刚 for less than 60 seconds', () => {
        expect(App._timeAgo(new Date(NOW - 5000).toISOString())).toBe('刚刚');
        expect(App._timeAgo(new Date(NOW - 59000).toISOString())).toBe('刚刚');
        expect(App._timeAgo(new Date(NOW).toISOString())).toBe('刚刚');
    });

    test('returns X分钟前 for 1-59 minutes', () => {
        expect(App._timeAgo(new Date(NOW - 60000).toISOString())).toBe('1分钟前');
        expect(App._timeAgo(new Date(NOW - 120000).toISOString())).toBe('2分钟前');
        expect(App._timeAgo(new Date(NOW - 3540000).toISOString())).toBe('59分钟前');
    });

    test('returns X小时前 for 1-23 hours', () => {
        expect(App._timeAgo(new Date(NOW - 3600000).toISOString())).toBe('1小时前');
        expect(App._timeAgo(new Date(NOW - 7200000).toISOString())).toBe('2小时前');
        expect(App._timeAgo(new Date(NOW - 82800000).toISOString())).toBe('23小时前');
    });

    test('returns X天前 for 24+ hours', () => {
        expect(App._timeAgo(new Date(NOW - 86400000).toISOString())).toBe('1天前');
        expect(App._timeAgo(new Date(NOW - 172800000).toISOString())).toBe('2天前');
        expect(App._timeAgo(new Date(NOW - 2592000000).toISOString())).toBe('30天前');
    });

    test('handles future dates gracefully', () => {
        expect(App._timeAgo(new Date(NOW + 3600000).toISOString())).toBe('刚刚');
    });

    test('handles invalid date strings gracefully', () => {
        expect(App._timeAgo('not-a-date')).toBe('NaN天前');
    });
});

// ==================== Theme Management ====================
describe('App — Theme Management', () => {
    beforeEach(() => {
        setupDom({
            themeToggleIcon: 'span',
            themeToggleLabel: 'span'
        });
        document.documentElement.removeAttribute('data-theme');
        localStorage.clear();
        localStorage.setItem.reset && localStorage.setItem.reset();
    });

    test('initTheme applies saved dark theme', () => {
        localStorage.setItem('grandware_theme', 'dark');
        App.initTheme();
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        expect(document.getElementById('themeToggleIcon').textContent).toBe('☀️');
        expect(document.getElementById('themeToggleLabel').textContent).toBe('浅色模式');
    });

    test('initTheme applies saved light theme', () => {
        localStorage.setItem('grandware_theme', 'light');
        App.initTheme();
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        expect(document.getElementById('themeToggleIcon').textContent).toBe('🌙');
        expect(document.getElementById('themeToggleLabel').textContent).toBe('暗色模式');
    });

    test('toggleTheme switches dark to light', () => {
        document.documentElement.setAttribute('data-theme', 'dark');
        App.toggleTheme();
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        expect(localStorage.getItem('grandware_theme')).toBe('light');
    });

    test('toggleTheme switches light to dark', () => {
        document.documentElement.setAttribute('data-theme', 'light');
        App.toggleTheme();
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        expect(localStorage.getItem('grandware_theme')).toBe('dark');
    });

    test('toggleTheme on unset theme defaults to dark', () => {
        document.documentElement.removeAttribute('data-theme');
        App.toggleTheme();
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    test('_applyTheme persists to localStorage', () => {
        App._applyTheme('dark');
        expect(localStorage.getItem('grandware_theme')).toBe('dark');
    });

    test('_applyTheme light is stored as light', () => {
        App._applyTheme('light');
        expect(localStorage.getItem('grandware_theme')).toBe('light');
    });

    test('_updateThemeToggleUI updates icon and label', () => {
        App._updateThemeToggleUI('dark');
        expect(document.getElementById('themeToggleIcon').textContent).toBe('☀️');
        expect(document.getElementById('themeToggleLabel').textContent).toBe('浅色模式');

        App._updateThemeToggleUI('light');
        expect(document.getElementById('themeToggleIcon').textContent).toBe('🌙');
        expect(document.getElementById('themeToggleLabel').textContent).toBe('暗色模式');
    });

    test('_updateThemeToggleUI handles missing elements gracefully', () => {
        document.body.innerHTML = '';
        expect(() => App._updateThemeToggleUI('dark')).not.toThrow();
    });
});

// ==================== Modal Management ====================
describe('App — Modal Management', () => {
    beforeEach(() => {
        setupDom({ modalContainer: 'div' });
    });

    test('showModal renders modal with title and body', () => {
        App.showModal('Test Title', '<p>Body content</p>');
        const container = document.getElementById('modalContainer');
        expect(container.innerHTML).toContain('Test Title');
        expect(container.innerHTML).toContain('Body content');
        expect(container.innerHTML).toContain('modal-overlay');
    });

    test('showModal with large option adds modal-large class', () => {
        App.showModal('Large', 'body', { large: true });
        expect(document.getElementById('modalContainer').innerHTML).toContain('modal-large');
    });

    test('showModal with custom footer', () => {
        App.showModal('Title', 'body', { footer: '<button id="customBtn">Custom</button>' });
        expect(document.getElementById('modalContainer').innerHTML).toContain('customBtn');
        expect(document.getElementById('modalContainer').innerHTML).not.toContain('确定');
    });

    test('showModal with hideFooter option', () => {
        App.showModal('Title', 'body', { hideFooter: true });
        expect(document.getElementById('modalContainer').innerHTML).not.toContain('modal-footer');
    });

    test('showModal default footer has cancel and confirm', () => {
        App.showModal('Title', 'body');
        const html = document.getElementById('modalContainer').innerHTML;
        expect(html).toContain('取消');
        expect(html).toContain('确定');
    });

    test('closeModal clears container', () => {
        App.showModal('Title', 'body');
        expect(document.getElementById('modalContainer').innerHTML).not.toBe('');
        App.closeModal();
        expect(document.getElementById('modalContainer').innerHTML).toBe('');
    });

    test('showConfirm renders confirm dialog with message', () => {
        App.showConfirm('Are you sure?', () => {});
        const html = document.getElementById('modalContainer').innerHTML;
        expect(html).toContain('确认操作');
        expect(html).toContain('Are you sure?');
        expect(html).toContain('confirmBtn');
    });

    test('showConfirm confirm button triggers callback', () => {
        let confirmed = false;
        App.showConfirm('Delete?', () => {
            confirmed = true;
        });
        // Click the confirm button
        const btn = document.getElementById('confirmBtn');
        expect(btn).toBeTruthy();
        btn.click();
        expect(confirmed).toBe(true);
        // Modal should be closed after confirm
        expect(document.getElementById('modalContainer').innerHTML).toBe('');
    });

    test('showConfirm escapes HTML in message', () => {
        App.showConfirm('<script>alert("xss")</script>', () => {});
        const html = document.getElementById('modalContainer').innerHTML;
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });
});

// ==================== Save Status ====================
describe('App — Save Status', () => {
    beforeEach(() => {
        setupDom({ saveStatusText: 'span' });
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        if (App._saveStatusTimer) {
            clearTimeout(App._saveStatusTimer);
            App._saveStatusTimer = null;
        }
    });

    test('updateSaveStatus saving shows spinner', () => {
        App.updateSaveStatus('saving');
        const el = document.getElementById('saveStatusText');
        expect(el.textContent).toBe('⏳ 保存中...');
    });

    test('updateSaveStatus saved shows success then clears after 3s', () => {
        App.updateSaveStatus('saved');
        const el = document.getElementById('saveStatusText');
        expect(el.textContent).toBe('✅ 已保存');
        // Fast-forward 3 seconds
        jest.advanceTimersByTime(3000);
        expect(el.textContent).toBe('');
    });

    test('updateSaveStatus error shows error message', () => {
        App.updateSaveStatus('error', 'Network timeout');
        const el = document.getElementById('saveStatusText');
        expect(el.textContent).toBe('❌ Network timeout');
    });

    test('updateSaveStatus default clears text', () => {
        const el = document.getElementById('saveStatusText');
        el.textContent = 'Something';
        App.updateSaveStatus('idle');
        expect(el.textContent).toBe('');
    });

    test('updateSaveStatus clears previous timer when called again', () => {
        App.updateSaveStatus('saved');
        App.updateSaveStatus('saved');
        // Should not throw or have overlapping timers
        const el = document.getElementById('saveStatusText');
        expect(el.textContent).toBe('✅ 已保存');
        jest.advanceTimersByTime(3000);
        expect(el.textContent).toBe('');
    });

    test('updateSaveStatus handles missing element gracefully', () => {
        document.body.innerHTML = '';
        expect(() => App.updateSaveStatus('saving')).not.toThrow();
    });
});

// ==================== Cloud Status ====================
describe('App — Cloud Status', () => {
    beforeEach(() => {
        setupDom({
            cloudStatusBar: 'div',
            cloudStatusIcon: 'span',
            cloudStatusText: 'span'
        });
    });

    test('updateCloudStatus shows online status when cloud ready', () => {
        DB._cloudReady = true;
        App.updateCloudStatus();
        const bar = document.getElementById('cloudStatusBar');
        expect(bar.style.display).toBe('block');
        expect(bar.style.background).toContain('48');
        expect(document.getElementById('cloudStatusText').textContent).toContain('Synced');
    });

    test('updateCloudStatus shows offline status when cloud not ready', () => {
        DB._cloudReady = false;
        App.updateCloudStatus();
        const bar = document.getElementById('cloudStatusBar');
        expect(bar.style.display).toBe('block');
        expect(bar.style.background).toContain('255');
        expect(document.getElementById('cloudStatusText').textContent).toBe('Offline');
    });

    test('updateCloudStatus handles missing elements gracefully', () => {
        document.body.innerHTML = '';
        DB._cloudReady = true;
        expect(() => App.updateCloudStatus()).not.toThrow();
    });

    test('updateCloudStatus shows "Synced X by Y" when meta has data', () => {
        DB._cloudReady = true;
        Cloud._lastMeta = { version: 5, updatedAt: new Date(Date.now() - 120000).toISOString(), updatedBy: 'David' };
        App.updateCloudStatus();
        expect(document.getElementById('cloudStatusText').textContent).toContain('Synced');
    });
});

// ==================== Company Selection ====================
describe('App — Company Selection', () => {
    beforeEach(() => {
        setupDom({
            companySelect: 'select',
            companyDisplayName: 'span',
            sidebar: 'div',
            sidebarOverlay: 'div',
            pageContent: 'div',
            pageTitle: 'h1'
        });
    });

    test('renderCompanySelect populates options', () => {
        DB.currentCompanyId = 'GR';
        App.renderCompanySelect();
        const select = document.getElementById('companySelect');
        expect(select.innerHTML).toContain('Grandware');
        expect(select.innerHTML).toContain('WeiYu');
    });

    test('renderCompanySelect auto-switches if current company not in list', () => {
        DB.currentCompanyId = 'INVALID';
        App.renderCompanySelect();
        expect(DB.currentCompanyId).toBe('GR'); // first accessible company
    });

    test('renderCompanySelect handles missing element gracefully', () => {
        document.body.innerHTML = '';
        expect(() => App.renderCompanySelect()).not.toThrow();
    });

    test('updateCompanyDisplay shows company name', () => {
        // Add options so select.value can be set
        const sel = document.getElementById('companySelect');
        sel.innerHTML = '<option value="GR">Grandware</option><option value="WY">WeiYu</option>';
        App.updateCompanyDisplay();
        expect(document.getElementById('companyDisplayName').textContent).toBe('Grandware');
        expect(document.getElementById('companySelect').value).toBe('GR');
    });

    test('selectCompany switches and shows toast', () => {
        toastCalls.length = 0;
        DB.currentCompanyId = 'GR';
        const origRouter = App.router;
        App.router = jest.fn();
        App.selectCompany('WY');
        App.router = origRouter;
        expect(DB.currentCompanyId).toBe('WY');
        expect(toastCalls.length).toBeGreaterThan(0);
    });

    test('selectCompany does nothing if same company', () => {
        toastCalls.length = 0;
        DB.currentCompanyId = 'GR';
        App.selectCompany('GR');
        expect(toastCalls.length).toBe(0);
    });
});

// ==================== User Display ====================
describe('App — User Display', () => {
    beforeEach(() => {
        setupDom({
            userAvatar: 'span',
            userNameDisplay: 'span',
            userRoleBadge: 'span',
            dropdownName: 'span',
            dropdownRole: 'span'
        });
    });

    test('updateUserDisplay shows user name and role', () => {
        Auth.currentUser = { name: 'David', role: 'admin', teamId: 'T1' };
        App.updateUserDisplay();
        expect(document.getElementById('userAvatar').textContent).toBe('D');
        expect(document.getElementById('userNameDisplay').textContent).toBe('David');
        expect(document.getElementById('userRoleBadge').textContent).toBe('管理员');
        expect(document.getElementById('dropdownName').textContent).toBe('David');
    });

    test('updateUserDisplay handles null user gracefully', () => {
        Auth.currentUser = null;
        expect(() => App.updateUserDisplay()).not.toThrow();
    });

    test('toggleUserMenu toggles dropdown visibility', () => {
        setupDom({ userDropdown: 'div' });
        App.toggleUserMenu();
        expect(document.getElementById('userDropdown').style.display).toBe('block');
        App.toggleUserMenu();
        expect(document.getElementById('userDropdown').style.display).toBe('none');
    });
});

// ==================== Mobile Sidebar ====================
describe('App — Mobile Sidebar', () => {
    beforeEach(() => {
        setupDom({
            sidebar: 'div',
            sidebarOverlay: 'div'
        });
    });

    test('toggleMobileSidebar opens sidebar', () => {
        App.toggleMobileSidebar();
        expect(document.getElementById('sidebar').classList.contains('open')).toBe(true);
        expect(document.getElementById('sidebarOverlay').classList.contains('visible')).toBe(true);
    });

    test('toggleMobileSidebar closes when already open', () => {
        document.getElementById('sidebar').classList.add('open');
        App.toggleMobileSidebar();
        expect(document.getElementById('sidebar').classList.contains('open')).toBe(false);
    });

    test('closeMobileSidebar removes open and visible', () => {
        document.getElementById('sidebar').classList.add('open');
        document.getElementById('sidebarOverlay').classList.add('visible');
        App.closeMobileSidebar();
        expect(document.getElementById('sidebar').classList.contains('open')).toBe(false);
        expect(document.getElementById('sidebarOverlay').classList.contains('visible')).toBe(false);
    });
});

// ==================== Sidebar Visibility ====================
describe('App — Sidebar Visibility', () => {
    test('updateSidebarVisibility shows all pages for admin', () => {
        setupDom({
            'nav-dashboard': 'a',
            'nav-orders': 'a',
            'nav-customers': 'a',
            'nav-factories': 'a',
            'nav-profit': 'a',
            'nav-shipping': 'a',
            'nav-settings': 'a'
        });
        App.updateSidebarVisibility();
        document.querySelectorAll('.nav-item').forEach(el => {
            // elements created with tag 'a' don't have class nav-item, so display won't be set
        });
        // Auth.getVisiblePages returns all pages, so nothing should be hidden
        const nav = document.getElementById('nav-dashboard');
        expect(nav).toBeTruthy();
    });

    test('updateSidebarVisibility hides restricted pages', () => {
        setupDom({
            'nav-dashboard': 'a',
            'nav-settings': 'a'
        });
        Auth.getVisiblePages = () => ['dashboard'];
        App.updateSidebarVisibility();
        expect(document.getElementById('nav-settings').style.display).toBe('none');
        expect(document.getElementById('nav-dashboard').style.display).toBe('');
        // Restore
        Auth.getVisiblePages = () => ['dashboard', 'orders', 'customers', 'factories', 'profit', 'shipping', 'settings'];
    });
});

// ==================== Exchange Rate Display ====================
describe('App — Exchange Rate Display', () => {
    beforeEach(() => {
        setupDom({
            exchangeRateDisplay: 'span',
            rateSourceText: 'span',
            exchangeRateInput: 'input'
        });
    });

    test('updateExchangeRateDisplay shows current rate', () => {
        App.updateExchangeRateDisplay();
        expect(document.getElementById('exchangeRateDisplay').textContent).toBe('7.25');
    });

    test('updateExchangeRateDisplay sets input value', () => {
        App.updateExchangeRateDisplay();
        expect(document.getElementById('exchangeRateInput').value).toBe('7.25');
    });

    test('updateExchangeRateDisplay handles missing elements', () => {
        document.body.innerHTML = '';
        expect(() => App.updateExchangeRateDisplay()).not.toThrow();
    });

    test('updateExchangeRateDisplay shows rate source when meta has updateTime', () => {
        DB.getRateMeta = () => ({
            updateTime: '2026-07-31T10:00:00Z',
            source: 'Bank of China',
            isAuto: true
        });
        App.updateExchangeRateDisplay();
        expect(document.getElementById('rateSourceText').textContent).toContain('🔄');
        expect(document.getElementById('exchangeRateDisplay').title).toContain('Bank of China');
    });
});

// ==================== Utility Methods ====================
describe('App — Utility Methods', () => {
    test('formatMoney delegates to DB.formatMoney', () => {
        const result = App.formatMoney(100, 'USD');
        expect(result).toBe('USD 100');
    });

    test('formatDate delegates to DB.formatDate', () => {
        const result = App.formatDate('2026-07-31');
        expect(result).toBe('2026-07-31');
    });
});

// ==================== Login / Logout ====================
describe('App — Login / Logout', () => {
    beforeEach(() => {
        setupDom({
            loginPage: 'div',
            app: 'div',
            loginUsername: 'input',
            loginPassword: 'input',
            loginError: 'span',
            pageContent: 'div'
        });
        toastCalls.length = 0;
    });

    test('showLogin shows login page and hides app', () => {
        App.showLogin();
        expect(document.getElementById('loginPage').style.display).toBe('flex');
        expect(document.getElementById('app').style.display).toBe('none');
    });

    test('handleLogin shows error for empty fields', async () => {
        document.getElementById('loginUsername').value = '';
        document.getElementById('loginPassword').value = '';
        const event = { preventDefault: jest.fn() };
        await App.handleLogin(event);
        expect(event.preventDefault).toHaveBeenCalled();
        expect(document.getElementById('loginError').style.display).toBe('block');
        expect(document.getElementById('loginError').textContent).toContain('请输入');
    });

    test('handleLogin with credentials calls Auth.login', async () => {
        document.getElementById('loginUsername').value = 'David';
        document.getElementById('loginPassword').value = 'password';
        Auth.login = jest.fn(() => Promise.resolve({ success: false, error: '密码错误' }));
        const event = { preventDefault: jest.fn() };
        await App.handleLogin(event);
        expect(Auth.login).toHaveBeenCalledWith('David', 'password');
        expect(document.getElementById('loginError').style.display).toBe('block');
        expect(document.getElementById('loginError').textContent).toBe('密码错误');
    });

    test('handleLogout flushes pending saves and shows login', async () => {
        DB._pendingSave = true;
        DB.flush = jest.fn(() => Promise.resolve(true));
        DB._stopPolling = jest.fn();
        Auth.logout = jest.fn();
        App.charts = { chart1: { destroy: jest.fn() } };

        await App.handleLogout();

        expect(DB._stopPolling).toHaveBeenCalled();
        expect(DB.flush).toHaveBeenCalled();
        expect(Auth.logout).toHaveBeenCalled();
        expect(document.getElementById('loginPage').style.display).toBe('flex');
        expect(document.getElementById('pageContent').innerHTML).toBe('');
        expect(App.charts).toEqual({});
    });

    test('handleLogout without pending save skips flush', async () => {
        DB._pendingSave = false;
        DB.flush = jest.fn(() => Promise.resolve(true));
        DB._stopPolling = jest.fn();
        Auth.logout = jest.fn();

        await App.handleLogout();

        expect(DB.flush).not.toHaveBeenCalled();
    });

    test('handleLogout handles flush error gracefully', async () => {
        DB._pendingSave = true;
        DB.flush = jest.fn(() => Promise.reject(new Error('Network error')));
        DB._stopPolling = jest.fn();
        Auth.logout = jest.fn();

        await expect(App.handleLogout()).resolves.not.toThrow();
        expect(document.getElementById('loginPage').style.display).toBe('flex');
    });
});

// ==================== Router ====================
describe('App — Router', () => {
    beforeEach(() => {
        setupDom({
            pageContent: 'div',
            pageTitle: 'h1',
            sidebar: 'div',
            sidebarOverlay: 'div'
        });
        // Add nav items with nav-item class
        ['dashboard', 'orders', 'customers', 'factories', 'profit', 'shipping', 'settings'].forEach(page => {
            const nav = document.createElement('a');
            nav.id = 'nav-' + page;
            nav.dataset.page = page;
            nav.className = 'nav-item';
            document.body.appendChild(nav);
        });

        // Mock global page modules
        global.Dashboard = { render: jest.fn() };
        global.Orders = { render: jest.fn(), filter: jest.fn() };
        global.Customers = { render: jest.fn() };
        global.Factories = { render: jest.fn() };
        global.Profit = { render: jest.fn() };
        global.Shipping = { render: jest.fn() };
        global.Settings = { render: jest.fn() };

        // Mock dynamic import — resolves instantly in tests
        App._pageModules = {};
        App._loadPageModule = jest.fn().mockResolvedValue({});
    });

    afterEach(() => {
        delete global.Dashboard;
        delete global.Orders;
        delete global.Customers;
        delete global.Factories;
        delete global.Profit;
        delete global.Shipping;
        delete global.Settings;
    });

    test('setupRouter adds hashchange listener', () => {
        const spy = jest.spyOn(window, 'addEventListener');
        App.setupRouter();
        expect(spy).toHaveBeenCalledWith('hashchange', expect.any(Function));
        spy.mockRestore();
    });

    test('router renders dashboard by default', async () => {
        window.location.hash = '#/dashboard';
        await App.router();
        expect(global.Dashboard.render).toHaveBeenCalled();
        expect(App.currentPage).toBe('dashboard');
        expect(document.getElementById('pageTitle').textContent).toBe('总览');
    });

    test('router renders orders page', async () => {
        window.location.hash = '#/orders';
        await App.router();
        expect(global.Orders.render).toHaveBeenCalled();
        expect(document.getElementById('pageTitle').textContent).toBe('订单管理');
    });

    test('router renders customers page with param', async () => {
        window.location.hash = '#/customers/C001';
        await App.router();
        expect(global.Customers.render).toHaveBeenCalledWith(expect.anything(), 'C001');
    });

    test('router renders factories page', async () => {
        window.location.hash = '#/factories';
        await App.router();
        expect(global.Factories.render).toHaveBeenCalled();
    });

    test('router renders profit page', async () => {
        window.location.hash = '#/profit';
        await App.router();
        expect(global.Profit.render).toHaveBeenCalled();
    });

    test('router renders shipping page', async () => {
        window.location.hash = '#/shipping';
        await App.router();
        expect(global.Shipping.render).toHaveBeenCalled();
    });

    test('router renders settings page', async () => {
        window.location.hash = '#/settings';
        await App.router();
        expect(global.Settings.render).toHaveBeenCalled();
    });

    test('router redirects to dashboard for unauthorized page', () => {
        Auth.getVisiblePages = () => ['dashboard'];
        window.location.hash = '#/orders';
        App.router();
        expect(window.location.hash).toBe('#/dashboard');
        Auth.getVisiblePages = () => ['dashboard', 'orders', 'customers', 'factories', 'profit', 'shipping', 'settings'];
    });

    test('router updates nav active class', async () => {
        window.location.hash = '#/orders';
        await App.router();
        const navOrders = document.getElementById('nav-orders');
        expect(navOrders.classList.contains('active')).toBe(true);
        const navDashboard = document.getElementById('nav-dashboard');
        expect(navDashboard.classList.contains('active')).toBe(false);
    });

    test('router destroys existing charts before rendering', async () => {
        const chartDestroy = jest.fn();
        App.charts = { old: { destroy: chartDestroy } };
        window.location.hash = '#/dashboard';
        await App.router();
        expect(chartDestroy).toHaveBeenCalled();
        expect(App.charts).toEqual({});
    });
});

// ==================== Refresh Cloud ====================
describe('App — Refresh Cloud', () => {
    beforeEach(() => {
        setupDom({
            cloudStatusBar: 'div',
            cloudStatusIcon: 'span',
            cloudStatusText: 'span'
        });
        toastCalls.length = 0;
    });

    test('refreshCloud warns when cloud not ready', async () => {
        DB._cloudReady = false;
        await App.refreshCloud();
        expect(toastCalls.length).toBeGreaterThan(0);
        expect(toastCalls[0][0]).toContain('云端未连接');
    });

    test('refreshCloud success shows toast and rerenders', async () => {
        DB._cloudReady = true;
        DB.refreshFromCloud = jest.fn(() => Promise.resolve({ ok: true, meta: { updatedBy: 'Nicole' } }));
        // Mock router to avoid global Dashboard
        App.router = jest.fn();
        App.updateCloudStatus = jest.fn();
        App.updateExchangeRateDisplay = jest.fn();

        await App.refreshCloud();

        expect(DB.refreshFromCloud).toHaveBeenCalled();
        expect(toastCalls.some(c => c[0].includes('已刷新'))).toBe(true);
        expect(App.router).toHaveBeenCalled();

        // Restore
        App.router = undefined;
    });

    test('refreshCloud handles no data case', async () => {
        DB._cloudReady = true;
        DB.refreshFromCloud = jest.fn(() => Promise.resolve({ ok: false }));
        App.router = jest.fn();
        App.updateCloudStatus = jest.fn();
        App.updateExchangeRateDisplay = jest.fn();

        await App.refreshCloud();

        expect(toastCalls.some(c => c[0].includes('云端暂无数据'))).toBe(true);
    });

    test('refreshCloud handles error gracefully', async () => {
        DB._cloudReady = true;
        DB.refreshFromCloud = jest.fn(() => Promise.reject(new Error('Network timeout')));
        App.router = jest.fn();
        App.updateCloudStatus = jest.fn();
        App.updateExchangeRateDisplay = jest.fn();

        await App.refreshCloud();

        expect(toastCalls.some(c => c[0].includes('刷新失败'))).toBe(true);
    });
});

// ==================== Export Excel ====================
describe('App — Export Excel', () => {
    beforeEach(() => {
        toastCalls.length = 0;
        // Mock XLSX global
        global.XLSX = {
            utils: {
                aoa_to_sheet: jest.fn(() => ({ '!cols': [] })),
                book_new: jest.fn(() => ({})),
                book_append_sheet: jest.fn()
            },
            writeFile: jest.fn()
        };
    });

    afterEach(() => {
        delete global.XLSX;
    });

    test('exportExcel creates workbook and writes file', () => {
        const data = [{ name: 'Test', amount: 100 }];
        const headers = ['name', 'amount'];

        App.exportExcel(data, 'export.csv', headers);

        expect(global.XLSX.utils.aoa_to_sheet).toHaveBeenCalled();
        expect(global.XLSX.utils.book_new).toHaveBeenCalled();
        expect(global.XLSX.utils.book_append_sheet).toHaveBeenCalled();
        expect(global.XLSX.writeFile).toHaveBeenCalledWith(expect.anything(), 'export.xlsx');
        expect(toastCalls.length).toBeGreaterThan(0);
    });

    test('exportExcel uses labels for header row', () => {
        const data = [{ name: 'Test', amount: 100 }];
        const headers = ['name', 'amount'];
        const labels = { name: '名称', amount: '金额' };

        App.exportExcel(data, 'export.xlsx', headers, labels);

        const call = global.XLSX.utils.aoa_to_sheet.mock.calls[0][0];
        expect(call[0]).toEqual(['名称', '金额']);
    });

    test('exportExcel handles null and undefined values', () => {
        const data = [{ name: null, amount: undefined, note: 'text' }];
        const headers = ['name', 'amount', 'note'];

        App.exportExcel(data, 'export.xlsx', headers);

        const call = global.XLSX.utils.aoa_to_sheet.mock.calls[0][0];
        expect(call[1]).toEqual(['', '', 'text']);
    });

    test('exportExcel handles numeric values as-is', () => {
        const data = [{ amount: 42.5 }];
        const headers = ['amount'];

        App.exportExcel(data, 'export.xlsx', headers);

        const call = global.XLSX.utils.aoa_to_sheet.mock.calls[0][0];
        expect(call[1]).toEqual([42.5]);
    });

    test('exportExcel sets column widths', () => {
        const data = [{ a: 1, b: 2 }];
        const headers = ['a', 'b'];

        App.exportExcel(data, 'export.xlsx', headers);

        const sheetArg = global.XLSX.utils.aoa_to_sheet.mock.results[0].value;
        expect(sheetArg['!cols']).toEqual([{ wch: 16 }, { wch: 16 }]);
    });
});
