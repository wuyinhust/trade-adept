import { jest } from '@jest/globals';
import { BusinessAPIClient, workspaceDraftKey } from '../js/api-client.js';

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
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][0]).toBe('/api/changes');
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
        const authoritative = fixture();
        Object.assign(authoritative.data.orders[0], {
            factoryCostRMB: 120,
            factories: [{ factoryId: 'F1', totalAmount: 120, prepayment: 20 }],
            orderAmountRMB: 720,
            profitRMB: 600,
            profitRate: 83.33
        });
        authoritative.meta = meta(5);
        fetcher.mockResolvedValueOnce(response({ meta: meta(5) })).mockResolvedValueOnce(response(authoritative));
        await client.saveData(working.data);
        expect(posted().changes[0].value).toEqual({
            factoryCostRMB: 120,
            factories: [{ factoryId: 'F1', totalAmount: 120, prepayment: 20 }]
        });
        expect(working.data.orders[0]).toMatchObject({ orderAmountRMB: 720, profitRMB: 600, profitRate: 83.33 });
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

    test('administrator reads and writes use their dedicated route and advance the shared CAS baseline', async () => {
        fetcher.mockResolvedValueOnce(response({ enterprise: { name: 'Before' }, meta: meta(4) }));
        expect((await client.adminState()).enterprise.name).toBe('Before');
        fetcher.mockResolvedValueOnce(response({ changed: { name: 'After' }, meta: meta(5) }));
        await client.adminUpdate({ expectedVersion: 4, resource: 'enterprise', value: { name: 'After' } });
        working.data.orders[0].remarks = 'business edit after configuration';
        fetcher.mockResolvedValueOnce(response({ meta: meta(6) }));
        await client.saveData(working.data);

        expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
            '/api/administrator',
            '/api/administrator',
            '/api/changes'
        ]);
        expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
            expectedVersion: 4,
            resource: 'enterprise',
            value: { name: 'After' }
        });
        expect(JSON.parse(fetcher.mock.calls[2][1].body).expectedVersion).toBe(5);
        expect(client.lastMeta.version).toBe(6);
    });

    test('administrator update is blocked while a business draft is dirty', async () => {
        working.data.orders[0].remarks = 'unsaved draft';
        await expect(
            client.adminUpdate({ expectedVersion: 4, resource: 'enterprise', value: { name: 'After' } })
        ).rejects.toMatchObject({ code: 'LOCAL_CHANGES' });
        expect(fetcher).not.toHaveBeenCalled();
    });

    test('administrator update rejects a stale page version before network mutation', async () => {
        await expect(
            client.adminUpdate({ expectedVersion: 3, resource: 'enterprise', value: { name: 'After' } })
        ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
        expect(fetcher).not.toHaveBeenCalled();
    });

    test('live exchange-rate read uses the same-origin gateway without altering the data baseline', async () => {
        const rate = {
            rawRate: 7.28,
            adjustedRate: 7.26,
            publishedAt: '2026-10-12T00:02:31Z',
            nextUpdateAt: '2026-10-13T00:02:31Z',
            cached: true
        };
        fetcher.mockResolvedValue(response(rate));
        expect(await client.getExchangeRate()).toEqual(rate);
        expect(fetcher.mock.calls[0][0]).toBe('/api/exchange-rate');
        expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin' });
        expect(client.lastMeta.version).toBe(4);
    });

    test('live-rate mode never persists an in-memory market quote with an unrelated business edit', async () => {
        const liveFetcher = jest.fn().mockResolvedValueOnce(response(fixture()));
        const liveClient = new BusinessAPIClient({ fetcher: liveFetcher, persistExchangeRates: false });
        const liveWorking = await liveClient.loadData();
        liveFetcher.mockClear();
        liveWorking.exchangeRates['CO-DEMO'] = 7.26;
        liveWorking.rateMetas['CO-DEMO'] = { source: 'ExchangeRate-API', isAuto: true };
        liveWorking.data.orders[0].remarks = 'uses current quote';
        liveFetcher.mockResolvedValue(response({ ok: true, meta: meta(5) }));
        await liveClient.saveData(liveWorking.data, liveWorking.exchangeRates, liveWorking.rateMetas);
        const body = JSON.parse(liveFetcher.mock.calls[0][1].body);
        expect(body.changes).toEqual([{ collection: 'orders', id: 'O1', value: { remarks: 'uses current quote' } }]);
        expect(body).not.toHaveProperty('exchangeRates');
        expect(body).not.toHaveProperty('rateMetas');
    });

    test('financial save reads back and displays server-derived values from the accepted rate publication', async () => {
        client.setSessionContext({ user: { permissions: ['finance.write'] } });
        Object.assign(working.data.orders[0], {
            companyId: 'CO-DEMO',
            orderAmountUSD: 100,
            orderAmountRMB: 720,
            profitRMB: 120
        });
        const authoritative = fixture();
        Object.assign(authoritative.data.orders[0], {
            companyId: 'CO-DEMO',
            orderAmountUSD: 100,
            orderAmountRMB: 726,
            profitRMB: 126,
            profitUSD: 17.36,
            profitRate: 17.36,
            margin: 0.1736,
            profitPolicy: 'live-publication',
            settlementCurrency: 'CNY',
            updatedAt: '2026-10-12T00:05:00Z',
            updatedBy: 'demo-user',
            version: 5
        });
        authoritative.meta = meta(5);
        fetcher
            .mockResolvedValueOnce(response({ ok: true, meta: meta(5) }))
            .mockResolvedValueOnce(response(authoritative));

        await client.saveData(working.data, working.exchangeRates, working.rateMetas);

        expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/changes', '/api/data']);
        expect(working.data.orders[0]).toMatchObject({
            orderAmountUSD: 100,
            orderAmountRMB: 726,
            profitRMB: 126,
            profitUSD: 17.36,
            profitPolicy: 'live-publication',
            settlementCurrency: 'CNY',
            version: 5
        });
        expect(client.lastMeta.version).toBe(5);
        expect(client.hasChanges()).toBe(false);
    });

    test('financial reconciliation preserves user input edits made during both write and follow-up read', async () => {
        client.setSessionContext({ user: { permissions: ['finance.write'] } });
        Object.assign(working.data.orders[0], {
            companyId: 'CO-DEMO',
            orderAmountUSD: 100,
            orderAmountRMB: 720
        });
        const postEntered = deferred();
        const postPending = deferred();
        const readEntered = deferred();
        const readPending = deferred();
        fetcher
            .mockImplementationOnce(() => {
                postEntered.resolve();
                return postPending.promise;
            })
            .mockImplementationOnce(() => {
                readEntered.resolve();
                return readPending.promise;
            });

        const saving = client.saveData(working.data, working.exchangeRates, working.rateMetas);
        await postEntered.promise;
        working.data.orders[0].orderAmountUSD = 200;
        working.data.orders[0].remarks = 'edited during write';
        postPending.resolve(response({ ok: true, meta: meta(5) }));
        await readEntered.promise;
        working.data.orders[0].freightCostUSD = 15;
        const authoritative = fixture();
        Object.assign(authoritative.data.orders[0], {
            companyId: 'CO-DEMO',
            orderAmountUSD: 100,
            orderAmountRMB: 726,
            profitRMB: 126,
            settlementCurrency: 'CNY',
            updatedAt: '2026-10-12T00:05:00Z'
        });
        authoritative.meta = meta(5);
        readPending.resolve(response(authoritative));
        await saving;

        expect(working.data.orders[0]).toMatchObject({
            orderAmountUSD: 200,
            remarks: 'edited during write',
            freightCostUSD: 15,
            orderAmountRMB: 726,
            profitRMB: 126
        });
        expect(client._diff(working.data, working.exchangeRates, working.rateMetas).changes).toEqual([
            {
                collection: 'orders',
                id: 'O1',
                value: { remarks: 'edited during write', orderAmountUSD: 200, freightCostUSD: 15 }
            }
        ]);
    });

    test('failed readback reports an applied conflict and prevents duplicate financial submission', async () => {
        client.setSessionContext({ user: { permissions: ['finance.write'] } });
        Object.assign(working.data.orders[0], {
            companyId: 'CO-DEMO',
            orderAmountUSD: 100,
            orderAmountRMB: 720
        });
        fetcher
            .mockResolvedValueOnce(response({ ok: true, meta: meta(5) }))
            .mockRejectedValueOnce(new Error('readback unavailable'));

        await expect(client.saveData(working.data, working.exchangeRates, working.rateMetas)).rejects.toMatchObject({
            code: 'CONFLICT',
            status: 409,
            latestVersion: 5,
            operationApplied: true,
            refreshRequired: true
        });
        expect(client.lastMeta.version).toBe(5);
        expect(client.hasChanges()).toBe(false);
        await expect(client.saveData(working.data)).rejects.toMatchObject({
            code: 'CONFLICT',
            operationApplied: true
        });
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/changes', '/api/data']);
    });

    test('a newer readback version is an applied conflict instead of a baseline that can overwrite another user', async () => {
        client.setSessionContext({ user: { permissions: ['finance.write'] } });
        Object.assign(working.data.orders[0], {
            companyId: 'CO-DEMO',
            orderAmountUSD: 100,
            orderAmountRMB: 720
        });
        const newer = fixture();
        Object.assign(newer.data.orders[0], {
            companyId: 'CO-DEMO',
            orderAmountUSD: 100,
            orderAmountRMB: 726,
            remarks: 'another user changed this'
        });
        newer.meta = meta(6);
        fetcher.mockResolvedValueOnce(response({ ok: true, meta: meta(5) })).mockResolvedValueOnce(response(newer));

        await expect(client.saveData(working.data)).rejects.toMatchObject({
            code: 'CONFLICT',
            operationApplied: true,
            refreshRequired: true,
            latestVersion: 6
        });
        expect(client.lastMeta.version).toBe(5);
        expect(working.data.orders[0]).toMatchObject({ remarks: 'base one', orderAmountRMB: 720 });
        await expect(client.saveData(working.data)).rejects.toMatchObject({ code: 'CONFLICT', latestVersion: 6 });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});

describe('native order actions preserve the acknowledged baseline', () => {
    let fetcher, client, working;
    beforeEach(async () => {
        fetcher = jest.fn().mockResolvedValueOnce(response(fixture()));
        client = new BusinessAPIClient({ fetcher });
        working = await client.loadData();
        fetcher.mockClear();
    });
    test('conversion is one atomic CAS request and requires a new authorized read', async () => {
        fetcher.mockResolvedValueOnce(
            response({ meta: meta(5), nativeDocuments: [{ doctype: 'Sales Order', name: 'SO-1', docstatus: 0 }] })
        );
        await client.convertOrder('O1', { idempotencyKey: 'convert-once' });
        expect(fetcher.mock.calls[0][0]).toBe('/api/orders/convert');
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
            orderId: 'O1',
            expectedVersion: 4,
            idempotencyKey: 'convert-once'
        });
        expect(client.lastMeta.version).toBe(4);
        fetcher.mockResolvedValueOnce(response({ ...fixture(), meta: meta(5) }));
        await client.loadData();
        expect(client.lastMeta.version).toBe(5);
    });
    test('a dirty workspace prevents native conversion without losing its draft', async () => {
        working.data.orders[0].remarks = 'draft';
        await expect(client.convertOrder('O1', { idempotencyKey: 'one' })).rejects.toMatchObject({
            code: 'LOCAL_CHANGES'
        });
        expect(fetcher).not.toHaveBeenCalled();
        expect(working.data.orders[0].remarks).toBe('draft');
    });
    test('a native CAS conflict holds subsequent saves against the original baseline', async () => {
        fetcher.mockResolvedValueOnce(response({ code: 'VERSION_CONFLICT', latestVersion: 9 }, 409));
        await expect(client.submitOrder('O1', { idempotencyKey: 'submit-once' })).rejects.toMatchObject({
            code: 'CONFLICT',
            latestVersion: 9
        });
        working.data.orders[0].remarks = 'retained';
        await expect(client.saveData(working.data)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(client.lastMeta.version).toBe(4);
    });
    test('edits during native receipt remain a draft even when the receipt succeeds', async () => {
        const entered = deferred(),
            pending = deferred();
        fetcher.mockImplementationOnce(() => {
            entered.resolve();
            return pending.promise;
        });
        const receiving = client.receivePayment('O1', {
            idempotencyKey: 'receipt-once',
            amountUSD: 25,
            referenceNo: 'BANK-1',
            referenceDate: '2026-10-12'
        });
        await entered.promise;
        working.data.orders[0].remarks = 'during receipt';
        pending.resolve(response({ meta: meta(5) }));
        await expect(receiving).rejects.toMatchObject({ code: 'CONFLICT', operationApplied: true, latestVersion: 5 });
        expect(working.data.orders[0].remarks).toBe('during receipt');
        expect(client.lastMeta.version).toBe(4);
        await expect(client.loadData()).rejects.toMatchObject({ code: 'LOCAL_CHANGES' });
    });
    test('network-lost receipt retries retain the exact same request identity and inputs', async () => {
        const inputs = {
            idempotencyKey: 'receipt-stable',
            amountUSD: 25,
            referenceNo: 'BANK-1',
            referenceDate: '2026-10-12'
        };
        fetcher.mockRejectedValueOnce(new Error('lost'));
        await expect(client.receivePayment('O1', inputs)).rejects.toMatchObject({ code: 'NETWORK' });
        fetcher.mockResolvedValueOnce(response({ meta: meta(5) }));
        await client.receivePayment('O1', inputs);
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(JSON.parse(fetcher.mock.calls[1][1].body));
        expect(working.data.orders[0]).not.toHaveProperty('paidAmountUSD');
    });
    test('cancellation dependency errors do not lock unrelated edits as a version conflict', async () => {
        fetcher.mockResolvedValueOnce(
            response({ code: 'NATIVE_CANCELLATION_REQUIRES_RECONCILIATION', error: 'Resolve receipt first' }, 409)
        );
        await expect(client.cancelOrder('O1', { idempotencyKey: 'cancel-once' })).rejects.toMatchObject({
            code: 'NATIVE_CANCELLATION_REQUIRES_RECONCILIATION'
        });
        expect(fetcher.mock.calls[0][0]).toBe('/api/orders/cancel');
        working.data.orders[0].remarks = 'operational note';
        fetcher.mockResolvedValueOnce(response({ meta: meta(5) }));
        await client.saveData(working.data);
        expect(JSON.parse(fetcher.mock.calls[1][1].body).expectedVersion).toBe(4);
    });
    test('finance editors cannot submit source or frozen-rate server metadata', async () => {
        client.setSessionContext({ user: { permissions: ['finance.write'] } });
        Object.assign(working.data.orders[0], {
            stage: 'native',
            nativeDocuments: [{ doctype: 'Sales Order', name: 'spoofed' }],
            exchangeRateUsed: 999,
            settlementCurrency: 'EUR',
            profitPolicy: 'spoofed'
        });
        await client.saveData(working.data);
        expect(fetcher).not.toHaveBeenCalled();
    });
});

