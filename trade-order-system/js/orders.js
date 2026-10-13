/**
 * 订单管理模块
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';
import { FormDrafts } from './form-drafts.js';
import { escapeHtml, toast, validate, installBusinessModalHooks, businessDraftScope } from './utils.js';
import { BusinessBackendPanel } from './erpnext-panel.js';
import {
    handleFileImport,
    processImportRows,
    validateOrderData,
    validateNativeProductionPlan,
    requiresOverseasPort,
    canWriteFinancials
} from './order-import.js';

const knownNumber = value => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value));
const formatOrderMoney = (value, currency) => (knownNumber(value) ? App.formatMoney(value, currency) : '—');
const formatOrderPercent = (value, digits) => (knownNumber(value) ? Number(value).toFixed(digits) + '%' : '—');
const formatOrderText = value => String(value ?? '').trim() || '—';
const ORDER_MONEY_FIELDS = [
    'factoryCostRMB',
    'factoryCostUSD',
    'freightCostUSD',
    'freightCostRMB',
    'insuranceCostUSD',
    'otherCostUSD',
    'otherCostRMB'
];
const FACTORY_DRAFT_FIELDS = {
    productType: 'productType',
    totalQuantity: 'quantity',
    totalAmount: 'amount',
    prepayment: 'prepayment',
    inspectionDate: 'inspectionDate',
    estimatedShipDate: 'shipDate'
};
const financialDraftField = name =>
    ORDER_MONEY_FIELDS.includes(name) ||
    ['paidAmountUSD', 'paymentStatus', 'factoryPaidRMB', 'factoryPaidStatus'].includes(name);
const editableDraftInput = input => input && !input.disabled && !input.readOnly && input.type !== 'hidden';
const orderMoneyFields = order =>
    typeof Exchange.getOrderMoneyFields === 'function'
        ? Exchange.getOrderMoneyFields(order)
        : {
              factoryCost: {
                  key: 'factoryCostRMB',
                  value: order.factoryCostRMB,
                  currency: Exchange.isDomestic(order.companyId) ? 'CNY' : 'USD'
              },
              freightCost: {
                  key: 'freightCostUSD',
                  value: order.freightCostUSD,
                  currency:
                      Exchange.isDomestic(order.companyId) &&
                      (order.profitPolicy ||
                          order.formulaVersion ||
                          DB.companies.find(company => company.id === order.companyId)?.profitPolicy) ===
                          'grandware-v40'
                          ? 'CNY'
                          : 'USD'
              },
              otherCost: {
                  key: 'otherCostUSD',
                  value: order.otherCostUSD,
                  currency:
                      Exchange.isDomestic(order.companyId) &&
                      (order.profitPolicy ||
                          order.formulaVersion ||
                          DB.companies.find(company => company.id === order.companyId)?.profitPolicy) ===
                          'grandware-v40'
                          ? 'CNY'
                          : 'USD'
              }
          };
const orderQuantitySummary = order => {
    const unknown = { value: '—', unit: '—', text: '—' };
    if (order.stage === 'native' && order.erpItems?.length) {
        if (!order.erpItems.every(line => knownNumber(line.quantity))) return unknown;
        const groups = new Map();
        for (const line of order.erpItems) {
            const unit = formatOrderText(line.uom);
            groups.set(unit, (groups.get(unit) || 0) + Number(line.quantity));
        }
        if (groups.size > 1) {
            const text = [...groups].map(([unit, quantity]) => `${quantity} ${unit}`).join(' / ');
            return { value: text, unit: '', text };
        }
        const [[unit, quantity]] = groups;
        return { value: String(quantity), unit, text: `${quantity} ${unit}` };
    }
    // Finance-redacted native records still expose public production quantities.
    // Legacy records retain their original unknown quantity rather than a sum.
    if (order.stage === 'native') {
        if (!order.factories?.length || !order.factories.every(factory => knownNumber(factory.totalQuantity))) {
            return unknown;
        }
        const quantity = order.factories.reduce((total, factory) => total + Number(factory.totalQuantity), 0);
        return { value: String(quantity), unit: '—', text: `${quantity} —` };
    }
    if (knownNumber(order.quantity)) {
        const unit = formatOrderText(order.unit);
        return { value: String(order.quantity), unit, text: `${order.quantity} ${unit}` };
    }
    return unknown;
};

const Orders = {
    currentFilter: { status: 'all', paymentStatus: 'all', shippingStatus: 'all', salespersonId: 'all', search: '' },
    selectedOrders: new Set(),

    salespersonName(order) {
        const id = order.salespersonId;
        const active = (Auth.users || []).find(user => String(user.id) === String(id));
        return (
            active?.name ||
            (typeof order.salesperson === 'string' ? order.salesperson.trim() : '') ||
            Auth.getRecordOwner?.(id)?.name ||
            (id !== undefined && id !== null && String(id) !== '' ? String(id) : '未记录')
        );
    },

    salespersonOptions(order = null) {
        const selectedId = order ? order.salespersonId : Auth.currentUser?.id;
        const users = Auth.users || [];
        const hasActive = users.some(user => String(user.id) === String(selectedId));
        const preserved =
            order && !hasActive
                ? `<option value="${App.escapeHtml(selectedId ?? '')}" data-historical-owner-preserve="true" selected>${App.escapeHtml(this.salespersonName(order))} · 历史负责人（已停用）</option>`
                : '';
        return (
            preserved +
            users
                .map(
                    user =>
                        `<option value="${App.escapeHtml(user.id)}" ${String(user.id) === String(selectedId) ? 'selected' : ''}>${App.escapeHtml(user.name)}</option>`
                )
                .join('')
        );
    },

    draftScope() {
        const actor = Auth.currentUser || {};
        const permissions = actor.permissions;
        return {
            ...businessDraftScope(DB, Auth),
            roleId: actor.roleId || '',
            dataScope: actor.scope || '',
            companyGrants: (actor.visibleCompanyIds || []).map(String).sort(),
            permissions: Array.isArray(permissions)
                ? [...permissions].sort()
                : Object.entries(permissions || {}).sort(([a], [b]) => a.localeCompare(b)),
            financialWrite: canWriteFinancials(),
            financialRead: Auth.canSeeFinancials?.() === true,
            edit: Auth.canEdit?.() !== false,
            companyCurrency: DB.getCurrentCompany()?.settlementCurrency || '',
            companyPolicy: DB.getCurrentCompany()?.profitPolicy || ''
        };
    },

    draftFactoryRows(form) {
        return [...form.querySelectorAll('#factoryCards .factory-card')].map(card => {
            const index = card.dataset.factoryIndex;
            const factoryId = card.querySelector(`[name="factory_${index}_id"]`)?.value || '';
            const row = {
                draftId: card.dataset.draftRowId,
                factoryId,
                factoryAvailable: DB.getFactories().some(factory => String(factory.id) === String(factoryId))
            };
            for (const [field, suffix] of Object.entries(FACTORY_DRAFT_FIELDS)) {
                const input = card.querySelector(`[name="factory_${index}_${suffix}"]`);
                if (editableDraftInput(input)) row[field] = input.value;
            }
            return row;
        });
    },

    sanitizeOrderDraft(form, value) {
        const allowed = Object.entries(FACTORY_DRAFT_FIELDS).filter(
            ([field, suffix]) =>
                editableDraftInput(form.querySelector(`#factoryCards [name$="_${suffix}"]`)) &&
                (!['totalAmount', 'prepayment'].includes(field) || canWriteFinancials())
        );
        return {
            access: value?.access || {},
            contact: {
                customerId: String(value?.contact?.customerId || ''),
                value: String(value?.contact?.value || ''),
                customerAvailable: value?.contact?.customerAvailable === true
            },
            factories: (Array.isArray(value?.factories) ? value.factories : []).map(row => ({
                draftId: String(row?.draftId || ''),
                factoryId: String(row?.factoryId || ''),
                factoryAvailable: row?.factoryAvailable === true,
                ...Object.fromEntries(
                    allowed
                        .filter(([field]) => Object.hasOwn(row || {}, field))
                        .map(([field]) => [field, String(row[field] ?? '')])
                )
            }))
        };
    },

    validateOrderDraft(form, value, base) {
        if (JSON.stringify(value.access) !== JSON.stringify(this.draftScope())) {
            return '订单编辑权限或公司设置已变化，请核对保留的草稿。';
        }
        const customerId = value.contact.customerId;
        const customer = DB.getCustomers().find(row => String(row.id) === customerId);
        const original = form.dataset.orderId ? DB.getOrder(form.dataset.orderId) : null;
        const preservedMissingCustomer =
            !base.contact.customerAvailable &&
            customerId === base.contact.customerId &&
            value.contact.value === base.contact.value;
        if (customerId && !customer && !preservedMissingCustomer) return '草稿关联的客户已不可用，请重新选择客户。';
        if (customer && value.contact.value) {
            const choices = document.createElement('select');
            choices.innerHTML = this.getContactOptions(
                customer,
                String(original?.customerId) === customerId ? original?.contactPerson || '' : '',
                String(original?.customerId) === customerId ? original?.contactId : undefined
            );
            if (![...choices.options].some(option => option.value === value.contact.value && !option.disabled)) {
                return '联系人名录已变化，请重新核对保留的联系人选择。';
            }
        }
        const identities = value.factories.map(row => row.draftId);
        if (identities.some(id => !id) || new Set(identities).size !== identities.length) {
            return '工厂行身份无法核实，请核对保留的生产安排。';
        }
        if (
            original?.stage === 'native' &&
            JSON.stringify(identities) !== JSON.stringify(base.factories.map(row => row.draftId))
        ) {
            return '正式订单工厂结构已变化，请重新打开生产计划。';
        }
        for (const row of value.factories) {
            const previous = base.factories.find(candidate => candidate.draftId === row.draftId);
            const available = DB.getFactories().some(factory => String(factory.id) === row.factoryId);
            if (
                row.factoryId &&
                !available &&
                !(previous && !previous.factoryAvailable && previous.factoryId === row.factoryId)
            ) {
                return '草稿关联的工厂已不可用，请重新选择工厂。';
            }
        }
        return '';
    },

    attachDraft(recordId = 'new') {
        const form = document.getElementById('orderForm');
        if (!form) return;
        const scope = this.draftScope();
        const mainFields = [
            ...new Set(
                [...form.elements]
                    .filter(
                        input =>
                            input.name &&
                            !input.name.startsWith('factory_') &&
                            (!financialDraftField(input.name) || canWriteFinancials())
                    )
                    .map(input => input.name)
            )
        ];
        const sourceFields = Object.entries(FACTORY_DRAFT_FIELDS)
            .filter(([, suffix]) => form.querySelector(`#factoryCards [name$="_${suffix}"]`))
            .filter(([field]) => !['totalAmount', 'prepayment'].includes(field) || canWriteFinancials())
            .map(([field]) => field);
        const openingCustomerId = form.elements.namedItem('customerId')?.value || '';
        const openingFactoryIds = this.draftFactoryRows(form)
            .map(row => row.factoryId)
            .filter(Boolean);
        FormDrafts.attach(form, {
            scope,
            getScope: () => this.draftScope(),
            recordId,
            allowField: input => !financialDraftField(input.name) || canWriteFinancials(),
            pendingExists: id =>
                DB.getOrders().some(
                    row =>
                        String(row.id) === String(id) &&
                        String(row.companyId) === String(scope.companyId) &&
                        !row.deleted
                ),
            getRecord: () => {
                const id = form.dataset.orderId || form.dataset.pendingRecordId;
                const row = id ? DB.getOrder(id) : null;
                return {
                    record: row
                        ? {
                              ...Object.fromEntries(mainFields.map(field => [field, String(row[field] ?? '')])),
                              contactId: form.elements.namedItem('contactPerson') ? String(row.contactId ?? '') : '',
                              companyId: row.companyId,
                              stage: row.stage,
                              formulaVersion: row.formulaVersion || '',
                              profitPolicy: row.profitPolicy || '',
                              historicalReference: row.historicalReference === true,
                              nativeSettlementProjection: row.nativeSettlementProjection === true,
                              deleted: row.deleted === true,
                              factories: (row.factories || []).map(factory => ({
                                  id: factory.id ?? null,
                                  factoryId: factory.factoryId,
                                  ...Object.fromEntries(
                                      sourceFields.map(field => [field, String(factory[field] ?? '')])
                                  )
                              }))
                          }
                        : null,
                    customerAvailable:
                        !openingCustomerId ||
                        DB.getCustomers().some(customer => String(customer.id) === String(openingCustomerId)),
                    factoriesAvailable: openingFactoryIds.map(id => [
                        id,
                        DB.getFactories().some(factory => String(factory.id) === String(id))
                    ])
                };
            },
            dynamic: {
                capture: () => ({
                    access: this.draftScope(),
                    contact: {
                        customerId: form.elements.namedItem('customerId')?.value || '',
                        value: form.elements.namedItem('contactPerson')?.value || '',
                        customerAvailable: DB.getCustomers().some(
                            customer => String(customer.id) === String(form.elements.namedItem('customerId')?.value)
                        )
                    },
                    factories: this.draftFactoryRows(form)
                }),
                sanitize: value => this.sanitizeOrderDraft(form, value),
                validate: (value, base) => this.validateOrderDraft(form, value, base),
                equal: (a, b) =>
                    JSON.stringify({ ...a, factories: a.factories.map(({ draftId, ...row }) => row) }) ===
                    JSON.stringify({ ...b, factories: b.factories.map(({ draftId, ...row }) => row) }),
                describe: value =>
                    [
                        value.contact.customerId
                            ? `客户联系人：${value.contact.value || '尚未选择'}（客户 ${value.contact.customerId}）`
                            : '',
                        ...value.factories.map(
                            (row, index) =>
                                `工厂 ${index + 1}：${DB.getFactory(row.factoryId)?.name || row.factoryId || '尚未选择'}\n${Object.entries(
                                    FACTORY_DRAFT_FIELDS
                                )
                                    .filter(([field]) => Object.hasOwn(row, field))
                                    .map(
                                        ([field]) =>
                                            `${{ productType: '产品类型', totalQuantity: '数量', totalAmount: '金额', prepayment: '预付款', inspectionDate: '验货日期', estimatedShipDate: '预计出货日期' }[field]}：${row[field]}`
                                    )
                                    .join('\n')}`
                        )
                    ]
                        .filter(Boolean)
                        .join('\n\n'),
                restore: value => {
                    const original = form.dataset.orderId ? DB.getOrder(form.dataset.orderId) : null;
                    const customerId = form.elements.namedItem('customerId')?.value;
                    const customer = DB.getCustomers().find(row => String(row.id) === String(customerId));
                    const contact = form.elements.namedItem('contactPerson');
                    if (contact) {
                        contact.innerHTML = this.getContactOptions(
                            customer,
                            String(original?.customerId) === String(customerId) ? original?.contactPerson || '' : '',
                            String(original?.customerId) === String(customerId) ? original?.contactId : undefined
                        );
                        contact.value = value.contact.value;
                    }
                    const container = form.querySelector('#factoryCards');
                    if (container) {
                        const currentRows = [...container.querySelectorAll('.factory-card')].map(card => ({
                            draftId: card.dataset.draftRowId,
                            factoryId: card.querySelector('[name$="_id"]')?.value || '',
                            ...Object.fromEntries(
                                Object.entries(FACTORY_DRAFT_FIELDS).map(([field, suffix]) => [
                                    field,
                                    card.querySelector(`[name$="_${suffix}"]`)?.value
                                ])
                            )
                        }));
                        container.innerHTML = value.factories
                            .map((row, index) => {
                                const current =
                                    currentRows.find(candidate => candidate.draftId === row.draftId) ||
                                    (String(original?.factories?.[index]?.factoryId) === row.factoryId
                                        ? original.factories[index]
                                        : {});
                                return this.createFactoryRow(index, { ...current, ...row, _draftId: row.draftId });
                            })
                            .join('');
                        this._factoryIndex = value.factories.length;
                        this._updateFactoryDeleteButtons();
                        if (original?.stage === 'native') this.lockNativeFactoryDraft(form);
                        else if (original?.stage !== 'legacy' && !original?.historicalReference) {
                            this.updateFactoryCost();
                        }
                    }
                    this.calcProfit();
                }
            }
        });
    },

    lockNativeFactoryDraft(form) {
        for (const input of form.querySelectorAll(
            '#factoryCards [name$="_id"], #factoryCards [name$="_quantity"], #factoryCards [name$="_amount"], #factoryCards [name$="_prepayment"], #factoryCards button'
        )) {
            input.disabled = true;
        }
        for (const input of form.querySelectorAll(
            '#factoryCards [name$="_productType"], #factoryCards [name$="_inspectionDate"], #factoryCards [name$="_shipDate"]'
        )) {
            input.required = false;
        }
    },

    render(container, param) {
        if (param) {
            this.renderDetail(container, param);
            return;
        }
        this.selectedOrders.clear();
        const showFinance = Auth.canSeeFinancials();
        container.innerHTML = `
            <div class="filter-bar">
                <input type="text" id="orderSearchInput" class="filter-input" placeholder="搜索订单号/客户名/产品..." style="width:260px" oninput="Orders.filter()">
                <select id="filterStatus" class="filter-select" onchange="Orders.filter()">
                    <option value="all">所有状态</option>
                    <option value="进行中">进行中</option>
                    <option value="已订船">已订船</option>
                    <option value="已取消">已取消</option>
                    <option value="推迟出货">推迟出货</option>
                </select>
                ${
                    showFinance
                        ? `<select id="filterPayment" class="filter-select" onchange="Orders.filter()">
                    <option value="all">所有收款状态</option>
                    <option value="已收款">已收款</option>
                    <option value="部分收款">部分收款</option>
                    <option value="未收款">未收款</option>
                </select>`
                        : ''
                }
                <select id="filterShipping" class="filter-select" onchange="Orders.filter()">
                    <option value="all">所有出运状态</option>
                    <option value="待出运">待出运</option>
                    <option value="已出运">已出运</option>
                    <option value="已到港">已到港</option>
                    <option value="已签收">已签收</option>
                </select>
                <select id="filterSalesperson" class="filter-select" onchange="Orders.filter()">
                    <option value="all">所有业务员</option>
                    ${(Auth.users || []).map(user => `<option value="${App.escapeHtml(user.id)}">${App.escapeHtml(user.name)}</option>`).join('')}
                </select>
                ${Auth.isManager() || Auth.isSalesperson() || Auth.isDocument() ? `<span class="filter-info">👤 当前查看：${Auth.isManager() ? '我团队的订单' : Auth.isDocument() ? '我团队及自己创建的订单' : '我的订单'}</span>` : ''}
                <div style="margin-left:auto;display:flex;gap:8px">
                    <button class="btn btn-secondary" onclick="Orders.exportExcel()">📥 导出Excel</button>
                    <button class="btn btn-secondary" onclick="Orders.importExcel()">📤 导入Excel</button>
                    <button class="btn btn-primary" onclick="Orders.showAddForm()">➕ 新建订单</button>
                </div>
            </div>
            <div id="orderBatchBar" class="batch-bar">
                <span>已选择 <span class="batch-count" id="batchCount">0</span> 笔订单</span>
                <button class="btn btn-sm btn-warning" onclick="Orders.batchUpdateStatus()">📝 批量改状态</button>
                <button class="btn btn-sm btn-danger" onclick="Orders.batchDelete()">🗑️ 批量删除</button>
                <button class="btn btn-sm btn-secondary" onclick="Orders.clearSelection()">取消选择</button>
            </div>
            <div class="card">
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th class="checkbox-col"><input type="checkbox" id="selectAllCheckbox" onchange="Orders.toggleSelectAll()" title="全选"></th>
                                <th>公司操作单号</th>
                                <th>客户订单号</th>
                                <th>客户</th>
                                <th>联系人</th>
                                <th>产品</th>
                                <th>下单日期</th>
                                <th>出运日期</th>
                                <th class="text-right">订单金额(USD)</th>
                                ${showFinance ? '<th class="text-right">工厂成本(结算币种)</th><th class="text-right">利润率</th>' : ''}
                                ${showFinance ? '<th>收款状态</th><th>工厂付款状态</th>' : ''}
                                <th>出运状态</th>
                                <th>订单状态</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="ordersTableBody"></tbody>
                    </table>
                </div>
            </div>
        `;
        this.renderTable();
    },

    filter() {
        this.currentFilter = {
            status: document.getElementById('filterStatus')?.value || 'all',
            paymentStatus: document.getElementById('filterPayment')?.value || 'all',
            shippingStatus: document.getElementById('filterShipping')?.value || 'all',
            salespersonId: document.getElementById('filterSalesperson')?.value || 'all',
            search: document.getElementById('orderSearchInput')?.value || ''
        };
        this.selectedOrders.clear();
        this.renderTable();
    },

    renderTable() {
        const orders = DB.getOrders(this.currentFilter);
        const tbody = document.getElementById('ordersTableBody');
        if (!tbody) return;
        const showFinance = Auth.canSeeFinancials();
        const colSpan = showFinance ? 16 : 12;

        // 同步全选 checkbox 状态
        const selectAll = document.getElementById('selectAllCheckbox');
        if (selectAll && orders.length > 0) {
            selectAll.checked = this.selectedOrders.size === orders.length;
            selectAll.indeterminate = this.selectedOrders.size > 0 && this.selectedOrders.size < orders.length;
        } else if (selectAll) {
            selectAll.checked = false;
            selectAll.indeterminate = false;
        }

        if (orders.length === 0) {
            tbody.innerHTML = `<tr><td colspan="${colSpan}" class="text-center text-gray" style="padding:40px">暂无匹配订单</td></tr>`;
            this.updateBatchBar();
            return;
        }

        tbody.innerHTML = orders
            .map(o => {
                const checked = this.selectedOrders.has(o.id) ? 'checked' : '';
                const isListHK = !Exchange.isDomestic(o.companyId);
                return `
            <tr>
                <td class="checkbox-col"><input type="checkbox" ${checked} onchange="Orders.toggleSelect('${App.escapeHtml(o.id)}')"></td>
                <td><span class="table-link" onclick="window.location.hash='#/orders/${App.escapeHtml(o.id)}'">${App.escapeHtml(o.companyOperationNo) || '-'}</span></td>
                <td class="text-sm">${App.escapeHtml(o.customerOrderNo) || '-'}</td>
                <td>${App.escapeHtml(o.customerName)}<div class="text-xs text-gray">负责人：${App.escapeHtml(this.salespersonName(o))}</div></td>
                <td>${App.escapeHtml(o.contactPerson) || '-'}</td>
                <td class="text-sm">${App.escapeHtml(o.productName)}</td>
                <td>${App.formatDate(o.orderDate)}</td>
                <td>${o.actualShipDate ? App.formatDate(o.actualShipDate) : '<span class="text-gray">' + App.formatDate(o.expectedShipDate) + '</span>'}</td>
                <td class="text-right font-semi">${formatOrderMoney(o.orderAmountUSD, 'USD')}</td>
                ${
                    showFinance
                        ? `
                <td class="text-right">${formatOrderMoney(orderMoneyFields(o).factoryCost.value, isListHK ? 'USD' : 'CNY')}</td>
                <td class="text-right ${App.getProfitColor(o.profitRate)} font-semi">${formatOrderPercent(o.profitRate, 1)}</td>`
                        : ''
                }
                ${showFinance ? `<td>${App.getPaymentBadge(o.paymentStatus)}</td><td>${App.getFactoryPaidBadge(o.factoryPaidStatus)}</td>` : ''}
                <td>${App.getShippingBadge(o.shippingStatus)}</td>
                <td>${App.getStatusBadge(o.status)}</td>
                <td>
                    <div class="flex gap-2">
                        <button class="btn btn-sm btn-secondary" onclick="window.location.hash='#/orders/${App.escapeHtml(o.id)}'">详情</button>
                        <button class="btn btn-sm btn-secondary" onclick="Orders.showEditForm('${App.escapeHtml(o.id)}')">编辑</button>
                    </div>
                </td>
            </tr>
            `;
            })
            .join('');

        this.updateBatchBar();
    },

    // ==================== 订单详情 ====================
    renderDetail(container, orderId) {
        const order = DB.getOrder(orderId);
        if (!order) {
            container.innerHTML =
                '<div class="card"><div class="card-body text-center text-gray">订单不存在</div></div>';
            return;
        }
        // 权限检查
        if (!Auth.canViewOrder(orderId, DB.data.orders)) {
            container.innerHTML =
                '<div class="card"><div class="card-body text-center text-gray">无权限查看此订单</div></div>';
            return;
        }
        const customer = DB.getCustomer(order.customerId);
        const factoryDataList =
            order.factories && order.factories.length > 0
                ? order.factories
                : [
                      {
                          factoryId: order.factoryId,
                          factoryName: order.factoryName || '',
                          productType: order.productCategory,
                          totalQuantity: order.quantity,
                          totalAmount: orderMoneyFields(order).factoryCost.value,
                          prepayment: order.stage === 'legacy' ? order.factoryPaidRMB : order.factoryPaidRMB || 0,
                          inspectionDate: '',
                          estimatedShipDate: order.expectedShipDate
                      }
                  ];
        const factoryIds = factoryDataList.map(f => f.factoryId).filter(Boolean);
        const factoryDisplay =
            factoryDataList
                .map(f => f.factoryName)
                .filter(Boolean)
                .join('、') ||
            order.factoryName ||
            '-';
        const shipment = DB.getShipmentByOrder(orderId);
        const docs = DB.getInvoicesByOrder(orderId);
        const showFinance = Auth.canSeeFinancials();
        const quantity = orderQuantitySummary(order);
        const canDel = Auth.canDeleteOrder(order) && order.stage !== 'native';
        const isDomestic = Exchange.isDomestic(order.companyId);
        const isHK = !Exchange.isDomestic(order.companyId);
        const financials = Exchange.getOrderFinancials(order);
        const money = orderMoneyFields(order);
        const legacyRmbFees = financials.policy === 'grandware-v40';
        const detailFinanceTitle = isDomestic ? '订单信息' : '财务明细';

        document.getElementById('pageTitle').textContent = '订单详情 - ' + (order.companyOperationNo || orderId);

        container.innerHTML = `
            <div class="flex gap-3 mb-4">
                <button class="btn btn-secondary" onclick="window.location.hash='#/orders'">← 返回列表</button>
                <button class="btn btn-primary" onclick="Orders.showEditForm('${App.escapeHtml(order.id)}')">✏️ 编辑订单</button>
                ${!shipment && Auth.canEdit() ? `<button class="btn btn-secondary" onclick="Orders.createShipment('${App.escapeHtml(order.id)}')">🚢 建立出运记录</button>` : ''}
                ${canWriteFinancials() && order.stage !== 'legacy' ? `<button class="btn btn-secondary" onclick="Orders.updatePayment('${App.escapeHtml(order.id)}')">${order.stage === 'native' ? '登记实际收款' : order.stage === 'brief' ? '收款说明' : '💰 更新付款'}</button>` : ''}
                ${canDel ? `<div style="margin-left:auto"><button class="btn btn-danger" onclick="Orders.deleteOrder('${App.escapeHtml(order.id)}')">🗑️ 删除订单</button></div>` : ''}
            </div>

            ${order.stage ? `<div class="card mb-6"><div class="card-body"><p>${order.stage === 'legacy' ? '历史参考 · 保留原始 Excel 记录与余额，不作为实际收款单据。' : order.stage === 'native' ? '正式订单 · 金额、采购和收款由业务单据维护。' : '待完善订单 · 可先安排生产，真实商品明细完善后建立正式订单。'}</p>${canWriteFinancials() && order.stage === 'brief' ? `<button class="btn btn-secondary btn-sm" onclick="Orders.editBusinessItems('${App.escapeHtml(order.id)}')">商品明细</button> <button class="btn btn-secondary btn-sm" onclick="Orders.confirmBusinessOrder('${App.escapeHtml(order.id)}', 'convert')">建立正式订单</button>` : ''}${canWriteFinancials() && order.stage === 'native' && (order.nativeDocuments || []).some(doc => doc.doctype === 'Sales Order' && Number(doc.docstatus) === 0) ? `<button class="btn btn-secondary btn-sm" onclick="Orders.confirmBusinessOrder('${App.escapeHtml(order.id)}', 'submit')">提交订单</button>` : ''}${canWriteFinancials() && order.stage === 'native' && (order.nativeDocuments || []).some(doc => doc.doctype === 'Sales Order' && Number(doc.docstatus) === 1) ? `<button class="btn btn-secondary btn-sm" onclick="Orders.confirmBusinessOrder('${App.escapeHtml(order.id)}', 'cancel')">撤销正式订单</button>` : ''}</div></div>` : ''}

            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon blue">💵</div></div>
                    <div class="stat-label">订单金额</div>
                    <div class="stat-value">${formatOrderMoney(order.orderAmountUSD, 'USD')}</div>
                    ${isHK ? '' : `<div class="stat-sub">≈ ${formatOrderMoney(order.orderAmountRMB, 'CNY')}</div>`}
                </div>
                ${
                    showFinance
                        ? `
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon orange">🏭</div></div>
                    <div class="stat-label">工厂成本</div>
                    <div class="stat-value">${formatOrderMoney(money.factoryCost.value, isHK ? 'USD' : 'CNY')}</div>
                    <div class="stat-sub">付款：${App.escapeHtml(order.factoryPaidStatus)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon green">📈</div></div>
                    <div class="stat-label">利润</div>
                    <div class="stat-value ${App.getProfitColor(order.profitRate)}">${formatOrderMoney(order.profitRMB, isHK ? 'USD' : 'CNY')}</div>
                    <div class="stat-sub">利润率 ${formatOrderPercent(order.profitRate, 2)}</div>
                </div>`
                        : `
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon orange">📦</div></div>
                    <div class="stat-label">产品数量</div>
                    <div class="stat-value">${App.escapeHtml(quantity.value)}</div>
                    <div class="stat-sub">${App.escapeHtml(quantity.unit)}</div>
                </div>`
                }
                ${
                    showFinance
                        ? `<div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon red">💳</div></div>
                    <div class="stat-label">${order.nativeSettlementProjection === true ? '预收及已核销进度' : '收款进度'}</div>
                    <div class="stat-value">${formatOrderMoney(order.paidAmountUSD, 'USD')}</div>
                    <div class="stat-sub">${App.escapeHtml(order.paymentStatus)} / 共 ${formatOrderMoney(order.orderAmountUSD, 'USD')}</div>
                </div>`
                        : ''
                }
            </div>

            <div class="card mb-6">
                <div class="card-header"><span class="card-title">基本信息</span></div>
                <div class="card-body">
                    <div class="detail-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                        <div class="detail-item"><div class="detail-label">公司操作单号</div><div class="detail-value">${App.escapeHtml(order.companyOperationNo || order.id)}</div></div>
                        <div class="detail-item"><div class="detail-label">客户订单号</div><div class="detail-value">${App.escapeHtml(order.customerOrderNo) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">订单状态</div><div class="detail-value">${App.getStatusBadge(order.status)}</div></div>
                        <div class="detail-item"><div class="detail-label">业务员</div><div class="detail-value">${App.escapeHtml(this.salespersonName(order))}</div></div>
                        <div class="detail-item"><div class="detail-label">客户</div><div class="detail-value">${App.escapeHtml(order.customerName)}</div></div>
                        <div class="detail-item"><div class="detail-label">客户联系人</div><div class="detail-value">${App.escapeHtml(order.contactPerson) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">工厂</div><div class="detail-value">${App.escapeHtml(factoryDisplay)}</div></div>
                        <div class="detail-item"><div class="detail-label">产品名称</div><div class="detail-value">${App.escapeHtml(formatOrderText(order.productName))}</div></div>
                        <div class="detail-item"><div class="detail-label">产品类别</div><div class="detail-value">${App.escapeHtml(formatOrderText(order.productCategory))}</div></div>
                        <div class="detail-item"><div class="detail-label">数量</div><div class="detail-value">${App.escapeHtml(quantity.text)}</div></div>
                        <div class="detail-item"><div class="detail-label">下单日期</div><div class="detail-value">${App.formatDate(order.orderDate)}</div></div>
                        <div class="detail-item"><div class="detail-label">预计出运</div><div class="detail-value">${App.formatDate(order.expectedShipDate)}</div></div>
                        <div class="detail-item"><div class="detail-label">实际出运</div><div class="detail-value">${order.actualShipDate ? App.formatDate(order.actualShipDate) : '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">起运港</div><div class="detail-value">${App.escapeHtml(order.loadingPort)}</div></div>
                        ${order.overseasPort ? `<div class="detail-item"><div class="detail-label">海外港口</div><div class="detail-value">${App.escapeHtml(order.overseasPort)}</div></div>` : ''}
                        <div class="detail-item"><div class="detail-label">付款条件</div><div class="detail-value">${App.escapeHtml(order.paymentTerms)}</div></div>
                        <div class="detail-item"><div class="detail-label">备注</div><div class="detail-value">${App.escapeHtml(order.remarks) || '无'}</div></div>
                    </div>
                </div>
            </div>

            <div class="card mb-6">
                <div class="card-header"><span class="card-title">🏭 工厂信息</span></div>
                <div class="card-body">
                    ${factoryDataList
                        .map(
                            (f, idx) => `
                    <div class="factory-detail-card" style="background:var(--gray-50);border:1px solid var(--gray-200);border-radius:8px;padding:12px 14px;margin-bottom:10px">
                        <div style="font-weight:600;color:var(--primary);margin-bottom:8px;font-size:13px">工厂 ${idx + 1}：${App.escapeHtml(f.factoryName) || '-'}</div>
                        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 16px;font-size:12px">
                            <div><span class="text-gray">产品类型：</span>${App.escapeHtml(formatOrderText(f.productType))}</div>
                            <div><span class="text-gray">总数量：</span>${knownNumber(f.totalQuantity) ? App.escapeHtml(f.totalQuantity) : '—'}</div>
                            ${
                                showFinance
                                    ? `<div><span class="text-gray">总金额：</span>${formatOrderMoney(order.stage === 'legacy' ? f.totalAmount : f.totalAmount || 0, isHK ? 'USD' : 'CNY')}</div>
                            <div><span class="text-gray">${order.nativeSettlementProjection === true ? '预付及已核销：' : '预付款：'}</span>${formatOrderMoney(order.stage === 'legacy' ? f.prepayment : f.prepayment || 0, isHK ? 'USD' : 'CNY')}</div>`
                                    : ''
                            }
                            <div><span class="text-gray">预计验货：</span>${f.inspectionDate ? App.formatDate(f.inspectionDate) : '-'}</div>
                            <div><span class="text-gray">预计出货：</span>${f.estimatedShipDate ? App.formatDate(f.estimatedShipDate) : '-'}</div>
                        </div>
                    </div>
                    `
                        )
                        .join('')}
                </div>
            </div>

            ${
                showFinance
                    ? `
            <div class="card mb-6">
                <div class="card-header"><span class="card-title">${detailFinanceTitle}</span></div>
                <div class="card-body">
                    <table>
                        <tbody>
                            <tr><td>订单总金额 (USD)</td><td class="text-right font-bold">${formatOrderMoney(order.orderAmountUSD, 'USD')}</td></tr>
                            ${isHK ? '' : `<tr><td>订单总金额 (RMB)</td><td class="text-right">${formatOrderMoney(order.orderAmountRMB, 'CNY')}</td></tr>`}
                            <tr><td>工厂成本 (${isHK ? 'USD' : 'RMB'})</td><td class="text-right text-danger">${formatOrderMoney(money.factoryCost.value, money.factoryCost.currency)}</td></tr>
                            ${
                                isHK
                                    ? ''
                                    : `
                            <tr><td>${legacyRmbFees ? '货代费' : '运费'} (${money.freightCost.currency === 'CNY' ? 'RMB' : 'USD'})</td><td class="text-right text-danger">${formatOrderMoney(money.freightCost.value, money.freightCost.currency)}</td></tr>
                            <tr><td>${legacyRmbFees ? '退税率 (%)' : '保险费 (USD)'}</td><td class="text-right text-danger">${legacyRmbFees ? Number(order.insuranceCostUSD || 0).toFixed(2) + '%' : formatOrderMoney(order.insuranceCostUSD, 'USD')}</td></tr>`
                            }
                            <tr><td>其他费用 (${money.otherCost.currency === 'CNY' ? 'RMB' : 'USD'})</td><td class="text-right text-danger">${formatOrderMoney(money.otherCost.value, money.otherCost.currency)}</td></tr>
                            <tr style="border-top:2px solid var(--gray-300)"><td class="font-bold">利润 (${isHK ? 'USD' : 'RMB'})</td><td class="text-right font-bold ${App.getProfitColor(order.profitRate)}">${formatOrderMoney(order.profitRMB, isHK ? 'USD' : 'CNY')}</td></tr>
                            <tr><td class="text-gray">利润率</td><td class="text-right font-bold ${App.getProfitColor(order.profitRate)}">${formatOrderPercent(order.profitRate, 2)}</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>`
                    : ''
            }

            ${showFinance && order.nativeSettlementProjection === true ? this.renderNativeReceipts(order) : ''}

            ${
                shipment
                    ? `
            <div class="card mb-6">
                <div class="card-header">
                    <span class="card-title">出运信息</span>
                    <a href="#/shipping" class="btn btn-sm btn-secondary">查看物流</a>
                </div>
                <div class="card-body">
                    <div class="detail-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                        <div class="detail-item"><div class="detail-label">报关状态</div><div class="detail-value">${App.getCustomsBadge(shipment.customsStatus)}</div></div>
                        <div class="detail-item"><div class="detail-label">ETD (预计出运)</div><div class="detail-value">${App.formatDate(shipment.etd)}</div></div>
                        <div class="detail-item"><div class="detail-label">毛重 (kg)</div><div class="detail-value">${Number(shipment.grossWeight || 0).toLocaleString()}</div></div>
                        <div class="detail-item"><div class="detail-label">体积 (CBM)</div><div class="detail-value">${shipment.volume}</div></div>
                    </div>
                </div>
            </div>`
                    : ''
            }

            ${'' /* 单证管理模块已移除 */}
        `;
    },

    renderNativeReceipts(order) {
        if (
            Auth.hasCapability?.('finance.payment_entry.read') !== true ||
            Auth.hasCapability?.('finance.bank_accounts.read') !== true
        ) {
            return '';
        }
        const rows = Array.isArray(order.nativeReceiptSummary) ? order.nativeReceiptSummary : [];
        const receipts = [...new Map(rows.filter(row => row && row.name).map(row => [String(row.name), row])).values()];
        if (!receipts.length) return '';
        return `<div class="card mb-6"><div class="card-header"><span class="card-title">银行实际收付 · 共享凭证</span></div><div class="card-body"><p class="text-sm text-gray">以下金额属于整张收付款凭证，可能覆盖多个订单；与本订单的预收及已核销金额分别列示，不按订单累加银行金额。</p><table><thead><tr><th>凭证</th><th>日期</th><th>方向</th><th class="text-right">银行净额</th></tr></thead><tbody>${receipts.map(row => `<tr data-native-receipt-name="${App.escapeHtml(row.name)}"><td>${App.escapeHtml(row.name)}</td><td>${App.formatDate(row.postingDate)}</td><td>${App.escapeHtml({ Receive: '收款', Pay: '付款', 'Internal Transfer': '内部转账' }[row.paymentType] || row.paymentType || '—')}</td><td class="text-right">${formatOrderMoney(row.bankAmount, row.bankCurrency)}</td></tr>`).join('')}</tbody></table></div></div>`;
    },

    async createShipment(orderId) {
        const { Shipping } = await import('./shipping.js');
        window.Shipping = Shipping;
        Shipping.showAddForm(orderId);
    },

    // ==================== 新建/编辑订单 ====================
    showAddForm() {
        const pendingId = FormDrafts.pendingFor('orderForm', { scope: this.draftScope(), recordId: 'new' });
        const pending = pendingId
            ? DB.getOrders().find(
                  row =>
                      String(row.id) === String(pendingId) &&
                      String(row.companyId) === String(DB.currentCompanyId) &&
                      !row.deleted
              )
            : null;
        if (pending) return this.showEditForm(pending.id, { draftRecordId: 'new', pendingRecordId: pending.id });
        const previousEditor = {
            _factoryIndex: this._factoryIndex,
            _editingOrder: this._editingOrder,
            _isHK: this._isHK
        };
        this._factoryIndex = 1;
        this._editingOrder = false;
        const customers = DB.getCustomers();
        const factories = DB.getFactories();
        const localToday = new Date();
        const today = [
            localToday.getFullYear(),
            String(localToday.getMonth() + 1).padStart(2, '0'),
            String(localToday.getDate()).padStart(2, '0')
        ].join('-');
        const showFinance = canWriteFinancials();
        const showSalesSelect = Auth.canSeeAll();
        const isDomestic = Exchange.isDomestic(DB.currentCompanyId);
        const isHK = !Exchange.isDomestic(DB.currentCompanyId);
        this._isHK = isHK; // 供工厂卡片使用
        const financeTitle = isDomestic ? '💰 订单信息' : '💰 财务信息 (USD)';
        const factoryCostLabel = isHK ? '工厂成本 (USD)' : '工厂成本 (RMB)';
        const legacyRmbFees = DB.getCurrentCompany()?.profitPolicy === 'grandware-v40';
        const otherLabel = isDomestic && legacyRmbFees ? '其他费用 (RMB)' : '其他费用 (USD)';
        const profitLabel = isHK ? '预计利润 (USD)' : '预计利润 (RMB)';
        const freightLabel = isDomestic ? (legacyRmbFees ? '货代费 (RMB)' : '运费 (USD)') : '';
        const insuranceLabel = isDomestic ? (legacyRmbFees ? '退税率 (%)' : '保险费 (USD)') : '';
        const opNoPreview = DB.generateCompanyOperationNo(DB.currentCompanyId, Auth.currentUser?.id || 'U005');

        const bodyHtml = `
            <form id="orderForm" data-company-id="${App.escapeHtml(DB.currentCompanyId)}" data-operation-no-preview="${App.escapeHtml(opNoPreview)}" onsubmit="Orders.saveOrder(event); return false;">
                ${
                    showSalesSelect
                        ? `
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">业务员 <span class="required">*</span></label>
                        <select class="form-select" name="salespersonId" required>
                            ${this.salespersonOptions()}
                        </select>
                    </div>
                </div>`
                        : `<input type="hidden" name="salespersonId" value="${App.escapeHtml(Auth.currentUser?.id ?? '')}">`
                }
                <div class="form-group">
                    <label class="form-label">客户 <span class="required">*</span></label>
                    <select class="form-select" name="customerId" required onchange="Orders.onCustomerChange(this)">
                        <option value="">请选择客户</option>
                        ${customers.map(c => `<option value="${App.escapeHtml(c.id)}" data-payment="${App.escapeHtml(c.paymentTerms)}">${App.escapeHtml(c.company)} (${App.escapeHtml(c.country)})</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">客户联系人 <span class="required">*</span></label>
                    <select class="form-select" name="contactPerson" required id="orderContactSelect" data-draft-dynamic>
                        <option value="">请先选择客户</option>
                    </select>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">客户订单号 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="customerOrderNo" required placeholder="PO-2026-0001">
                    </div>
                    <div class="form-group">
                        <label class="form-label">下单日期 <span class="required">*</span></label>
                        <input type="date" class="form-input" name="orderDate" required value="${today}">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">起运港 <span class="required">*</span></label>
                        <select class="form-select" name="loadingPort" required>
                            <option value="上海港">上海港</option>
                            <option value="深圳港">深圳港</option>
                            <option value="宁波港">宁波港</option>
                            <option value="广州港">广州港</option>
                            <option value="青岛港">青岛港</option>
                            <option value="厦门港">厦门港</option>
                        </select>
                    </div>
                    ${
                        requiresOverseasPort(DB.getCurrentCompany())
                            ? `
                    <div class="form-group">
                        <label class="form-label">海外港口 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="overseasPort" required placeholder="例：Los Angeles / Hamburg / Dubai">
                    </div>`
                            : ''
                    }
                </div>
                <hr style="border:none;border-top:1px solid var(--gray-200);margin:16px 0">
                ${
                    showFinance
                        ? `
                <h3 class="font-semi mb-3">${financeTitle}</h3>
                <div class="form-row-3">
                    <div class="form-group">
                        <label class="form-label">订单金额 (USD) <span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input" name="orderAmountUSD" required placeholder="0.00" oninput="Orders.calcProfit()">
                    </div>
                    <div class="form-group">
                        <label class="form-label">${factoryCostLabel} <span class="text-xs text-gray" style="font-weight:400">自动计算</span></label>
                        <input type="number" step="0.01" class="form-input" name="factoryCostRMB" value="0" readonly style="background:var(--gray-100);color:var(--gray-600)">
                    </div>
                    ${
                        isHK
                            ? ''
                            : `
                    <div class="form-group">
                        <label class="form-label">${freightLabel} <span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input" name="freightCostUSD" value="0" required oninput="Orders.calcProfit()">
                    </div>`
                    }
                </div>
                <div class="form-row-3">
                    ${
                        isHK
                            ? ''
                            : `
                    <div class="form-group">
                        <label class="form-label">${insuranceLabel} <span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input" name="insuranceCostUSD" value="0" required oninput="Orders.calcProfit()">
                    </div>`
                    }
                    <div class="form-group">
                        <label class="form-label">${otherLabel} <span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input" name="otherCostUSD" value="0" required oninput="Orders.calcProfit()">
                    </div>
                    <div class="form-group">
                        <label class="form-label">${profitLabel}</label>
                        <input type="text" class="form-input" id="calcProfit" readonly style="font-weight:600;color:var(--success)">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">公司操作单号 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="companyOperationNo" placeholder="${App.escapeHtml(DB.getCurrentCompany()?.orderPrefix || 'OP')}${String(new Date().getFullYear()).slice(2)}A001（留空自动生成）" value="${App.escapeHtml(opNoPreview)}">
                    </div>
                </div>
`
                        : `
                <h3 class="font-semi mb-3">💰 金额信息</h3>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">订单金额 (USD) <span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input" name="orderAmountUSD" required placeholder="0.00">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">公司操作单号 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="companyOperationNo" placeholder="${App.escapeHtml(DB.getCurrentCompany()?.orderPrefix || 'OP')}${String(new Date().getFullYear()).slice(2)}A001（留空自动生成）" value="${App.escapeHtml(opNoPreview)}">
                    </div>
                </div>`
                }
                <hr style="border:none;border-top:1px solid var(--gray-200);margin:16px 0">
                <div class="form-section-header">
                    <h3 class="font-semi mb-1">🏭 工厂信息</h3>
                    <span class="text-xs text-gray">填写每个工厂的详细生产信息</span>
                </div>
                <div id="factoryCards" data-draft-dynamic>
                    ${this.createFactoryRow(0)}
                </div>
                <button type="button" class="btn btn-sm btn-secondary" onclick="Orders.addFactoryRow()" style="margin-top:8px">＋ 添加工厂</button>
                <input type="hidden" name="expectedShipDate" value="">
                ${
                    showFinance
                        ? `
                <hr style="border:none;border-top:1px solid var(--gray-200);margin:16px 0">
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">收款状态 <span class="required">*</span></label>
                        <select class="form-select" name="paymentStatus" required>
                            <option value="未收款">未收款</option>
                            <option value="部分收款">部分收款</option>
                            <option value="已收款">已收款</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">已收款 (USD) <span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input" name="paidAmountUSD" value="0" required>
                    </div>
                </div>`
                        : ''
                }
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">订单状态 <span class="required">*</span></label>
                        <select class="form-select" name="status" required>
                            <option value="进行中">进行中</option>
                            <option value="已订船">已订船</option>
                            <option value="已取消">已取消</option>
                            <option value="推迟出货">推迟出货</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">付款条件 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="paymentTerms" required placeholder="选择客户后自动填充">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">备注</label>
                    <textarea class="form-textarea" name="remarks" placeholder="特殊要求、注意事项等"></textarea>
                </div>
            </form>
        `;
        if (
            App.showModal('新建订单', bodyHtml, {
                footer: `<button class="btn btn-secondary" onclick="App.closeModal({discardDraft:true})">取消</button><button class="btn btn-primary" onclick="document.getElementById('orderForm').requestSubmit()">💾 保存订单</button>`
            }) === false
        ) {
            Object.assign(this, previousEditor);
            return;
        }
        if (DB._businessAPI) {
            const editor = document.getElementById('orderForm');
            for (const input of editor.querySelectorAll('[name="paidAmountUSD"], [name="paymentStatus"]')) {
                input.disabled = true;
            }
            const note = document.createElement('p');
            note.className = 'text-sm text-gray';
            note.textContent = '可先保存待完善订单，后续补充商品和生产安排。实际收款在正式订单提交后登记。';
            editor.prepend(note);
        }
        this.attachDraft();
    },

    showEditForm(orderId, { draftRecordId = orderId, pendingRecordId = null } = {}) {
        const order = DB.getOrder(orderId);
        if (!order) return;
        const previousEditor = {
            _factoryIndex: this._factoryIndex,
            _editingOrder: this._editingOrder,
            _isHK: this._isHK
        };
        this._factoryIndex = 1;
        this._editingOrder = true;
        const customers = DB.getCustomers();
        const customer = customers.find(c => String(c.id) === String(order.customerId));
        const showFinance = canWriteFinancials();
        const showSalesSelect = Auth.canSeeAll();
        const isDomestic = Exchange.isDomestic(order.companyId);
        const isHK = !Exchange.isDomestic(order.companyId);
        this._isHK = isHK; // 供工厂卡片使用
        const financeTitle = isDomestic ? '💰 订单信息' : '💰 财务信息 (USD)';
        const factoryCostLabel = isHK ? '工厂成本 (USD)' : '工厂成本 (RMB)';
        const companyPolicy = DB.companies.find(
            company => String(company.id) === String(order.companyId)
        )?.profitPolicy;
        const legacyRmbFees = (order.profitPolicy || order.formulaVersion || companyPolicy) === 'grandware-v40';
        const money = orderMoneyFields(order);
        const otherLabel = `其他费用 (${money.otherCost.currency === 'CNY' ? 'RMB' : 'USD'})`;
        const profitLabel = isHK ? '预计利润 (USD)' : '预计利润 (RMB)';
        const freightLabel = isDomestic
            ? `${legacyRmbFees ? '货代费' : '运费'} (${money.freightCost.currency === 'CNY' ? 'RMB' : 'USD'})`
            : '';
        const insuranceLabel = isDomestic ? (legacyRmbFees ? '退税率 (%)' : '保险费 (USD)') : '';

        // 构建工厂数据（新模型优先，兼容旧数据）
        const factoryDataList =
            order.factories && order.factories.length > 0
                ? order.factories
                : [
                      {
                          factoryId: order.factoryId,
                          productType: order.productCategory,
                          totalQuantity: order.quantity,
                          totalAmount: money.factoryCost.value,
                          prepayment: 0,
                          inspectionDate: '',
                          estimatedShipDate: order.expectedShipDate
                      }
                  ];
        this._factoryIndex = factoryDataList.length;
        const occurrences = new Map();
        const factoryCardsHtml = factoryDataList
            .map((fd, idx) => {
                const key = String(fd.id ?? fd.factoryId ?? 'unknown');
                const occurrence = occurrences.get(key) || 0;
                occurrences.set(key, occurrence + 1);
                return this.createFactoryRow(idx, { ...fd, _draftId: `stored:${key}:${occurrence}` });
            })
            .join('');

        const bodyHtml = `
            <form id="orderForm" data-order-id="${App.escapeHtml(orderId)}" data-company-id="${App.escapeHtml(order.companyId)}" data-formula-version="${App.escapeHtml(order.formulaVersion || '')}" onsubmit="Orders.saveOrder(event, '${orderId}'); return false;">
                ${
                    showSalesSelect
                        ? `
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">业务员</label>
                        <select class="form-select" name="salespersonId">
                            ${this.salespersonOptions(order)}
                        </select>
                    </div>
                </div>`
                        : `<input type="hidden" name="salespersonId" value="${App.escapeHtml(order.salespersonId ?? '')}">`
                }
                <div class="form-group">
                    <label class="form-label">客户 <span class="required">*</span></label>
                    <select class="form-select" name="customerId" required onchange="Orders.onCustomerChange(this)">
                        ${!customer && order.customerId ? `<option value="${App.escapeHtml(order.customerId)}" selected>${App.escapeHtml(order.customerName || order.customerId)}（当前订单关联）</option>` : ''}
                        ${customers.map(c => `<option value="${App.escapeHtml(c.id)}" ${String(c.id) === String(order.customerId) ? 'selected' : ''}>${App.escapeHtml(c.company)} (${App.escapeHtml(c.country)})</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">客户联系人 <span class="required">*</span></label>
                    <select class="form-select" name="contactPerson" ${order.contactPerson ? 'required' : ''} id="orderContactSelect" data-draft-dynamic>
                        ${order.contactPerson ? '' : '<option value="" selected>历史订单未记录联系人</option>'}
                        ${this.getContactOptions(customer, order.contactPerson || '', order.contactId)}
                    </select>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">客户订单号 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="customerOrderNo" required value="${App.escapeHtml(order.customerOrderNo ?? '')}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">下单日期</label>
                        <input type="date" class="form-input" name="orderDate" value="${App.escapeHtml(order.orderDate ?? '')}">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">起运港</label>
                        <select class="form-select" name="loadingPort">
                            ${['上海港', '深圳港', '宁波港', '广州港', '青岛港', '厦门港'].map(p => `<option value="${p}" ${p === order.loadingPort ? 'selected' : ''}>${p}</option>`).join('')}
                        </select>
                    </div>
                    ${
                        requiresOverseasPort(DB.companies.find(company => company.id === order.companyId))
                            ? `
                    <div class="form-group">
                        <label class="form-label">海外港口 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="overseasPort" required value="${App.escapeHtml(order.overseasPort ?? '')}" placeholder="例：Los Angeles / Hamburg / Dubai">
                    </div>`
                            : ''
                    }
                </div>
                <hr style="border:none;border-top:1px solid var(--gray-200);margin:16px 0">
                <hr style="border:none;border-top:1px solid var(--gray-200);margin:16px 0">
                ${
                    showFinance
                        ? `
                <h3 class="font-semi mb-3">${financeTitle}</h3>
                <div class="form-row-3">
                    <div class="form-group">
                        <label class="form-label">订单金额 (USD)</label>
                        <input type="number" step="0.01" class="form-input" name="orderAmountUSD" value="${App.escapeHtml(order.orderAmountUSD ?? '')}" oninput="Orders.calcProfit()">
                    </div>
                    <div class="form-group">
                        <label class="form-label">${factoryCostLabel} <span class="text-xs text-gray" style="font-weight:400">自动计算</span></label>
                        <input type="number" step="0.01" class="form-input" name="${money.factoryCost.key}" value="${App.escapeHtml(money.factoryCost.value ?? '')}" readonly style="background:var(--gray-100);color:var(--gray-600)">
                    </div>
                    ${
                        isHK
                            ? ''
                            : `
                    <div class="form-group">
                        <label class="form-label">${freightLabel}</label>
                        <input type="number" step="0.01" class="form-input" name="${money.freightCost.key}" value="${App.escapeHtml(money.freightCost.value ?? '')}" oninput="Orders.calcProfit()">
                    </div>`
                    }
                </div>
                <div class="form-row-3">
                    ${
                        isHK
                            ? ''
                            : `
                    <div class="form-group">
                        <label class="form-label">${insuranceLabel}</label>
                        <input type="number" step="0.01" class="form-input" name="insuranceCostUSD" value="${App.escapeHtml(order.insuranceCostUSD ?? '')}" oninput="Orders.calcProfit()">
                    </div>`
                    }
                    <div class="form-group">
                        <label class="form-label">${otherLabel}</label>
                        <input type="number" step="0.01" class="form-input" name="${money.otherCost.key}" value="${App.escapeHtml(money.otherCost.value ?? '')}" oninput="Orders.calcProfit()">
                    </div>
                    <div class="form-group">
                        <label class="form-label">${profitLabel}</label>
                        <input type="text" class="form-input" id="calcProfit" readonly value="${App.escapeHtml(order.profitRMB ?? '')}" style="font-weight:600;color:var(--success)">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">公司操作单号 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="companyOperationNo" required value="${App.escapeHtml(order.companyOperationNo ?? '')}">
                    </div>
                </div>
`
                        : `
                <h3 class="font-semi mb-3">💰 金额信息</h3>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">订单金额 (USD)</label>
                        <input type="number" step="0.01" class="form-input" name="orderAmountUSD" value="${App.escapeHtml(order.orderAmountUSD ?? '')}">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">公司操作单号 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="companyOperationNo" required value="${App.escapeHtml(order.companyOperationNo ?? '')}">
                    </div>
                </div>`
                }
                <hr style="border:none;border-top:1px solid var(--gray-200);margin:16px 0">
                <div class="form-section-header">
                    <h3 class="font-semi mb-1">🏭 工厂信息</h3>
                    <span class="text-xs text-gray">填写每个工厂的详细生产信息</span>
                </div>
                <div id="factoryCards" data-draft-dynamic>
                    ${factoryCardsHtml}
                </div>
                <button type="button" class="btn btn-sm btn-secondary" onclick="Orders.addFactoryRow()" style="margin-top:8px">＋ 添加工厂</button>
                <input type="hidden" name="expectedShipDate" value="${App.escapeHtml(order.expectedShipDate ?? '')}">
                <input type="hidden" name="actualShipDate" value="${App.escapeHtml(order.actualShipDate ?? '')}">
                ${
                    showFinance
                        ? `
                <hr style="border:none;border-top:1px solid var(--gray-200);margin:16px 0">
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">收款状态</label>
                        <select class="form-select" name="paymentStatus">
                            ${['未收款', '部分收款', '已收款'].map(s => `<option value="${s}" ${s === order.paymentStatus ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">${order.nativeSettlementProjection === true ? '预收及已核销' : '已收款'} (USD)</label>
                        <input type="number" step="0.01" class="form-input" name="paidAmountUSD" value="${App.escapeHtml(order.paidAmountUSD ?? '')}">
                    </div>
                </div>`
                        : ''
                }
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">订单状态</label>
                        <select class="form-select" name="status">
                            ${['进行中', '已订船', '已取消', '推迟出货'].map(s => `<option value="${s}" ${s === order.status ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">出运状态</label>
                        <select class="form-select" name="shippingStatus">
                            ${['待出运', '已出运', '已到港', '已签收'].map(s => `<option value="${s}" ${s === order.shippingStatus ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                    </div>
                </div>
                ${
                    showFinance
                        ? `
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">工厂收款状态</label>
                        <select class="form-select" name="factoryPaidStatus">
                            ${['未付款', '部分付款', '已付清'].map(s => `<option value="${s}" ${s === order.factoryPaidStatus ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">${order.nativeSettlementProjection === true ? '工厂预付及已核销' : '已付工厂'} (${isHK ? 'USD' : 'RMB'})</label>
                        <input type="number" step="0.01" class="form-input" name="factoryPaidRMB" value="${App.escapeHtml(order.factoryPaidRMB ?? 0)}">
                    </div>
                </div>`
                        : ''
                }
                <div class="form-group">
                    <label class="form-label">备注</label>
                    <textarea class="form-textarea" name="remarks">${App.escapeHtml(order.remarks || '')}</textarea>
                </div>
            </form>
        `;
        if (
            App.showModal('编辑订单 - ' + App.escapeHtml(order.companyOperationNo || orderId), bodyHtml, {
                footer: `<button class="btn btn-secondary" onclick="App.closeModal({discardDraft:true})">取消</button><button class="btn btn-primary" onclick="document.getElementById('orderForm').requestSubmit()">💾 保存修改</button>`
            }) === false
        ) {
            Object.assign(this, previousEditor);
            return;
        }
        this.updateFactoryCost();
        this.calcProfit();
        const editor = document.getElementById('orderForm');
        if (editor && (order.stage === 'legacy' || (order.historicalReference && order.stage !== 'native'))) {
            // Historical omissions must not block an unrelated edit before the
            // patch-aware validator and authenticated API inspect changed fields.
            editor.noValidate = true;
        }
        if (editor && order.stage === 'native') {
            for (const input of editor.querySelectorAll(
                '[name="customerId"], [name="customerOrderNo"], [name="orderDate"], [name="expectedShipDate"], [name="actualShipDate"], [name="shippingStatus"], [name="orderAmountUSD"], [name="factoryCostRMB"], [name="factoryCostUSD"], [name="paidAmountUSD"], [name="paymentStatus"], [name="factoryPaidRMB"], [name="factoryPaidStatus"], #factoryCards [name$="_id"], #factoryCards [name$="_quantity"], #factoryCards [name$="_amount"], #factoryCards [name$="_prepayment"], #factoryCards button, [onclick="Orders.addFactoryRow()"]'
            )) {
                input.disabled = true;
            }
            for (const input of editor.querySelectorAll(
                '#factoryCards [name$="_productType"], #factoryCards [name$="_inspectionDate"], #factoryCards [name$="_shipDate"]'
            )) {
                input.required = false;
                input.closest('.form-group')?.querySelector('.required')?.remove();
            }
            const note = document.createElement('p');
            note.className = 'text-sm text-gray';
            note.textContent =
                '正式订单的客户、客户订单号、订单与出运日期、出运状态、数量和付款由业务单据维护。此处可修改生产计划的产品类型、验货与预计出货日期、备注和港口；到港与签收在出运记录中登记。';
            editor.prepend(note);
            const status = editor.elements.status;
            if (order.status === '已取消') status.disabled = true;
            else status.querySelector('option[value="已取消"]')?.remove();
        }
        if (editor && DB._businessAPI && order.stage === 'brief') {
            for (const input of editor.querySelectorAll('[name="paidAmountUSD"], [name="paymentStatus"]')) {
                input.disabled = true;
            }
        }
        if (editor) editor.dataset.originalValues = JSON.stringify(Object.fromEntries(new FormData(editor)));
        if (editor && pendingRecordId) editor.dataset.pendingRecordId = pendingRecordId;
        this.attachDraft(draftRecordId);
    },

    // ==================== 工厂信息动态管理 ====================
    _factoryIndex: 1,

    onCustomerChange(select) {
        const option = select.selectedOptions[0];
        const paymentTerms = option?.dataset.payment;
        const input = document.querySelector('input[name="paymentTerms"]');
        if (input && paymentTerms) input.value = paymentTerms;

        // 更新联系人下拉菜单
        const customerId = select.value;
        const contactSelect = document.getElementById('orderContactSelect');
        if (contactSelect) {
            const customer = DB.getCustomer(customerId);
            contactSelect.innerHTML = customer
                ? this.getContactOptions(customer)
                : '<option value="">请先选择客户</option>';
        }
    },

    /** 无 ID 的旧联系人仅用内容指纹标识当次选项，不生成持久 ID。 */
    legacyContactValue(contact) {
        return (
            'legacy:' +
            encodeURIComponent(
                JSON.stringify(
                    ['name', 'position', 'email', 'phone', 'mobilePhone', 'homeAddress'].map(key => contact[key] ?? '')
                )
            )
        );
    },

    /** 稳定 ID 优先；历史姓名从不自动匹配到同名的第一个人。 */
    getContactOptions(customer, selectedName = '', selectedId) {
        const contacts = Array.isArray(customer?.contacts)
            ? customer.contacts.filter(contact => contact && typeof contact === 'object')
            : [];
        const hasId = contact => contact.id !== undefined && contact.id !== null && String(contact.id) !== '';
        const selectedContacts =
            selectedId !== undefined && selectedId !== null && String(selectedId) !== ''
                ? contacts.filter(contact => hasId(contact) && String(contact.id) === String(selectedId))
                : [];
        const matchedId = selectedContacts.length === 1;
        let html = '';
        if (
            !matchedId &&
            (selectedName || (selectedId !== undefined && selectedId !== null && String(selectedId) !== ''))
        ) {
            const historyValue = customer ? 'history:' + encodeURIComponent(selectedName) : selectedName;
            html += `<option value="${App.escapeHtml(historyValue)}" data-contact-preserve="true" selected>${App.escapeHtml(selectedName || '未记录姓名')}（当前订单联系人，保留历史记录）</option>`;
        } else {
            html += `<option value=""${matchedId ? '' : ' selected'}>${customer ? '请选择客户联系人' : '请先选择客户'}</option>`;
        }
        if (!contacts.length && customer?.contact) {
            const value = this.legacyContactValue({ name: customer.contact });
            html += `<option value="${App.escapeHtml(value)}" data-contact-legacy="true" data-contact-name="${App.escapeHtml(customer.contact)}">${App.escapeHtml(customer.contact)}（旧联系人，未记录编号）</option>`;
        }
        return (
            html +
            contacts
                .map(contact => {
                    const identified = hasId(contact);
                    const value = identified ? String(contact.id) : this.legacyContactValue(contact);
                    const duplicate =
                        contacts.filter(other =>
                            identified
                                ? hasId(other) && String(other.id) === value
                                : !hasId(other) && this.legacyContactValue(other) === value
                        ).length > 1;
                    const selected = matchedId && identified && String(contact.id) === String(selectedId);
                    const detail = [contact.position, contact.email, contact.mobilePhone || contact.phone]
                        .filter(Boolean)
                        .join(' · ');
                    const identity = identified ? `编号 ${String(contact.id)}` : '旧联系人，未记录编号';
                    return `<option value="${App.escapeHtml(value)}" ${identified ? 'data-contact-id="' + App.escapeHtml(value) + '"' : 'data-contact-legacy="true"'} data-contact-name="${App.escapeHtml(contact.name || '')}"${selected ? ' selected' : ''}${duplicate ? ' disabled' : ''}>${App.escapeHtml(contact.name || '未记录姓名')}${detail ? ' · ' + App.escapeHtml(detail) : ''}（${App.escapeHtml(duplicate ? '联系人身份重复，请先核对名录' : identity)}）</option>`;
                })
                .join('')
        );
    },

    collectOrderContact(form, fd, customer, original) {
        if (!fd.has('contactPerson')) return {};
        const value = String(fd.get('contactPerson') || '');
        const originalValues = form.dataset.originalValues ? JSON.parse(form.dataset.originalValues) : null;
        const customerId = fd.has('customerId') ? fd.get('customerId') : original?.customerId;
        const sameCustomer = original && String(original.customerId) === String(customerId);
        if (sameCustomer && originalValues && value === String(originalValues.contactPerson || '')) return {};
        const select = form.elements.namedItem('contactPerson');
        // 兼容保留的旧表单；正式联系人选择由上面的 select 生成。
        if (select?.tagName !== 'SELECT') return { contactPerson: value };
        const option = select.selectedOptions[0];
        if (option?.dataset.contactPreserve === 'true' && sameCustomer) return {};
        if (!option || option.disabled || !value) throw new Error('请选择客户联系人');
        const contacts = Array.isArray(customer?.contacts) ? customer.contacts : [];
        if (option.dataset.contactId !== undefined) {
            const matching = contacts.filter(
                contact => contact.id !== undefined && contact.id !== null && String(contact.id) === value
            );
            if (matching.length !== 1) throw new Error('联系人名录已变化，请重新选择联系人');
            return { contactId: String(matching[0].id), contactPerson: matching[0].name || '' };
        }
        const matching = contacts.filter(
            contact =>
                (contact.id === undefined || contact.id === null || String(contact.id) === '') &&
                this.legacyContactValue(contact) === value
        );
        const name =
            matching.length === 1
                ? matching[0].name
                : !contacts.length && customer?.contact && this.legacyContactValue({ name: customer.contact }) === value
                  ? customer.contact
                  : null;
        if (!name) throw new Error('旧联系人无法唯一识别，请先在客户名录中核对联系人');
        return { contactPerson: name, ...(original?.contactId !== undefined ? { contactId: null } : {}) };
    },

    createFactoryRow(index, data = {}) {
        const factories = DB.getFactories();
        const required = this._editingOrder ? '' : 'required';
        const currency = this._isHK ? 'USD' : 'RMB';
        return `
            <div class="factory-card" data-factory-index="${index}" data-draft-row-id="${App.escapeHtml(data._draftId || (index === 0 ? 'blank:0' : 'row:' + crypto.randomUUID()))}">
                <div class="factory-card-header">
                    <span class="factory-card-title">工厂 ${index + 1}</span>
                    ${index > 0 ? `<button type="button" class="btn btn-sm btn-outline-danger" onclick="Orders.removeFactoryRow(this)">✕ 删除</button>` : ''}
                </div>
                <div class="form-row-3">
                    <div class="form-group">
                        <label class="form-label">工厂名称 <span class="required">*</span></label>
                        <select class="form-select" name="factory_${index}_id" ${required}>
                            <option value="">请选择工厂</option>
                            ${data.factoryId && !factories.some(factory => String(factory.id) === String(data.factoryId)) ? `<option value="${App.escapeHtml(data.factoryId)}" selected>${App.escapeHtml(data.factoryName || data.factoryId)}（历史关联）</option>` : ''}
                            ${factories.map(f => `<option value="${App.escapeHtml(f.id)}" ${String(data.factoryId) === String(f.id) ? 'selected' : ''}>${App.escapeHtml(f.name)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">产品类型 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="factory_${index}_productType" value="${App.escapeHtml(data.productType || '')}" placeholder="例：电子产品" ${required}>
                    </div>
                    <div class="form-group">
                        <label class="form-label">总数量 <span class="required">*</span></label>
                        <input type="number" class="form-input" name="factory_${index}_quantity" value="${App.escapeHtml(data.totalQuantity ?? '')}" placeholder="0" ${required}>
                    </div>
                </div>
                <div class="form-row-3">
                    ${
                        canWriteFinancials()
                            ? `
                    <div class="form-group">
                        <label class="form-label">总金额 (${currency}) <span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input factory-amount" name="factory_${index}_amount" value="${App.escapeHtml(data.totalAmount ?? '')}" placeholder="0.00" oninput="Orders.updateFactoryCost()" ${required}>
                    </div>
                    <div class="form-group">
                        <label class="form-label">预付款 (${currency}) <span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input" name="factory_${index}_prepayment" value="${App.escapeHtml(data.prepayment ?? '')}" placeholder="0.00" ${required}>
                    </div>
                    `
                            : ''
                    }
                    <div class="form-group">
                        <label class="form-label">预计验货日期 <span class="required">*</span></label>
                        <input type="date" class="form-input" name="factory_${index}_inspectionDate" value="${App.escapeHtml(data.inspectionDate ?? '')}" ${required}>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">预计出货日期 <span class="required">*</span></label>
                        <input type="date" class="form-input" name="factory_${index}_shipDate" value="${App.escapeHtml(data.estimatedShipDate ?? '')}" ${required}>
                    </div>
                </div>
            </div>`;
    },

    addFactoryRow() {
        const container = document.getElementById('factoryCards');
        if (!container) return;
        const index = this._factoryIndex++;
        container.insertAdjacentHTML('beforeend', this.createFactoryRow(index));
        // 更新所有工厂卡片的删除按钮（确保只有最后一张卡片可删除）
        this._updateFactoryDeleteButtons();
        FormDrafts.persist(document.getElementById('orderForm'));
    },

    removeFactoryRow(btn) {
        const card = btn.closest('.factory-card');
        if (card) {
            card.style.opacity = '0';
            card.style.transform = 'translateX(20px)';
            card.style.transition = 'all 0.2s';
            setTimeout(() => {
                card.remove();
                this._updateFactoryDeleteButtons();
                this.updateFactoryCost();
                FormDrafts.persist(document.getElementById('orderForm'));
            }, 200);
        }
    },

    _updateFactoryDeleteButtons() {
        const cards = document.querySelectorAll('#factoryCards .factory-card');
        cards.forEach((card, idx) => {
            const header = card.querySelector('.factory-card-header');
            const title = header.querySelector('.factory-card-title');
            const existingBtn = header.querySelector('button');
            // 更新标题编号
            if (title) title.textContent = `工厂 ${idx + 1}`;
            // 第一个工厂不可删除
            if (idx === 0 && existingBtn) existingBtn.remove();
            if (idx > 0 && !existingBtn) {
                header.insertAdjacentHTML(
                    'beforeend',
                    '<button type="button" class="btn btn-sm btn-outline-danger" onclick="Orders.removeFactoryRow(this)">✕ 删除</button>'
                );
            }
        });
    },

    updateFactoryCost() {
        // Public production cards omit factory amounts. Their missing financial
        // inputs never become a submitted zero when an editor is opened.
        if (!document.getElementById('factoryCards')) return;
        const editor = document.getElementById('orderForm');
        const original = editor?.dataset.orderId ? DB.getOrder(editor.dataset.orderId) : null;
        if (
            original?.stage === 'native' ||
            ((original?.stage === 'legacy' || original?.historicalReference) && !editor.dataset.originalValues)
        ) {
            // Native procurement totals are projected from purchase orders;
            // production cards cannot recalculate those authoritative amounts.
            this.calcProfit();
            return;
        }
        const amounts = document.querySelectorAll('#factoryCards .factory-amount');
        let total = 0;
        amounts.forEach(input => {
            total += parseFloat(input.value) || 0;
        });
        const key = orderMoneyFields(original || { companyId: editor?.dataset.companyId || DB.currentCompanyId })
            .factoryCost.key;
        const costInput = document.querySelector(`input[name="${key}"]`);
        if (costInput) {
            costInput.value = total.toFixed(2);
        }
        if (typeof Orders !== 'undefined' && Orders.calcProfit) {
            Orders.calcProfit();
        }
    },

    calcProfit() {
        const form = document.getElementById('orderForm');
        const el = document.getElementById('calcProfit');
        if (!form || !el) return;
        const original = form.dataset.orderId ? DB.getOrder(form.dataset.orderId) : null;
        if (
            original?.stage === 'legacy' ||
            (original?.historicalReference && original.stage !== 'native') ||
            (original?.stage === 'native' && original.status === '已取消')
        ) {
            // Historical reference profit and cancelled-document profit are
            // source values, not a current-FX quote or active native forecast.
            const profit = original.profitRMB;
            el.value = Number.isFinite(profit) ? profit.toFixed(2) : '—';
            el.style.color = Number.isFinite(profit)
                ? profit >= 0
                    ? 'var(--success)'
                    : 'var(--danger)'
                : 'var(--gray-500)';
            return;
        }
        const value = name => parseFloat(form.elements.namedItem(name)?.value) || 0;
        const usd = value('orderAmountUSD');
        const factoryRMB = value('factoryCostRMB');
        // HK 公司不渲染货代费和退税率字段，用可选链防止 TypeError
        const freight = value('freightCostUSD');
        const insurance = value('insuranceCostUSD');
        const other = value('otherCostUSD');

        // Quotes use configured company rates. Native previews retain document
        // revenue, procurement cost and frozen FX; only extension expenses vary.
        const companyId = form.dataset.companyId || DB.currentCompanyId;
        const preview = {
            ...original,
            companyId,
            formulaVersion: form.dataset.formulaVersion || original?.formulaVersion || undefined,
            ...Object.fromEntries(
                ORDER_MONEY_FIELDS.filter(
                    name =>
                        form.elements.namedItem(name) &&
                        (original?.stage !== 'native' || !name.startsWith('factoryCost'))
                ).map(name => [name, value(name)])
            )
        };
        if (original?.stage !== 'native') {
            preview.orderAmountUSD = usd;
            delete preview.orderAmountRMB;
        }
        const financials =
            typeof Exchange.getOrderFinancials === 'function' ? Exchange.getOrderFinancials(preview) : null;
        const profit = financials
            ? financials.computedProfit
            : DB.calcOrderProfit(usd, factoryRMB, freight, insurance, other, companyId);
        if (el) {
            el.value = Number.isFinite(profit) ? profit.toFixed(2) : '—';
            el.style.color = Number.isFinite(profit)
                ? profit >= 0
                    ? 'var(--success)'
                    : 'var(--danger)'
                : 'var(--gray-500)';
        }
    },

    async saveOrder(event, orderId = null) {
        event.preventDefault();
        const form = event.target;
        if (form.dataset.savingOrder === 'true') return;
        form.dataset.savingOrder = 'true';
        try {
            await this._saveOrder(event, orderId);
        } finally {
            delete form.dataset.savingOrder;
        }
    },

    async _saveOrder(event, orderId = null) {
        event.preventDefault();

        if (!DB._cloudReady) {
            App.toast('⚠️ 云端未连接，请检查网络后刷新重试', 'error');
            return;
        }

        const form = event.target;
        if (!FormDrafts.canSubmit(form)) return;
        const fd = new FormData(form);
        const pendingId = orderId || form.dataset.pendingRecordId || null;
        const originalOrder = pendingId ? DB.getOrder(pendingId) : null;
        const owner = form.elements.namedItem('salespersonId');
        if (
            owner?.tagName === 'SELECT' &&
            String(owner.value) !== String(originalOrder?.salespersonId ?? '') &&
            !(Auth.users || []).some(user => String(user.id) === String(owner.value))
        ) {
            App.toast('请选择当前启用的业务员；历史负责人只能保留原关联', 'warning');
            return;
        }
        const customer = DB.getCustomer(fd.has('customerId') ? fd.get('customerId') : originalOrder?.customerId);
        let contactPatch;
        try {
            contactPatch = this.collectOrderContact(form, fd, customer, originalOrder);
        } catch (error) {
            App.toast(error.message, 'warning');
            return;
        }

        // 收集工厂信息（从动态工厂卡片）
        const factoryCards = form.querySelectorAll('#factoryCards .factory-card');
        const factories = [];
        factoryCards.forEach(card => {
            const idx = card.dataset.factoryIndex;
            const factoryId = fd.get(`factory_${idx}_id`) || '';
            if (!factoryId) return; // 跳过未选工厂的行
            const f = DB.getFactory(factoryId);
            const previous = pendingId
                ? DB.getOrder(pendingId)?.factories?.find(item => String(item.factoryId) === String(factoryId))
                : null;
            const factory = {
                ...(previous || {}),
                factoryId: factoryId,
                factoryName: f ? f.name : factoryId,
                productType: fd.get(`factory_${idx}_productType`) || '',
                totalQuantity: Number(fd.get(`factory_${idx}_quantity`) || 0),
                inspectionDate: fd.get(`factory_${idx}_inspectionDate`) || '',
                estimatedShipDate: fd.get(`factory_${idx}_shipDate`) || ''
            };
            if (canWriteFinancials()) {
                factory.totalAmount = Number(fd.get(`factory_${idx}_amount`) || 0);
                factory.prepayment = Number(fd.get(`factory_${idx}_prepayment`) || 0);
            }
            factories.push(factory);
        });

        const factoryIds = factories.map(f => f.factoryId);
        const factoryNames = factories.map(f => f.factoryName).join('、');
        const productTypes = [...new Set(factories.map(f => f.productType.trim()).filter(Boolean))].join('、');
        const primaryFactoryId = factories.length > 0 ? factories[0].factoryId : '';
        // 工厂成本 = 所有工厂总金额之和，优先以表单自动计算值为准
        const totalFactoryCost = factories.reduce((sum, f) => sum + f.totalAmount, 0);
        const money = orderMoneyFields(originalOrder || { companyId: form.dataset.companyId || DB.currentCompanyId });
        const financialPatch = {};
        if (canWriteFinancials()) {
            for (const key of ORDER_MONEY_FIELDS) {
                if (!fd.has(key)) continue;
                const amount =
                    key === money.factoryCost.key
                        ? parseFloat(fd.get(key)) || totalFactoryCost || 0
                        : Number(fd.get(key) || 0);
                if (!Number.isFinite(amount) || amount < 0) {
                    App.toast('费用金额须为有效非负数', 'error');
                    return;
                }
                financialPatch[key] = amount;
            }
        }

        // 预计出运日期取最早出货工厂的日期
        const shipDates = factories
            .map(f => f.estimatedShipDate)
            .filter(Boolean)
            .sort();
        const expectedShipDate = shipDates.length > 0 ? shipDates[0] : fd.get('expectedShipDate') || '';

        const data = {
            customerId: fd.get('customerId'),
            customerName: customer?.company || '',
            ...contactPatch,
            factoryId: primaryFactoryId,
            factoryIds: factoryIds,
            factoryName: factoryNames,
            factories: factories,
            productCategory: productTypes,
            productName: productTypes,
            quantity: factories.reduce((sum, f) => sum + f.totalQuantity, 0),
            unit: 'PCS',
            orderDate: fd.get('orderDate'),
            expectedShipDate: expectedShipDate,
            actualShipDate: fd.get('actualShipDate') || null,
            orderAmountUSD: Number(fd.get('orderAmountUSD')),
            ...financialPatch,
            paymentStatus: fd.get('paymentStatus') || '未收款',
            paidAmountUSD: Number(fd.get('paidAmountUSD') || 0),
            status: fd.get('status') || '进行中',
            shippingStatus: fd.get('shippingStatus') || '待出运',
            factoryPaidStatus: fd.get('factoryPaidStatus') || '未付款',
            factoryPaidRMB: Number(fd.get('factoryPaidRMB') || 0),
            paymentTerms: fd.get('paymentTerms') || '',
            loadingPort: fd.get('loadingPort') || '',
            destinationPort: customer?.country || '',
            overseasPort: fd.get('overseasPort') || '',
            remarks: fd.get('remarks') || '',
            customerOrderNo: fd.get('customerOrderNo') || '',
            companyOperationNo: fd.get('companyOperationNo') || '',
            salespersonId: fd.get('salespersonId') || (Auth.currentUser ? Auth.currentUser.id : null)
        };
        if (!pendingId && !orderId && !form.dataset.orderId) {
            const number = String(fd.get('companyOperationNo') || '').trim();
            data.companyOperationNoAuto = !number || number === form.dataset.operationNoPreview;
        }
        if (pendingId && form.dataset.originalValues) {
            const original = JSON.parse(form.dataset.originalValues);
            for (const key of Object.keys(data)) {
                if (fd.has(key) && Object.hasOwn(original, key) && String(fd.get(key)) === String(original[key])) {
                    delete data[key];
                }
            }
            if (String(fd.get('customerId')) === String(original.customerId)) {
                delete data.customerName;
                delete data.destinationPort;
            }
            const factoryKeys = new Set(
                [...Object.keys(original), ...fd.keys()].filter(key => key.startsWith('factory_'))
            );
            const factoriesChanged = [...factoryKeys].some(
                key => String(fd.get(key) ?? '') !== String(original[key] ?? '')
            );
            if (!factoriesChanged) {
                for (const key of [
                    'factoryId',
                    'factoryIds',
                    'factoryName',
                    'factories',
                    'productCategory',
                    'productName',
                    'quantity',
                    'unit',
                    'expectedShipDate',
                    'factoryCostRMB',
                    'factoryCostUSD'
                ]) {
                    delete data[key];
                }
            }
        }
        if (!canWriteFinancials()) {
            for (const key of [
                ...ORDER_MONEY_FIELDS,
                'factoryPaidStatus',
                'factoryPaidRMB',
                'paidAmountUSD',
                'paymentStatus'
            ]) {
                delete data[key];
            }
        }
        if (pendingId && form.querySelector('#factoryCards')) {
            const previous = DB.getOrder(pendingId);
            const publicRows = rows =>
                (rows || []).map(row => ({
                    factoryId: row.factoryId || '',
                    productType: row.productType || '',
                    totalQuantity: Number(row.totalQuantity || 0),
                    inspectionDate: row.inspectionDate || '',
                    estimatedShipDate: row.estimatedShipDate || '',
                    ...(canWriteFinancials()
                        ? { totalAmount: Number(row.totalAmount || 0), prepayment: Number(row.prepayment || 0) }
                        : {})
                }));
            if (JSON.stringify(publicRows(factories)) === JSON.stringify(publicRows(previous?.factories))) {
                for (const key of [
                    'factoryId',
                    'factoryIds',
                    'factoryName',
                    'factories',
                    'productCategory',
                    'productName',
                    'quantity',
                    'unit',
                    'expectedShipDate'
                ]) {
                    delete data[key];
                }
            }
        }
        if (pendingId) {
            // Submit only fields present in this editor. Hidden/absent sections
            // must not erase factories, production dates or finance values.
            if (!form.querySelector('#factoryCards')) {
                for (const key of [
                    'factoryId',
                    'factoryIds',
                    'factoryName',
                    'factories',
                    'productCategory',
                    'productName',
                    'quantity',
                    'unit'
                ]) {
                    delete data[key];
                }
            }
            for (const key of ['expectedShipDate', 'actualShipDate', 'paymentTerms', 'overseasPort']) {
                if (
                    !fd.has(key) &&
                    (['paymentTerms', 'overseasPort', 'actualShipDate'].includes(key) ||
                        !form.querySelector('#factoryCards'))
                ) {
                    delete data[key];
                }
            }
            for (const key of [
                'freightCostUSD',
                'freightCostRMB',
                'insuranceCostUSD',
                'otherCostUSD',
                'otherCostRMB'
            ]) {
                if (!fd.has(key)) delete data[key];
            }
            if (!canWriteFinancials()) {
                for (const key of [...ORDER_MONEY_FIELDS, 'factoryPaidStatus', 'factoryPaidRMB']) {
                    delete data[key];
                }
            }
        }

        const company = DB.companies.find(item => item.id === (form.dataset.companyId || DB.currentCompanyId));
        const existing = pendingId ? DB.getOrder(pendingId) : null;
        if (existing?.stage === 'native') {
            for (const key of [
                'companyId',
                'customerId',
                'customerOrderNo',
                'customerName',
                'destinationPort',
                'orderDate',
                'expectedShipDate',
                'actualShipDate',
                'shippingStatus',
                'orderAmountUSD',
                'orderAmountRMB',
                'factoryCostRMB',
                'factoryCostUSD',
                'paidAmountUSD',
                'paymentStatus',
                'factoryPaidRMB',
                'factoryPaidStatus',
                'costPaidUSD',
                'costPaymentStatus',
                'erpItems',
                'factoryId',
                'factoryIds',
                'factoryName',
                'factories',
                'productCategory',
                'productName',
                'quantity',
                'unit'
            ]) {
                delete data[key];
            }
        }
        if (existing?.stage === 'native' && !fd.has('status')) delete data.status;
        if (existing?.stage === 'native' && form.querySelector('#factoryCards')) {
            const original = JSON.parse(form.dataset.originalValues || '{}');
            const plans = (existing.factories || []).map((row, index) => {
                const value = { ...row };
                for (const [field, suffix] of [
                    ['productType', 'productType'],
                    ['inspectionDate', 'inspectionDate'],
                    ['estimatedShipDate', 'shipDate']
                ]) {
                    const name = `factory_${index}_${suffix}`;
                    if (fd.has(name) && String(fd.get(name) || '') !== String(original[name] || '')) {
                        value[field] = String(fd.get(name) || '').trim();
                    }
                }
                return value;
            });
            if (JSON.stringify(plans) !== JSON.stringify(existing.factories || [])) data.factories = plans;
        }
        if (DB._businessAPI && (!existing || existing.stage === 'brief')) {
            // Receipt history is recorded after a formal order is submitted.
            delete data.paidAmountUSD;
            delete data.paymentStatus;
        }
        if (existing) {
            for (const key of Object.keys(data)) {
                if (JSON.stringify(data[key] ?? '') === JSON.stringify(existing[key] ?? '')) delete data[key];
            }
        }
        const validationPatch = { ...data };
        let planInvalid = '';
        if (existing?.stage === 'native' && data.factories) {
            planInvalid = validateNativeProductionPlan(existing.factories || [], data.factories);
            delete validationPatch.factories;
        }
        const invalid =
            planInvalid || validateOrderData({ ...existing, ...data }, validationPatch, !pendingId, company);
        if (invalid) {
            App.toast(invalid, 'error');
            return;
        }
        if (pendingId) {
            const pendingOrder = DB.getOrder(pendingId);
            if (!orderId && Object.hasOwn(data, 'companyOperationNo') && !data.companyOperationNo) {
                data.companyOperationNo = pendingOrder?.companyOperationNo || '';
            }
            const updated = DB.updateOrder(pendingId, data);
            if (!updated) {
                App.toast('⚠️ 订单未更新，请检查操作单号或权限提示', 'error');
                return;
            }
        } else {
            const newOrder = DB.addOrder(data);
            if (!newOrder) {
                App.toast('⚠️ 订单未创建，请检查必填项、重复单号与权限', 'error');
                return;
            }
            form.dataset.pendingRecordId = newOrder.id;
        }

        FormDrafts.stageRecord(form);
        const ok = await DB.flush();
        if (!ok) {
            App.toast('⚠️ 保存到云端失败，请稍后重试', 'error');
            return;
        }

        if (!FormDrafts.acknowledgeStaged(form)) {
            // Submitted values become the edit baseline. Inputs entered during
            // the request remain distinct, even when the server normalizes money keys.
            form.dataset.originalValues = JSON.stringify(Object.fromEntries(fd));
            const number = form.elements.namedItem('companyOperationNo');
            const acknowledged = DB.getOrder(form.dataset.pendingRecordId)?.companyOperationNo;
            if (
                form.isConnected &&
                document.getElementById('orderForm') === form &&
                data.companyOperationNoAuto === true &&
                number?.value === String(fd.get('companyOperationNo') || '') &&
                acknowledged
            ) {
                // The server may allocate another number while a new form remains open.
                // Adopt only the untouched preview; later manual input remains the user's draft.
                number.value = acknowledged;
                form.dataset.operationNoPreview = acknowledged;
                FormDrafts.persist(form);
            }
            App.toast('上一版已保存，当前新输入尚未保存，请再次保存', 'info');
            return;
        }
        App.toast(orderId ? '订单更新成功' : '订单创建成功');
        App.closeModal();
        if (DB._businessAPI) {
            try {
                await DB._initFromBusinessAPI();
            } catch (error) {
                DB._handleSaveFailure(error);
                return;
            }
        }
        if (orderId) {
            this.renderDetail(document.getElementById('pageContent'), orderId);
        } else {
            this.renderTable();
        }
    },

    updatePayment(orderId) {
        const order = DB.getOrder(orderId);
        if (!order || !canWriteFinancials()) return;
        if (order.stage === 'native') return BusinessBackendPanel.receivePayment(orderId);
        if (order.stage === 'brief') return App.toast('完善商品明细并提交正式订单后，可登记实际收款', 'info');
        if (order.stage === 'legacy') {
            return App.toast('此记录的历史余额来自 Excel；可在编辑订单中校对，不生成实际收款单据', 'info');
        }
        if (DB._businessAPI) return App.toast('请先刷新订单数据，再通过正式订单登记实际收款', 'info');
        const remaining = order.orderAmountUSD - order.paidAmountUSD;
        const bodyHtml = `
            <form id="paymentForm" onsubmit="Orders.savePayment(event, '${orderId}'); return false;">
                <div class="detail-item mb-4">
                    <div class="detail-label">订单金额</div>
                    <div class="detail-value">${formatOrderMoney(order.orderAmountUSD, 'USD')}</div>
                </div>
                <div class="detail-item mb-4">
                    <div class="detail-label">已收款</div>
                    <div class="detail-value">${formatOrderMoney(order.paidAmountUSD, 'USD')}</div>
                </div>
                <div class="detail-item mb-4">
                    <div class="detail-label">待收余额</div>
                    <div class="detail-value text-warning">${formatOrderMoney(remaining, 'USD')}</div>
                </div>
                <div class="form-group">
                    <label class="form-label">本次收款 (USD)</label>
                    <input type="number" step="0.01" class="form-input" name="amount" value="${remaining.toFixed(2)}" required>
                </div>
                <div class="form-group">
                    <label class="form-label">收款后状态</label>
                    <select class="form-select" name="paymentStatus">
                        <option value="部分收款">部分收款</option>
                        <option value="已收款">已收款</option>
                    </select>
                </div>
            </form>
        `;
        App.showModal('更新收款 - ' + orderId, bodyHtml, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="document.getElementById('paymentForm').requestSubmit()">确认收款</button>`
        });
    },

    async savePayment(event, orderId) {
        event.preventDefault();

        if (!DB._cloudReady) {
            App.toast('⚠️ 云端未连接，请检查网络后刷新重试', 'error');
            return;
        }

        const fd = new FormData(event.target);
        const amount = Number(fd.get('amount'));
        if (!Number.isFinite(amount) || amount <= 0) {
            App.toast('本次收款必须是大于 0 的有效金额', 'error');
            return;
        }
        const status = fd.get('paymentStatus');
        const order = DB.getOrder(orderId);
        if (!order) {
            App.toast('⚠️ 订单不存在，无法更新', 'error');
            return;
        }
        if (!canWriteFinancials()) {
            App.toast('当前账号无收款权限', 'error');
            return;
        }
        if (order.stage || DB._businessAPI) {
            App.toast('请通过正式订单登记实际收款；历史余额在原始记录中校对', 'warning');
            return;
        }
        const form = event.target;
        if (form.dataset.saving === 'true') return;
        if (!form.dataset.receiptTarget) {
            const target = Number(order.paidAmountUSD || 0) + amount;
            if (target > Number(order.orderAmountUSD || 0)) {
                App.toast('收款金额不能超过待收余额', 'error');
                return;
            }
            form.dataset.receiptTarget = String(target);
            form.dataset.receiptAmount = String(amount);
        } else if (Number(form.dataset.receiptAmount) !== amount) {
            App.toast('本次收款已有待保存草稿，请先重试保存', 'error');
            return;
        }
        const newPaid = Number(form.dataset.receiptTarget);
        const updated = DB.updateOrder(orderId, { paidAmountUSD: newPaid, paymentStatus: status });
        if (!updated) {
            App.toast('⚠️ 订单不存在，无法更新', 'error');
            return;
        }

        form.dataset.saving = 'true';
        let ok;
        try {
            ok = await DB.flush();
        } catch {
            ok = false;
        } finally {
            form.dataset.saving = 'false';
        }
        if (!ok) {
            App.toast('⚠️ 保存到云端失败，请稍后重试', 'error');
            return;
        }

        App.toast('收款记录已更新');
        App.closeModal();
        this.renderDetail(document.getElementById('pageContent'), orderId);
    },

    deleteOrder(orderId) {
        if (DB.getOrder(orderId)?.stage === 'native') {
            App.toast('正式订单需使用撤销业务单据，不能删除原始记录', 'warning');
            return;
        }
        App.showConfirm(
            '确定要删除订单 ' + orderId + ' 吗？此操作不可撤销，关联的出运和单证信息也将被删除。',
            async () => {
                App.toast('正在删除...', 'info');
                DB.deleteOrder(orderId);
                // ★ 显式 flush（deleteOrder 不再自动 flush）
                const ok = await DB.flush();
                if (!ok) {
                    App.toast('⚠️ 删除保存失败，请刷新页面重试', 'error');
                    return;
                }
                App.toast('订单已删除');
                window.location.hash = '#/orders';
            }
        );
    },

    editBusinessItems(orderId) {
        BusinessBackendPanel.editItems(orderId);
    },

    confirmBusinessOrder(orderId, action) {
        if (!['convert', 'submit', 'cancel'].includes(action)) return;
        App.showConfirm(
            action === 'convert'
                ? '根据真实商品明细建立销售、采购订单草稿？'
                : action === 'cancel'
                  ? '撤销正式销售、采购订单？已有收款、发货或发票时需先处理对应业务，撤销记录将保留。'
                  : '提交销售、采购订单？收款需单独登记。',
            () => BusinessBackendPanel.runAction(action, orderId)
        );
    },

    exportExcel() {
        const orders = DB.getOrders(this.currentFilter).map(order => {
            const financials = Exchange.getOrderFinancials(order);
            const money = orderMoneyFields(order);
            const domestic = financials.currency === 'CNY';
            const legacy = financials.policy === 'grandware-v40';
            // Export is a display copy. Keep original amount units and source keys unchanged.
            return {
                ...order,
                settlementCurrency: financials.currency,
                formulaPolicy: financials.policy,
                factoryCostRMB: money.factoryCost.value,
                freightCostUSD: money.freightCost.value,
                otherCostUSD: money.otherCost.value,
                factoryCostCurrency: money.factoryCost.currency,
                freightCostCurrency: money.freightCost.currency,
                otherCostCurrency: money.otherCost.currency,
                feeCurrency: [...new Set([money.freightCost.currency, money.otherCost.currency])].join(' / '),
                insuranceUnit: domestic && legacy ? '%' : 'USD'
            };
        });
        const headers = [
            'id',
            'customerOrderNo',
            'companyOperationNo',
            'companyId',
            'settlementCurrency',
            'formulaPolicy',
            'feeCurrency',
            'insuranceUnit',
            'customerName',
            'contactPerson',
            'productName',
            'orderDate',
            'expectedShipDate',
            'actualShipDate',
            'orderAmountUSD',
            'orderAmountRMB',
            'factoryCostRMB',
            'factoryCostCurrency',
            'freightCostUSD',
            'freightCostCurrency',
            'insuranceCostUSD',
            'otherCostUSD',
            'otherCostCurrency',
            'profitRMB',
            'profitRate',
            'paymentStatus',
            'paidAmountUSD',
            'factoryPaidStatus',
            'status',
            'shippingStatus',
            'loadingPort',
            'destinationPort',
            'overseasPort',
            'remarks'
        ];
        const labels = {
            id: '订单号',
            customerOrderNo: '客户订单号',
            companyOperationNo: '公司操作单号',
            companyId: '法人主体ID',
            settlementCurrency: '结算币种',
            formulaPolicy: '核算公式版本',
            feeCurrency: '货代/其他费用币种',
            insuranceUnit: '退税率/保险费单位',
            customerName: '客户',
            contactPerson: '联系人',
            productName: '产品',
            orderDate: '下单日期',
            expectedShipDate: '预计出运',
            actualShipDate: '实际出运',
            orderAmountUSD: '订单金额(USD)',
            orderAmountRMB: '结算收入(结算币种)',
            factoryCostRMB: '工厂成本(结算币种)',
            factoryCostCurrency: '工厂成本币种',
            freightCostUSD: '货代/运费(费用币种)',
            freightCostCurrency: '货代/运费币种',
            insuranceCostUSD: '退税率/保险费(原始值)',
            otherCostUSD: '其他费用(费用币种)',
            otherCostCurrency: '其他费用币种',
            profitRMB: '利润(结算币种)',
            profitRate: '利润率(%)',
            paymentStatus: '收款状态',
            paidAmountUSD: '已收款(USD)',
            factoryPaidStatus: '工厂收款状态',
            status: '订单状态',
            shippingStatus: '出运状态',
            loadingPort: '起运港',
            destinationPort: '目的港',
            overseasPort: '海外港口',
            remarks: '备注'
        };
        const financialHeaders = new Set([
            'factoryCostRMB',
            'factoryCostCurrency',
            'freightCostUSD',
            'freightCostCurrency',
            'insuranceCostUSD',
            'otherCostUSD',
            'otherCostCurrency',
            'profitRMB',
            'profitRate',
            'factoryPaidStatus',
            'paidAmountUSD',
            'paymentStatus'
        ]);
        const visibleHeaders = Auth.canSeeFinancials()
            ? headers
            : headers.filter(header => !financialHeaders.has(header));
        App.exportExcel(orders, '订单列表_' + new Date().toISOString().split('T')[0] + '.xlsx', visibleHeaders, labels);
    },

    // ==================== Excel导入 ====================

    downloadTemplate() {
        const isHK = !Exchange.isDomestic(DB.currentCompanyId);
        const legacyRmbFees = !isHK && DB.getCurrentCompany()?.profitPolicy === 'grandware-v40';
        const costLabel = isHK ? '工厂成本(USD)' : '工厂成本(RMB)';
        const headers = [
            '客户',
            '客户订单号',
            '客户联系人',
            '下单日期',
            '订单金额(USD)',
            costLabel,
            legacyRmbFees ? '货代费(RMB)' : '运费(USD)',
            legacyRmbFees ? '退税率(%)' : '保险费(USD)',
            legacyRmbFees ? '其他费用(RMB)' : '其他费用(USD)',
            '起运港',
            '海外港口',
            '收款状态',
            '已收款(USD)',
            '订单状态',
            '出运状态',
            '付款条件',
            '产品',
            '备注'
        ];
        const exampleRow = [
            '示例: ABC Imports',
            'PO-2026-0001',
            '示例联系人',
            '2026-01-15',
            '50000.00',
            '35000.00',
            '1500.00',
            legacyRmbFees ? '13' : '300.00',
            '200.00',
            '上海港',
            'Los Angeles',
            '未收款',
            '0',
            '进行中',
            '待出运',
            'T/T 30%预付',
            'LED灯具',
            '无特殊要求'
        ];

        const financeColumns = new Set([
            costLabel,
            legacyRmbFees ? '货代费(RMB)' : '运费(USD)',
            legacyRmbFees ? '退税率(%)' : '保险费(USD)',
            legacyRmbFees ? '其他费用(RMB)' : '其他费用(USD)',
            '收款状态',
            '已收款(USD)'
        ]);
        const indexes = headers
            .map((header, index) => index)
            .filter(
                index =>
                    (!isHK || !/^(运费|货代费|退税率|保险费)/.test(headers[index])) &&
                    (canWriteFinancials() || !financeColumns.has(headers[index]))
            );
        const wsData = [indexes.map(index => headers[index]), indexes.map(index => exampleRow[index])];
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        // Set column widths
        ws['!cols'] = headers.map(() => ({ wch: 18 }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '订单导入模板');
        XLSX.writeFile(wb, '订单导入模板_' + (DB.currentCompanyId || '') + '.xlsx');
    },

    importExcel() {
        const bodyHtml = `
            <div style="padding:8px 0">
                <p style="margin-bottom:12px;color:var(--gray-600);line-height:1.6">
                    请先 <strong>下载模板</strong> 按格式填写后上传，或将已有订单Excel文件导入。<br>
                    <span style="color:var(--danger);font-size:13px">请填写客户、客户订单号、客户联系人、下单日期、订单金额及付款条件；香港主体需海外港口。</span>
                </p>
                <div style="display:flex;gap:8px;margin-bottom:16px">
                    <button class="btn btn-sm btn-secondary" onclick="Orders.downloadTemplate()">📋 下载导入模板</button>
                </div>
                <div class="form-group">
                    <label class="form-label" for="importPurpose">导入用途</label>
                    <select class="form-select" id="importPurpose"><option value="order-brief">待完善订单（新业务） / 维护现有记录</option>${canWriteFinancials() ? '<option value="historical-reference">历史参考（保留累计余额，不生成账务）</option>' : ''}</select>
                    <p class="text-sm text-gray">按记录 ID 或当前法人下的操作单号匹配已有记录；空白单元格保留现有值。新业务的实际收款请通过正式订单登记。</p>
                </div>
                <div class="form-group">
                    <label class="form-label">选择Excel文件 (.xlsx / .xls)</label>
                    <input type="file" id="importFileInput" class="form-input" accept=".xlsx,.xls" onchange="Orders.handleFileImport(this)">
                </div>
                <div id="importResult" style="margin-top:16px"></div>
            </div>
        `;
        App.showModal('📤 导入Excel订单', bodyHtml, { hideFooter: true });
    },

    handleFileImport,

    processImportRows,

    // ==================== 多选功能 ====================

    toggleSelectAll() {
        const selectAll = document.getElementById('selectAllCheckbox');
        const orders = DB.getOrders(this.currentFilter);
        if (selectAll && selectAll.checked) {
            orders.forEach(o => this.selectedOrders.add(o.id));
        } else {
            orders.forEach(o => this.selectedOrders.delete(o.id));
        }
        this.renderTable();
    },

    toggleSelect(id) {
        if (this.selectedOrders.has(id)) {
            this.selectedOrders.delete(id);
        } else {
            this.selectedOrders.add(id);
        }
        const selectAll = document.getElementById('selectAllCheckbox');
        const orders = DB.getOrders(this.currentFilter);
        if (selectAll) {
            selectAll.checked = this.selectedOrders.size === orders.length;
            selectAll.indeterminate = this.selectedOrders.size > 0 && this.selectedOrders.size < orders.length;
        }
        this.updateBatchBar();
    },

    updateBatchBar() {
        const bar = document.getElementById('orderBatchBar');
        const count = document.getElementById('batchCount');
        if (bar && count) {
            bar.classList.toggle('visible', this.selectedOrders.size > 0);
            count.textContent = this.selectedOrders.size;
        }
    },

    clearSelection() {
        this.selectedOrders.clear();
        this.renderTable();
    },

    batchDelete() {
        if (this.selectedOrders.size === 0) return;
        const ids = [...this.selectedOrders];
        // 权限过滤：salesperson 只能删自己的订单，越权部分剔除并提示
        const deletable = ids.filter(id => {
            const o = DB.getOrder(id);
            return o && o.stage !== 'native' && Auth.canDeleteOrder(o);
        });
        const blocked = ids.length - deletable.length;
        if (deletable.length === 0) {
            App.toast(
                ids.some(id => DB.getOrder(id)?.stage === 'native')
                    ? '正式订单需撤销业务单据；选中记录未删除'
                    : '选中的订单均无删除权限',
                'error'
            );
            this.selectedOrders.clear();
            this.renderTable();
            return;
        }
        const warnMsg = `<p style="margin-bottom:8px">确定要批量删除 <strong>${deletable.length}</strong> 笔订单吗？${blocked > 0 ? `<span style="color:var(--danger)">（另有 ${blocked} 笔受权限或正式单据保护，已跳过）</span>` : ''}</p><p style="color:var(--danger);font-size:13px">⚠️ 关联的出运和单证信息也将被删除。此操作不可恢复！</p>`;

        App.showConfirm(warnMsg, async () => {
            App.toast('正在批量删除...', 'info');
            deletable.forEach(id => DB.deleteOrder(id));
            const ok = await DB.flush();
            if (!ok) {
                App.toast('⚠️ 批量删除保存失败，请刷新页面重试', 'error');
                return;
            }
            this.selectedOrders.clear();
            App.toast(`已删除 ${deletable.length} 笔订单`);
            App.closeModal();
            this.renderTable();
        });
    },

    batchUpdateStatus() {
        if (this.selectedOrders.size === 0) return;
        const ids = [...this.selectedOrders];
        const bodyHtml = `
            <form id="batchStatusForm" onsubmit="Orders.saveBatchStatus(event); return false;">
                <p style="margin-bottom:16px">将 <strong>${ids.length}</strong> 笔订单统一更新为：</p>
                <div class="form-group">
                    <label class="form-label">订单状态</label>
                    <select class="form-select" name="batchStatus">
                        <option value="">不修改</option>
                        <option value="进行中">进行中</option>
                        <option value="已订船">已订船</option>
                        <option value="已取消">已取消</option>
                        <option value="推迟出货">推迟出货</option>
                    </select>
                </div>
                ${
                    canWriteFinancials()
                        ? `<div class="form-group">
                    <label class="form-label">收款状态</label>
                    <select class="form-select" name="batchPayment">
                        <option value="">不修改</option>
                        <option value="未收款">未收款</option>
                        <option value="部分收款">部分收款</option>
                        <option value="已收款">已收款</option>
                    </select>
                </div>`
                        : ''
                }
                <div class="form-group">
                    <label class="form-label">出运状态</label>
                    <select class="form-select" name="batchShipping">
                        <option value="">不修改</option>
                        <option value="待出运">待出运</option>
                        <option value="已出运">已出运</option>
                        <option value="已到港">已到港</option>
                        <option value="已签收">已签收</option>
                    </select>
                </div>
                <input type="hidden" name="batchIds" value="${App.escapeHtml(ids.join(','))}">
            </form>
        `;
        App.showModal('批量修改状态', bodyHtml, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="document.getElementById('batchStatusForm').requestSubmit()">💾 应用</button>`
        });
    },

    async saveBatchStatus(event) {
        event.preventDefault();
        const fd = new FormData(event.target);
        const ids = fd.get('batchIds').split(',');
        const status = fd.get('batchStatus');
        const payment = fd.get('batchPayment');
        const shipping = fd.get('batchShipping');
        if (status === '已取消' && ids.some(id => DB.getOrder(id)?.stage === 'native')) {
            App.toast('正式订单需通过撤销业务单据处理，不能批量修改为已取消', 'warning');
            return;
        }
        if (shipping && ids.some(id => DB.getOrder(id)?.stage === 'native')) {
            App.toast('正式订单出运状态由业务单据和出运里程碑计算，不能批量改写', 'warning');
            return;
        }
        if (payment && ids.some(id => DB.getOrder(id)?.stage && DB.getOrder(id).stage !== 'legacy')) {
            App.toast('正式订单收款状态由实际收款记录计算，不能批量修改', 'warning');
            return;
        }

        const changes = {};
        if (status) changes.status = status;
        if (payment && canWriteFinancials()) changes.paymentStatus = payment;
        if (shipping) changes.shippingStatus = shipping;

        if (!Object.keys(changes).length) {
            App.toast('请至少选择一项要修改的状态', 'info');
            return;
        }
        let updated = 0;
        ids.forEach(id => {
            if (DB.updateOrder(id, changes)) updated++;
        });
        const ok = await DB.flush();
        if (!ok) {
            App.toast('批量更新保存失败，请重试', 'error');
            return;
        }
        this.selectedOrders.clear();
        App.toast(`已更新 ${updated} 笔订单`);
        App.closeModal();
        this.renderTable();
    }
};

installBusinessModalHooks(App, FormDrafts);
window.Orders = Orders;
