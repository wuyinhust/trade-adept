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
