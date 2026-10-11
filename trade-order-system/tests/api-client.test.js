import { jest } from '@jest/globals';
import { BusinessAPIClient } from '../js/api-client.js';

const clone = value => JSON.parse(JSON.stringify(value));
const meta = version => ({
    version,
    updatedAt: `2026-10-11T00:00:${String(version).padStart(2, '0')}Z`,
    updatedBy: 'demo-user'
});
const fixture = () => ({
    data: {
        customers: [{ id: 'C1', company: 'Demo customer', contacts: [{ id: 'CT1', name: 'Ann', phone: '123' }] }],
        orders: [
            { id: 'O1', remarks: 'base one' },
            { id: 'O2', remarks: 'base two' }
        ],
        factories: [],
        shipments: [],
        invoices: []
    },
    exchangeRates: { 'CO-DEMO': 7.2 },
    rateMetas: { 'CO-DEMO': { source: 'manual' } },
    meta: meta(4)
});
const response = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => clone(payload)
});
const deferred = () => {
    let resolve;
    const promise = new Promise(r => {
        resolve = r;
    });
    return { promise, resolve };
};

describe('BusinessAPIClient acknowledged baseline and atomic API contract', () => {
    let fetcher;
    let client;
    let working;
    beforeEach(async () => {
        fetcher = jest.fn().mockResolvedValueOnce(response(fixture()));
        client = new BusinessAPIClient({ fetcher });
        working = await client.loadData();
        fetcher.mockClear();
    });
    const posted = () => JSON.parse(fetcher.mock.calls.find(([, options]) => options.method === 'POST')[1].body);

    test('an open edit form prevents reads from advancing the save baseline', async () => {
        client._canReplaceData = () => false;
        await expect(client.loadData()).rejects.toMatchObject({ code: 'LOCAL_CHANGES' });
        expect(fetcher).not.toHaveBeenCalled();
        expect(client.lastMeta.version).toBe(4);
    });

    test('opening a form during a read preserves the baseline it was opened against', async () => {
        let canReplace = true;
        client._canReplaceData = () => canReplace;
        const waiting = deferred();
        fetcher.mockReturnValueOnce(waiting.promise);
        const reading = client.loadData();
        await Promise.resolve();
        canReplace = false;
        waiting.resolve(response({ ...fixture(), meta: meta(5) }));
        await expect(reading).rejects.toMatchObject({ code: 'LOCAL_CHANGES' });
        expect(client.lastMeta.version).toBe(4);
        expect(working.data.orders[0].remarks).toBe('base one');
    });

    test('creates new parents before their order and shipping references in one batch', async () => {
        working.data.customers.push({ id: 'C2', company: 'New customer' });
        working.data.factories.push({ id: 'F1', name: 'New factory' });
        working.data.orders.push({ id: 'O3', customerId: 'C2', factories: [{ factoryId: 'F1' }] });
        working.data.shipments.push({ id: 'S1', orderId: 'O3' });
        working.data.invoices.push({ id: 'I1', orderId: 'O3' });
        fetcher.mockResolvedValue(response({ ok: true, meta: meta(5) }));
        await client.saveData(working.data, working.exchangeRates, working.rateMetas);
        expect(posted().changes.map(change => change.collection)).toEqual([
            'customers',
            'factories',
            'orders',
            'shipments',
            'invoices'
        ]);
    });

    test('sends only edited record fields, excluding stale unrelated rows', async () => {
        working.data.orders[1].remarks = 'B edits order two';
        fetcher.mockResolvedValue(response({ ok: true, meta: meta(5) }));
        await client.saveData(working.data, working.exchangeRates, working.rateMetas);
        expect(posted()).toEqual({
            expectedVersion: 4,
            changes: [{ collection: 'orders', id: 'O2', value: { remarks: 'B edits order two' } }]
        });
        expect(client.lastMeta.version).toBe(5);
        expect(client.hasChanges()).toBe(false);
    });

    test('server 409 retains baseline and edits and blocks queued retries', async () => {
        working.data.orders[0].remarks = 'draft';
        fetcher.mockResolvedValue(
            response({ error: 'Version changed', code: 'VERSION_CONFLICT', latestVersion: 9 }, 409)
        );
        const first = client.saveData(working.data);
        const queued = client.saveData(working.data);
        await expect(first).rejects.toMatchObject({ code: 'CONFLICT', status: 409, latestVersion: 9 });
        await expect(queued).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(client.lastMeta.version).toBe(4);
        expect(working.data.orders[0].remarks).toBe('draft');
        expect(client.hasChanges()).toBe(true);
    });

    test('network failure does not advance the baseline or discard draft', async () => {
        working.data.orders[0].remarks = 'offline edit';
        fetcher.mockRejectedValueOnce(new Error('connection lost'));
        await expect(client.saveData(working.data)).rejects.toMatchObject({ code: 'NETWORK' });
        expect(client.lastMeta.version).toBe(4);
        expect(client.hasChanges()).toBe(true);
        fetcher.mockResolvedValueOnce(response({ meta: meta(5) }));
        await client.saveData(working.data);
        expect(JSON.parse(fetcher.mock.calls[1][1].body).expectedVersion).toBe(4);
    });

    test('unchanged data avoids POST even when object key order differs', async () => {
        working.data.orders[0] = { remarks: 'base one', id: 'O1' };
        await expect(client.saveData(working.data, working.exchangeRates, working.rateMetas)).resolves.toBe(true);
        expect(fetcher).not.toHaveBeenCalled();
        expect(client.lastMeta.version).toBe(4);
    });

    test('soft deletion sends a deletion command without stale field contents', async () => {
        Object.assign(working.data.orders[0], { deleted: true, deletedAt: 'local clock', remarks: 'old content' });
        fetcher.mockResolvedValue(response({ meta: meta(5) }));
        await client.saveData(working.data);
        expect(posted().changes).toEqual([{ collection: 'orders', id: 'O1', deleted: true }]);
        expect(client.hasChanges()).toBe(false);
    });

    test('removed visible record becomes soft-delete while missing collection is left untouched', async () => {
        working.data.orders.splice(0, 1);
        delete working.data.customers;
        fetcher.mockResolvedValue(response({ meta: meta(5) }));
        await client.saveData(working.data);
        expect(posted().changes).toEqual([{ collection: 'orders', id: 'O1', deleted: true }]);
    });

    test('new records across all collections use stable supplied IDs', async () => {
        working.data.factories.push({ id: 'F2', name: 'Demo supplier' });
        working.data.shipments.push({ id: 'S1', orderId: 'O1', shippingStatus: '待出运' });
        working.data.invoices.push({ id: 'I1', orderId: 'O1', docType: 'invoice' });
        fetcher.mockResolvedValue(response({ meta: meta(5) }));
        await client.saveData(working.data);
        expect(posted().changes.map(c => c.collection)).toEqual(['factories', 'shipments', 'invoices']);
        expect(client.hasChanges()).toBe(false);
    });

    test('omitted fields and omitted rates do not become deletion patches', async () => {
        delete working.data.orders[0].remarks;
        working.data.orders[1].shippingStatus = '已出运';
        delete working.exchangeRates['CO-DEMO'];
        fetcher.mockResolvedValue(response({ meta: meta(5) }));
        await client.saveData(working.data, working.exchangeRates);
        expect(posted().changes).toEqual([{ collection: 'orders', id: 'O2', value: { shippingStatus: '已出运' } }]);
        expect(posted()).not.toHaveProperty('exchangeRates');
    });

    test('non-finance session drops form-generated financial zeroes and nested costs', async () => {
        client.setSessionContext({ user: { permissions: ['orders.write'] } });
        Object.assign(working.data.orders[0], {
            remarks: 'public edit',
            factoryCostRMB: 0,
            paidAmountUSD: 0,
            paymentStatus: '未收款',
            profitRMB: 0
        });
        working.data.orders[0].factories = [{ factoryId: 'F1', productType: 'Demo', totalAmount: 0, prepayment: 0 }];
        fetcher.mockResolvedValue(response({ meta: meta(5) }));
        await client.saveData(working.data);
        expect(posted().changes[0].value).toEqual({
            remarks: 'public edit',
            factories: [{ factoryId: 'F1', productType: 'Demo' }]
        });
        expect(client.hasChanges()).toBe(false);
    });

    test('configured permission map allows cost fields while server-derived profit is omitted', async () => {
        client.setSessionContext({ user: { permissions: { 'finance.write': true } } });
        Object.assign(working.data.orders[0], {
            factoryCostRMB: 120,
            profitRMB: 999,
            orderAmountRMB: 999,
            profitRate: 80
        });
        working.data.orders[0].factories = [{ factoryId: 'F1', totalAmount: 120, prepayment: 20 }];
        fetcher.mockResolvedValue(response({ meta: meta(5) }));
        await client.saveData(working.data);
        expect(posted().changes[0].value).toEqual({
            factoryCostRMB: 120,
            factories: [{ factoryId: 'F1', totalAmount: 120, prepayment: 20 }]
        });
    });

    test('readonly finance visibility does not imply permission to submit financial edits', async () => {
        client.setSessionContext({ user: { role: 'viewer' }, roles: { viewer: { permissions: ['finance.read'] } } });
        working.data.orders[0].factoryCostRMB = 0;
        await client.saveData(working.data);
        expect(fetcher).not.toHaveBeenCalled();
    });

    test('contacts editing replaces the array rather than unioning old contacts', async () => {
        working.data.customers[0].contacts = [{ id: 'CT1', name: 'Ann', phone: '456' }];
        fetcher.mockResolvedValue(response({ meta: meta(5) }));
        await client.saveData(working.data);
        expect(posted().changes[0].value.contacts).toEqual([{ id: 'CT1', name: 'Ann', phone: '456' }]);
        working.data.customers[0].contacts = [];
        fetcher.mockResolvedValue(response({ meta: meta(6) }));
        await client.saveData(working.data);
        expect(JSON.parse(fetcher.mock.calls[1][1].body).changes[0].value.contacts).toEqual([]);
    });

    test('remote metadata does not replace the original expectedVersion or dirty draft', async () => {
        working.data.orders[0].remarks = 'draft';
        fetcher.mockResolvedValueOnce(response({ meta: meta(8) }));
        expect((await client.checkRemoteVersion()).version).toBe(8);
        expect(client.lastMeta.version).toBe(4);
        await expect(client.loadData()).rejects.toMatchObject({ code: 'LOCAL_CHANGES' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('acknowledges only the submitted snapshot while newer edits remain dirty', async () => {
        const entered = deferred();
        const pending = deferred();
        working.data.orders[0].remarks = 'first';
        fetcher.mockImplementationOnce(() => {
            entered.resolve();
            return pending.promise;
        });
        const saving = client.saveData(working.data);
        await entered.promise;
        working.data.orders[0].remarks = 'second';
        pending.resolve(response({ meta: meta(5) }));
        await saving;
        expect(client.hasChanges()).toBe(true);
        expect(posted().changes[0].value.remarks).toBe('first');
        fetcher.mockResolvedValueOnce(response({ meta: meta(6) }));
        await client.saveData(working.data);
        expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
            expectedVersion: 5,
            changes: [{ collection: 'orders', id: 'O1', value: { remarks: 'second' } }]
        });
    });

    test('queued save samples mutations when it starts after the previous ACK', async () => {
        const entered = deferred();
        const pending = deferred();
        working.data.orders[0].remarks = 'first';
        fetcher.mockImplementationOnce(() => {
            entered.resolve();
            return pending.promise;
        });
        const first = client.saveData(working.data);
        await entered.promise;
        const second = client.saveData(working.data);
        working.data.orders[1].remarks = 'edited after enqueue';
        fetcher.mockResolvedValueOnce(response({ meta: meta(6) }));
        pending.resolve(response({ meta: meta(5) }));
        await Promise.all([first, second]);
        expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
            expectedVersion: 5,
            changes: [{ collection: 'orders', id: 'O2', value: { remarks: 'edited after enqueue' } }]
        });
        expect(client.hasChanges()).toBe(false);
    });

    test('load waits for save and cannot reset its baseline during an in-flight mutation', async () => {
        const entered = deferred();
        const pending = deferred();
        working.data.orders[0].remarks = 'saved';
        fetcher.mockImplementationOnce(() => {
            entered.resolve();
            return pending.promise;
        });
        const saving = client.saveData(working.data);
        await entered.promise;
        const fresh = fixture();
        fresh.data.orders[0].remarks = 'saved';
        fresh.meta = meta(5);
        fetcher.mockResolvedValueOnce(response(fresh));
        const loading = client.loadData();
        expect(fetcher).toHaveBeenCalledTimes(1);
        pending.resolve(response({ meta: meta(5) }));
        await saving;
        const loaded = await loading;
        expect(loaded.data.orders[0].remarks).toBe('saved');
        expect(client.lastMeta.version).toBe(5);
    });

    test('an edit made while GET is in flight keeps the old baseline and draft', async () => {
        const entered = deferred();
        const pending = deferred();
        fetcher.mockImplementationOnce(() => {
            entered.resolve();
            return pending.promise;
        });
        const loading = client.loadData();
        await entered.promise;
        working.data.orders[0].remarks = 'edited during refresh';
        const fresh = fixture();
        fresh.meta = meta(8);
        pending.resolve(response(fresh));
        await expect(loading).rejects.toMatchObject({ code: 'LOCAL_CHANGES' });
        expect(client.lastMeta.version).toBe(4);
        expect(client.hasChanges()).toBe(true);
    });

    test('mutating returned meta cannot forge the write expectedVersion', async () => {
        working.meta.version = 90;
        client.lastMeta.version = 90;
        working.data.orders[0].remarks = 'draft';
        fetcher.mockResolvedValue(response({ meta: meta(5) }));
        await client.saveData(working.data);
        expect(posted().expectedVersion).toBe(4);
    });

    test('invalid success acknowledgement does not advance baseline', async () => {
        working.data.orders[0].remarks = 'draft';
        fetcher.mockResolvedValue(response({ meta: meta(4) }));
        await expect(client.saveData(working.data)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(client.lastMeta.version).toBe(4);
        expect(client.hasChanges()).toBe(true);
    });

    test('duplicate IDs fail before a network mutation', async () => {
        working.data.orders.push({ id: 'O1', remarks: 'duplicate' });
        await expect(client.saveData(working.data)).rejects.toMatchObject({ code: 'DUPLICATE_ID' });
        expect(fetcher).not.toHaveBeenCalled();
    });

    test('rate updates contain only modified company entries', async () => {
        working.exchangeRates['CO-DEMO'] = 7.3;
        fetcher.mockResolvedValue(response({ meta: meta(5) }));
        await client.saveData(working.data, working.exchangeRates, working.rateMetas);
        expect(posted()).toEqual({ expectedVersion: 4, changes: [], exchangeRates: { 'CO-DEMO': 7.3 } });
    });

    test('restore uses current read version and requires a new authorized read', async () => {
        fetcher.mockResolvedValue(response({ ok: true, meta: meta(5) }));
        await client.restore('SNAP-1');
        expect(posted()).toEqual({ snapshotId: 'SNAP-1', expectedVersion: 4 });
        expect(client.lastMeta.version).toBe(5);
        await expect(client.saveData(working.data)).rejects.toMatchObject({ code: 'NO_BASELINE' });
    });

    test('restore rejects dirty data and forged supplied version before POST', async () => {
        await expect(client.restore('SNAP-1', 9)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
        working.data.orders[0].remarks = 'draft';
        await expect(client.restore('SNAP-1')).rejects.toMatchObject({ code: 'LOCAL_CHANGES' });
        expect(fetcher).not.toHaveBeenCalled();
    });

    test('restore conflict preserves existing baseline', async () => {
        fetcher.mockResolvedValue(response({ error: 'Changed', latestVersion: 8 }, 409));
        await expect(client.restore('SNAP-1')).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
        expect(client.lastMeta.version).toBe(4);
    });

    test('explicit reset followed by read allows user-resolved conflict', async () => {
        working.data.orders[0].remarks = 'discarded draft';
        client.resetBaseline();
        const fresh = fixture();
        fresh.meta = meta(8);
        fetcher.mockResolvedValue(response(fresh));
        const loaded = await client.loadData();
        expect(loaded.data.orders[0].remarks).toBe('base one');
        expect(client.lastMeta.version).toBe(8);
    });

    test('session/login/logout use same-origin cookies and retain no password', async () => {
        fetcher.mockResolvedValue(
            response({ user: { id: 'demo-user' }, users: [], companies: [], roles: {}, tenant: { id: 'DEMO' } })
        );
        await client.session();
        await client.login({ tenantId: 'DEMO', username: 'demo', password: 'test-only-value' });
        expect(fetcher.mock.calls[1][1].credentials).toBe('same-origin');
        expect(JSON.stringify(client)).not.toContain('test-only-value');
        expect(client.lastMeta.version).toBe(0);
        await client.logout();
        expect(fetcher.mock.calls[2][0]).toBe('/api/logout');
        expect(client.isReady()).toBe(false);
    });

    test('snapshot listing does not alter data baseline', async () => {
        fetcher.mockResolvedValue(response({ snapshots: [{ id: 'SNAP-1', version: 2 }] }));
        expect(await client.listSnapshots()).toEqual([{ id: 'SNAP-1', version: 2 }]);
        expect(client.lastMeta.version).toBe(4);
    });
});
