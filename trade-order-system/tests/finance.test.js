import { jest } from '@jest/globals';

const Auth = {
    currentUser: { tenantId: 'EXAMPLE', id: 'U1', role: 'finance', permissions: ['*'], visibleCompanyIds: ['CO1'] },
    hasCapability: jest.fn()
};
const DB = { currentCompanyId: 'CO1' };
const toast = jest.fn();
const App = {
    showModal: jest.fn((title, body, options) => {
        document.querySelector('#modalContainer').innerHTML =
            `<section><h2>${title}</h2>${body}<footer>${options.footer || ''}</footer></section>`;
    }),
    closeModal: jest.fn(() => {
        document.querySelector('#modalContainer').innerHTML = '';
    })
};
jest.unstable_mockModule('../js/auth.js', () => ({ Auth }));
jest.unstable_mockModule('../js/data.js', () => ({ DB }));
jest.unstable_mockModule('../js/app.js', () => ({ App }));
jest.unstable_mockModule('../js/utils.js', () => ({
    escapeHtml: value =>
        String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;'),
    toast
}));
const { Finance, financeMoney } = await import('../js/finance.js');
const { AdminCenter } = await import('../js/administrator.js');

const invoice = () => ({
    name: 'INV-EX-0001',
    resource: 'sales_invoice',
    companyId: 'CO1',
    companyCurrency: 'CNY',
    party: 'CUSTOMER-1',
    postingDate: '2026-10-13',
    dueDate: '2026-11-13',
    currency: 'USD',
    grandTotal: 100,
    baseGrandTotal: 700,
    conversionRate: 7,
    outstandingAmount: 80,
    modified: '2026-10-13 01:00:00',
    docstatus: 0,
    items: [{ name: 'ROW-1', itemCode: 'ITEM-1', qty: 10, uom: 'Nos', rate: 10, amount: 100, salesOrder: 'SO-1' }]
});
const state = () => ({
    version: 12,
    companies: [{ id: 'CO1', name: 'Example Company', settlementCurrency: 'CNY' }],
    capabilities: ['*'],
    options: {
        defaultCurrency: 'USD',
        customers: [{ name: 'CUSTOMER-1', label: 'Example Buyer' }],
        suppliers: [{ name: 'SUPPLIER-1', label: 'Example Factory' }],
        currencies: ['USD', 'CNY'],
        items: [{ name: 'ITEM-1', uom: 'Nos' }],
        accounts: [
            { name: 'BANK-USD', currency: 'USD' },
            { name: 'AR-USD', currency: 'USD' },
            { name: 'BANK-CNY', currency: 'CNY' }
        ],
        costCenters: [{ name: 'MAIN-CO1' }],
        sources: [
            { resource: 'sales_order', name: 'SO-1', label: 'SO-1 · Example Buyer', modified: 'SOURCE-TIME' },
            { resource: 'sales_invoice', name: 'INV-EX-0001', label: 'INV-EX-0001', modified: 'INVOICE-TIME' },
            { resource: 'payment_entry', name: 'PE-1', modified: 'PAYMENT-TIME' }
        ],
        bankAccounts: [{ name: 'BANK-ACCOUNT-1', label: 'Example Bank', currency: 'USD' }]
    },
    documents: [invoice()],
    pagination: { total: 1, hasMore: false }
});
const error = (status, code) => Object.assign(new Error('API failure'), { status, code });
const setForm = values => {
    const form = document.querySelector('[data-finance-form]');
    for (const [key, value] of Object.entries(values)) form.elements.namedItem(key).value = value;
    return form;
};
const submit = async () => {
    const form = document.querySelector('[data-finance-form]');
    await form.onsubmit({ preventDefault: jest.fn(), currentTarget: form });
};
const configureEditor = async () => {
    await Finance.render(document.querySelector('#pageContent'));
    Finance.openEditor(invoice(), 'sales_invoice', 'save');
};

