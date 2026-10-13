import { Auth } from './auth.js';
import { DB } from './data.js';
import { App } from './app.js';
import { escapeHtml, toast } from './utils.js';
import { ItemCatalog } from './item-catalog.js';

const h = value => escapeHtml(String(value ?? ''));
const api = () => window.Workspace?.api;
const clone = value => JSON.parse(JSON.stringify(value));
const today = () => new Date().toLocaleDateString('en-CA');
const tabs = [
    ['sales_invoice', '销售账单', 'finance.sales_invoice.read'],
    ['purchase_invoice', '采购账单', 'finance.purchase_invoice.read'],
    ['payment_entry', '收付款', 'finance.payment_entry.read'],
    ['receivables', '应收账龄', 'finance.receivables.read'],
    ['payables', '应付账龄', 'finance.payables.read'],
    ['reconciliation', '预付款核销', 'finance.reconciliation.read'],
    ['general_ledger', '总账', 'finance.ledger.read'],
    ['bank_transaction', '银行流水', 'finance.bank_transaction.read'],
    ['bank_reconciliation', '银行对账', 'finance.bank_reconciliation.read']
];
const invoiceResources = ['sales_invoice', 'purchase_invoice'];
const documentResources = [...invoiceResources, 'payment_entry', 'bank_transaction'];
const resourceLabel = resource =>
    tabs.find(([key]) => key === resource)?.[1] || (resource === 'bank_transaction' ? '银行流水' : resource);
const capPrefix = resource => `finance.${resource === 'general_ledger' ? 'ledger' : resource}`;
const statusLabel = doc => ({ 0: '草稿', 1: '已提交', 2: '已取消' })[doc.docstatus] || doc.status || '—';
const number = value =>
    new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0);
export const financeMoney = (value, currency) => (value == null ? '—' : `${currency || '—'} ${number(value)}`);
const optionKey = item => item.id ?? item.name ?? item.itemCode ?? item.value;
const options = (items, current = '', empty = '请选择') =>
    `<option value="">${h(empty)}</option>${(items || [])
        .map(item => (typeof item === 'string' ? { name: item, label: item } : item))
        .map(
            item =>
                `<option value="${h(optionKey(item))}" ${String(optionKey(item)) === String(current) ? 'selected' : ''}>${h(item.label || item.customerName || item.supplierName || item.itemName || item.name || item.id)}</option>`
        )
        .join('')}`;
const input = (name, label, value = '', { type = 'text', required = false, readonly = false, step, min } = {}) =>
    `<label class="form-group"><span class="form-label">${h(label)}</span><input class="form-input" name="${h(name)}" type="${h(type)}" value="${h(value)}" ${required ? 'required' : ''} ${readonly ? 'readonly' : ''} ${step != null ? `step="${h(step)}"` : ''} ${min != null ? `min="${h(min)}"` : ''}></label>`;
const select = (name, label, items, current, required = false, empty) =>
    `<label class="form-group"><span class="form-label">${h(label)}</span><select class="form-select" name="${h(name)}" ${required ? 'required' : ''}>${options(items, current, empty)}</select></label>`;
const field = (form, name) => form.elements.namedItem(name)?.value?.trim() || '';
const numeric = (form, name) => Number(field(form, name));
const requestKey = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
};
const sessionFingerprint = () =>
    JSON.stringify([
        Auth.currentUser?.tenantId,
        Auth.currentUser?.id,
        Auth.currentUser?.role,
        Auth.currentUser?.permissions,
        Auth.currentUser?.visibleCompanyIds,
        Auth.currentUser?.financePolicy,
        DB.currentCompanyId
    ]);
const capabilityIn = (caps, key) =>
    Array.isArray(caps)
        ? caps.includes(key) || caps.includes('*')
        : caps && typeof caps === 'object'
          ? caps[key] === true || caps['*'] === true
          : null;
const nativeDate = value => h(String(value || '').slice(0, 10) || '—');
const fromCurrency = doc => doc.paidFromCurrency || doc.paidFromAccountCurrency || doc.paidCurrency || doc.currency;
const toCurrency = doc => doc.paidToCurrency || doc.paidToAccountCurrency || doc.receivedCurrency || doc.currency;

