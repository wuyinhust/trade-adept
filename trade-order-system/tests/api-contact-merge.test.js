import { jest } from '@jest/globals';
import { BusinessAPIClient } from '../js/api-client.js';
const copy = value => JSON.parse(JSON.stringify(value));
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => copy(value) });
const contact = (id, name) => ({
    id,
    name,
    phone: ' 00123 ',
    position: 'Sales',
    email: `${id}@example.invalid`,
    mobilePhone: '00123',
    homeAddress: ''
});
const data = () => ({
    data: {
        customers: [
            { id: 'C1', companyId: 'CO1', company: 'Example', contact: 'Ann', contacts: [contact('CT1', 'Ann')] }
        ],
        orders: [{ id: 'O1', remarks: 'original' }],
        factories: [],
        shipments: [],
        invoices: []
    },
    exchangeRates: {},
    rateMetas: {},
    meta: { version: 4 }
});
let fetcher, api, working, server;
beforeEach(async () => {
    server = data();
    fetcher = jest.fn(async (url, options) => {
        if (options.method === 'POST') {
            const body = JSON.parse(options.body);
            if (body.expectedVersion !== server.meta.version)
                return response({ code: 'CONFLICT', latestVersion: server.meta.version }, 409);
            for (const change of body.changes)
                Object.assign(
                    server.data.customers.find(row => row.id === change.id),
                    copy(change.value)
                );
            server.meta.version++;
            return response({ ok: true, meta: server.meta });
        }
        return response(server);
    });
    api = new BusinessAPIClient({ fetcher });
    working = await api.loadData();
    working.data.customers[0].contacts.push(contact('LOCAL', 'Local person'));
    api.bindWorkingData(working.data, working.exchangeRates, working.rateMetas);
    server.data.customers[0].contacts.push(contact('REMOTE', 'Remote person'));
    server.data.orders[0].remarks = 'remote current order';
    server.meta.version = 5;
    await expect(api.saveData(working.data, {}, {})).rejects.toMatchObject({ code: 'CONFLICT' });
    fetcher.mockClear();
});

test('independent additions save through latest CAS and preserve other remote records', async () => {
    const preview = await api.prepareContactMerge();
    expect(api.lastMeta.version).toBe(4);
    expect(working.data.customers[0].contacts.map(row => row.id)).toEqual(['CT1', 'LOCAL']);
    const result = await api.applyContactMerge(preview.id);
    const body = JSON.parse(fetcher.mock.calls.find(([, options]) => options.method === 'POST')[1].body);
    expect(body.expectedVersion).toBe(5);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].collection).toBe('customers');
    expect(result.data.customers[0].contacts.map(row => row.id)).toEqual(['CT1', 'REMOTE', 'LOCAL']);
    expect(result.data.customers[0].contacts[0].phone).toBe(' 00123 ');
    expect(result.data.orders[0].remarks).toBe('remote current order');
    expect(api.hasChanges()).toBe(false);
});