test('native draft namespaces bind backend instance, origin, tenant, actor and permissions', () => {
    const session = {
        backend: 'erpnext',
        backendIdentity: 'site-A:uuid-A',
        user: {
            id: 'U1',
            tenantId: 'tenant-A',
            role: 'admin',
            scope: 'tenant',
            permissions: ['finance.write'],
            visibleCompanyIds: ['C1']
        }
    };
    const key = workspaceDraftKey(session, 'https://example.test');
    expect(key.startsWith('trade_frappe_draft_v2:')).toBe(true);
    for (const changed of [
        { ...session, backendIdentity: 'site-B:uuid-B' },
        { ...session, user: { ...session.user, tenantId: 'tenant-B' } },
        { ...session, user: { ...session.user, id: 'U2' } },
        { ...session, user: { ...session.user, permissions: [] } }
    ])
        expect(workspaceDraftKey(changed, 'https://example.test')).not.toBe(key);
    expect(workspaceDraftKey(session, 'https://other.test')).not.toBe(key);
});

test('confirmed historical imports use one CAS batch and their purpose cannot leak into ordinary saves', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce(response(fixture()));
    const client = new BusinessAPIClient({ fetcher });
    const before = await client.loadData();
    client.setSessionContext({ user: { permissions: ['finance.write'] } });
    const change = {
        collection: 'orders',
        id: 'H1',
        value: {
            companyId: 'C1',
            companyOperationNo: 'HIS-001',
            orderAmountUSD: 1000,
            paidAmountUSD: 300,
            profitRMB: 777.77
        }
    };
    fetcher.mockResolvedValueOnce(response({ meta: meta(5) }));
    await client.importOrders([change], { importPurpose: 'historical-reference', expectedVersion: 4 });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
        expectedVersion: 4,
        importPurpose: 'historical-reference',
        changes: [change]
    });
    expect(before.data.orders).toHaveLength(2);
    expect(client.lastMeta.version).toBe(4);
    const fresh = fixture();
    fresh.data.orders.push({ id: 'H1', ...change.value });
    fresh.meta = meta(5);
    fetcher.mockResolvedValueOnce(response(fresh));
    const working = await client.loadData();
    working.data.orders[0].remarks = 'ordinary edit';
    fetcher.mockResolvedValueOnce(response({ meta: meta(6) }));
    await client.saveData(working.data);
    const body = JSON.parse(fetcher.mock.calls[3][1].body);
    expect(body).not.toHaveProperty('importPurpose');
    expect(body.expectedVersion).toBe(5);
});
