import { jest } from '@jest/globals';
import { Cloud } from '../js/cloud.js';

beforeEach(() => {
    Cloud.configure(null);
    localStorage.clear();
});

test('unconfigured transport fails closed without fetching or using cached business data', async () => {
    localStorage.setItem('grandware_cloud_config', JSON.stringify({ envId: 'obsolete-cloud' }));
    localStorage.setItem('gw_data', JSON.stringify({ orders: [{ id: 'cached' }] }));
    const fetcher = jest.fn();
    global.fetch = fetcher;
    expect(Cloud.isReady()).toBe(false);
    expect(await Cloud.init()).toEqual({ ok: false, uid: undefined, loginType: 'server-session' });
    expect(() => Cloud.loadData()).toThrow('业务服务尚未连接');
    expect(() => Cloud.saveData({ orders: [] })).toThrow('业务服务尚未连接');
    expect(fetcher).not.toHaveBeenCalled();
});

test('same-origin API owns the read/write baseline and queue', async () => {
    const data = { orders: [{ id: 'O1' }] };
    const rates = { C1: 7 };
    const metadata = { C1: { source: 'manual' } };
    const api = {
        isReady: () => true,
        loadData: jest.fn().mockResolvedValue({ data }),
        saveData: jest.fn().mockResolvedValue(true),
        checkRemoteVersion: jest.fn().mockResolvedValue({ version: 8 }),
        getLastMeta: () => ({ version: 7 }),
        drainQueue: jest.fn().mockResolvedValue(undefined)
    };
    Cloud.configure(api, () => ({ id: 'user-1' }));
    expect((await Cloud.init()).uid).toBe('user-1');
    await expect(Cloud.loadData({ discardLocal: true })).resolves.toEqual({ data });
    expect(api.loadData).toHaveBeenCalledWith({ discardLocal: true });
    await expect(Cloud.saveData(data, rates, metadata)).resolves.toBe(true);
    expect(api.saveData).toHaveBeenCalledWith(data, rates, metadata);
    expect((await Cloud.checkRemoteVersion()).version).toBe(8);
    expect(Cloud.getLastMeta()).toEqual({ version: 7 });
    await Cloud._drainQueue();
    expect(api.drainQueue).toHaveBeenCalledTimes(1);
});

test.each(['CONFLICT', 'AUTH_REQUIRED', 'NETWORK'])('API %s is propagated without anonymous fallback', async code => {
    const error = Object.assign(new Error(code), { code });
    const api = { isReady: () => false, saveData: jest.fn().mockRejectedValue(error) };
    Cloud.configure(api);
    await expect(Cloud.saveData({ orders: [] })).rejects.toBe(error);
    expect(api.saveData).toHaveBeenCalledTimes(1);
    expect(Cloud.isReady()).toBe(false);
});

test('logging out at the API prevents transport from reporting authenticated readiness', () => {
    let ready = true;
    Cloud.configure({ isReady: () => ready });
    expect(Cloud.getStatus().authDone).toBe(true);
    ready = false;
    Cloud.resetSession();
    expect(Cloud.getStatus().authDone).toBe(false);
    expect(Cloud.getStatus().dbReady).toBe(false);
});