describe('native finance workbench', () => {
    beforeEach(() => {
        document.body.innerHTML = '<main id="pageContent"></main><div id="modalContainer"></div>';
        Finance.clear();
        Finance.tab = 'sales_invoice';
        Auth.currentUser = {
            tenantId: 'EXAMPLE',
            id: 'U1',
            role: 'finance',
            permissions: ['*'],
            visibleCompanyIds: ['CO1']
        };
        Auth.hasCapability.mockImplementation(
            cap => Auth.currentUser.permissions.includes('*') || Auth.currentUser.permissions.includes(cap)
        );
        DB.currentCompanyId = 'CO1';
        window.Workspace = {
            api: {
                financeState: jest.fn(async () => state()),
                financeDocument: jest.fn(async () => ({ document: invoice(), version: 12 })),
                financeReport: jest.fn(async () => ({
                    columns: [
                        { fieldname: 'outstanding', label: 'Outstanding', fieldtype: 'Currency', options: 'currency' }
                    ],
                    result: [{ outstanding: 80, currency: 'USD' }],
                    version: 12
                })),
                financeOperation: jest.fn(async () => ({ version: 13 }))
            }
        };
        jest.clearAllMocks();
    });

    test('denies data requests and hides sensitive content without explicit financial capability', async () => {
        Auth.currentUser.permissions = ['finance.read'];
        await Finance.render(document.querySelector('#pageContent'));
        expect(window.Workspace.api.financeState).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain('没有财务访问权限');
        expect(document.body.textContent).not.toContain('INV-EX-0001');
    });

    test('shows original and base currency amounts as separate values', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        expect(document.body.textContent).toContain('USD 100.00');
        expect(document.body.textContent).toContain('USD 80.00');
        expect(document.body.textContent).toContain('CNY 700.00');
        expect(document.body.textContent).toContain('订单余额与发票余额分别核算');
        expect(financeMoney(undefined, 'USD')).toBe('—');
    });

    test.each(['sales_invoice', 'purchase_invoice'])('new %s preserves native defaults without blank accounting overrides', async resource => {
        await Finance.render(document.querySelector('#pageContent'));
        Finance.openEditor({}, resource, 'create');
        const form = setForm({ party: resource === 'sales_invoice' ? 'CUSTOMER-1' : 'SUPPLIER-1' });
        const row = form.querySelector('[data-finance-row="item"]');
        row.querySelector('[name="itemCode"]').value = 'ITEM-1';
        row.querySelector('[name="uom"]').value = 'Nos';
        row.querySelector('[name="rate"]').value = '10';
        await submit();
        const values = window.Workspace.api.financeOperation.mock.calls[0][0].values;
        expect(values).not.toHaveProperty(resource === 'sales_invoice' ? 'debitTo' : 'creditTo');
        expect(values).not.toHaveProperty('costCenter');
        expect(values.items).toEqual([{ itemCode: 'ITEM-1', qty: 1, uom: 'Nos', rate: 10 }]);
    });

    test('editing a draft explicitly resets optional accounting overrides to native defaults', async () => {
        await configureEditor();
        await submit();
        const values = window.Workspace.api.financeOperation.mock.calls[0][0].values;
        expect(values.debitTo).toBeNull();
        expect(values.costCenter).toBeNull();
        expect(values.items[0]).toEqual({ name: 'ROW-1', itemCode: 'ITEM-1', qty: 10, uom: 'Nos', rate: 10, incomeAccount: null, costCenter: null });
    });

    test('invoice currency and outstanding party-account currency remain distinct', async () => {
        window.Workspace.api.financeState.mockResolvedValueOnce({
            ...state(),
            documents: [
                {
                    ...invoice(),
                    currency: 'CNY',
                    grandTotal: 70,
                    companyCurrency: 'USD',
                    baseGrandTotal: 10,
                    outstandingAmount: 10,
                    outstandingCurrency: 'USD'
                }
            ]
        });
        await Finance.render(document.querySelector('#pageContent'));
        expect(document.body.textContent).toContain('CNY 70.00');
        expect(document.body.textContent).toContain('USD 10.00');
        expect(document.body.textContent).not.toContain('CNY 10.00');
        expect(document.body.textContent).toContain('往来账户币种');
    });

    test('server capability denial masks list data even when stale session grants read', async () => {
        window.Workspace.api.financeState.mockResolvedValue({ ...state(), capabilities: [] });
        await Finance.render(document.querySelector('#pageContent'));
        expect(document.body.textContent).not.toContain('INV-EX-0001');
        expect(Finance.state).toBeNull();
    });

    test('does not offer write, print, or export actions to read-only users', async () => {
        Auth.currentUser.permissions = ['finance.sales_invoice.read'];
        await Finance.render(document.querySelector('#pageContent'));
        await Finance.openDocument('INV-EX-0001');
        expect(document.querySelector('[data-finance-create]')).toBeNull();
        expect(document.querySelector('[data-finance-operation]')).toBeNull();
        expect(document.querySelector('[data-finance-print]')).toBeNull();
        expect(document.querySelector('[data-finance-export-document]')).toBeNull();
        await Finance.exportDocument('INV-EX-0001', 'sales_invoice');
        expect(window.Workspace.api.financeDocument).toHaveBeenCalledTimes(1);
    });

    test('discards an in-flight response after company or role switch', async () => {
        let resolve;
        window.Workspace.api.financeState.mockImplementationOnce(
            () =>
                new Promise(done => {
                    resolve = done;
                })
        );
        const rendering = Finance.render(document.querySelector('#pageContent'));
        DB.currentCompanyId = 'OTHER-CO';
        Finance.clear();
        resolve(state());
        await rendering;
        expect(document.body.textContent).not.toContain('INV-EX-0001');
        expect(Finance.state).toBeNull();
    });

    test('clear never erases the page when navigation has already replaced finance content', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        document.querySelector('#pageContent').innerHTML = '<section>客户工作台</section>';
        Finance.clear();
        expect(document.body.textContent).toContain('客户工作台');
        expect(Finance.target).toBeNull();
    });

    test('preserves native item row identity and disables arbitrary new rows on mapped invoices', async () => {
        await configureEditor();
        expect(document.querySelector('[data-finance-add-item]').disabled).toBe(true);
        setForm({ remarks: 'Keep my draft' });
        await submit();
        expect(window.Workspace.api.financeOperation).toHaveBeenCalledWith(
            expect.objectContaining({
                operation: 'save',
                expectedVersion: 12,
                expectedModified: '2026-10-13 01:00:00',
                values: expect.objectContaining({
                    remarks: 'Keep my draft',
                    items: [expect.objectContaining({ name: 'ROW-1', itemCode: 'ITEM-1', qty: 10, rate: 10 })]
                })
            })
        );
    });

    test('CAS conflict preserves draft but a fresh edit never overwrites another user changed price', async () => {
        await configureEditor();
        setForm({ remarks: 'Unsaved customer remark' });
        document.querySelector('[name="qty"]').value = '12';
        window.Workspace.api.financeOperation.mockRejectedValueOnce(error(409, 'VERSION_CONFLICT'));
        await submit();
        expect(document.querySelector('[name="remarks"]').value).toBe('Unsaved customer remark');
        expect(document.querySelector('[data-finance-save]').disabled).toBe(true);
        expect(document.querySelector('[data-finance-refresh-version]').hidden).toBe(false);
        const first = window.Workspace.api.financeOperation.mock.calls[0][0];
        window.Workspace.api.financeDocument.mockResolvedValueOnce({
            document: { ...invoice(), modified: 'NEW-TIME', items: [{ ...invoice().items[0], rate: 200 }] },
            version: 20
        });
        await document.querySelector('[data-finance-refresh-version]').onclick();
        expect(document.querySelector('[name="remarks"]').value).toBe('Unsaved customer remark');
        expect(document.querySelector('[name="qty"]').value).toBe('12');
        expect(document.querySelector('[name="rate"]').value).toBe('10');
        expect(document.querySelector('[data-finance-save]').disabled).toBe(true);
        await submit();
        expect(window.Workspace.api.financeOperation).toHaveBeenCalledTimes(1);
        await document.querySelector('[data-finance-reopen-latest]').onclick();
        expect(document.querySelector('[name="qty"]').value).toBe('10');
        expect(document.querySelector('[name="rate"]').value).toBe('200');
        expect(document.querySelector('[name="remarks"]').value).toBe('');
        expect(document.body.textContent).toContain('上一份未保存的草稿');
        expect(document.body.textContent).toContain('Unsaved customer remark');
        document.querySelector('[name="qty"]').value = '12';
        await submit();
        const second = window.Workspace.api.financeOperation.mock.calls[1][0];
        expect(second.expectedVersion).toBe(20);
        expect(second.expectedModified).toBe('NEW-TIME');
        expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
        expect(second.values.items[0]).toEqual(expect.objectContaining({ qty: 12, rate: 200 }));
    });

    test('uncertain network outcome retries exactly the same request and idempotency key', async () => {
        await configureEditor();
        setForm({ remarks: 'Keep stable request' });
        window.Workspace.api.financeOperation.mockRejectedValueOnce(error(undefined, 'NETWORK'));
        await submit();
        const first = window.Workspace.api.financeOperation.mock.calls[0][0];
        expect(document.querySelector('[name="remarks"]').disabled).toBe(true);
        expect(document.querySelector('[data-finance-save]').textContent).toContain('同一请求');
        await submit();
        expect(window.Workspace.api.financeOperation.mock.calls[1][0]).toEqual(first);
    });

    test('same-currency Payment Entry does not silently claim different paid and received amounts', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        Finance.openEditor({}, 'payment_entry', 'create');
        setForm({
            paidFrom: 'AR-USD',
            paidTo: 'BANK-USD',
            paidAmount: '100',
            receivedAmount: '97',
            party: 'CUSTOMER-1'
        });
        await submit();
        expect(window.Workspace.api.financeOperation).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain('付款额与到账额须一致');
        expect(document.querySelector('[data-finance-save]').textContent).toBe('保存草稿');
    });

    test('foreign-currency payments retain both native amounts and exchange rates', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        Finance.openEditor({}, 'payment_entry', 'create');
        setForm({
            paidFrom: 'AR-USD',
            paidTo: 'BANK-CNY',
            paidAmount: '100',
            receivedAmount: '700',
            sourceExchangeRate: '7',
            targetExchangeRate: '1',
            party: 'CUSTOMER-1'
        });
        await submit();
        expect(window.Workspace.api.financeOperation).toHaveBeenCalledWith(
            expect.objectContaining({
                values: expect.objectContaining({
                    paidAmount: 100,
                    receivedAmount: 700,
                    sourceExchangeRate: 7,
                    targetExchangeRate: 1
                })
            })
        );
    });

    test('bank details and payment editor require independent bank-account permission', async () => {
        Auth.currentUser.permissions = ['finance.payment_entry.read', 'finance.payment_entry.create'];
        Finance.tab = 'payment_entry';
        window.Workspace.api.financeState.mockResolvedValue({
            ...state(),
            documents: [
                {
                    name: 'PE-1',
                    party: 'CUSTOMER-1',
                    paidAmount: 100,
                    receivedAmount: 700,
                    paidFromCurrency: 'USD',
                    paidToCurrency: 'CNY',
                    paidFrom: 'SECRET-BANK',
                    paidTo: 'OTHER-SECRET-BANK',
                    docstatus: 1
                }
            ]
        });
        await Finance.render(document.querySelector('#pageContent'));
        expect(document.body.textContent).toContain('USD 100.00');
        expect(document.body.textContent).toContain('CNY 700.00');
        expect(document.body.textContent).not.toContain('SECRET-BANK');
        Finance.openEditor({}, 'payment_entry', 'create');
        expect(document.querySelector('[data-finance-form]')).toBeNull();
    });

    test('sales credit note maps to a customer refund with its native signed allocation', async () => {
        await Finance.render(document.getElementById('pageContent'));
        await Finance.openMappedPayment({ ...invoice(), docstatus: 1, isReturn: 1, outstandingAmount: -20, debitTo: 'RECEIVABLE', resource: 'sales_invoice' });
        expect(document.querySelector('[name="paymentType"]').value).toBe('Pay');
        expect(document.querySelector('[name="partyType"]').value).toBe('Customer');
        expect(document.querySelector('[name="allocatedAmount"]').value).toBe('-20');
        expect(document.querySelector('[name="paidAmount"]').value).toBe('20');
    });

    test('supplier return maps to incoming refund with a negative debit-note allocation', async () => {
        await Finance.render(document.getElementById('pageContent'));
        await Finance.openMappedPayment({ ...invoice(), party: 'SUPPLIER-1', docstatus: 1, isReturn: 1, outstandingAmount: -15, creditTo: 'PAYABLE', resource: 'purchase_invoice' });
        expect(document.querySelector('[name="paymentType"]').value).toBe('Receive');
        expect(document.querySelector('[name="partyType"]').value).toBe('Supplier');
        expect(document.querySelector('[name="allocatedAmount"]').value).toBe('-15');
    });

    test('mapped payment reads its own accounts and requires explicit current FX with nested source CAS', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        const invoiceOptions = Finance.state.options;
        await Finance.openMappedPayment({ ...invoice(), docstatus: 1 });
        expect(window.Workspace.api.financeState).toHaveBeenLastCalledWith({
            companyId: 'CO1',
            resource: 'payment_entry'
        });
        expect(Finance.state.options).toBe(invoiceOptions);
        expect(document.querySelector('[name="sourceExchangeRate"]').value).toBe('');
        setForm({
            paidFrom: 'AR-USD',
            paidTo: 'BANK-USD',
            paidAmount: '80',
            receivedAmount: '80',
            sourceExchangeRate: '7',
            targetExchangeRate: '7'
        });
        await submit();
        expect(window.Workspace.api.financeOperation).toHaveBeenCalledWith(
            expect.objectContaining({
                operation: 'payment_from_invoice',
                source: { resource: 'sales_invoice', name: 'INV-EX-0001', expectedModified: '2026-10-13 01:00:00' },
                values: expect.objectContaining({
                    paidAmount: 80,
                    receivedAmount: 80,
                    sourceExchangeRate: 7,
                    targetExchangeRate: 7
                })
            })
        );
    });

    test('customer settlement, bank net receipt, and fee remain separate native values', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        Finance.state.options.accounts.push({ name: 'BANK-FEE', currency: 'CNY', accountType: 'Expense' });
        Finance.openEditor(
            {
                references: [{ referenceDoctype: 'Sales Invoice', referenceName: 'INV-EX-0001', allocatedAmount: 100 }],
                deductions: [{ account: 'BANK-FEE', costCenter: 'MAIN-CO1', amount: 3 }]
            },
            'payment_entry',
            'create'
        );
        setForm({
            paidFrom: 'AR-USD',
            paidTo: 'BANK-USD',
            paidAmount: '97',
            receivedAmount: '97',
            sourceExchangeRate: '7',
            targetExchangeRate: '7',
            party: 'CUSTOMER-1'
        });
        await submit();
        expect(window.Workspace.api.financeOperation).toHaveBeenCalledWith(
            expect.objectContaining({
                values: expect.objectContaining({
                    paidAmount: 97,
                    receivedAmount: 97,
                    references: [expect.objectContaining({ allocatedAmount: 100 })],
                    deductions: [{ account: 'BANK-FEE', costCenter: 'MAIN-CO1', amount: 3 }]
                })
            })
        );
        expect(window.Workspace.api.financeOperation.mock.calls[0][0].values).not.toHaveProperty('profit');
    });

    test('split payment retains the native term on multiple allocations to the same invoice', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        const source = { ...invoice(), docstatus: 1, allocatePaymentBasedOnPaymentTerms: true,
            paymentSchedule: [{ paymentTerm: 'Deposit', dueDate: '2026-10-13', outstandingAmount: 30 },
                { paymentTerm: 'Balance', dueDate: '2026-11-13', outstandingAmount: 50 }] };
        const paymentState = state();
        paymentState.options.sources = [{ ...source }];
        window.Workspace.api.financeState.mockResolvedValueOnce(paymentState);
        await Finance.openMappedPayment(source);
        setForm({ paidFrom: 'AR-USD', paidTo: 'BANK-USD', paidAmount: '80', receivedAmount: '80',
            sourceExchangeRate: '7', targetExchangeRate: '7' });
        expect([...document.querySelectorAll('[name="paymentTerm"]')].map(element => element.value)).toEqual(['Deposit', 'Balance']);
        await submit();
        expect(window.Workspace.api.financeOperation.mock.calls[0][0].values.references).toEqual([
            { referenceDoctype: 'Sales Invoice', referenceName: 'INV-EX-0001', allocatedAmount: 30, paymentTerm: 'Deposit' },
            { referenceDoctype: 'Sales Invoice', referenceName: 'INV-EX-0001', allocatedAmount: 50, paymentTerm: 'Balance' }
        ]);
    });

    test('changing a payment reference clears the previous invoice term', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        Finance.state.options.sources[1].allocatePaymentBasedOnPaymentTerms = true;
        Finance.state.options.sources[1].paymentSchedule = [{ paymentTerm: 'Deposit', dueDate: '2026-10-13' }];
        Finance.openEditor({ references: [{ referenceDoctype: 'Sales Invoice', referenceName: 'INV-EX-0001', paymentTerm: 'Deposit', allocatedAmount: 30 }] }, 'payment_entry', 'create');
        const row = document.querySelector('[data-finance-row="reference"]');
        const reference = row.querySelector('[name="reference"]');
        expect(row.querySelector('[name="paymentTerm"]').required).toBe(true);
        reference.value = 'Sales Order:SO-1';
        reference.dispatchEvent(new Event('change'));
        expect(row.querySelector('[name="paymentTerm"]').value).toBe('');
        expect(row.querySelector('[name="paymentTerm"]').required).toBe(false);
    });

    test('unreconciliation preserves the payment and submits selected invoice modification timestamps once', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        const payment = { name: 'PE-1', docstatus: 1, modified: 'PE-TIME', references: [
            { referenceDoctype: 'Sales Invoice', referenceName: 'INV-EX-0001', referenceModified: 'INV-TIME', paymentTerm: 'Deposit' },
            { referenceDoctype: 'Sales Invoice', referenceName: 'INV-EX-0001', referenceModified: 'INV-TIME', paymentTerm: 'Balance' }
        ] };
        Finance.showDocument(payment, 'payment_entry');
        document.querySelector('[data-finance-unreconcile]').click();
        expect(document.body.textContent).toContain('付款凭证保留已提交状态');
        expect(document.querySelectorAll('[name="invoices"]')).toHaveLength(1);
        document.querySelector('[name="invoices"]').checked = true;
        await submit();
        expect(window.Workspace.api.financeOperation).toHaveBeenCalledWith(expect.objectContaining({
            resource: 'reconciliation', operation: 'unreconcile', name: 'PE-1', expectedModified: 'PE-TIME',
            values: { invoices: [{ resource: 'sales_invoice', name: 'INV-EX-0001', expectedModified: 'INV-TIME' }] }
        }));
    });

    test('reconcile permission alone cannot expose or execute unreconciliation', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        Auth.currentUser.permissions = ['finance.payment_entry.read', 'finance.reconciliation.write'];
        const payment = { name: 'PE-1', docstatus: 1, references: [{ referenceDoctype: 'Sales Invoice', referenceName: 'INV-1', referenceModified: 'T' }] };
        Finance.showDocument(payment, 'payment_entry');
        expect(document.querySelector('[data-finance-unreconcile]')).toBeNull();
        Finance.openUnreconciliation(payment);
        expect(document.querySelector('[data-finance-form]')).toBeNull();
    });

    test('export paginates with the backend page limit and refuses to mix changed versions', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        const download = jest.spyOn(Finance, 'downloadCsv').mockImplementation(() => {});
        window.Workspace.api.financeState
            .mockResolvedValueOnce({ ...state(), version: 12, pagination: { hasMore: true } })
            .mockResolvedValueOnce({ ...state(), version: 13, pagination: { hasMore: false } });
        await Finance.exportCurrent();
        expect(window.Workspace.api.financeState.mock.calls.at(-2)[0]).toEqual(
            expect.objectContaining({ action: 'export', limit: 100, offset: 0 })
        );
        expect(window.Workspace.api.financeState.mock.calls.at(-1)[0]).toEqual(
            expect.objectContaining({ action: 'export', limit: 100, offset: 100 })
        );
        expect(download).not.toHaveBeenCalled();
        expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('账务版本发生变化'), 'error');
        download.mockRestore();
    });

    test('bank transaction drafts remain accessible for native submit and cancel lifecycle', async () => {
        Finance.tab = 'bank_transaction';
        const bank = {
            name: 'BT-DRAFT-1',
            docstatus: 0,
            date: '2026-10-13',
            deposit: 97,
            withdrawal: 0,
            currency: 'USD',
            bankAccount: 'BANK-ACCOUNT-1',
            modified: 'BANK-MODIFIED'
        };
        window.Workspace.api.financeState.mockResolvedValueOnce({ ...state(), documents: [bank] });
        window.Workspace.api.financeDocument.mockResolvedValueOnce({ document: bank, version: 12 });
        await Finance.render(document.querySelector('#pageContent'));
        expect(document.body.textContent).toContain('BT-DRAFT-1');
        expect(document.querySelector('[data-finance-create="from_order"]')).toBeNull();
        await Finance.openDocument('BT-DRAFT-1', 'bank_transaction');
        expect(document.querySelector('[data-finance-operation="submit"]')).not.toBeNull();
        expect(document.body.textContent).toContain('银行实际存入');
        expect(document.body.textContent).toContain('USD 97.00');
    });

    test('native report filter contract excludes companyId and supports report-only permission', async () => {
        Auth.currentUser.permissions = ['finance.receivables.read'];
        Finance.tab = 'receivables';
        Finance.context = JSON.stringify([
            Auth.currentUser.tenantId,
            Auth.currentUser.id,
            Auth.currentUser.role,
            Auth.currentUser.permissions,
            Auth.currentUser.visibleCompanyIds,
            undefined,
            DB.currentCompanyId
        ]);
        Finance.filters = { companyId: 'CO1', fromDate: '2026-10-01', toDate: '2026-10-13', party: 'CUSTOMER-1' };
        await Finance.render(document.querySelector('#pageContent'));
        expect(window.Workspace.api.financeReport).toHaveBeenCalledWith({
            companyId: 'CO1',
            report: 'receivables',
            action: 'read',
            filters: { party: 'CUSTOMER-1', reportDate: '2026-10-13' }
        });
        expect(document.body.textContent).toContain('USD 80.00');
        expect(window.Workspace.api.financeState.mock.calls[0][0]).not.toHaveProperty('party');
    });

    test('reconciliation sends invoice and payment modification timestamps for every allocation', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        Finance.tab = 'reconciliation';
        Finance.filters = { partyType: 'Customer', party: 'CUSTOMER-1', receivablePayableAccount: 'AR-USD' };
        Finance.report = {
            currency: 'USD',
            payments: [
                {
                    referenceType: 'Payment Entry',
                    referenceName: 'PE-1',
                    unallocatedAmount: 100,
                    currency: 'USD',
                    modified: 'PE-TIME'
                }
            ],
            invoices: [
                {
                    invoiceType: 'Sales Invoice',
                    invoiceNumber: 'INV-EX-0001',
                    outstandingAmount: 80,
                    currency: 'USD',
                    modified: 'INV-TIME'
                }
            ]
        };
        Finance.openReconciliation();
        setForm({ payment: '0', 'allocation-0': '50' });
        await submit();
        expect(window.Workspace.api.financeOperation).toHaveBeenCalledWith(
            expect.objectContaining({
                resource: 'reconciliation',
                operation: 'reconcile',
                values: expect.objectContaining({
                    allocations: [
                        expect.objectContaining({
                            referenceName: 'PE-1',
                            invoiceNumber: 'INV-EX-0001',
                            allocatedAmount: 50,
                            paymentModified: 'PE-TIME',
                            invoiceModified: 'INV-TIME'
                        })
                    ]
                })
            })
        );
    });

    test('export and print ask backend to authorize the actual action', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        const csv = jest.spyOn(Finance, 'downloadCsv').mockImplementation(() => {});
        await Finance.exportDocument('INV-EX-0001', 'sales_invoice');
        expect(window.Workspace.api.financeDocument).toHaveBeenLastCalledWith(
            expect.objectContaining({ action: 'export' })
        );
        await Finance.printDocument('INV-EX-0001', 'sales_invoice');
        expect(window.Workspace.api.financeDocument).toHaveBeenLastCalledWith(
            expect.objectContaining({ action: 'print' })
        );
        csv.mockRestore();
    });

    test('exported refunds remain numeric in Excel while text formulas are escaped', () => {
        let contents;
        const blob = jest.spyOn(globalThis, 'Blob').mockImplementation(parts => { contents = parts.join(''); return {}; });
        const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const beforeCreate = URL.createObjectURL;
        const beforeRevoke = URL.revokeObjectURL;
        URL.createObjectURL = jest.fn(() => 'blob:test');
        URL.revokeObjectURL = jest.fn();
        try {
            Finance.downloadCsv([{ amount: -5, reference: '=HYPERLINK("bad")' }], null, 'refund');
            expect(contents).toContain('"-5"');
            expect(contents).not.toContain('"\'-5"');
            expect(contents).toContain('"\'=HYPERLINK(""bad"")"');
        } finally {
            blob.mockRestore(); click.mockRestore();
            if (beforeCreate) URL.createObjectURL = beforeCreate; else delete URL.createObjectURL;
            if (beforeRevoke) URL.revokeObjectURL = beforeRevoke; else delete URL.revokeObjectURL;
        }
    });

    test('bank report printing uses the newly authorized server result rather than cached status', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        Finance.tab = 'bank_reconciliation';
        Finance.filters = { bankAccount: 'BANK-ACCOUNT-1' };
        Finance.report = { transactions: [{ name: 'BT-STALE', date: '2026-10-13', deposit: 100, currency: 'USD' }] };
        window.Workspace.api.financeReport.mockResolvedValueOnce({
            transactions: [
                { name: 'BT-FRESH', date: '2026-10-13', deposit: 97, currency: 'USD', status: 'Reconciled' }
            ],
            version: 15
        });
        await Finance.printReport();
        expect(document.querySelector('.finance-print-preview').textContent).toContain('BT-FRESH');
        expect(document.querySelector('.finance-print-preview').textContent).not.toContain('BT-STALE');
    });

    test('bank-statement matching preserves actual amount and compares each voucher modified time', async () => {
        await Finance.render(document.querySelector('#pageContent'));
        Finance.tab = 'bank_reconciliation';
        Finance.report = {
            transactions: [
                { name: 'BT-1', date: '2026-10-13', deposit: 97, withdrawal: 0, currency: 'USD', modified: 'BANK-TIME' }
            ]
        };
        Finance.openBankMatch('BT-1');
        document.querySelector('[name="vouchers"]').checked = true;
        await submit();
        expect(window.Workspace.api.financeOperation).toHaveBeenCalledWith(
            expect.objectContaining({
                resource: 'bank_reconciliation',
                operation: 'reconcile',
                name: 'BT-1',
                expectedModified: 'BANK-TIME',
                values: { vouchers: [{ name: 'PE-1', expectedModified: 'PAYMENT-TIME' }] }
            })
        );
        expect(window.Workspace.api.financeOperation.mock.calls[0][0].values).not.toHaveProperty('receivedAmount');
    });
});

