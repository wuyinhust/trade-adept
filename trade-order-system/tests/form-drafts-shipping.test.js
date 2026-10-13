import { jest } from '@jest/globals';
import { escapeHtml } from '../js/utils.js';

const auth = { currentUser: { id: 'U1', tenantId: 'tenant' }, canEdit: jest.fn(() => true) };
const db = {
    _cloudReady: true,
    _BACKUP_KEY: 'shipment-drafts-test',
    currentCompanyId: 'C1',
    companies: [{ id: 'C1' }],
    orders: [],
    shipments: [],
    getOrders: () => db.orders,
    getOrder: id => db.orders.find(order => order.id === id),
    getShipment: id => db.shipments.find(shipment => shipment.id === id),
    getShipmentByOrder: id => db.shipments.find(shipment => shipment.orderId === id),
    getCurrentCompany: () => ({ id: 'C1' }),
    addShipment: jest.fn(value => {
        const shipment = { ...value, id: 'SHIPMENT-PENDING' };
        db.shipments.push(shipment);
        return shipment;
    }),
    updateShipment: jest.fn((id, value) => Object.assign(db.getShipment(id), value)),
    updateOrder: jest.fn((id, value) => Object.assign(db.getOrder(id), value)),
    flush: jest.fn()
};
const app = {
    escapeHtml,
    toast: jest.fn(),
    showModal: jest.fn((title, body, options) => {
        document.getElementById('modalContainer').innerHTML = body + options.footer;
    }),
    closeModal: jest.fn(() => {
        document.getElementById('modalContainer').innerHTML = '';
    })
};
jest.unstable_mockModule('../js/app.js', () => ({ App: app }));
jest.unstable_mockModule('../js/auth.js', () => ({ Auth: auth }));
jest.unstable_mockModule('../js/data.js', () => ({ DB: db }));
jest.unstable_mockModule('../js/order-import.js', () => ({ requiresOverseasPort: () => false }));
jest.unstable_mockModule('../js/exchange.js', () => ({ Exchange: {} }));
const { Shipping } = await import('../js/shipping.js');
const change = (form, name, value) => {
    const input = form.elements.namedItem(name);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
};
beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    sessionStorage.clear();
    document.body.innerHTML = '<div id="modalContainer"></div><div id="pageContent"></div>';
    db.orders = [
        {
            id: 'O1',
            companyId: 'C1',
            companyOperationNo: 'TEST-1',
            customerName: 'Fictional Customer',
            loadingPort: 'Port A',
            expectedShipDate: '2026-10-14',
            productName: 'Widgets'
        }
    ];
    db.shipments = [];
    db.flush.mockReset().mockResolvedValue(true);
    auth.canEdit.mockReturnValue(true);
});

test('unsubmitted shipping fields survive a DOM rebuild without creating a business record', () => {
    Shipping.showAddForm('O1');
    const form = document.getElementById('shipmentForm');
    change(form, 'invoiceNo', 'INV-DRAFT');
    change(form, 'cargoDesc', 'Unsaved cargo');
    change(form, 'grossWeight', '12.5');
    document.getElementById('modalContainer').innerHTML = '';
    Shipping.showAddForm('O1');
    const restored = document.getElementById('shipmentForm');
    expect(restored.elements.invoiceNo.value).toBe('INV-DRAFT');
    expect(restored.elements.cargoDesc.value).toBe('Unsaved cargo');
    expect(restored.elements.grossWeight.value).toBe('12.5');
    expect(db.addShipment).not.toHaveBeenCalled();
    expect(db.flush).not.toHaveBeenCalled();
});

test('a failed staged shipment can be reopened and retried with the original pending identity', async () => {
    Shipping.showAddForm('O1');
    let form = document.getElementById('shipmentForm');
    change(form, 'invoiceNo', 'INV-DRAFT');
    db.flush.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await Shipping.saveShipment({ preventDefault() {}, target: form });
    expect(form.dataset.pendingRecordId).toBe('SHIPMENT-PENDING');
    expect(sessionStorage.length).toBe(1);
    expect(app.closeModal).not.toHaveBeenCalled();
    change(form, 'invoiceNo', 'INV-LATER-FAILED');
    document.getElementById('modalContainer').innerHTML = '';
    Shipping.showAddForm('O1');
    form = document.getElementById('shipmentForm');
    expect(form).not.toBeNull();
    expect(form.dataset.pendingRecordId).toBe('SHIPMENT-PENDING');
    expect(form.elements.invoiceNo.value).toBe('INV-LATER-FAILED');
    expect(form.querySelector('[data-form-draft-notice]')).toBeNull();
    await Shipping.saveShipment({ preventDefault() {}, target: form });
    expect(db.addShipment).toHaveBeenCalledTimes(1);
    expect(db.updateShipment).toHaveBeenCalledTimes(1);
    expect(db.shipments).toHaveLength(1);
    expect(sessionStorage.length).toBe(0);
    expect(app.closeModal).toHaveBeenCalledTimes(1);
});

