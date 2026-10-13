import { jest } from '@jest/globals';

const Auth = {
    currentUser: { id: 'U1', tenantId: 'GW', role: 'admin', permissions: ['*'], visibleCompanyIds: ['CO1'] },
    hasCapability: jest.fn(() => true)
};
const DB = { currentCompanyId: 'CO1' };
const App = {
    showModal: jest.fn((title, body, options) => {
        document.getElementById('modalContainer').innerHTML =
            `<div class="modal"><h2>${title}</h2>${body}<footer>${options.footer || ''}</footer></div>`;
    }),
    closeModal: jest.fn(() => {
        document.getElementById('modalContainer').innerHTML = '';
    })
};
jest.unstable_mockModule('../js/auth.js', () => ({ Auth }));
jest.unstable_mockModule('../js/data.js', () => ({ DB }));
jest.unstable_mockModule('../js/utils.js', () => ({
    escapeHtml: value =>
        String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;')
}));
const { ItemCatalog } = await import('../js/item-catalog.js');
const item = (overrides = {}) => ({
    name: 'SKU-1',
    itemCode: 'SKU-1',
    itemName: '旅行杯',
    itemGroup: 'Products',
    stockUom: 'Nos',
    description: '不锈钢旅行杯',
    disabled: false,
    isStockItem: false,
    isSalesItem: true,
    isPurchaseItem: true,
    modified: '2026-10-13 08:00:00',
    canWrite: true,
    canDisable: true,
    ...overrides
});
const state = (overrides = {}) => ({
    version: 12,
    companyId: 'CO1',
    companies: [{ id: 'CO1', name: 'Grandware' }],
    capabilities: { read: true, create: true, write: true, disable: true },
    options: { itemGroups: [{ name: 'Products' }], uoms: [{ name: 'Nos' }] },
    items: [item()],
    ...overrides
});
const error = (status, code, message = 'Native API error') => Object.assign(new Error(message), { status, code });
const getForm = () => document.querySelector('[data-catalog-form]');
const fill = values => {
    const form = getForm();
    for (const [name, value] of Object.entries(values)) {
        const control = form.elements.namedItem(name);
        if (control.type === 'checkbox') control.checked = value;
        else control.value = value;
    }
};
const submit = () => getForm().onsubmit({ preventDefault: jest.fn() });
const deferred = () => {
    let resolve;
    const promise = new Promise(done => {
        resolve = done;
    });
    return { promise, resolve };
};
let client;