describe('finance permission administration', () => {
    test('the rendered standard-finance template button opens its real role-selection form', () => {
        document.body.innerHTML = '<main id="pageContent"><button data-admin-action="finance_template">配置标准财务权限</button></main><div id="modalContainer"></div>';
        AdminCenter.target = document.getElementById('pageContent');
        AdminCenter.state = { roles: [{ key: 'admin', label: '管理员', scope: 'tenant' }, { key: 'finance', label: '财务', scope: 'tenant' }], options: { finance: {} } };
        AdminCenter.bindActions();
        document.querySelector('[data-admin-action="finance_template"]').click();
        expect(document.querySelector('[name="roleKeys"][value="admin"]')).not.toBeNull();
        expect(document.querySelector('[name="roleKeys"][value="finance"]')).not.toBeNull();
    });

    test('role matrix and payment limits save real financePolicy fields without implicit financial grants', async () => {
        document.body.innerHTML = '<main id="pageContent"></main><div id="modalContainer"></div>';
        AdminCenter.state = {
            options: {
                permissions: [
                    'read',
                    'finance.sales_invoice.read',
                    'finance.sales_invoice.submit',
                    'finance.bank_accounts.read'
                ],
                pages: ['finance'],
                finance: { bankAccounts: [{ name: 'BANK-ACCOUNT-1', currency: 'USD' }] }
            },
            roles: [{ key: 'finance', label: '财务' }]
        };
        AdminCenter.open_role({
            key: 'finance',
            label: '财务',
            scope: 'tenant',
            permissions: ['read'],
            financePolicy: { scope: 'self', paymentLimit: null, allowedBankAccounts: [] }
        });
        expect(document.querySelector('[aria-label="销售账单 提交"]').checked).toBe(false);
        const save = jest.spyOn(AdminCenter, 'save').mockResolvedValue({});
        const form = document.querySelector('.admin-form');
        form.elements.namedItem('paymentLimitAmount').value = '1000';
        form.elements.namedItem('paymentLimitCurrency').value = 'usd';
        await form.onsubmit({ preventDefault: jest.fn() });
        expect(save).toHaveBeenCalledWith(
            'role',
            expect.objectContaining({
                permissions: ['read'],
                financePolicy: {
                    scope: 'self',
                    paymentLimit: { amount: 1000, currency: 'USD' },
                    allowedBankAccounts: []
                }
            }),
            'organization'
        );
        save.mockRestore();
    });
});
