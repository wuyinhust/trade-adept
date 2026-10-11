import { jest } from '@jest/globals';

let orders;
let finance;
let documentRole;
const App = {
    charts: {},
    formatMoney: (value, currency) => currency + ' ' + Number(value).toFixed(2),
    formatDate: value => value || '-',
    getShippingBadge: value => value || '-'
};
const DB = {
    currentCompanyId: 'COMPANY-CN',
    companies: [
        { id: 'COMPANY-CN', name: 'Demo domestic', settlementCurrency: 'CNY', profitPolicy: 'legacy-usd-v56' },
        { id: 'COMPANY-US', name: 'Demo USD', settlementCurrency: 'USD', profitPolicy: 'legacy-usd-v56' }
    ],
    getExchangeRate: () => 9,
    getOrders: () => orders,
    getDashboardStats: () => ({
        totalOrders: orders.length,
        activeOrders: orders.length,
        completedOrders: 0,
        pendingShipmentCount: orders.length,
        customerCount: 1,
        // Deliberately poisoned legacy aggregate: chart must ignore its mixed currency amount.
        monthlyStats: { '2026-10': { revenue: 999999, profit: 999999 } },
        statusStats: { 进行中: orders.length },
        upcomingShipments: []
    }),
    save: jest.fn()
};
const Auth = {
    canSeeFinancials: () => finance,
    canSeeAll: () => finance,
    isDocument: () => documentRole
};

jest.unstable_mockModule('../js/app.js', () => ({ App }));
jest.unstable_mockModule('../js/data.js', () => ({ DB }));
jest.unstable_mockModule('../js/auth.js', () => ({ Auth }));
jest.unstable_mockModule('../js/ui.js', () => ({ icon: () => '<svg aria-hidden="true"></svg>' }));
jest.unstable_mockModule('../js/utils.js', () => ({
    escapeHtml: value =>
        String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;'),
    handleError: jest.fn(),
    toast: jest.fn()
}));

const { Dashboard } = await import('../js/dashboard.js');

