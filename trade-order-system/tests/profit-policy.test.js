import { jest } from '@jest/globals';

const DB = {
    companies: [
        { id: 'arbitrary-cn', settlementCurrency: 'CNY', profitPolicy: 'grandware-v40' },
        { id: 'arbitrary-hk', settlementCurrency: 'USD', profitPolicy: 'grandware-v40' }
    ],
    getExchangeRate: () => 7,
    data: { orders: [] }
};
jest.unstable_mockModule('../js/data.js', () => ({ DB }));
jest.unstable_mockModule('../js/utils.js', () => ({ handleError() {}, toast() {} }));
const { Exchange } = await import('../js/exchange.js');

test('configured company currency works without Grandware company IDs', () => {
    expect(Exchange.isDomestic('arbitrary-cn')).toBe(true);
    expect(Exchange.isDomestic('arbitrary-hk')).toBe(false);
});

test('Grandware v40 uses RMB fees and actual rebate percent', () => {
    // Fictional sample: revenue 7000, taxable cost 1130, rebate 90, fees 120.
    expect(Exchange.calcOrderProfit(1000, 1130, 100, 9, 20, 'arbitrary-cn')).toBeCloseTo(5840);
});

test('HK policy does not convert USD cost or revenue', () => {
    expect(Exchange.calcOrderProfit(1000, 700, 0, 0, 20, 'arbitrary-hk')).toBe(280);
});

test('report keeps stored historical revenue and profit when current rate differs', () => {
    const report = Exchange.getOrderFinancials({
        companyId: 'arbitrary-cn',
        orderAmountUSD: 1000,
        orderAmountRMB: 6690,
        profitRMB: 5500,
        factoryCostRMB: 1130,
        freightCostUSD: 100,
        insuranceCostUSD: 9,
        otherCostUSD: 20
    });
    expect(report.revenue).toBe(6690);
    expect(report.profit).toBe(5500);
    expect(report.insuranceCost).toBe(0);
    expect(report.taxRebate).toBeCloseTo(90);
    expect(report.currency).toBe('CNY');
});

test('generic quotes never assume a tax rebate and include USD expenses', () => {
    expect(Exchange.calcOrderProfit(1000, 700, 30, 10, 20, 'arbitrary-hk', 'generic-native')).toBe(240);
    expect(Exchange.calcOrderProfit(1000, 1130, 30, 10, 20, 'arbitrary-cn', 'generic-native')).toBe(5450);
});

test('native reports keep the order conversion rate after current company rate changes', () => {
    const order = {
        companyId: 'arbitrary-cn',
        stage: 'native',
        profitPolicy: 'generic-native',
        exchangeRateUsed: 6.5,
        orderAmountUSD: 1000,
        orderAmountRMB: 6500,
        factoryCostRMB: 4000,
        freightCostUSD: 10,
        insuranceCostUSD: 5,
        otherCostUSD: 5,
        profitRMB: 2370
    };
    const report = Exchange.getOrderFinancials(order);
    expect(report.revenue).toBe(6500);
    expect(report.totalCost).toBe(4130);
    expect(report.taxRebate).toBe(0);
    expect(report.profit).toBe(2370);
    expect(report.computedProfit).toBe(2370);
});

test('generic USD reports include freight and insurance without a currency conversion', () => {
    const report = Exchange.getOrderFinancials({
        companyId: 'arbitrary-hk',
        profitPolicy: 'generic-native',
        orderAmountUSD: 1000,
        factoryCostRMB: 700,
        freightCostUSD: 30,
        insuranceCostUSD: 10,
        otherCostUSD: 20
    });
    expect(report.totalCost).toBe(760);
    expect(report.profit).toBe(240);
    expect(report.currency).toBe('USD');
});

test('unknown historical amounts remain unknown instead of using current FX or computed profit', () => {
    const report = Exchange.getOrderFinancials({
        companyId: 'arbitrary-cn',
        stage: 'legacy',
        historicalReference: true,
        orderAmountUSD: 1000
    });
    expect(report.revenue).toBeNull();
    expect(report.factoryCost).toBeNull();
    expect(report.totalCost).toBeNull();
    expect(report.profit).toBeNull();
    expect(report.profitRate).toBeNull();
    expect(report.incompleteHistory).toBe(true);
});

test('historical zero is a known value and original stored financials remain intact', () => {
    const report = Exchange.getOrderFinancials({
        companyId: 'arbitrary-cn',
        stage: 'legacy',
        orderAmountUSD: 100,
        orderAmountRMB: 600,
        factoryCostRMB: 400,
        freightCostUSD: 0,
        insuranceCostUSD: 0,
        otherCostUSD: 0,
        profitRMB: 200,
        profitRate: 33.33
    });
    expect(report.revenue).toBe(600);
    expect(report.totalCost).toBe(400);
    expect(report.profit).toBe(200);
    expect(report.profitRate).toBe(33.33);
    expect(report.incompleteHistory).toBe(false);
});
