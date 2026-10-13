import { jest } from '@jest/globals';
import { BusinessAPIClient } from '../js/api-client.js';

const reply = (value, status = 200) => ({ ok: status < 300, status, json: async () => value });
const baseline = () => ({
    data: { orders: [{ id: 'O-1', remarks: 'original' }], customers: [], factories: [], shipments: [], invoices: [] },
    exchangeRates: {}, rateMetas: {}, meta: { version: 4 }
});

test('financial reads preserve filters and encode native names safely', async () => {
    const fetcher = jest.fn().mockResolvedValue(reply({ version: 4, documents: [] }));
    const client = new BusinessAPIClient({ fetcher });
    await client.financeState({ companyId: 'CO-1', resource: 'sales_invoice', search: 'A&B', offset: 10 });
    const query = new URL(fetcher.mock.calls[0][0], 'http://localhost').searchParams;
    expect(query.get('search')).toBe('A&B');
    expect(query.get('offset')).toBe('10');
    await client.financeReport({ companyId: 'CO-1', report: 'receivables', filters: { report_date: '2026-10-13' } });
    const [path, options] = fetcher.mock.calls[1];
    expect(path).toBe('/api/finance/report');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body).filters.report_date).toBe('2026-10-13');
});

test('a financial operation preserves its retry identity and business baseline', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce(reply(baseline()));
    const client = new BusinessAPIClient({ fetcher });
    const working = await client.loadData();
    const request = { companyId: 'CO-1', resource: 'payment_entry', operation: 'submit', expectedVersion: 5,
        expectedModified: '2026-10-13 10:00:00.123456', idempotencyKey: 'stable-request-1', name: 'ACC-PAY-1' };
    fetcher.mockResolvedValueOnce(reply({ version: 6, meta: { version: 6 } }));
    await client.financeOperation(request);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(request);
    expect(client.lastMeta.version).toBe(4);
    expect(working.data.orders[0].remarks).toBe('original');
    expect(client.hasChanges()).toBe(false);
});

test('drafts block financial writes, and a conflict keeps the caller draft and nonce', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce(reply(baseline()));
    const client = new BusinessAPIClient({ fetcher });
    const working = await client.loadData();
    const request = { companyId: 'CO-1', expectedVersion: 4, idempotencyKey: 'keep-on-conflict', values: { paidAmount: 40 } };
    working.data.orders[0].remarks = 'draft';
    await expect(client.financeOperation(request)).rejects.toMatchObject({ code: 'LOCAL_CHANGES' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    working.data.orders[0].remarks = 'original';
    fetcher.mockResolvedValueOnce(reply({ code: 'STALE_VERSION', error: 'Changed', latestVersion: 9 }, 409));
    await expect(client.financeOperation(request)).rejects.toMatchObject({ code: 'CONFLICT', latestVersion: 9 });
    expect(request.idempotencyKey).toBe('keep-on-conflict');
    expect(request.values.paidAmount).toBe(40);
    expect(client.lastMeta.version).toBe(4);
});

test('canonical quote inputs read back normalized aliases and allocated numbers without losing a newer edit', async () => {
    const initial = baseline();
    initial.data.orders[0].factoryCostRMB = 600;
    const fetcher = jest.fn().mockResolvedValueOnce(reply(initial));
    const client = new BusinessAPIClient({ fetcher });
    client.setSessionContext({ user: { permissions: ['finance.write'] } });
    const working = await client.loadData();
    working.data.orders[0].factoryCostUSD = 700;
    const normalized = baseline();
    normalized.meta.version = 5;
    Object.assign(normalized.data.orders[0], { factoryCostUSD: 700, factoryCostRMB: 700, profitUSD: 300 });
    let finishRead, reading;
    const entered = new Promise(resolve => { reading = resolve; });
    fetcher.mockResolvedValueOnce(reply({ meta: { version: 5 } }));
    fetcher.mockImplementationOnce(() => { reading(); return new Promise(resolve => { finishRead = resolve; }); });
    const saving = client.saveData(working.data);
    await entered;
    working.data.orders[0].factoryCostUSD = 800;
    finishRead(reply(normalized));
    await saving;
    expect(working.data.orders[0].factoryCostUSD).toBe(800);
    expect(working.data.orders[0].factoryCostRMB).toBe(700);
    expect(client.hasChanges()).toBe(true);
    expect(fetcher.mock.calls[2][0]).toBe('/api/data');
});

test('server numbers replace only the acknowledged preview and native projections never write back', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce(reply(baseline()));
    const client = new BusinessAPIClient({ fetcher });
    client.setSessionContext({ user: { permissions: ['finance.write'] } });
    const working = await client.loadData();
    working.data.orders.push({ id: 'NEW', companyId: 'C', orderAmountUSD: 100, companyOperationNo: 'preview', companyOperationNoAuto: true,
        nativeSettlementProjection: true, nativeReceiptSummary: [{ name: 'fake' }], factories: [{ factoryId: 'F', advanceAmount: 99, productType: 'Widget' }] });
    const normalized = baseline();
    normalized.meta.version = 5;
    normalized.data.orders.push({ id: 'NEW', companyId: 'C', orderAmountUSD: 100, companyOperationNo: 'EX26U002', factories: [{ factoryId: 'F', productType: 'Widget' }] });
    fetcher.mockResolvedValueOnce(reply({ meta: { version: 5 } })).mockResolvedValueOnce(reply(normalized));
    await client.saveData(working.data);
    const sent = JSON.parse(fetcher.mock.calls[1][1].body).changes[0].value;
    expect(sent).not.toHaveProperty('nativeReceiptSummary');
    expect(sent).not.toHaveProperty('nativeSettlementProjection');
    expect(sent.factories[0]).not.toHaveProperty('advanceAmount');
    expect(working.data.orders[1].companyOperationNo).toBe('EX26U002');
    expect(working.data.orders[1]).not.toHaveProperty('companyOperationNoAuto');
    expect(client.hasChanges()).toBe(false);
});

test('catalog reads and native writes retain exact identity without acknowledging business drafts', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce(reply(baseline()));
    const client = new BusinessAPIClient({ fetcher });
    await client.loadData();
    fetcher.mockResolvedValueOnce(reply({ version: 4, items: [] }));
    await client.catalogState({ companyId: 'C', includeDisabled: true, name: 'A&B' });
    const query = new URL(fetcher.mock.calls[1][0], 'http://localhost').searchParams;
    expect(query.get('includeDisabled')).toBe('1');
    expect(query.get('name')).toBe('A&B');
    const request = { companyId: 'C', operation: 'create', expectedVersion: 4, idempotencyKey: 'new-real-item', values: { itemCode: 'C-001' } };
    fetcher.mockResolvedValueOnce(reply({ meta: { version: 5 }, document: { itemCode: 'C-001' } }));
    await client.catalogOperation(request);
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual(request);
    expect(client.lastMeta.version).toBe(4);
    await expect(client.catalogOperation({ ...request, idempotencyKey: '' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetcher).toHaveBeenCalledTimes(3);
});