test('same field requires an explicit choice before any POST', async () => {
    working.data.customers[0].contacts[0].phone = 'local phone';
    server.data.customers[0].contacts[0].phone = 'remote phone';
    const preview = await api.prepareContactMerge();
    await expect(api.applyContactMerge(preview.id)).rejects.toMatchObject({ code: 'CONTACT_MERGE_UNRESOLVED' });
    expect(fetcher.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
    const conflict = preview.customers[0].plan.conflicts[0];
    const result = await api.applyContactMerge(preview.id, { [`C1:${conflict.id}`]: 'local' });
    expect(result.data.customers[0].contacts[0].phone).toBe('local phone');
});

test('a second server update rejects the reviewed old version without overwriting', async () => {
    const preview = await api.prepareContactMerge();
    server.meta.version = 6;
    server.data.customers[0].contacts.push(contact('LATER', 'Later person'));
    await expect(api.applyContactMerge(preview.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(server.data.customers[0].contacts.map(row => row.id)).toEqual(['CT1', 'REMOTE', 'LATER']);
    expect(api.lastMeta.version).toBe(4);
});

test('other pending changes cannot be discarded by a contacts-only merge', async () => {
    working.data.orders[0].remarks = 'new local order input';
    await expect(api.prepareContactMerge()).rejects.toMatchObject({ code: 'CONTACT_MERGE_REQUIRES_CONTACT_ONLY' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(working.data.orders[0].remarks).toBe('new local order input');
});

test('new input after preview invalidates the proposal', async () => {
    const preview = await api.prepareContactMerge();
    working.data.customers[0].contacts.push(contact('LATER', 'New unsaved person'));
    await expect(api.applyContactMerge(preview.id)).rejects.toMatchObject({ code: 'CONTACT_MERGE_CHANGED' });
    expect(fetcher.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
});

test('deleted or no longer visible customer cannot be restored by a merge', async () => {
    server.data.customers = [];
    await expect(api.prepareContactMerge()).rejects.toMatchObject({ code: 'CONTACT_MERGE_UNAVAILABLE' });
    expect(working.data.customers).toHaveLength(1);
});

test('permission changes invalidate the prepared merge', async () => {
    api.setSessionContext({ user: { id: 'U1', tenantId: 'T1', permissions: ['records.write'] } });
    const preview = await api.prepareContactMerge();
    api.setSessionContext({ user: { id: 'U1', tenantId: 'T1', permissions: [] } });
    await expect(api.applyContactMerge(preview.id)).rejects.toMatchObject({ code: 'CONTACT_MERGE_CHANGED' });
});

test('the persisted acknowledged base supports recovery after refresh', async () => {
    const original = api.exportDraftBaseline();
    const next = new BusinessAPIClient({ fetcher });
    await next.loadData();
    next.restoreDraftBaseline(original, 4, { conflict: true });
    next.bindWorkingData(working.data, {}, {});
    const preview = await next.prepareContactMerge();
    const result = await next.applyContactMerge(preview.id);
    expect(result.data.customers[0].contacts.map(row => row.id)).toEqual(['CT1', 'REMOTE', 'LOCAL']);
});

test('same-version recovered offline drafts remain normally saveable', async () => {
    server = data();
    const next = new BusinessAPIClient({ fetcher });
    const current = await next.loadData();
    next.restoreDraftBaseline(next.exportDraftBaseline(), 4);
    current.data.customers[0].contacts.push(contact('OFFLINE', 'Offline person'));
    await next.saveData(current.data, {}, {});
    expect(server.meta.version).toBe(5);
});

test('missing original contacts ID requires manual review', async () => {
    working.data.customers[0].contacts.push({ name: 'No identity' });
    const preview = await api.prepareContactMerge();
    await expect(api.applyContactMerge(preview.id)).rejects.toMatchObject({ code: 'CONTACT_MERGE_UNRESOLVED' });
});

test('legacy refreshed drafts cannot treat the latest server copy as their original base', async () => {
    const next = new BusinessAPIClient({ fetcher });
    await next.loadData();
    next.bindWorkingData(working.data, {}, {});
    fetcher.mockClear();
    await expect(next.prepareContactMerge({ expectedBaseVersion: 4 })).rejects.toMatchObject({
        code: 'CONTACT_BASE_MISSING'
    });
    expect(fetcher).not.toHaveBeenCalled();
});

test('an autosave queued behind the explicit merge cannot replay the old contact array', async () => {
    const preview = await api.prepareContactMerge();
    let release;
    let started;
    const pending = new Promise(resolve => {
        release = resolve;
    });
    const entered = new Promise(resolve => {
        started = resolve;
    });
    const transport = fetcher.getMockImplementation();
    fetcher.mockImplementationOnce(async (...args) => {
        started();
        await pending;
        return transport(...args);
    });
    const merging = api.applyContactMerge(preview.id);
    await entered;
    const staleSave = api.saveData(working.data, {}, {});
    const rejected = expect(staleSave).rejects.toMatchObject({ code: 'STALE_WORKING_DATA' });
    release();
    await merging;
    await rejected;
    expect(server.data.customers[0].contacts.map(row => row.id)).toEqual(['CT1', 'REMOTE', 'LOCAL']);
    expect(fetcher.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
});