export const Finance = {
    target: null,
    state: null,
    report: null,
    tab: 'sales_invoice',
    filters: {},
    offset: 0,
    epoch: 0,
    context: null,
    pending: null,
    conflictDraft: null,

    clear() {
        this.epoch += 1;
        this.state = null;
        this.report = null;
        this.filters = {};
        this.offset = 0;
        this.pending = null;
        this.conflictDraft = null;
        this.context = null;
        if (this.target?.querySelector('[data-finance-root]')) this.target.innerHTML = '';
        this.target = null;
        if (document.querySelector('[data-finance-modal]')) App.closeModal();
    },

    can(capability) {
        if (Auth.hasCapability(capability) !== true) return false;
        const grant = capabilityIn(this.state?.capabilities, capability);
        return grant !== false;
    },

    availableTabs() {
        return tabs.filter(([, , capability]) => Auth.hasCapability(capability) === true);
    },

    async render(target = document.getElementById('pageContent')) {
        const context = sessionFingerprint();
        if (this.context !== context) this.clear();
        this.context = context;
        this.target = target;
        const visible = this.availableTabs();
        if (!visible.length) {
            this.state = null;
            target.innerHTML =
                '<section class="card finance-empty" data-finance-root><h3>没有财务访问权限</h3><p>请由企业管理员配置账单、收付款、报表及公司范围。</p></section>';
            return;
        }
        if (!visible.some(([key]) => key === this.tab)) this.tab = visible[0][0];
        await this.load();
    },

    async load() {
        const epoch = ++this.epoch;
        const context = this.context;
        this.state = null;
        this.report = null;
        this.target.innerHTML =
            '<div class="card finance-empty" data-finance-root role="status">正在读取财务数据…</div>';
        try {
            const listFilters = documentResources.includes(this.tab) ? this.filters : {};
            const state = await api().financeState({
                companyId: this.filters.companyId || DB.currentCompanyId,
                resource: this.tab,
                ...listFilters,
                limit: 40,
                offset: this.offset
            });
            if (epoch !== this.epoch || context !== sessionFingerprint()) return;
            this.state = state;
            if (!this.can(`${capPrefix(this.tab)}.read`)) throw new Error('财务权限已变更，请重新登录。');
            if (!documentResources.includes(this.tab)) {
                const ready =
                    this.tab === 'reconciliation'
                        ? this.filters.party && this.filters.receivablePayableAccount
                        : this.tab === 'bank_reconciliation'
                          ? this.filters.bankAccount
                          : true;
                const result = ready
                    ? await api().financeReport({
                          companyId: this.companyId(),
                          report: this.tab,
                          filters: this.reportFilters(),
                          action: 'read'
                      })
                    : { version: state.version, payments: [], invoices: [], transactions: [] };
                if (epoch !== this.epoch || context !== sessionFingerprint()) return;
                this.report = result;
                this.state.version = result.version;
            }
            this.draw();
        } catch (error) {
            if (epoch !== this.epoch || context !== sessionFingerprint()) return;
            this.state = null;
            this.report = null;
            this.target.innerHTML = `<section class="card finance-empty" data-finance-root><h3>财务数据未能加载</h3><p>${h(error.message || '请检查权限与财务配置。')}</p><button class="btn btn-secondary" data-finance-reload>重新读取</button></section>`;
            this.target.querySelector('[data-finance-reload]').onclick = () => this.load();
        }
    },

    companyId() {
        return this.filters.companyId || DB.currentCompanyId || this.state?.companies?.[0]?.id;
    },
    reportFilters() {
        const { companyId: _companyId, search: _search, status: _status, ...filters } = this.filters;
        const cutOff = this.filters.toDate || today();
        const dates = ['receivables', 'payables'].includes(this.tab)
            ? { reportDate: cutOff }
            : { fromDate: this.filters.fromDate || `${cutOff.slice(0, 7)}-01`, toDate: cutOff };
        delete filters.fromDate;
        delete filters.toDate;
        if (filters.allTransactions != null) filters.allTransactions = Number(filters.allTransactions);
        return Object.fromEntries(
            Object.entries({ ...filters, ...dates }).filter(([, value]) => value !== '' && value != null)
        );
    },

    draw() {
        if (!this.state || this.context !== sessionFingerprint()) return;
        const documents = documentResources.includes(this.tab);
        this.target.innerHTML = `<div data-finance-root><section class="page-intro finance-intro"><div><p class="page-eyebrow">FINANCE</p><h2>应收与应付</h2><p class="page-description">账单、收付款和核销统一记录于企业账簿，按公司和授权范围展示。</p></div><span class="finance-ledger-tag">ERPNext 财务账簿</span></section>
            <nav class="finance-tabs" aria-label="财务栏目">${this.availableTabs()
                .map(
                    ([key, label]) =>
                        `<button type="button" data-finance-tab="${key}" class="${this.tab === key ? 'active' : ''}" aria-selected="${this.tab === key}">${h(label)}</button>`
                )
                .join('')}</nav>
            ${this.filterBar()}
            <div class="finance-heading"><div><h3>${h(resourceLabel(this.tab))}</h3><p>${documents ? '提交账单形成应收或应付；银行收付与账单核销分别记录。订单余额与发票余额分别核算。' : this.tab === 'reconciliation' ? '将已提交的预收、预付或未分配款项分配到未结清账单。核销采用 ERPNext 原生规则。' : '金额、账龄及总账余额来自已提交的原生账务单据。'}</p></div><div class="finance-actions">${documents && this.can(`${capPrefix(this.tab)}.create`) ? `${this.tab === 'bank_transaction' ? '' : `<button class="btn btn-secondary" data-finance-create="from_order">从${this.tab === 'payment_entry' ? '账单或订单' : '订单 / 收发货'}创建</button>`}<button class="btn btn-primary" data-finance-create="direct">新建${h(resourceLabel(this.tab))}</button>` : ''}${this.can(`${capPrefix(this.tab)}.export`) ? '<button class="btn btn-secondary" data-finance-export>导出</button>' : ''}${!documents && this.can(`${capPrefix(this.tab)}.print`) ? '<button class="btn btn-secondary" data-finance-print-report>打印</button>' : ''}</div></div>
            ${documents ? this.documentsTable() : this.tab === 'reconciliation' ? this.reconciliationView() : this.tab === 'bank_reconciliation' ? this.bankReconciliationView() : this.reportTable()}${this.conflictDraft?.context === this.context && this.conflictDraft.resource === this.tab ? this.draftReviewHtml(this.conflictDraft.values) : ''}</div>`;
        for (const button of this.target.querySelectorAll('[data-finance-tab]')) {
            button.onclick = () => {
                this.pending = null;
                this.tab = button.dataset.financeTab;
                this.offset = 0;
                this.filters = { companyId: this.companyId() };
                this.load();
            };
        }
        this.target.querySelector('#financeFilters').onsubmit = event => {
            event.preventDefault();
            const form = event.currentTarget;
            this.filters = Object.fromEntries(new FormData(form).entries());
            this.offset = 0;
            this.pending = null;
            this.load();
        };
        const partyTypeFilter = this.target.querySelector('#financeFilters [name="partyType"]');
        if (partyTypeFilter) {
            partyTypeFilter.onchange = () => {
                const party = this.target.querySelector('#financeFilters [name="party"]');
                if (party) {
                    party.innerHTML = options(
                        partyTypeFilter.value === 'Supplier'
                            ? this.state.options?.suppliers
                            : this.state.options?.customers,
                        '',
                        this.tab === 'reconciliation' ? '请选择往来方' : '所有获授权往来方'
                    );
                }
            };
        }
        for (const button of this.target.querySelectorAll('[data-finance-open]')) {
            button.onclick = () => this.openDocument(button.dataset.financeOpen);
        }
        for (const button of this.target.querySelectorAll('[data-finance-create]')) {
            button.onclick = () => this.openCreate(button.dataset.financeCreate);
        }
        for (const button of this.target.querySelectorAll('[data-finance-offset]')) {
            button.onclick = () => {
                this.offset = Number(button.dataset.financeOffset);
                this.load();
            };
        }
        if (['sales_invoice', 'purchase_invoice'].includes(this.tab) && ['catalog.read', 'catalog.create', 'catalog.write', 'catalog.disable'].some(cap => this.can(cap))) {
            const actions = this.target.querySelector('.finance-actions');
            if (actions) {
                actions.insertAdjacentHTML('afterbegin', '<button class="btn btn-secondary" data-finance-catalog>商品目录</button>');
                actions.querySelector('[data-finance-catalog]').onclick = () => ItemCatalog.open(this.companyId(), async () => {
                    await DB._initFromBusinessAPI();
                    await this.load();
                });
            }
        }
        this.target.querySelector('[data-finance-export]')?.addEventListener('click', () => this.exportCurrent());
        this.target.querySelector('[data-finance-print-report]')?.addEventListener('click', () => this.printReport());
        this.target
            .querySelector('[data-finance-reconcile]')
            ?.addEventListener('click', () => this.openReconciliation());
        this.target
            .querySelector('[data-finance-create-bank]')
            ?.addEventListener('click', () => this.openBankTransaction());
        for (const button of this.target.querySelectorAll('[data-finance-match-bank]')) {
            button.onclick = () => this.openBankMatch(button.dataset.financeMatchBank);
        }
        for (const button of this.target.querySelectorAll('[data-finance-bank-operation]')) {
            button.onclick = () =>
                this.bankOperation(button.dataset.financeBankOperation, button.dataset.financeBankName);
        }
    },

    filterBar() {
        const opts = this.state.options || {};
        const companies = this.state.companies || [];
        const reconciliation = this.tab === 'reconciliation';
        const bankReconciliation = this.tab === 'bank_reconciliation';
        const bankAccountFilter = bankReconciliation || this.tab === 'bank_transaction';
        const parties =
            (reconciliation && this.filters.partyType === 'Supplier') ||
            this.tab === 'purchase_invoice' ||
            this.tab === 'payables'
                ? opts.suppliers
                : opts.customers;
        return `<form id="financeFilters" class="filter-bar finance-filter-bar">${select('companyId', '公司主体', companies, this.companyId(), true, '选择公司')}
            ${
                documentResources.includes(this.tab)
                    ? input('search', '单号 / 往来方', this.filters.search, {}) +
                      select(
                          'status',
                          '单据状态',
                          [
                              { name: '0', label: '草稿' },
                              { name: '1', label: '已提交' },
                              { name: '2', label: '已取消' }
                          ],
                          this.filters.status,
                          false,
                          '所有状态'
                      )
                    : ''
            }
            ${
                reconciliation || this.tab === 'general_ledger'
                    ? select(
                          'partyType',
                          '往来方类型',
                          [
                              { name: 'Customer', label: '客户' },
                              { name: 'Supplier', label: '供应商' }
                          ],
                          this.filters.partyType || 'Customer',
                          reconciliation
                      )
                    : ''
            }
            ${bankAccountFilter ? select('bankAccount', '银行账户', opts.bankAccounts, this.filters.bankAccount, bankReconciliation, '所有获授权银行账户') : select('party', '往来方', parties, this.filters.party, reconciliation, '所有获授权往来方')}
            ${input('fromDate', '起始日期', this.filters.fromDate, { type: 'date' })}${input('toDate', this.tab === 'receivables' || this.tab === 'payables' ? '账龄截止日期' : '截止日期', this.filters.toDate || today(), { type: 'date' })}
            ${
                reconciliation
                    ? select(
                          'receivablePayableAccount',
                          '应收 / 应付科目',
                          opts.partyAccounts || opts.accounts,
                          this.filters.receivablePayableAccount,
                          true
                      )
                    : bankReconciliation
                      ? select(
                            'allTransactions',
                            '银行流水范围',
                            [
                                { name: '1', label: '所有流水' },
                                { name: '0', label: '仅未核对流水' }
                            ],
                            this.filters.allTransactions || '0'
                        )
                      : ''
            }
            <button type="submit" class="btn btn-secondary">查询</button></form>`;
    },

    documentsTable() {
        if (this.tab === 'bank_transaction') return this.bankTransactionsTable();
        const docs = this.state.documents || [];
        const payment = this.tab === 'payment_entry';
        const bank = this.can('finance.bank_accounts.read');
        const pagination = this.state.pagination || {};
        return `<div class="card"><div class="table-container"><table class="finance-table"><thead><tr><th>单号</th><th>往来方</th><th>日期</th><th>状态</th>${payment ? '<th class="text-right">付款金额 · 付款币种</th><th class="text-right">到账金额 · 到账币种</th>' + (bank ? '<th>账户</th>' : '') : '<th class="text-right">账单金额 · 原币</th><th class="text-right">剩余应收 / 应付 · 往来账户币种</th><th class="text-right">本位币金额</th>'}<th></th></tr></thead><tbody>${docs.length ? docs.map(doc => `<tr><td><strong>${h(doc.name)}</strong>${doc.isReturn ? '<small>贷项 / 退货账单</small>' : ''}</td><td>${h(doc.partyLabel || doc.party || '—')}</td><td>${nativeDate(doc.postingDate)}${!payment ? `<small>到期 ${nativeDate(doc.dueDate)}</small>` : ''}</td><td><span class="finance-status status-${Number(doc.docstatus)}">${h(statusLabel(doc))}</span></td>${payment ? `<td class="text-right">${h(financeMoney(doc.paidAmount, fromCurrency(doc)))}</td><td class="text-right">${h(financeMoney(doc.receivedAmount, toCurrency(doc)))}</td>${bank ? `<td>${h(doc.paidFrom || '—')}<small>→ ${h(doc.paidTo || '—')}</small></td>` : ''}` : `<td class="text-right">${h(financeMoney(doc.grandTotal, doc.currency))}</td><td class="text-right">${h(financeMoney(doc.outstandingAmount, doc.outstandingCurrency || doc.partyAccountCurrency || doc.currency))}</td><td class="text-right">${h(financeMoney(doc.baseGrandTotal, doc.companyCurrency || doc.baseCurrency))}</td>`}<td><button class="btn btn-secondary btn-sm" data-finance-open="${h(doc.name)}">详情</button></td></tr>`).join('') : `<tr><td colspan="9" class="finance-empty-cell">当前筛选条件下暂无获授权单据。</td></tr>`}</tbody></table></div></div><div class="finance-pagination"><span>已加载 ${docs.length} 条${pagination.total != null ? ` · 共 ${h(pagination.total)} 条` : ''}</span><div><button class="btn btn-secondary btn-sm" data-finance-offset="${Math.max(0, this.offset - 40)}" ${this.offset === 0 ? 'disabled' : ''}>上一页</button> <button class="btn btn-secondary btn-sm" data-finance-offset="${this.offset + 40}" ${pagination.hasMore === true || Number(pagination.total) > this.offset + docs.length ? '' : 'disabled'}>下一页</button></div></div>`;
    },

    bankTransactionsTable() {
        const documents = this.state.documents || [];
        return `<div class="card"><div class="table-container"><table class="finance-table"><thead><tr><th>流水单号 / 银行参考号</th><th>日期</th><th>状态</th><th>银行账户</th><th class="text-right">实际存入 · 银行账户币种</th><th class="text-right">实际支出 · 银行账户币种</th><th>操作</th></tr></thead><tbody>${documents.length ? documents.map(doc => `<tr><td>${h(doc.name)}<small>${h(doc.referenceNumber)}</small></td><td>${nativeDate(doc.date)}</td><td><span class="finance-status status-${doc.docstatus}">${h(statusLabel(doc))}</span></td><td>${this.can('finance.bank_accounts.read') ? h(doc.bankAccount) : '未授权'}</td><td class="text-right">${h(financeMoney(doc.deposit, doc.currency))}</td><td class="text-right">${h(financeMoney(doc.withdrawal, doc.currency))}</td><td><button class="btn btn-secondary btn-sm" data-finance-open="${h(doc.name)}">详情</button></td></tr>`).join('') : '<tr><td colspan="7" class="finance-empty-cell">暂无获授权银行流水。录入草稿并提交后，可在银行对账中匹配账簿款项。</td></tr>'}</tbody></table></div></div><div class="finance-pagination"><span>已加载 ${documents.length} 条</span><div><button class="btn btn-secondary btn-sm" data-finance-offset="${Math.max(0, this.offset - 40)}" ${this.offset === 0 ? 'disabled' : ''}>上一页</button> <button class="btn btn-secondary btn-sm" data-finance-offset="${this.offset + 40}" ${this.state.pagination?.hasMore ? '' : 'disabled'}>下一页</button></div></div>`;
    },

    reportTable(report = this.report) {
        const columns = report?.columns || [];
        const rows = report?.result || [];
        const labels = {
            voucher_no: '单据号',
            party: '往来方',
            posting_date: '记账日期',
            due_date: '到期日',
            currency: '币种',
            invoiced: '账单金额',
            paid: '已核销金额',
            outstanding: '未结清',
            account: '科目',
            debit: '借方',
            credit: '贷方',
            balance: '余额',
            range1: '0–30 天',
            range2: '31–60 天',
            range3: '61–90 天',
            range4: '91–120 天',
            range5: '121 天以上'
        };
        return `<div class="finance-report-note">${h(report?.nativeReport || resourceLabel(this.tab))} · ${h(this.state?.companies?.find(company => company.id === this.companyId())?.name || this.companyId())} · 截止 ${nativeDate(this.filters.toDate || today())}</div><div class="card"><div class="table-container"><table class="finance-table"><thead><tr>${columns.map(col => `<th>${h(labels[col.fieldname] || col.label || col.fieldname || col)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${columns.map((col, index) => `<td>${this.reportCell(col, Array.isArray(row) ? row[index] : row[col.fieldname], row)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${Math.max(1, columns.length)}" class="finance-empty-cell">暂无账务记录，或当前筛选范围内没有获授权记录。</td></tr>`}</tbody></table></div></div>${typeof report?.message === 'string' && report.message ? `<p class="finance-report-note">${h(report.message)}</p>` : ''}`;
    },

    reportCell(column, value, row) {
        if (column.fieldtype === 'Currency') {
            const currencyIndex = (this.report?.columns || []).findIndex(
                col => col.fieldname === column.options || col.fieldname === 'currency'
            );
            const currency = Array.isArray(row) ? row[currencyIndex] : row?.[column.options] || row?.currency;
            const company = this.state?.companies?.find(item => item.id === this.companyId());
            return h(
                financeMoney(
                    value,
                    currency || company?.settlementCurrency || company?.defaultCurrency || column.currency
                )
            );
        }
        return h(value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : value);
    },

    reconciliationView() {
        const payments = this.report?.payments || [];
        const invoices = this.report?.invoices || [];
        const table = (rows, payment) =>
            `<div class="card"><div class="table-container"><table class="finance-table"><thead><tr><th>${payment ? '预收 / 预付单据' : '未结清账单'}</th><th>日期</th><th class="text-right">可核销金额 · 币种</th></tr></thead><tbody>${rows.length ? rows.map(row => `<tr><td>${h(payment ? row.referenceName || row.reference_name || row.name : row.invoiceNumber || row.invoice_number || row.name)}</td><td>${nativeDate(row.postingDate || row.posting_date)}</td><td class="text-right">${h(financeMoney(payment ? (row.unallocatedAmount ?? row.unallocated_amount ?? row.amount) : (row.outstandingAmount ?? row.outstanding_amount), row.currency || row.accountCurrency || this.report.currency))}</td></tr>`).join('') : '<tr><td colspan="3" class="finance-empty-cell">暂无可核销记录。</td></tr>'}</tbody></table></div></div>`;
        return `${!this.filters.party || !this.filters.receivablePayableAccount ? '<p class="finance-report-note">请选择往来方类型、具体往来方和应收 / 应付科目后查询可核销款项。</p>' : ''}<div class="finance-reconcile-summary"><span>${payments.length} 笔未分配款项</span><span>${invoices.length} 张待核销账单</span>${this.can('finance.reconciliation.write') ? `<button class="btn btn-primary" data-finance-reconcile ${!payments.length || !invoices.length ? 'disabled' : ''}>分配并核销</button>` : ''}</div><div class="finance-two-columns"><section><h4>预付款与未分配款项</h4>${table(payments, true)}</section><section><h4>未结清账单</h4>${table(invoices, false)}</section></div>`;
    },

    bankReconciliationView(report = this.report) {
        if (!this.can('finance.bank_accounts.read')) {
            return '<section class="card finance-empty">银行对账需要银行账户查看授权。</section>';
        }
        const transactions = report?.transactions || [];
        return `<div class="finance-reconcile-summary"><span>银行流水实际净额与账簿收付款分别记录。</span>${this.can('finance.bank_transaction.create') ? '<button class="btn btn-primary" data-finance-create-bank>录入银行流水</button>' : ''}</div>${!this.filters.bankAccount ? '<p class="finance-report-note">请选择银行账户后查询并匹配银行流水。</p>' : ''}<div class="card"><div class="table-container"><table class="finance-table"><thead><tr><th>流水 / 银行参考号</th><th>日期</th><th>状态</th><th class="text-right">实际存入</th><th class="text-right">实际支出</th><th class="text-right">未匹配金额</th><th>说明</th><th>操作</th></tr></thead><tbody>${transactions.length ? transactions.map(row => `<tr><td>${h(row.name)}<small>${h(row.referenceNumber || '—')}</small></td><td>${nativeDate(row.date)}</td><td>${h(row.status || statusLabel(row))}</td><td class="text-right">${h(financeMoney(row.deposit, row.currency))}</td><td class="text-right">${h(financeMoney(row.withdrawal, row.currency))}</td><td class="text-right">${h(financeMoney(row.unallocatedAmount, row.currency))}</td><td>${h(row.description || '—')}</td><td><div class="finance-actions">${Number(row.docstatus) === 0 && this.can('finance.bank_transaction.write') ? `<button class="btn btn-secondary btn-sm" data-finance-bank-operation="save" data-finance-bank-name="${h(row.name)}">编辑</button>` : ''}${Number(row.docstatus) === 0 && this.can('finance.bank_transaction.submit') ? `<button class="btn btn-secondary btn-sm" data-finance-bank-operation="submit" data-finance-bank-name="${h(row.name)}">提交</button>` : ''}${(row.docstatus == null || Number(row.docstatus) === 1) && this.can('finance.bank_reconciliation.write') ? `<button class="btn btn-secondary btn-sm" data-finance-match-bank="${h(row.name)}">匹配款项</button>${Number(row.allocatedAmount) > 0 ? `<button class="btn btn-secondary btn-sm" data-finance-bank-operation="unreconcile" data-finance-bank-name="${h(row.name)}">解除匹配</button>` : ''}` : ''}${Number(row.docstatus) === 1 && this.can('finance.bank_transaction.cancel') ? `<button class="btn btn-secondary btn-sm" data-finance-bank-operation="cancel" data-finance-bank-name="${h(row.name)}">取消</button>` : ''}</div></td></tr>`).join('') : '<tr><td colspan="8" class="finance-empty-cell">暂无获授权银行流水。</td></tr>'}</tbody></table></div></div>`;
    },

    openBankTransaction(doc = {}) {
        const operation = doc.name ? 'save' : 'create';
        if (
            !this.can(`finance.bank_transaction.${doc.name ? 'write' : 'create'}`) ||
            !this.can('finance.bank_accounts.read')
        ) {
            return;
        }
        this.openOperationForm(
            `${doc.name ? '编辑' : '录入'}银行流水`,
            `<div data-finance-modal><div class="finance-form-grid">${select('bankAccount', '银行账户', this.state.options?.bankAccounts, doc.bankAccount || this.filters.bankAccount, true)}${input('date', '银行记账日期', doc.date || today(), { type: 'date', required: true })}${select('currency', '银行账户币种', this.state.options?.currencies, doc.currency || this.state.options?.defaultCurrency, true)}${input('deposit', '实际存入金额', doc.deposit || 0, { type: 'number', step: '0.01', min: 0, required: true })}${input('withdrawal', '实际支出金额', doc.withdrawal || 0, { type: 'number', step: '0.01', min: 0, required: true })}${input('referenceNumber', '银行参考号', doc.referenceNumber)}${input('includedFee', '流水金额内手续费', doc.includedFee || 0, { type: 'number', step: '0.01', min: 0 })}${input('excludedFee', '流水金额外手续费', doc.excludedFee || 0, { type: 'number', step: '0.01', min: 0 })}</div>${input('description', '银行摘要', doc.description)}<p class="finance-report-note">银行流水保留实际存入 / 支出的净额，不改写账单或账簿付款金额。费用与匹配由 ERPNext 原生对账规则处理。</p></div>`,
            form => ({
                operation,
                name: doc.name,
                expectedModified: doc.modified,
                values: {
                    bankAccount: field(form, 'bankAccount'),
                    date: field(form, 'date'),
                    currency: field(form, 'currency'),
                    deposit: numeric(form, 'deposit'),
                    withdrawal: numeric(form, 'withdrawal'),
                    referenceNumber: field(form, 'referenceNumber'),
                    includedFee: numeric(form, 'includedFee'),
                    excludedFee: numeric(form, 'excludedFee'),
                    description: field(form, 'description')
                }
            }),
            'bank_transaction',
            { document: doc, submitLabel: '保存流水草稿' }
        );
        const form = document.querySelector('[data-finance-form]');
        const updateCurrency = () => {
            const bank = (this.state.options?.bankAccounts || []).find(
                account => optionKey(account) === field(form, 'bankAccount')
            );
            if (bank?.currency) form.elements.namedItem('currency').value = bank.currency;
        };
        form.elements.namedItem('bankAccount').onchange = updateCurrency;
        updateCurrency();
        if (
            this.conflictDraft?.context === this.context &&
            this.conflictDraft.resource === 'bank_transaction' &&
            this.conflictDraft.name === (doc.name || null)
        ) {
            form.insertAdjacentHTML('beforeend', this.draftReviewHtml(this.conflictDraft.values));
        }
    },

    bankOperation(operation, name) {
        const transaction = (this.report?.transactions || []).find(row => row.name === name);
        if (!transaction) return;
        if (operation === 'save') return this.openBankTransaction(transaction);
        if (operation === 'unreconcile') {
            if (!this.can('finance.bank_reconciliation.write')) return;
            this.openOperationForm(
                '解除银行流水匹配',
                `<div data-finance-modal><h3>${h(name)}</h3><p class="finance-report-note">解除此流水的账簿款项关联，保留原始银行流水与收付款单。此操作不会擅自修改应收或应付金额。</p></div>`,
                () => ({ operation, name, expectedModified: transaction.modified, values: {} }),
                'bank_reconciliation',
                { document: transaction, submitLabel: '确认解除匹配' }
            );
        } else {
            if (!this.can(`finance.bank_transaction.${operation}`)) return;
            this.confirmOperation(operation, transaction, 'bank_transaction');
        }
    },

    openBankMatch(name) {
        if (!this.can('finance.bank_reconciliation.write') || !this.can('finance.bank_accounts.read')) return;
        const transaction = (this.report?.transactions || []).find(row => row.name === name);
        const vouchers = (this.state.options?.sources || []).filter(source => source.resource === 'payment_entry');
        if (!transaction) return;
        if (!vouchers.length) {
            toast('当前公司没有获授权且已提交的收付款单可供匹配。', 'info');
            return;
        }
        this.openOperationForm(
            '匹配银行流水与账簿款项',
            `<div data-finance-modal><h3>${h(name)}</h3><p class="finance-report-note">实际存入 ${h(financeMoney(transaction.deposit, transaction.currency))}；实际支出 ${h(financeMoney(transaction.withdrawal, transaction.currency))}。请选择对应的已提交收付款单。</p><div class="admin-check-grid">${vouchers.map(voucher => `<label><input type="checkbox" name="vouchers" value="${h(voucher.name)}"> ${h(voucher.label || voucher.name)}</label>`).join('')}</div></div>`,
            form => {
                const selected = [...form.querySelectorAll('[name="vouchers"]:checked')].map(element =>
                    vouchers.find(voucher => voucher.name === element.value)
                );
                if (!selected.length) throw new Error('请选择至少一张已提交收付款单。');
                return {
                    operation: 'reconcile',
                    name,
                    expectedModified: transaction.modified,
                    values: {
                        vouchers: selected.map(voucher => ({ name: voucher.name, expectedModified: voucher.modified }))
                    }
                };
            },
            'bank_reconciliation',
            { document: transaction, submitLabel: '确认匹配' }
        );
    },

    async openDocument(name, resource = this.tab) {
        if (!this.can(`${capPrefix(resource)}.read`)) return;
        const context = this.context;
        const epoch = this.epoch;
        try {
            const result = await api().financeDocument({ companyId: this.companyId(), resource, name, action: 'read' });
            if (context !== sessionFingerprint() || epoch !== this.epoch) return;
            this.state.version = result.version;
            this.showDocument(result.document, resource);
        } catch (error) {
            toast(error.message || '无法读取单据', 'error');
        }
    },

    detailHtml(doc, resource) {
        if (resource === 'bank_transaction') {
            return `<div data-finance-modal class="finance-detail"><div class="finance-detail-header"><div><h3>${h(doc.name)}</h3><p>银行记账日期 ${nativeDate(doc.date)}</p></div><span class="finance-status status-${doc.docstatus}">${h(statusLabel(doc))}</span></div><dl class="finance-detail-grid">${[
                ['银行实际存入', financeMoney(doc.deposit, doc.currency)],
                ['银行实际支出', financeMoney(doc.withdrawal, doc.currency)],
                ['未匹配金额', financeMoney(doc.unallocatedAmount, doc.currency)],
                ['已匹配金额', financeMoney(doc.allocatedAmount, doc.currency)],
                ['金额内手续费', financeMoney(doc.includedFee, doc.currency)],
                ['金额外手续费', financeMoney(doc.excludedFee, doc.currency)],
                ...(this.can('finance.bank_accounts.read')
                    ? [
                          ['银行账户', doc.bankAccount],
                          ['银行参考号', doc.referenceNumber]
                      ]
                    : [])
            ]
                .map(([label, value]) => `<div><dt>${h(label)}</dt><dd>${h(value ?? '—')}</dd></div>`)
                .join(
                    ''
                )}</dl><p class="finance-report-note">${h(doc.description)}</p><p class="finance-report-note">此处保留银行实际净额。账簿收付款、账单核销和银行匹配按原生财务规则分别管理。</p></div>`;
        }
        const payment = resource === 'payment_entry';
        const bank = this.can('finance.bank_accounts.read');
        const entries = payment
            ? [
                  ['付款账户端金额', financeMoney(doc.paidAmount, fromCurrency(doc))],
                  ['到账账户端金额', financeMoney(doc.receivedAmount, toCurrency(doc))],
                  [
                      '账单分配 / 核销额',
                      financeMoney(doc.totalAllocatedAmount, doc.partyAccountCurrency || doc.currency)
                  ],
                  ['付款端汇率', doc.sourceExchangeRate],
                  ['到账端汇率', doc.targetExchangeRate],
                  ['未分配金额', financeMoney(doc.unallocatedAmount, fromCurrency(doc))]
              ]
            : [
                  ['账单总额 · 原币', financeMoney(doc.grandTotal, doc.currency)],
                  [
                      '剩余应收 / 应付 · 往来账户币种',
                      financeMoney(
                          doc.outstandingAmount,
                          doc.outstandingCurrency || doc.partyAccountCurrency || doc.currency
                      )
                  ],
                  ['账单总额 · 本位币', financeMoney(doc.baseGrandTotal, doc.companyCurrency || doc.baseCurrency)],
                  ['记账汇率', doc.conversionRate],
                  ['到期日', doc.dueDate]
              ];
        return `<div data-finance-modal class="finance-detail"><div class="finance-detail-header"><div><h3>${h(doc.name || '待保存单据')}</h3><p>${h(doc.partyLabel || doc.party)} · ${nativeDate(doc.postingDate)}</p></div><span class="finance-status status-${doc.docstatus}">${h(statusLabel(doc))}</span></div><dl class="finance-detail-grid">${entries.map(([label, value]) => `<div><dt>${h(label)}</dt><dd>${h(value ?? '—')}</dd></div>`).join('')}${payment && bank ? `<div><dt>付款账户</dt><dd>${h(doc.paidFrom)}</dd></div><div><dt>到账账户</dt><dd>${h(doc.paidTo)}</dd></div><div><dt>银行流水号 / 日期</dt><dd>${h(doc.referenceNo || doc.refNo || '—')} / ${nativeDate(doc.referenceDate || doc.refDate)}</dd></div>` : ''}</dl>
            ${
                payment
                    ? `<h4>账单分配与核销</h4>${this.detailTable(
                          ['单据类型', '单据号', '付款期', '本次核销金额', '原剩余金额'],
                          (doc.references || []).map(ref => [
                              ref.referenceDoctype || ref.reference_doctype,
                              ref.referenceName || ref.reference_name,
                              ref.paymentTerm || ref.payment_term || '整张账单',
                              financeMoney(
                                  ref.allocatedAmount ?? ref.allocated_amount,
                                  doc.partyAccountCurrency || doc.currency
                              ),
                              financeMoney(
                                  ref.outstandingAmount ?? ref.outstanding_amount,
                                  doc.partyAccountCurrency || doc.currency
                              )
                          ])
                      )}${
                          bank
                              ? `<h4>手续费与差额科目</h4>${this.detailTable(
                                    ['科目', '成本中心', '金额 · 本位币'],
                                    (doc.deductions || []).map(row => [
                                        row.account,
                                        row.costCenter || row.cost_center,
                                        financeMoney(row.amount, doc.companyCurrency || doc.baseCurrency)
                                    ])
                                )}`
                              : ''
                      }`
                    : `<h4>账单明细</h4>${this.detailTable(
                          ['商品', '数量', '单位', '单价 · 原币', '金额 · 原币'],
                          (doc.items || []).map(row => [
                              row.itemName || row.itemCode || row.item_code,
                              row.qty,
                              row.uom,
                              financeMoney(row.rate, doc.currency),
                              financeMoney(row.amount, doc.currency)
                          ])
                      )}<h4>税费</h4>${this.detailTable(
                          ['税费科目', '税率', '金额 · 原币'],
                          (doc.taxes || []).map(row => [
                              row.description || row.accountHead || row.account_head,
                              row.rate,
                              financeMoney(row.taxAmount ?? row.tax_amount, doc.currency)
                          ])
                      )}`
            }
            ${doc.returnAgainst ? `<p class="finance-report-note">原账单 ${h(doc.returnAgainst)}</p>` : ''}${doc.remarks ? `<p class="finance-report-note">${h(doc.remarks)}</p>` : ''}<p class="finance-report-note">单据修改时间 ${h(doc.modified || '—')}。已提交的账单和收付款通过取消、修订或退货单调整；实际银行收付差额不直接作为订单利润。</p></div>`;
    },

    detailTable(headers, rows) {
        return `<div class="table-container"><table class="finance-table"><thead><tr>${headers.map(label => `<th>${h(label)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(value => `<td>${h(value ?? '—')}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}" class="finance-empty-cell">无记录</td></tr>`}</tbody></table></div>`;
    },

    draftReviewHtml(values) {
        const labels = {
            party: '往来方',
            partyType: '往来方类型',
            postingDate: '记账日期',
            dueDate: '到期日',
            currency: '币种',
            conversionRate: '记账汇率',
            remarks: '备注',
            debitTo: '应收科目',
            creditTo: '应付科目',
            paymentType: '收付款类型',
            paidFrom: '付款账户',
            paidTo: '到账账户',
            paidAmount: '付款端金额',
            receivedAmount: '到账端金额',
            sourceExchangeRate: '付款端汇率',
            targetExchangeRate: '到账端汇率',
            referenceNo: '银行流水号',
            referenceDate: '银行流水日期',
            modeOfPayment: '收付款方式',
            itemCode: '商品',
            qty: '数量',
            uom: '单位',
            rate: '单价',
            incomeAccount: '收入科目',
            expenseAccount: '费用科目',
            costCenter: '成本中心',
            warehouse: '仓库',
            referenceDoctype: '分配单据类型',
            referenceName: '分配单据号',
            allocatedAmount: '分配 / 核销金额',
            account: '科目',
            amount: '金额',
            invoiceNumber: '账单号',
            referenceType: '预付款类型',
            invoiceType: '账单类型',
            bankAccount: '银行账户',
            date: '银行日期',
            deposit: '实际存入',
            withdrawal: '实际支出',
            includedFee: '金额内手续费',
            excludedFee: '金额外手续费',
            description: '摘要',
            referenceNumber: '银行参考号',
            name: '单据 / 明细号',
            paymentTermsTemplate: '付款条款模板',
            taxesTemplate: '税费模板',
            billNo: '供应商账单号',
            billDate: '供应商账单日期',
            discountAmount: '折扣金额',
            additionalDiscountPercentage: '折扣百分比',
            applyDiscountOn: '折扣基准'
        };
        const render = object =>
            `<dl class="finance-draft-fields">${Object.entries(object || {})
                .filter(([key, value]) => labels[key] && value != null && value !== '' && typeof value !== 'object')
                .map(([key, value]) => `<div><dt>${h(labels[key])}</dt><dd>${h(value)}</dd></div>`)
                .join('')}</dl>${Object.entries(object || {})
                .filter(([, value]) => Array.isArray(value))
                .map(
                    ([key, rows]) =>
                        `<h5>${h({ items: '商品明细', references: '款项分配', deductions: '手续费与差额', allocations: '核销分配', vouchers: '银行匹配款项' }[key] || '明细')}</h5>${rows.map(row => render(row)).join('')}`
                )
                .join('')}`;
        return `<details class="finance-draft-review" open><summary>上一份未保存的草稿 · 只读对照</summary><p class="finance-report-note">这些输入保留供核对、选择和复制；新的编辑表单采用服务器最新值，旧草稿不会自动覆盖他人的修改。</p>${render(values)}</details>`;
    },

    showDocument(doc, resource) {
        const buttons = [];
        const add = (operation, label, allowed) => {
            if (allowed && this.can(`${capPrefix(resource)}.${operation === 'save' ? 'write' : operation}`)) {
                buttons.push(
                    `<button class="btn btn-secondary" data-finance-operation="${operation}">${h(label)}</button>`
                );
            }
        };
        add('save', '编辑草稿', Number(doc.docstatus) === 0);
        add('submit', '提交入账', Number(doc.docstatus) === 0);
        add('cancel', '取消单据', Number(doc.docstatus) === 1);
        add('amend', '修订为新草稿', Number(doc.docstatus) === 2);
        add(
            'return',
            resource === 'sales_invoice' ? '创建贷项 / 退货账单' : '创建借项 / 退货账单',
            Number(doc.docstatus) === 1 && invoiceResources.includes(resource) && !doc.isReturn
        );
        if (
            invoiceResources.includes(resource) &&
            Number(doc.docstatus) === 1 &&
            this.can('finance.payment_entry.create')
        ) {
            buttons.push('<button class="btn btn-primary" data-finance-from-invoice>创建收付款草稿</button>');
        }
        if (resource === 'payment_entry' && Number(doc.docstatus) === 1 &&
            this.can('finance.reconciliation.unreconcile') &&
            (doc.references || []).some(ref => ['Sales Invoice', 'Purchase Invoice'].includes(ref.referenceDoctype))) {
            buttons.push('<button class="btn btn-secondary" data-finance-unreconcile>解除发票核销</button>');
        }
        if (this.can(`${capPrefix(resource)}.print`)) {
            buttons.push('<button class="btn btn-secondary" data-finance-print>打印</button>');
        }
        if (this.can(`${capPrefix(resource)}.export`)) {
            buttons.push('<button class="btn btn-secondary" data-finance-export-document>导出明细</button>');
        }
        App.showModal(`${resourceLabel(resource)}详情`, this.detailHtml(doc, resource), {
            large: true,
            footer: `${buttons.join('')}<button class="btn btn-secondary" data-finance-close>关闭</button>`
        });
        document.querySelector('[data-finance-close]').onclick = () => App.closeModal();
        for (const button of document.querySelectorAll('[data-finance-operation]')) {
            button.onclick = () => {
                const operation = button.dataset.financeOperation;
                if (operation === 'save' && resource === 'bank_transaction') this.openBankTransaction(doc);
                else if (operation === 'save') this.openEditor(doc, resource, 'save');
                else this.confirmOperation(operation, doc, resource);
            };
        }
        document
            .querySelector('[data-finance-from-invoice]')
            ?.addEventListener('click', () => this.openMappedPayment({ ...doc, resource }));
        document
            .querySelector('[data-finance-unreconcile]')
            ?.addEventListener('click', () => this.openUnreconciliation(doc));
        document
            .querySelector('[data-finance-print]')
            ?.addEventListener('click', () => this.printDocument(doc.name, resource));
        document
            .querySelector('[data-finance-export-document]')
            ?.addEventListener('click', () => this.exportDocument(doc.name, resource));
    },

    openCreate(mode) {
        if (!this.can(`${capPrefix(this.tab)}.create`)) return;
        if (this.tab === 'bank_transaction') return this.openBankTransaction();
        if (mode === 'direct') return this.openEditor({}, this.tab, 'create');
        const payment = this.tab === 'payment_entry';
        const allowed = payment
            ? ['sales_invoice', 'purchase_invoice', 'sales_order', 'purchase_order']
            : this.tab === 'sales_invoice'
              ? ['sales_order', 'delivery_note']
              : ['purchase_order', 'purchase_receipt'];
        const sources = (this.state.options?.sources || []).filter(source => allowed.includes(source.resource));
        if (!sources.length) {
            toast('当前公司没有已提交且获授权的原生来源单据。请先完成订单或收发货的 ERP 商品与会计配置。', 'info');
            return;
        }
        if (payment) {
            const id = `financeSource-${requestKey()}`;
            App.showModal(
                '选择收付款来源',
                `<form id="${h(id)}" data-finance-modal>${select(
                    'source',
                    '账单 / 订单',
                    sources.map(source => ({
                        id: `${source.resource}:${source.name}`,
                        label: source.label || source.name
                    })),
                    '',
                    true
                )}<p class="finance-report-note">选择来源后设置实际收付款账户、双端金额和本次记账汇率，再保存草稿。</p></form>`,
                {
                    large: true,
                    footer: `<button class="btn btn-secondary" data-finance-close>取消</button><button class="btn btn-primary" type="submit" form="${h(id)}">继续设置收付款</button>`
                }
            );
            document.querySelector('[data-finance-close]').onclick = () => App.closeModal();
            document.getElementById(id).onsubmit = event => {
                event.preventDefault();
                const source = sources.find(
                    item => `${item.resource}:${item.name}` === field(event.currentTarget, 'source')
                );
                this.openMappedPayment(source);
            };
            return;
        }
        this.openOperationForm(
            '选择原生来源单据',
            `<div data-finance-modal>${select(
                'source',
                '订单 / 账单 / 收发货单',
                sources.map(source => ({
                    id: `${source.resource}:${source.name}`,
                    label: source.label || source.name
                })),
                '',
                true
            )}<p class="finance-report-note">系统按来源单据建立原生草稿，不重复生成已开票的数量。历史订单需先具备可开票的 ERP 商品与主体资料。</p></div>`,
            form => {
                const source = sources.find(item => `${item.resource}:${item.name}` === field(form, 'source'));
                return {
                    operation: 'from_order',
                    source: { resource: source.resource, name: source.name, expectedModified: source.modified },
                    expectedModified: source.modified
                };
            },
            this.tab,
            { submitLabel: '创建草稿' }
        );
    },

    async openMappedPayment(source) {
        if (!source || !this.can('finance.payment_entry.create')) return;
        const context = this.context;
        const epoch = this.epoch;
        let editorOptions;
        try {
            const latest = await api().financeState({ companyId: this.companyId(), resource: 'payment_entry' });
            if (context !== sessionFingerprint() || epoch !== this.epoch) return;
            if (capabilityIn(latest.capabilities, 'finance.payment_entry.create') === false) {
                throw new Error('当前账号的收付款创建权限已变更。');
            }
            editorOptions = latest.options;
            this.state.version = latest.version;
        } catch (error) {
            toast(error.message || '收付款配置未能读取。', 'error');
            return;
        }
        const receivable = ['sales_invoice', 'sales_order'].includes(source.resource);
        const refund = Boolean(source.isReturn || source.is_return) || Number(source.outstandingAmount) < 0;
        const receiving = source.paymentType ? source.paymentType === 'Receive' : refund ? !receivable : receivable;
        const amount = Math.abs(Number(source.outstandingAmount ?? source.grandTotal ?? source.orderAmount ?? 0)) || '';
        const configuredSource = (editorOptions?.sources || []).find(item => item.resource === source.resource && item.name === source.name);
        const paymentSchedule = configuredSource?.paymentSchedule || source.paymentSchedule || [];
        const allocateByTerms = configuredSource?.allocatePaymentBasedOnPaymentTerms ?? source.allocatePaymentBasedOnPaymentTerms;
        const referenceDoctype = {
            sales_invoice: 'Sales Invoice', purchase_invoice: 'Purchase Invoice',
            sales_order: 'Sales Order', purchase_order: 'Purchase Order'
        }[source.resource];
        const references = allocateByTerms
            ? paymentSchedule.filter(row => row.paymentTerm && Number(row.outstandingAmount) !== 0)
                .map(row => ({ referenceDoctype, referenceName: source.name, paymentTerm: row.paymentTerm,
                    allocatedAmount: row.outstandingAmount ?? '' }))
            : [{ referenceDoctype, referenceName: source.name, allocatedAmount: refund ? -Number(amount) : amount }];
        this.openEditor(
            {
                paymentType: receiving ? 'Receive' : 'Pay',
                partyType: receivable ? 'Customer' : 'Supplier',
                party: source.party,
                paidFrom: source.paidFrom || (receiving ? (receivable ? source.debitTo : source.creditTo) : ''),
                paidTo: source.paidTo || (!receiving ? (receivable ? source.debitTo : source.creditTo) : ''),
                paidAmount: amount,
                receivedAmount: amount,
                remarks: source.remarks || '',
                currency: source.outstandingCurrency || source.partyAccountCurrency || source.currency,
                references
            },
            'payment_entry',
            'payment_from_invoice',
            { source, editorOptions }
        );
    },

    openEditor(doc, resource, operation, { source = null, editorOptions = null } = {}) {
        const opts = editorOptions || this.state.options || {};
        if (!this.can(`${capPrefix(resource)}.${operation === 'save' ? 'write' : 'create'}`)) return;
        const payment = resource === 'payment_entry';
        const common = input('postingDate', '记账日期', doc.postingDate || today(), { type: 'date', required: true });
        let body;
        if (payment) {
            if (!this.can('finance.bank_accounts.read')) {
                toast('创建或修改收付款需要银行账户查看授权。', 'warning');
                return;
            }
            body = `<div class="finance-form-grid">${select(
                'paymentType',
                '收付款类型',
                [
                    { name: 'Receive', label: '收款' },
                    { name: 'Pay', label: '付款' },
                    { name: 'Internal Transfer', label: '公司内账户划转' }
                ],
                doc.paymentType || 'Receive',
                true
            )}${select(
                'partyType',
                '往来方类型',
                [
                    { name: 'Customer', label: '客户' },
                    { name: 'Supplier', label: '供应商' }
                ],
                doc.partyType || 'Customer',
                false
            )}${select('party', '往来方', doc.partyType === 'Supplier' ? opts.suppliers : opts.customers, doc.party, false)}${common}${select('paidFrom', '付款账户', opts.accounts, doc.paidFrom, true)}${select('paidTo', '到账账户', opts.accounts, doc.paidTo, true)}${input('paidAmount', '付款金额 · 付款账户币种', doc.paidAmount ?? '', { type: 'number', step: '0.01', min: 0, required: true })}${input('receivedAmount', '到账金额 · 到账账户币种', doc.receivedAmount ?? '', { type: 'number', step: '0.01', min: 0, required: true })}${input('sourceExchangeRate', '付款币种 → 本位币汇率', doc.sourceExchangeRate ?? (source ? '' : 1), { type: 'number', step: '0.000000001', min: '0.000000001', required: true })}${input('targetExchangeRate', '到账币种 → 本位币汇率', doc.targetExchangeRate ?? (source ? '' : 1), { type: 'number', step: '0.000000001', min: '0.000000001', required: true })}${input('referenceNo', '银行流水号', doc.referenceNo || doc.refNo)}${input('referenceDate', '银行流水日期', doc.referenceDate || doc.refDate || today(), { type: 'date' })}${select('modeOfPayment', '收付款方式', opts.paymentModes, doc.modeOfPayment)}</div><p id="financeAccountCurrencies" class="finance-report-note"></p><h4>分配到多张账单 / 订单</h4><p class="finance-report-note">分配金额使用应收 / 应付账户币种。仅已提交单据可核销；未分配金额保留为预收或预付。</p><div id="financeReferences">${(doc.references || []).map(row => this.referenceRow(row, opts)).join('')}</div><button type="button" class="btn btn-secondary btn-sm" data-finance-add-reference>增加分配</button><h4>手续费与差额</h4><p class="finance-report-note">金额使用本位币，按 ERPNext 的借贷方向与差额规则填写。账户币种与本位币一致时，例如客户付款 / 账单核销 100、银行净收 97、手续费 3；外币差额按实际记账汇率折算为本位币。订单金额不改写。</p><div id="financeDeductions">${(doc.deductions || []).map(row => this.deductionRow(row, opts)).join('')}</div><button type="button" class="btn btn-secondary btn-sm" data-finance-add-deduction>增加科目</button>`;
        } else {
            body = `<div class="finance-form-grid">${select('party', resource === 'sales_invoice' ? '客户' : '供应商', resource === 'sales_invoice' ? opts.customers : opts.suppliers, doc.party, true)}${common}${input('dueDate', '到期日', doc.dueDate || doc.postingDate || today(), { type: 'date', required: true })}${select('currency', '账单原币', opts.currencies, doc.currency || opts.defaultCurrency || opts.companyCurrency, true)}${input('conversionRate', '原币 → 本位币汇率', doc.conversionRate || 1, { type: 'number', step: '0.000000001', min: '0.000000001', required: true })}${select('taxesTemplate', '原生税费模板', resource === 'sales_invoice' ? opts.salesTaxesTemplates || (opts.taxesTemplates || opts.taxTemplates || []).filter(template => !template.resource || template.resource === resource) : opts.purchaseTaxesTemplates || (opts.taxesTemplates || opts.taxTemplates || []).filter(template => !template.resource || template.resource === resource), doc.taxesTemplate, false, '不套用税费模板')}${select('debitTo', resource === 'sales_invoice' ? '应收科目（可自动选择）' : '应付科目（可自动选择）', opts.partyAccounts || opts.accounts, doc.debitTo || doc.creditTo, false, '采用往来方 / 公司默认科目')}</div><details class="finance-advanced"><summary>付款条款与高级会计设置</summary><div class="finance-form-grid">${select('paymentTermsTemplate', '分期 / 付款条款模板', opts.paymentTermsTemplates || opts.paymentTerms, doc.paymentTermsTemplate, false, '采用原生默认付款计划')}${select('invoiceCostCenter', '账单成本中心', opts.costCenters, doc.costCenter, false)}${resource === 'purchase_invoice' ? input('billNo', '供应商账单号', doc.billNo) + input('billDate', '供应商账单日期', doc.billDate, { type: 'date' }) : ''}</div><label class="finance-policy-note"><input type="checkbox" name="configureDiscount"> 设置本次额外折扣</label><div class="finance-form-grid">${input('discountAmount', '额外折扣金额 · 原币', doc.discountAmount || 0, { type: 'number', step: '0.01', min: 0 })}${input('additionalDiscountPercentage', '额外折扣百分比', doc.additionalDiscountPercentage || 0, { type: 'number', step: '0.01', min: 0 })}${select(
                'applyDiscountOn',
                '额外折扣基准',
                [
                    { name: 'Grand Total', label: '含税总额' },
                    { name: 'Net Total', label: '未税净额' }
                ],
                doc.applyDiscountOn || 'Grand Total'
            )}</div><label class="finance-policy-note"><input type="checkbox" name="allocateAdvances"> 按 ERPNext 原生规则分配可用预付款</label><p class="finance-report-note">税费、分期和折扣由 ERPNext 计算。修改原生默认值前请核对关联账单与预付款。</p></details><h4>商品明细</h4><div id="financeItems">${(doc.items?.length ? doc.items : [{}]).map(row => this.itemRow(row, resource, opts)).join('')}</div><button type="button" class="btn btn-secondary btn-sm" data-finance-add-item>增加商品</button>`;
        }
        body = `<div data-finance-modal class="finance-editor">${body}${input('remarks', '备注', doc.remarks)}<div class="finance-form-error" role="alert" hidden></div></div>`;
        this.openOperationForm(
            `${operation === 'save' ? '编辑' : '新建'}${resourceLabel(resource)}草稿`,
            body,
            form => ({
                operation,
                name: doc.name || undefined,
                expectedModified: source?.modified || doc.modified || undefined,
                ...(source
                    ? { source: { resource: source.resource, name: source.name, expectedModified: source.modified } }
                    : {}),
                values: this.editorValues(form, resource, opts, { existingDocument: operation === 'save' })
            }),
            resource,
            { document: source || doc, submitLabel: '保存草稿', readResource: source?.resource || resource }
        );
        const form = document.querySelector('[data-finance-form]');
        if (
            this.conflictDraft?.context === this.context &&
            this.conflictDraft.resource === resource &&
            this.conflictDraft.companyId === this.companyId() &&
            this.conflictDraft.name === (source?.name || doc.name || null)
        ) {
            form.insertAdjacentHTML('beforeend', this.draftReviewHtml(this.conflictDraft.values));
        }
        if (
            invoiceResources.includes(resource) &&
            (doc.items || []).some(
                row => row.salesOrder || row.deliveryNote || row.purchaseOrder || row.purchaseReceipt
            )
        ) {
            const add = form.querySelector('[data-finance-add-item]');
            add.disabled = true;
            add.textContent = '来源账单只调整已映射明细';
        }
        const bindRemove = () => {
            for (const button of form.querySelectorAll('[data-finance-remove-row]')) {
                button.onclick = () => button.closest('[data-finance-row]').remove();
            }
        };
        const bindItems = () => {
            for (const row of form.querySelectorAll('[data-finance-row="item"]')) {
                row.querySelector('[name="itemCode"]').onchange = () => {
                    const item = (opts.items || []).find(
                        item => optionKey(item) === row.querySelector('[name="itemCode"]').value
                    );
                    if (item?.uom || item?.stockUom) {
                        row.querySelector('[name="uom"]').value = item.uom || item.stockUom;
                    }
                };
            }
        };
        const bindReferences = () => {
            for (const row of form.querySelectorAll('[data-finance-row="reference"]')) {
                const reference = row.querySelector('[name="reference"]');
                reference.onchange = () => {
                    const source = (opts.sources || []).find(item =>
                        `${({ sales_invoice: 'Sales Invoice', purchase_invoice: 'Purchase Invoice', sales_order: 'Sales Order', purchase_order: 'Purchase Order' })[item.resource]}:${item.name}` === reference.value);
                    const term = row.querySelector('[name="paymentTerm"]');
                    term.innerHTML = options(source?.paymentSchedule?.map(item => ({ name: item.paymentTerm, label: `${item.paymentTerm} · ${String(item.dueDate || '').slice(0, 10)}` })) || [], '', '不指定付款期');
                    term.required = Boolean(source?.allocatePaymentBasedOnPaymentTerms);
                };
            }
        };
        form.querySelector('[data-finance-add-item]')?.addEventListener('click', () => {
            form.querySelector('#financeItems').insertAdjacentHTML('beforeend', this.itemRow({}, resource, opts));
            bindRemove();
            bindItems();
        });
        form.querySelector('[data-finance-add-reference]')?.addEventListener('click', () => {
            form.querySelector('#financeReferences').insertAdjacentHTML('beforeend', this.referenceRow({}, opts));
            bindRemove();
            bindReferences();
        });
        form.querySelector('[data-finance-add-deduction]')?.addEventListener('click', () => {
            form.querySelector('#financeDeductions').insertAdjacentHTML('beforeend', this.deductionRow({}, opts));
            bindRemove();
        });
        if (payment && !this.can('finance.payment_entry.deductions')) {
            const add = form.querySelector('[data-finance-add-deduction]');
            if (add) {
                add.disabled = true;
                add.title = '当前角色没有费用与核销差额权限';
            }
            form.querySelectorAll('[data-finance-row="deduction"] input, [data-finance-row="deduction"] select, [data-finance-row="deduction"] button')
                .forEach(element => { element.disabled = true; });
        }
        if (payment) {
            const update = () => {
                const from = (opts.accounts || []).find(account => optionKey(account) === field(form, 'paidFrom'));
                const to = (opts.accounts || []).find(account => optionKey(account) === field(form, 'paidTo'));
                form.querySelector('#financeAccountCurrencies').textContent =
                    `付款账户币种 ${from?.currency || from?.accountCurrency || '待选择'}；到账账户币种 ${to?.currency || to?.accountCurrency || '待选择'}。同币种原生收付款单的双端金额相同，请填写银行净收付金额；账单分配可填写客户实际付款总额，差额记手续费。手续费按本位币记账；账户币种与本位币一致时，例如银行净收 97、账单核销 100、手续费 3。不同币种分别填写双端金额及实际汇率。`;
            };
            const baseCurrency =
                this.state.companies?.find(company => company.id === this.companyId())?.settlementCurrency ||
                this.state.companies?.find(company => company.id === this.companyId())?.defaultCurrency;
            const accountChanged = (accountName, rateName) => {
                const account = (opts.accounts || []).find(account => optionKey(account) === field(form, accountName));
                const currency = account?.currency || account?.accountCurrency;
                form.elements.namedItem(rateName).value = currency && currency === baseCurrency ? '1' : '';
                update();
            };
            form.elements.namedItem('paidFrom').onchange = () => accountChanged('paidFrom', 'sourceExchangeRate');
            form.elements.namedItem('paidTo').onchange = () => accountChanged('paidTo', 'targetExchangeRate');
            form.elements.namedItem('partyType').onchange = () => {
                form.elements.namedItem('party').innerHTML = options(
                    field(form, 'partyType') === 'Supplier' ? opts.suppliers : opts.customers
                );
            };
            update();
        }
        bindRemove();
        bindItems();
        bindReferences();
    },

    itemRow(row, resource, editorOptions = null) {
        const opts = editorOptions || this.state.options || {};
        const account = resource === 'sales_invoice' ? 'incomeAccount' : 'expenseAccount';
        return `<div data-finance-row="item" class="finance-form-row"><input type="hidden" name="name" value="${h(row.name || '')}">${select('itemCode', '商品', opts.items, row.itemCode || row.item_code, true)}${input('qty', '数量', row.qty ?? 1, { type: 'number', step: '0.000001', required: true })}${input('uom', '单位', row.uom, { required: true })}${input('rate', '单价 · 原币', row.rate ?? '', { type: 'number', step: '0.000001', min: 0, required: true })}${select(account, resource === 'sales_invoice' ? '收入科目' : '费用科目', opts.accounts, row[account] || row[account === 'incomeAccount' ? 'income_account' : 'expense_account'], false, '商品 / 公司默认')}${select('costCenter', '成本中心', opts.costCenters, row.costCenter || row.cost_center)}<button type="button" class="btn btn-secondary btn-sm" data-finance-remove-row aria-label="移除此商品">移除</button></div>`;
    },
    referenceRow(row, editorOptions = null) {
        const sources = ((editorOptions || this.state.options)?.sources || []).filter(item =>
            ['sales_invoice', 'purchase_invoice', 'sales_order', 'purchase_order'].includes(item.resource)
        );
        const doctype = resource =>
            ({
                sales_invoice: 'Sales Invoice',
                purchase_invoice: 'Purchase Invoice',
                sales_order: 'Sales Order',
                purchase_order: 'Purchase Order'
            })[resource];
        const current = `${row.referenceDoctype || row.reference_doctype || ''}:${row.referenceName || row.reference_name || ''}`;
        const source = sources.find(item => `${doctype(item.resource)}:${item.name}` === current);
        const term = row.paymentTerm || row.payment_term || '';
        const terms = (source?.paymentSchedule || []).map(item => ({ name: item.paymentTerm, label: `${item.paymentTerm} · ${String(item.dueDate || '').slice(0, 10)}` }));
        if (term && !terms.some(item => item.name === term)) terms.push({ name: term });
        return `<div data-finance-row="reference" class="finance-form-row finance-reference-row">${select(
            'reference',
            '账单 / 订单',
            sources.map(item => ({ id: `${doctype(item.resource)}:${item.name}`, label: item.label || item.name })),
            current,
            true
        )}${select('paymentTerm', '付款期', terms, term, Boolean(source?.allocatePaymentBasedOnPaymentTerms), '不指定付款期')}${input('allocatedAmount', '本次分配金额 · 往来方账户币种', row.allocatedAmount ?? row.allocated_amount ?? '', { type: 'number', step: '0.01', required: true })}<button type="button" class="btn btn-secondary btn-sm" data-finance-remove-row aria-label="移除此分配">移除</button></div>`;
    },
    deductionRow(row, editorOptions = null) {
        const opts = editorOptions || this.state.options;
        return `<div data-finance-row="deduction" class="finance-form-row finance-deduction-row">${select('account', '手续费 / 汇差科目', opts?.accounts, row.account, true)}${select('costCenter', '成本中心', opts?.costCenters, row.costCenter || row.cost_center, true)}${input('amount', '金额 · 本位币', row.amount ?? '', { type: 'number', step: '0.01', required: true })}<button type="button" class="btn btn-secondary btn-sm" data-finance-remove-row aria-label="移除此科目">移除</button></div>`;
    },

    editorValues(form, resource, editorOptions = null, { existingDocument = false } = {}) {
        const opts = editorOptions || this.state.options;
        const values = { postingDate: field(form, 'postingDate'), remarks: field(form, 'remarks') };
        if (resource === 'payment_entry') {
            Object.assign(values, {
                paymentType: field(form, 'paymentType'),
                partyType: field(form, 'partyType'),
                party: field(form, 'party'),
                paidFrom: field(form, 'paidFrom'),
                paidTo: field(form, 'paidTo'),
                paidAmount: numeric(form, 'paidAmount'),
                receivedAmount: numeric(form, 'receivedAmount'),
                sourceExchangeRate: numeric(form, 'sourceExchangeRate'),
                targetExchangeRate: numeric(form, 'targetExchangeRate'),
                referenceNo: field(form, 'referenceNo'),
                referenceDate: field(form, 'referenceDate'),
                modeOfPayment: field(form, 'modeOfPayment'),
                references: [...form.querySelectorAll('[data-finance-row="reference"]')].map(row => {
                    const [referenceDoctype, ...name] = row.querySelector('[name="reference"]').value.split(':');
                    const paymentTerm = row.querySelector('[name="paymentTerm"]').value;
                    if (row.querySelector('[name="paymentTerm"]').required && !paymentTerm) throw new Error('分期账单需要选择本次付款期。');
                    return {
                        referenceDoctype,
                        referenceName: name.join(':'),
                        allocatedAmount: Number(row.querySelector('[name="allocatedAmount"]').value),
                        ...(paymentTerm ? { paymentTerm } : {})
                    };
                }),
                deductions: [...form.querySelectorAll('[data-finance-row="deduction"]')].map(row =>
                    Object.fromEntries(
                        ['account', 'costCenter', 'amount'].map(key => [
                            key,
                            key === 'amount'
                                ? Number(row.querySelector(`[name="${key}"]`).value)
                                : row.querySelector(`[name="${key}"]`).value
                        ])
                    )
                )
            });
            const from = (opts?.accounts || []).find(account => optionKey(account) === values.paidFrom);
            const to = (opts?.accounts || []).find(account => optionKey(account) === values.paidTo);
            const fromCurrency = from?.currency || from?.accountCurrency;
            const toCurrency = to?.currency || to?.accountCurrency;
            if (fromCurrency && fromCurrency === toCurrency && values.paidAmount !== values.receivedAmount) {
                throw new Error(
                    '同币种收付款单的付款额与到账额须一致，填写银行净额；账单分配填实际付款总额，差额填手续费科目。账户币种与本位币一致时，例如双端金额 97、核销 100、手续费 3；外币费用需按实际汇率折算为本位币。'
                );
            }
        } else {
            Object.assign(values, {
                party: field(form, 'party'),
                dueDate: field(form, 'dueDate'),
                currency: field(form, 'currency'),
                conversionRate: numeric(form, 'conversionRate'),
                taxesTemplate: field(form, 'taxesTemplate'),
                items: [...form.querySelectorAll('[data-finance-row="item"]')].map(row => {
                    const item = Object.fromEntries(
                        ['itemCode', 'qty', 'uom', 'rate'].map(key => [
                            key,
                            ['qty', 'rate'].includes(key)
                                ? Number(row.querySelector(`[name="${key}"]`).value)
                                : row.querySelector(`[name="${key}"]`).value
                        ])
                    );
                    const name = row.querySelector('[name="name"]').value;
                    if (name) item.name = name;
                    for (const key of [resource === 'sales_invoice' ? 'incomeAccount' : 'expenseAccount', 'costCenter']) {
                        const value = row.querySelector(`[name="${key}"]`).value;
                        if (value) item[key] = value;
                        else if (existingDocument) item[key] = null;
                    }
                    return item;
                })
            });
            const partyAccount = resource === 'sales_invoice' ? 'debitTo' : 'creditTo';
            if (field(form, 'debitTo')) values[partyAccount] = field(form, 'debitTo');
            else if (existingDocument) values[partyAccount] = null;
            if (field(form, 'paymentTermsTemplate')) values.paymentTermsTemplate = field(form, 'paymentTermsTemplate');
            if (field(form, 'invoiceCostCenter')) values.costCenter = field(form, 'invoiceCostCenter');
            else if (existingDocument) values.costCenter = null;
            if (resource === 'purchase_invoice') {
                if (field(form, 'billNo')) values.billNo = field(form, 'billNo');
                if (field(form, 'billDate')) values.billDate = field(form, 'billDate');
            }
            if (form.elements.namedItem('configureDiscount')?.checked) {
                values.discountAmount = numeric(form, 'discountAmount');
                values.additionalDiscountPercentage = numeric(form, 'additionalDiscountPercentage');
                values.applyDiscountOn = field(form, 'applyDiscountOn');
            }
            if (form.elements.namedItem('allocateAdvances')?.checked) values.allocateAdvances = true;
            if (!values.items.length) throw new Error('请至少填写一个商品明细。');
        }
        return values;
    },

    confirmOperation(operation, doc, resource, extra = {}) {
        const labels = {
            submit: '提交入账',
            cancel: '取消单据',
            amend: '修订单据',
            return: '创建退货 / 调整账单',
            payment_from_invoice: '创建收付款草稿'
        };
        const texts = {
            submit: '提交后将由 ERPNext 形成账务记录。请核对主体、原币、本位币、税费和到期日。',
            cancel: 'ERPNext 将检查已核销款项和关联单据，并按原生规则生成冲销。',
            amend: '保留原已取消单据，为它建立关联的新草稿。',
            return: '由 ERPNext 生成关联原账单的贷项 / 借项草稿；可在草稿中调整退货数量后提交。',
            payment_from_invoice: '按来源账单或订单生成原生收付款草稿，请核对付款、到账金额和银行账户后提交。'
        };
        this.openOperationForm(
            labels[operation],
            `<div data-finance-modal><h3>${h(doc.name)}</h3><p class="finance-report-note">${h(texts[operation])}</p><div class="finance-form-error" role="alert" hidden></div></div>`,
            () => ({
                operation,
                name: operation === 'payment_from_invoice' ? undefined : doc.name,
                expectedModified: doc.modified,
                ...extra
            }),
            resource,
            { document: doc, submitLabel: labels[operation] }
        );
    },

    openOperationForm(
        title,
        body,
        prepare,
        resource,
        { document: doc = null, submitLabel = '保存', readResource = resource } = {}
    ) {
        const id = `financeForm-${requestKey()}`;
        const context = this.context;
        const pending = {
            resource,
            companyId: this.companyId(),
            version: this.state.version,
            modified: doc?.modified,
            idempotencyKey: requestKey(),
            request: null,
            uncertain: false
        };
        this.pending = pending;
        App.showModal(
            title,
            `<form id="${h(id)}" data-finance-form>${body}<div class="finance-operation-message" role="status" hidden></div></form>`,
            {
                large: true,
                footer: `<button type="button" class="btn btn-secondary" data-finance-close>取消</button><button type="button" class="btn btn-secondary" data-finance-refresh-version hidden>读取最新版本并保留草稿</button><button type="submit" form="${h(id)}" class="btn btn-primary" data-finance-save>${h(submitLabel)}</button>`
            }
        );
        const form = document.getElementById(id);
        const button = document.querySelector('[data-finance-save]');
        const message = form.querySelector('.finance-operation-message');
        const refresh = document.querySelector('[data-finance-refresh-version]');
        document.querySelector('[data-finance-close]').onclick = () => {
            this.pending = null;
            App.closeModal();
        };
        const execute = async event => {
            event.preventDefault();
            if (pending.conflicted) return;
            if (context !== sessionFingerprint() || this.pending !== pending) {
                this.clear();
                toast('公司或账号已切换，财务草稿已清除。', 'warning');
                return;
            }
            button.disabled = true;
            message.hidden = true;
            try {
                const operation = pending.uncertain
                    ? clone(pending.request)
                    : {
                          companyId: pending.companyId,
                          resource,
                          expectedVersion: pending.version,
                          idempotencyKey: pending.idempotencyKey,
                          ...prepare(form)
                      };
                pending.request = clone(operation);
                const result = await api().financeOperation(operation);
                if (context !== sessionFingerprint()) {
                    this.clear();
                    return;
                }
                if (this.pending !== pending) {
                    toast('原生财务操作已完成，请重新读取数据核对。', 'success');
                    return;
                }
                this.pending = null;
                this.conflictDraft = null;
                App.closeModal();
                toast('原生财务单据已保存', 'success');
                await this.load();
                if (
                    result.document &&
                    documentResources.includes(resource) &&
                    this.can(`${capPrefix(resource)}.read`)
                ) {
                    this.showDocument(result.document, resource);
                }
            } catch (error) {
                if (context !== sessionFingerprint()) {
                    this.clear();
                    return;
                }
                if (this.pending !== pending) return;
                message.hidden = false;
                const conflict =
                    error.status === 409 ||
                    ['CONFLICT', 'VERSION_CONFLICT', 'STALE_VERSION', 'STALE_DOCUMENT'].includes(error.code);
                const uncertain =
                    error.code === 'NETWORK' ||
                    error.name === 'AbortError' ||
                    (!error.status && pending.request && error.code !== 'INVALID_RECORD') ||
                    Number(error.status) >= 500;
                if (conflict) {
                    pending.conflicted = true;
                    message.textContent = '单据或企业版本已变化。当前输入已保留，请读取最新版本，核对变化后再保存。';
                    refresh.hidden = false;
                    button.disabled = true;
                } else if (uncertain) {
                    pending.uncertain = true;
                    message.textContent =
                        '请求结果尚不确定。请保留此窗口；再次确认会使用同一请求标识和完全相同的内容，避免重复记账。';
                    for (const element of form.elements) element.disabled = true;
                    button.textContent = '使用同一请求确认结果';
                    button.disabled = false;
                } else {
                    pending.idempotencyKey = requestKey();
                    pending.request = null;
                    message.textContent = error.message || '保存失败，当前输入已保留。';
                    button.disabled = false;
                }
            }
        };
        form.onsubmit = execute;
        refresh.onclick = async () => {
            refresh.disabled = true;
            try {
                const draftRequest = prepare(form);
                const latest =
                    doc?.name && (documentResources.includes(readResource) || readResource === 'bank_transaction')
                        ? await api().financeDocument({
                              companyId: pending.companyId,
                              resource: readResource,
                              name: doc.name,
                              action: 'read'
                          })
                        : await api().financeState({ companyId: pending.companyId, resource });
                if (context !== sessionFingerprint()) {
                    this.clear();
                    return;
                }
                if (this.pending !== pending) return;
                this.conflictDraft = {
                    context,
                    resource,
                    companyId: pending.companyId,
                    name: draftRequest.name || draftRequest.source?.name || null,
                    values: clone(draftRequest.values || draftRequest)
                };
                message.innerHTML =
                    '<p>最新版本已读取，原草稿已保留。旧保存按钮保持关闭，请基于服务器最新内容重新编辑。</p>' +
                    this.draftReviewHtml(this.conflictDraft.values) +
                    (latest.document
                        ? '<h4>服务器最新单据 · 只读</h4>' + this.detailHtml(latest.document, readResource)
                        : '<p>请重新读取当前单据和可用分配记录。</p>') +
                    '<button type="button" class="btn btn-secondary" data-finance-reopen-latest>以最新版本重新编辑</button>';
                refresh.hidden = true;
                button.disabled = true;
                const reopen = message.querySelector('[data-finance-reopen-latest]');
                reopen.onclick = async () => {
                    this.pending = null;
                    this.state.version = latest.version;
                    if (
                        latest.document &&
                        draftRequest.operation === 'save' &&
                        Number(latest.document.docstatus) === 0
                    ) {
                        if (resource === 'bank_transaction') this.openBankTransaction(latest.document);
                        else this.openEditor(latest.document, resource, 'save');
                    } else if (latest.document && draftRequest.operation === 'payment_from_invoice') {
                        await this.openMappedPayment({ ...latest.document, resource: readResource });
                    } else if (latest.document) {
                        this.showDocument(latest.document, readResource);
                    } else {
                        App.closeModal();
                        await this.load();
                    }
                };
            } catch (error) {
                message.textContent = error.message || '最新版本读取失败，草稿仍保留。';
            }
            refresh.disabled = false;
        };
    },

    openUnreconciliation(doc) {
        if (!this.can('finance.reconciliation.unreconcile') || Number(doc.docstatus) !== 1) return;
        const invoices = [...new Map((doc.references || [])
            .filter(ref => ['Sales Invoice', 'Purchase Invoice'].includes(ref.referenceDoctype))
            .map(ref => [`${ref.referenceDoctype}:${ref.referenceName}`, {
                resource: ref.referenceDoctype === 'Sales Invoice' ? 'sales_invoice' : 'purchase_invoice',
                name: ref.referenceName, expectedModified: ref.referenceModified
            }])).values()];
        this.openOperationForm('解除发票核销',
            `<div data-finance-modal><h3>${h(doc.name)}</h3><p class="finance-report-note">付款凭证保留已提交状态。ERPNext 将解除此付款单与所选整张发票的核销关联；分期账单的所有付款期关联一起解除。银行流水匹配需在银行对账中单独处理。</p>${invoices.map((item, index) => `<label class="finance-allocation-row"><input type="checkbox" name="invoices" value="${index}" ${item.expectedModified ? '' : 'disabled'}><span>${h(item.name)}${item.expectedModified ? '' : ' · 请重新读取单据'}</span></label>`).join('')}<div class="finance-form-error" role="alert" hidden></div></div>`,
            form => {
                const selected = [...form.querySelectorAll('[name="invoices"]:checked')].map(element => invoices[Number(element.value)]);
                if (!selected.length) throw new Error('请选择需要解除核销的发票。');
                return { operation: 'unreconcile', name: doc.name, expectedModified: doc.modified, values: { invoices: selected } };
            }, 'reconciliation', { document: doc, readResource: 'payment_entry', submitLabel: '确认解除核销' });
    },

    openReconciliation() {
        if (!this.can('finance.reconciliation.write')) return;
        const payments = this.report?.payments || [];
        const invoices = this.report?.invoices || [];
        const paymentName = row => row.referenceName || row.reference_name || row.name;
        const invoiceName = row => row.invoiceNumber || row.invoice_number || row.name;
        this.openOperationForm(
            '分配预付款并核销',
            `<div data-finance-modal>${select(
                'payment',
                '预收 / 预付单据',
                payments.map((row, index) => ({
                    id: String(index),
                    label: `${paymentName(row)} · ${financeMoney(row.unallocatedAmount ?? row.unallocated_amount ?? row.amount, row.currency || this.report.currency)}`
                })),
                '',
                true
            )}<p class="finance-report-note">金额使用往来方应收 / 应付账户币种，不跨币种相加。每张账单和付款单的修改时间都参与并发检查。</p><div class="finance-allocation-list">${invoices.map((row, index) => `<label class="finance-allocation-row"><span>${h(invoiceName(row))}<small>未结清 ${h(financeMoney(row.outstandingAmount ?? row.outstanding_amount, row.currency || this.report.currency))}</small></span><input class="form-input" type="number" name="allocation-${index}" step="0.01" min="0" placeholder="核销金额" aria-label="${h(invoiceName(row))} 核销金额"></label>`).join('')}</div><div class="finance-form-error" role="alert" hidden></div></div>`,
            form => {
                const payment = payments[Number(field(form, 'payment'))];
                const allocations = invoices.flatMap((invoice, index) => {
                    const amount = numeric(form, `allocation-${index}`);
                    if (!amount) return [];
                    if (amount < 0 || amount > Number(invoice.outstandingAmount ?? invoice.outstanding_amount)) {
                        throw new Error('核销金额需大于零且不超过账单未结清金额。');
                    }
                    return [
                        {
                            referenceType: payment.referenceType || payment.reference_type || 'Payment Entry',
                            referenceName: paymentName(payment),
                            referenceRow: payment.referenceRow || payment.reference_row,
                            invoiceType:
                                invoice.invoiceType ||
                                invoice.invoice_type ||
                                (this.filters.partyType === 'Supplier' ? 'Purchase Invoice' : 'Sales Invoice'),
                            invoiceNumber: invoiceName(invoice),
                            allocatedAmount: amount,
                            paymentModified: payment.modified,
                            invoiceModified: invoice.modified
                        }
                    ];
                });
                if (!allocations.length) throw new Error('请至少填写一张账单的核销金额。');
                const allocated = allocations.reduce((sum, row) => sum + row.allocatedAmount, 0);
                if (allocated > Number(payment.unallocatedAmount ?? payment.unallocated_amount ?? payment.amount)) {
                    throw new Error('分配合计超过此付款单的可核销金额。');
                }
                return {
                    operation: 'reconcile',
                    values: { ...this.reportFilters(), partyType: this.filters.partyType || 'Customer', allocations }
                };
            },
            'reconciliation',
            { submitLabel: '确认核销' }
        );
    },

    async exportCurrent() {
        if (!this.can(`${capPrefix(this.tab)}.export`)) return;
        const context = this.context;
        const epoch = this.epoch;
        const resource = this.tab;
        const companyId = this.companyId();
        const filters = clone(this.filters);
        const reportFilters = this.reportFilters();
        try {
            if (documentResources.includes(resource)) {
                const documents = [];
                let version;
                for (let offset = 0; offset < 10000; offset += 100) {
                    const page = await api().financeState({
                        companyId,
                        resource,
                        ...filters,
                        action: 'export',
                        limit: 100,
                        offset
                    });
                    if (context !== sessionFingerprint() || epoch !== this.epoch) return;
                    if (version != null && page.version !== version) {
                        throw new Error('导出期间账务版本发生变化，请重新查询后再导出。');
                    }
                    version = page.version;
                    documents.push(...(page.documents || []));
                    const more =
                        page.pagination?.hasMore === true ||
                        Number(page.pagination?.total) > offset + (page.documents || []).length;
                    if (!more) {
                        this.downloadCsv(documents, null, resourceLabel(resource));
                        return;
                    }
                    if (!(page.documents || []).length) throw new Error('导出分页没有返回记录，请缩小筛选范围后重试。');
                }
                throw new Error('筛选范围超过 10,000 条，请按公司与日期分批导出。');
            }
            const result = await api().financeReport({
                companyId,
                report: resource,
                filters: reportFilters,
                action: 'export'
            });
            if (context !== sessionFingerprint() || epoch !== this.epoch) return;
            if (resource === 'bank_reconciliation') this.downloadCsv(result.transactions || [], null, '银行流水与对账');
            else this.downloadCsv(result.result || [], result.columns || [], resourceLabel(resource));
        } catch (error) {
            toast(error.message || '导出失败', 'error');
        }
    },
    async exportDocument(name, resource) {
        if (!this.can(`${capPrefix(resource)}.export`)) return;
        const context = this.context;
        const epoch = this.epoch;
        try {
            const result = await api().financeDocument({
                companyId: this.companyId(),
                resource,
                name,
                action: 'export'
            });
            if (context !== sessionFingerprint() || epoch !== this.epoch) return;
            const doc = result.document;
            if (resource === 'bank_transaction') {
                this.downloadCsv([doc], null, doc.name);
                return;
            }
            const rows = (resource === 'payment_entry' ? doc.references : doc.items) || [];
            this.downloadCsv(
                rows.map(row => ({ document: doc.name, companyId: doc.companyId, currency: doc.currency, ...row })),
                null,
                doc.name
            );
        } catch (error) {
            toast(error.message || '导出失败', 'error');
        }
    },
    downloadCsv(rows, columns, filename) {
        const keys = columns?.length
            ? columns.map(column => column.fieldname || column)
            : [...new Set(rows.flatMap(row => Object.keys(row)))].filter(key =>
                  rows.some(row => typeof row[key] !== 'object')
              );
        const cell = value => {
            const numericValue = typeof value === 'number' && Number.isFinite(value);
            const text = numericValue ? String(value) : String(value ?? '').replace(/^(\s*[=+@-])/, "'$1");
            return `"${text.replaceAll('"', '""')}"`;
        };
        const labels = columns?.length ? columns.map(column => column.label || column.fieldname || column) : keys;
        const csv =
            '\uFEFF' +
            [
                labels.map(cell).join(','),
                ...rows.map(row => keys.map((key, index) => cell(Array.isArray(row) ? row[index] : row[key])).join(','))
            ].join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${String(filename).replace(/[^\p{L}\p{N}_.-]/gu, '_')}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    },
    async printDocument(name, resource) {
        if (!this.can(`${capPrefix(resource)}.print`)) return;
        const context = this.context;
        const epoch = this.epoch;
        try {
            const result = await api().financeDocument({
                companyId: this.companyId(),
                resource,
                name,
                action: 'print'
            });
            if (context !== sessionFingerprint() || epoch !== this.epoch) return;
            this.printHtml(`${resourceLabel(resource)} · ${name}`, this.detailHtml(result.document, resource));
        } catch (error) {
            toast(error.message || '打印失败', 'error');
        }
    },
    async printReport() {
        if (!this.can(`${capPrefix(this.tab)}.print`)) return;
        const context = this.context;
        const epoch = this.epoch;
        try {
            const result = await api().financeReport({
                companyId: this.companyId(),
                report: this.tab,
                filters: this.reportFilters(),
                action: 'print'
            });
            if (context !== sessionFingerprint() || epoch !== this.epoch) return;
            this.printHtml(
                resourceLabel(this.tab),
                this.tab === 'bank_reconciliation' ? this.bankReconciliationView(result) : this.reportTable(result)
            );
        } catch (error) {
            toast(error.message || '打印失败', 'error');
        }
    },
    printHtml(title, body) {
        App.showModal(h(`打印预览 · ${title}`), `<div data-finance-modal class="finance-print-preview">${body}</div>`, {
            large: true,
            footer: '<button class="btn btn-secondary" data-finance-close>关闭</button><button class="btn btn-primary" data-finance-browser-print>打印</button>'
        });
        document.querySelector('[data-finance-close]').onclick = () => App.closeModal();
        document.querySelector('[data-finance-browser-print]').onclick = () => {
            document.body.classList.add('finance-printing');
            window.addEventListener('afterprint', () => document.body.classList.remove('finance-printing'), {
                once: true
            });
            window.print();
        };
    }
};

window.Finance = Finance;