describe('Dashboard currencies, authorized financial reporting and history preservation', () => {
    let container;
    beforeEach(() => {
        finance = true;
        documentRole = false;
        DB.currentCompanyId = 'COMPANY-CN';
        orders = [
            {
                id: 'O-CN',
                companyId: 'COMPANY-CN',
                orderDate: '2026-10-01',
                orderAmountUSD: 100,
                orderAmountRMB: 600,
                profitRMB: 80,
                factoryCostRMB: 500,
                factoryPaidRMB: 100,
                paidAmountUSD: 20
            },
            {
                id: 'O-US',
                companyId: 'COMPANY-US',
                orderDate: '2026-10-02',
                orderAmountUSD: 50,
                orderAmountRMB: 50,
                profitRMB: 15,
                factoryCostRMB: 35,
                factoryPaidRMB: 5,
                paidAmountUSD: 10
            }
        ];
        App.charts = {};
        DB.save.mockClear();
        global.Chart = jest.fn().mockImplementation(function (canvas, config) {
            this.canvas = canvas;
            this.config = config;
            this.destroy = jest.fn();
        });
        document.body.innerHTML = '';
        container = document.createElement('main');
        document.body.appendChild(container);
    });

    test('mixed company view produces one currency per chart and ignores mixed legacy aggregate', () => {
        Dashboard.render(container);
        const cny = App.charts['monthly-CNY'].config;
        const usd = App.charts['monthly-USD'].config;
        expect(cny.data.datasets.map(dataset => dataset.label)).toEqual(['营收 · CNY', '利润 · CNY']);
        expect(cny.data.datasets.map(dataset => dataset.data)).toEqual([[600], [80]]);
        expect(usd.data.datasets.map(dataset => dataset.label)).toEqual(['营收 · USD', '利润 · USD']);
        expect(usd.data.datasets.map(dataset => dataset.data)).toEqual([[50], [15]]);
        expect(Object.keys(cny.options.scales)).toEqual(['y']);
        expect(cny.options.scales.y.title.text).toBe('CNY');
        expect(usd.options.scales.y.title.text).toBe('USD');
        expect(container.textContent).toContain('同一图表仅汇总一种结算币种');
        expect(container.textContent).not.toContain('999999');
    });

    test('changing selected company cannot relabel or convert all-company chart totals', () => {
        DB.currentCompanyId = 'COMPANY-US';
        Dashboard.render(container);
        expect(App.charts['monthly-CNY'].config.data.datasets[0].data).toEqual([600]);
        expect(App.charts['monthly-USD'].config.data.datasets[0].data).toEqual([50]);
        expect(container.textContent).toContain('CNY 80.00');
        expect(container.textContent).toContain('USD 利润 USD 15.00');
    });

    test('uses saved historical domestic revenue instead of current FX and never persists normalization', () => {
        const original = JSON.stringify(orders);
        orders.forEach(Object.freeze);
        Object.freeze(orders);
        Dashboard.render(container);
        expect(App.charts['monthly-CNY'].config.data.datasets[0].data).toEqual([600]);
        expect(App.charts['monthly-CNY'].config.data.datasets[1].data).toEqual([80]);
        expect(JSON.stringify(orders)).toBe(original);
        expect(DB.save).not.toHaveBeenCalled();
    });

    test('ordinary role sees revenue but no profit datasets, profit cards or protected payments', () => {
        finance = false;
        Dashboard.render(container);
        for (const currency of ['CNY', 'USD']) {
            expect(App.charts['monthly-' + currency].config.data.datasets.map(dataset => dataset.label)).toEqual([
                '营收 · ' + currency
            ]);
        }
        expect(container.textContent).not.toContain('利润');
        expect(container.textContent).not.toContain('待收款');
        expect(container.textContent).not.toContain('收付款进度');
        expect(container.textContent).not.toContain('NaN');
        expect(container.querySelector('canvas').getAttribute('aria-label')).not.toContain('利润');
    });

    test('document role omits financial trend charts entirely', () => {
        finance = false;
        documentRole = true;
        Dashboard.render(container);
        expect(Object.keys(App.charts)).toEqual(['status']);
        expect(container.querySelectorAll('canvas')).toHaveLength(1);
        expect(container.textContent).not.toContain('利润');
    });

    test('cached chart data cannot display profit after finance permission is removed', () => {
        const cached = Dashboard.getMonthlyData(orders);
        finance = false;
        container.innerHTML = '<canvas id="monthlyChart-CNY"></canvas><canvas id="monthlyChart-USD"></canvas>';
        Dashboard.renderMonthlyChart(cached);
        expect(App.charts['monthly-CNY'].config.data.datasets.map(dataset => dataset.label)).toEqual(['营收 · CNY']);
        expect(App.charts['monthly-USD'].config.data.datasets.map(dataset => dataset.label)).toEqual(['营收 · USD']);
    });

    test('last six months and zero-revenue currency remain separate without inventing records', () => {
        orders = Array.from({ length: 7 }, (_, index) => ({
            id: 'O-' + index,
            companyId: 'COMPANY-CN',
            orderDate: `2026-${String(index + 1).padStart(2, '0')}-01`,
            orderAmountUSD: 10,
            orderAmountRMB: 60,
            profitRMB: -5
        }));
        orders.push({
            id: 'USD-ZERO',
            companyId: 'COMPANY-US',
            orderDate: '2026-07-01',
            orderAmountUSD: 0,
            profitRMB: -2
        });
        const data = Dashboard.getMonthlyData(orders);
        expect(data.months).toEqual(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
        expect(data.currencies).toEqual(['CNY', 'USD']);
        Dashboard.render(container);
        expect(App.charts['monthly-USD'].config.data.datasets[0].data).toEqual([0, 0, 0, 0, 0, 0]);
        expect(App.charts['monthly-USD'].config.data.datasets[1].data).toEqual([0, 0, 0, 0, 0, -2]);
    });

    test('empty or malformed order dates render an honest empty trend state', () => {
        orders = [{ id: 'INVALID', companyId: 'COMPANY-US', orderDate: 'bad', orderAmountUSD: 20 }];
        Dashboard.render(container);
        expect(Object.keys(App.charts)).toEqual(['status']);
        expect(container.textContent).toContain('有订单后显示经营趋势');
    });
});