test('a fresh server status while the form remains open prevents a stale status patch', async () => {
    db.shipments = [
        {
            id: 'S1',
            orderId: 'O1',
            companyId: 'C1',
            loadingPort: 'Port A',
            status: '待出运',
            customsStatus: '未报关',
            etd: '2026-10-14'
        }
    ];
    Shipping.updateStatus('S1');
    const form = document.getElementById('statusForm');
    change(form, 'customsStatus', '清关中');
    db.shipments[0].status = '已出运';
    db.shipments[0].actualShipDate = '2026-10-15';
    await Shipping.saveStatus({ preventDefault() {}, target: form }, 'S1');
    expect(db.updateShipment).not.toHaveBeenCalled();
    expect(db.flush).not.toHaveBeenCalled();
    expect(form.querySelector('[data-form-draft-notice]')).not.toBeNull();
    expect(sessionStorage.length).toBe(1);
});

test('shipment ACK leaves input typed in flight for a second update without duplicate creation', async () => {
    Shipping.showAddForm('O1');
    const form = document.getElementById('shipmentForm');
    change(form, 'invoiceNo', 'INV-SUBMITTED');
    let resolveFlush;
    db.flush.mockImplementationOnce(
        () =>
            new Promise(resolve => {
                resolveFlush = resolve;
            })
    );
    const saving = Shipping.saveShipment({ preventDefault() {}, target: form });
    change(form, 'invoiceNo', 'INV-TYPED-LATER');
    resolveFlush(true);
    await saving;
    expect(db.shipments[0].invoiceNo).toBe('INV-SUBMITTED');
    expect(form.elements.invoiceNo.value).toBe('INV-TYPED-LATER');
    expect(app.closeModal).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(1);
    document.getElementById('modalContainer').innerHTML = '';
    Shipping.showAddForm('O1');
    const reopened = document.getElementById('shipmentForm');
    expect(reopened.elements.invoiceNo.value).toBe('INV-TYPED-LATER');
    expect(reopened.querySelector('[data-form-draft-notice]')).toBeNull();
    await Shipping.saveShipment({ preventDefault() {}, target: reopened });
    expect(db.addShipment).toHaveBeenCalledTimes(1);
    expect(db.updateShipment).toHaveBeenCalledTimes(1);
    expect(db.shipments[0].invoiceNo).toBe('INV-TYPED-LATER');
    expect(sessionStorage.length).toBe(0);
});

test('status ACK adopts the saved server baseline and keeps later status input for retry', async () => {
    db.shipments = [
        { id: 'S1', orderId: 'O1', companyId: 'C1', loadingPort: 'Port A', status: '待出运', customsStatus: '未报关' }
    ];
    Shipping.updateStatus('S1');
    const form = document.getElementById('statusForm');
    change(form, 'customsStatus', '已报关');
    let resolveFlush;
    db.flush.mockImplementationOnce(
        () =>
            new Promise(resolve => {
                resolveFlush = resolve;
            })
    );
    const saving = Shipping.saveStatus({ preventDefault() {}, target: form }, 'S1');
    change(form, 'customsStatus', '清关中');
    await Shipping.saveStatus({ preventDefault() {}, target: form }, 'S1');
    expect(db.flush).toHaveBeenCalledTimes(1);
    resolveFlush(true);
    await saving;
    expect(db.shipments[0].customsStatus).toBe('已报关');
    expect(form.elements.customsStatus.value).toBe('清关中');
    expect(app.closeModal).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(1);
    Shipping.renderDetail = jest.fn();
    await Shipping.saveStatus({ preventDefault() {}, target: form }, 'S1');
    expect(db.updateShipment).toHaveBeenCalledTimes(2);
    expect(db.shipments[0].customsStatus).toBe('清关中');
    expect(sessionStorage.length).toBe(0);
    expect(app.closeModal).toHaveBeenCalledTimes(1);
});