describe('native Item catalog workbench', () => {
    beforeEach(() => {
        ItemCatalog.clear(false);
        document.body.innerHTML = '<div id="modalContainer"></div>';
        window.App = App;
        Auth.currentUser = { id: 'U1', tenantId: 'GW', role: 'admin', permissions: ['*'], visibleCompanyIds: ['CO1'] };
        Auth.hasCapability.mockImplementation(() => true);
        DB.currentCompanyId = 'CO1';
        client = {
            catalogState: jest.fn().mockResolvedValue(state()),
            catalogOperation: jest.fn().mockResolvedValue({ meta: { version: 13 }, document: item() })
        };
        window.Workspace = { api: client };
        App.showModal.mockClear();
        App.closeModal.mockClear();
    });
    afterEach(() => ItemCatalog.clear());

    test('empty native catalog can create its first non-stock trade item and reads authoritative data', async () => {
        client.catalogState.mockResolvedValueOnce(state({ items: [] })).mockResolvedValue(state({ version: 13 }));
        const changed = jest.fn();
        await ItemCatalog.open(undefined, changed);
        expect(document.body.textContent).toContain('暂无商品');
        document.querySelector('[data-catalog-create]').click();
        fill({ itemCode: ' SKU-1 ', itemName: '旅行杯', description: '杯子' });
        await submit();
        const command = client.catalogOperation.mock.calls[0][0];
        expect(command).toEqual({
            companyId: 'CO1',
            operation: 'create',
            expectedVersion: 12,
            idempotencyKey: expect.any(String),
            values: {
                itemCode: 'SKU-1',
                itemName: '旅行杯',
                itemGroup: 'Products',
                stockUom: 'Nos',
                description: '杯子',
                isSalesItem: true,
                isPurchaseItem: true
            }
        });
        expect(command.values).not.toHaveProperty('isStockItem');
        expect(command.values).not.toHaveProperty('company');
        expect(document.body.textContent).toContain('商品已保存');
        expect(document.body.textContent).toContain('旅行杯');
        expect(ItemCatalog.state.version).toBe(13);
        expect(changed).toHaveBeenCalledWith({ companyId: 'CO1', document: item(), version: 13 });
    });

    test('local read denial makes no API request', async () => {
        Auth.hasCapability.mockReturnValue(false);
        await ItemCatalog.open();
        expect(client.catalogState).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain('没有商品目录访问权限');
    });

    test('server read-only grants hide every write control', async () => {
        client.catalogState.mockResolvedValue(state({ capabilities: { read: true } }));
        await ItemCatalog.open();
        expect(document.querySelector('[data-catalog-create]')).toBeNull();
        expect(document.querySelector('[data-catalog-edit]')).toBeNull();
        expect(document.querySelector('[data-catalog-disable]')).toBeNull();
        ItemCatalog.editor(item());
        expect(getForm()).toBeNull();
    });

    test('write and disable are independent and native per-Item grants constrain shared records', async () => {
        client.catalogState.mockResolvedValue(
            state({
                capabilities: { read: true, write: true, disable: true },
                items: [
                    item({ shared: true, canWrite: false }),
                    item({ name: 'SKU-2', disabled: true, canDisable: false })
                ]
            })
        );
        await ItemCatalog.open();
        expect(document.querySelector('[data-catalog-edit="0"]')).toBeNull();
        expect(document.querySelector('[data-catalog-disable="0"]')).not.toBeNull();
        expect(document.querySelector('[data-catalog-edit="1"]')).not.toBeNull();
        expect(document.querySelector('[data-catalog-disable="1"]')).toBeNull();
        expect(document.body.textContent).toContain('共享商品');
    });

    test('disable-only actor can disable without Item write and preserves native identity', async () => {
        client.catalogState.mockResolvedValue(state({ capabilities: { read: true, disable: true } }));
        await ItemCatalog.open();
        document.querySelector('[data-catalog-disable]').click();
        await submit();
        expect(client.catalogOperation).toHaveBeenCalledWith(
            expect.objectContaining({
                operation: 'disable',
                name: 'SKU-1',
                expectedModified: item().modified,
                values: { disabled: true }
            })
        );
    });

    test('existing item flags and historic UOM remain explicit; code cannot be changed', async () => {
        await ItemCatalog.open();
        ItemCatalog.editor(item({ stockUom: 'Legacy Unit', isSalesItem: 0 }));
        expect(getForm().elements.namedItem('stockUom').value).toBe('Legacy Unit');
        expect(getForm().elements.namedItem('itemCode').readOnly).toBe(true);
        expect(getForm().elements.namedItem('isSalesItem').checked).toBe(false);
        fill({ itemName: '新名称', itemCode: 'FAKE-CODE' });
        await submit();
        const command = client.catalogOperation.mock.calls[0][0];
        expect(command.name).toBe('SKU-1');
        expect(command.values).not.toHaveProperty('itemCode');
        expect(command.values.isSalesItem).toBe(false);
    });

    test('validation failure retains entered values with readable escaped native error', async () => {
        client.catalogOperation.mockRejectedValue(error(400, 'VALIDATION', '<script>native error</script>'));
        await ItemCatalog.open();
        ItemCatalog.editor(item());
        fill({ itemName: '仍然保留' });
        await submit();
        expect(getForm().elements.namedItem('itemName').value).toBe('仍然保留');
        expect(document.querySelector('[data-catalog-save]').disabled).toBe(false);
        expect(document.querySelector('script')).toBeNull();
        expect(document.querySelector('[data-catalog-message]').textContent).toContain('<script>native error</script>');
    });

    test('409 retains the draft and cannot replay it against a refreshed version', async () => {
        client.catalogOperation.mockRejectedValueOnce(error(409, 'STALE_DOCUMENT'));
        const latest = item({ itemName: '同事修改的名称', modified: 'LATEST-TIME' });
        await ItemCatalog.open();
        ItemCatalog.editor(item());
        fill({ itemName: '我的草稿' });
        await submit();
        expect(getForm().elements.namedItem('itemName').value).toBe('我的草稿');
        expect(document.querySelector('[data-catalog-save]').disabled).toBe(true);
        await submit();
        expect(client.catalogOperation).toHaveBeenCalledTimes(1);
        client.catalogState.mockResolvedValue(state({ version: 18, document: latest, items: [latest] }));
        await document.querySelector('[data-catalog-latest]').onclick();
        expect(getForm().elements.namedItem('itemName').value).toBe('我的草稿');
        expect(document.querySelector('[data-catalog-message]').textContent).toContain('同事修改的名称');
        expect(document.querySelector('[data-catalog-save]').disabled).toBe(true);
        document.querySelector('[data-catalog-reopen]').click();
        expect(getForm().elements.namedItem('itemName').value).toBe('同事修改的名称');
        await submit();
        expect(client.catalogOperation.mock.calls[1][0]).toEqual(
            expect.objectContaining({
                expectedVersion: 18,
                expectedModified: 'LATEST-TIME',
                values: expect.objectContaining({ itemName: '同事修改的名称' })
            })
        );
    });

    test('lost response uses identical stable command even if the disabled input is changed programmatically', async () => {
        client.catalogOperation.mockRejectedValueOnce(error(0, 'NETWORK'));
        await ItemCatalog.open();
        ItemCatalog.editor();
        fill({ itemCode: 'NEW-SKU', itemName: '原商品' });
        await submit();
        const first = client.catalogOperation.mock.calls[0][0];
        expect(getForm().elements.namedItem('itemName').disabled).toBe(true);
        fill({ itemName: '不能进入重试的新名称' });
        await submit();
        expect(client.catalogOperation.mock.calls[1][0]).toEqual(first);
        expect(client.catalogOperation.mock.calls[1][0].values.itemName).toBe('原商品');
    });

    test('double submit issues one native command', async () => {
        const response = deferred();
        client.catalogOperation.mockReturnValue(response.promise);
        await ItemCatalog.open();
        ItemCatalog.editor(item());
        const saving = submit();
        await submit();
        expect(client.catalogOperation).toHaveBeenCalledTimes(1);
        response.resolve({ document: item(), meta: { version: 13 } });
        await saving;
    });

    test('company switch drops delayed reads and closes the old company modal', async () => {
        const response = deferred();
        client.catalogState.mockReturnValue(response.promise);
        const loading = ItemCatalog.open();
        DB.currentCompanyId = 'CO2';
        response.resolve(state());
        await loading;
        expect(ItemCatalog.state).toBeNull();
        expect(document.querySelector('[data-item-catalog-root]')).toBeNull();
    });

    test('permission/session change during save discards stale success', async () => {
        const response = deferred();
        client.catalogOperation.mockReturnValue(response.promise);
        const changed = jest.fn();
        await ItemCatalog.open('CO1', changed);
        ItemCatalog.editor(item());
        const saving = submit();
        Auth.currentUser.permissions = ['catalog.read'];
        response.resolve({ document: item(), meta: { version: 13 } });
        await saving;
        expect(changed).not.toHaveBeenCalled();
        expect(ItemCatalog.state).toBeNull();
        expect(document.querySelector('[data-item-catalog-root]')).toBeNull();
    });

    test('closing or replacing the modal prevents late results from reopening it', async () => {
        const response = deferred();
        client.catalogOperation.mockReturnValue(response.promise);
        await ItemCatalog.open();
        ItemCatalog.editor(item());
        const saving = submit();
        App.showModal('其他窗口', '<p>其他内容</p>', {});
        response.resolve({ document: item(), meta: { version: 13 } });
        await saving;
        expect(document.body.textContent).toContain('其他内容');
        expect(document.querySelector('[data-item-catalog-root]')).toBeNull();
        expect(client.catalogState).toHaveBeenCalledTimes(1);
    });

    test('acknowledged native save with failed readback never offers an old save retry', async () => {
        await ItemCatalog.open();
        client.catalogState.mockRejectedValue(error(503, 'NETWORK', '目录暂时无法读取'));
        ItemCatalog.editor(item());
        await submit();
        expect(document.querySelector('[data-catalog-message]').textContent).toContain(
            '商品已保存，但最新目录未能读取'
        );
        expect(document.querySelector('[data-catalog-save]').disabled).toBe(true);
        await submit();
        expect(client.catalogOperation).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[data-catalog-latest]').textContent).toBe('重新读取目录');
        client.catalogState.mockResolvedValue(state({ version: 13 }));
        await document.querySelector('[data-catalog-latest]').onclick();
        expect(getForm()).toBeNull();
        expect(ItemCatalog.state.version).toBe(13);
    });

    test('403 retains input but disables the stale write control', async () => {
        await ItemCatalog.open();
        ItemCatalog.editor(item());
        fill({ itemName: '我的草稿' });
        client.catalogOperation.mockRejectedValue(error(403, 'FORBIDDEN', '商品修改权限已撤销'));
        await submit();
        expect(getForm().elements.namedItem('itemName').value).toBe('我的草稿');
        expect(document.querySelector('[data-catalog-save]').disabled).toBe(true);
        await submit();
        expect(client.catalogOperation).toHaveBeenCalledTimes(1);
    });

    test('search queries native items beyond the first page and paging keeps that query', async () => {
        await ItemCatalog.open();
        client.catalogState.mockResolvedValue(
            state({
                items: [item({ name: 'NATIVE-MATCH', itemCode: 'NATIVE-MATCH' })],
                pagination: { hasMore: true }
            })
        );
        document.querySelector('[data-catalog-search]').value = ' NATIVE-MATCH ';
        await document.querySelector('[data-catalog-query]').onsubmit({ preventDefault: jest.fn() });
        expect(client.catalogState).toHaveBeenLastCalledWith(
            expect.objectContaining({ search: 'NATIVE-MATCH', offset: 0 })
        );
        expect(document.querySelector('[data-catalog-search]').value).toBe('NATIVE-MATCH');
        const paging = ItemCatalog.load({ offset: 100 });
        await paging;
        expect(client.catalogState).toHaveBeenLastCalledWith(
            expect.objectContaining({ search: 'NATIVE-MATCH', offset: 100 })
        );
        expect(document.body.textContent).toContain('第 2 页');
    });
});
