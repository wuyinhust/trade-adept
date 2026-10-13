/**
 * 物流单证跟踪模块
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { requiresOverseasPort } from './order-import.js';
import { Exchange } from './exchange.js';
import { escapeHtml, toast, validate, installBusinessModalHooks, businessDraftScope } from './utils.js';
import { FormDrafts } from './form-drafts.js';

const Shipping = {
    attachDraft(formId, recordId) {
        const form = document.getElementById(formId);
        const pendingId = FormDrafts.pendingFor(formId, { scope: businessDraftScope(DB, Auth), recordId });
        FormDrafts.attach(form, {
            scope: businessDraftScope(DB, Auth),
            getScope: () => businessDraftScope(DB, Auth),
            recordId,
            pendingExists: id => Boolean(DB.getShipment(id)),
            getRecord: () => {
                const id = formId === 'statusForm' ? recordId : form.dataset.pendingRecordId || pendingId;
                const record = DB.getShipment(id);
                return record
                    ? Object.fromEntries(
                          [...form.elements]
                              .filter(input => input.name && !input.disabled)
                              .map(input => [input.name, record[input.name]])
                      )
                    : null;
            }
        });
    },
    render(container, param) {
        if (param) {
            this.renderDetail(container, param);
            return;
        }
        container.innerHTML = `
            <div class="filter-bar">
                <input type="text" id="shippingSearchInput" class="filter-input" placeholder="搜索操作单号/发票号码..." style="width:280px" oninput="Shipping.filter()">
                <select id="filterShippingStatus" class="filter-select" onchange="Shipping.filter()">
                    <option value="all">所有状态</option>
                    <option value="待出运">待出运</option>
                    <option value="已出运">已出运</option>
                    <option value="已到港">已到港</option>
                    <option value="已签收">已签收</option>
                </select>
                <div style="margin-left:auto">
                    <button class="btn btn-secondary" onclick="Shipping.exportExcel()">📥 导出Excel</button>
                    ${Auth.canEdit() ? '<button class="btn btn-primary" onclick="Shipping.showAddForm()">＋ 建立出运记录</button>' : ''}
                </div>
            </div>

            <div class="stats-grid">
                ${(() => {
                    const orders = DB.getOrders();
                    const unshipped = orders.filter(o => o.shippingStatus === '待出运');
                    const shipped = orders.filter(o => o.shippingStatus !== '待出运');
                    const isHK = !Exchange.isDomestic(DB.currentCompanyId);
                    let freightCards = '';
                    if (!isHK && Auth.canSeeFinancials()) {
                        const financials = orders
                            .filter(order => Exchange.isDomestic(order.companyId))
                            .map(order => Exchange.getOrderFinancials(order));
                        const totalFreightRMB = financials.reduce((sum, row) => sum + row.freightCost, 0);
                        const totalAmount = financials.reduce((sum, row) => sum + row.revenue, 0);
                        const freightRatio =
                            totalAmount > 0 ? ((totalFreightRMB / totalAmount) * 100).toFixed(2) : '0.00';
                        freightCards = `
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon cyan">💰</div></div>
                    <div class="stat-label">货代费总和 (RMB)</div>
                    <div class="stat-value">${App.formatMoney(totalFreightRMB, 'CNY')}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon purple">📊</div></div>
                    <div class="stat-label">货代费占比</div>
                    <div class="stat-value">${freightRatio}%</div>
                </div>`;
                    }
                    return `
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon orange">📦</div></div>
                    <div class="stat-label">未出运订单</div>
                    <div class="stat-value">${unshipped.length}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon blue">🚢</div></div>
                    <div class="stat-label">已出运订单</div>
                    <div class="stat-value">${shipped.length}</div>
                </div>
                    ${freightCards}
                    `;
                })()}
            </div>

            <div class="card">
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>发票号码</th>
                                <th>操作单号</th>
                                <th>客户</th>
                                <th>起运港</th>
                                <th>海外港口</th>
                                <th>ETD</th>
                                <th>报关状态</th>
                                <th>出运状态</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="shippingTableBody"></tbody>
                    </table>
                </div>
            </div>
        `;
        this.renderTable();
    },

    filter() {
        const status = document.getElementById('filterShippingStatus')?.value || 'all';
        const search = document.getElementById('shippingSearchInput')?.value || '';
        this.renderTable({ status, search });
    },

    renderTable(filter = {}) {
        const shipments = DB.getShipments(filter);
        const tbody = document.getElementById('shippingTableBody');
        if (!tbody) return;

        if (shipments.length === 0) {
            tbody.innerHTML =
                '<tr><td colspan="9" class="text-center text-gray" style="padding:40px">暂无出运记录</td></tr>';
            return;
        }

        tbody.innerHTML = shipments
            .map(
                s => `
            <tr>
                <td><span class="table-link" onclick="window.location.hash='#/shipping/${App.escapeHtml(s.id)}'">${App.escapeHtml(s.invoiceNo || '未填写')}</span></td>
                <td><span class="table-link" onclick="window.location.hash='#/orders/${App.escapeHtml(s.orderId)}'">${App.escapeHtml(s.companyOperationNo || DB.getOrder(s.orderId)?.companyOperationNo || '未关联')}</span></td>
                <td>${App.escapeHtml(s.customerName)}</td>
                <td>${App.escapeHtml(s.loadingPort)}</td>
                <td>${App.escapeHtml(s.overseasPort) || '-'}</td>
                <td>${App.formatDate(s.etd)}</td>
                <td>${App.getCustomsBadge(s.customsStatus)}</td>
                <td>${App.getShippingBadge(s.status)}</td>
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="window.location.hash='#/shipping/${App.escapeHtml(s.id)}'">详情</button>
                </td>
            </tr>
        `
            )
            .join('');
    },

    renderDetail(container, shipmentId) {
        const shipment = DB.getShipment(shipmentId);
        if (!shipment) {
            container.innerHTML =
                '<div class="card"><div class="card-body text-center text-gray">出运记录不存在</div></div>';
            return;
        }
        const order = DB.getOrder(shipment.orderId);

        const operationNo = order?.companyOperationNo || shipment.companyOperationNo;
        document.getElementById('pageTitle').textContent = operationNo ? '出运详情 - ' + operationNo : '出运详情';

        container.innerHTML = `
            <div class="flex gap-3 mb-4">
                <button class="btn btn-secondary" onclick="window.location.hash='#/shipping'">← 返回列表</button>
                ${order ? `<button class="btn btn-primary" onclick="window.location.hash='#/orders/${App.escapeHtml(order.id)}'">查看关联操作单</button>` : ''}
                ${Auth.canEdit() ? `<button class="btn btn-secondary" onclick="Shipping.updateStatus('${App.escapeHtml(shipment.id)}')">更新状态</button>` : ''}
            </div>

            <div class="card mb-6">
                <div class="card-header"><span class="card-title">物流时间线</span></div>
                <div class="card-body">
                    <div class="timeline">
                        <div class="timeline-item">
                            <div class="timeline-dot ${shipment.status !== '待出运' ? 'done' : 'current'}"></div>
                            <div class="timeline-content">
                                <div class="timeline-title">订单建立</div>
                                <div class="timeline-date">${order ? App.formatDate(order.orderDate) : '-'}</div>
                                <div class="timeline-desc">订单已确认，工厂开始生产</div>
                            </div>
                        </div>
                        <div class="timeline-item">
                            <div class="timeline-dot ${['已出运', '已到港', '已签收'].includes(shipment.status) ? 'done' : shipment.status === '待出运' ? 'current' : 'pending'}"></div>
                            <div class="timeline-content">
                                <div class="timeline-title">报关完成</div>
                                <div class="timeline-date">${App.formatDate(shipment.customsDate)}</div>
                                <div class="timeline-desc">${App.escapeHtml(shipment.customsStatus)}</div>
                            </div>
                        </div>
                        <div class="timeline-item">
                            <div class="timeline-dot ${['已出运', '已到港', '已签收'].includes(shipment.status) ? 'done' : shipment.status === '待出运' ? 'current' : 'pending'}"></div>
                            <div class="timeline-content">
                                <div class="timeline-title">货物装船出运</div>
                                <div class="timeline-date">${App.formatDate(shipment.actualShipDate)}</div>
                                <div class="timeline-desc">${App.escapeHtml(shipment.loadingPort)} → ${App.escapeHtml(shipment.overseasPort) || App.escapeHtml(shipment.destinationPort)}</div>
                            </div>
                        </div>
                        <div class="timeline-item">
                            <div class="timeline-dot ${shipment.status === '已签收' ? 'done' : shipment.status === '已到港' ? 'current' : 'pending'}"></div>
                            <div class="timeline-content">
                                <div class="timeline-title">客户签收</div>
                                <div class="timeline-date">${App.formatDate(shipment.receivedDate)}</div>
                                <div class="timeline-desc">${shipment.receivedDate ? '货物已交付客户' : '尚未记录签收日期'}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="card mb-6">
                <div class="card-header"><span class="card-title">出运信息</span></div>
                <div class="card-body">
                    <div class="detail-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                        <div class="detail-item"><div class="detail-label">发票号码</div><div class="detail-value">${App.escapeHtml(shipment.invoiceNo || '未填写')}</div></div>
                        <div class="detail-item"><div class="detail-label">关联操作单号</div><div class="detail-value">${App.escapeHtml(operationNo || '未关联')}</div></div>
                        <div class="detail-item"><div class="detail-label">客户</div><div class="detail-value">${App.escapeHtml(shipment.customerName)}</div></div>
                        <div class="detail-item"><div class="detail-label">货物描述</div><div class="detail-value">${App.escapeHtml(shipment.cargoDesc)}</div></div>
                        <div class="detail-item"><div class="detail-label">起运港</div><div class="detail-value">${App.escapeHtml(shipment.loadingPort)}</div></div>
                        <div class="detail-item"><div class="detail-label">海外港口</div><div class="detail-value">${App.escapeHtml(shipment.overseasPort) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">ETD (预计出运)</div><div class="detail-value">${App.formatDate(shipment.etd)}</div></div>
                        <div class="detail-item"><div class="detail-label">毛重 (KG)</div><div class="detail-value">${Number(shipment.grossWeight || 0).toLocaleString()}</div></div>
                        <div class="detail-item"><div class="detail-label">净重 (KG)</div><div class="detail-value">${Number(shipment.netWeight || 0).toLocaleString()}</div></div>
                        <div class="detail-item"><div class="detail-label">体积 (CBM)</div><div class="detail-value">${Number(shipment.volume || 0)}</div></div>
                        <div class="detail-item"><div class="detail-label">报关状态</div><div class="detail-value">${App.getCustomsBadge(shipment.customsStatus)}</div></div>
                        <div class="detail-item"><div class="detail-label">出运状态</div><div class="detail-value">${App.getShippingBadge(shipment.status)}</div></div>
                    </div>
                </div>
            </div>

            ${
                order
                    ? `
            <div class="card">
                <div class="card-header"><span class="card-title">关联操作单信息</span></div>
                <div class="table-container">
                    <table>
                        <tbody>
                            <tr><td>操作单号</td><td>${App.escapeHtml(order.companyOperationNo || order.id)}</td></tr>
                            <tr><td>客户</td><td>${App.escapeHtml(order.customerName)}</td></tr>
                            <tr><td>产品</td><td>${App.escapeHtml(order.productName)}</td></tr>
                            <tr><td>订单金额</td><td>${App.formatMoney(order.orderAmountUSD, 'USD')}</td></tr>
                            ${Auth.canSeeFinancials() ? `<tr><td>收款状态</td><td>${App.getPaymentBadge(order.paymentStatus)}</td></tr>` : ''}
                            <tr><td>订单状态</td><td>${App.getStatusBadge(order.status)}</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>`
                    : ''
            }
        `;
    },

    showAddForm(orderId = '') {
        if (!Auth.canEdit()) return;
        const orders = DB.getOrders().filter(order => {
            const existing = DB.getShipmentByOrder(order.id);
            const pendingId = FormDrafts.pendingFor('shipmentForm', {
                scope: businessDraftScope(DB, Auth),
                recordId: 'new:' + order.id
            });
            // Reopening a failed creation must update its pending ID, not create a second shipment.
            return !existing || String(existing.id) === String(pendingId);
        });
        const selected = orderId || orders[0]?.id || '';
        if (!orders.some(order => String(order.id) === String(selected))) {
            App.toast('当前法人没有可建立出运记录的订单', 'info');
            return;
        }
        const order = DB.getOrder(selected);
        const pendingId = FormDrafts.pendingFor('shipmentForm', {
            scope: businessDraftScope(DB, Auth),
            recordId: 'new:' + selected
        });
        const pending = pendingId ? DB.getShipment(pendingId) : null;
        const body = `<form id="shipmentForm" onsubmit="Shipping.saveShipment(event); return false;">
            <div class="form-group"><label class="form-label">关联操作单 *</label><select name="orderId" class="form-select" required onchange="Shipping.onOrderChange(this)">
            ${orders.map(item => `<option value="${App.escapeHtml(item.id)}" ${item.id === selected ? 'selected' : ''}>${App.escapeHtml(item.companyOperationNo || item.id)} · ${App.escapeHtml(item.customerName)}</option>`).join('')}</select></div>
            <div class="form-group"><label class="form-label">发票号码</label><input name="invoiceNo" class="form-input" value="${App.escapeHtml(pending?.invoiceNo || '')}"></div>
            <div class="form-row"><div class="form-group"><label class="form-label">起运港 *</label><input name="loadingPort" class="form-input" value="${App.escapeHtml(pending ? pending.loadingPort : order.loadingPort || '')}" required></div>
            <div class="form-group"><label class="form-label">海外港口</label><input name="overseasPort" class="form-input" value="${App.escapeHtml(pending ? pending.overseasPort : order.overseasPort || '')}" ${requiresOverseasPort(DB.getCurrentCompany()) ? 'required' : ''}></div></div>
            <div class="form-group"><label class="form-label">货物描述</label><input name="cargoDesc" class="form-input" value="${App.escapeHtml(pending ? pending.cargoDesc : order.productName || '')}"></div>
            ${this.statusFields(pending || { status: '待出运', customsStatus: '未报关', etd: order.expectedShipDate || '' })}
            <div class="form-row-3">${[
                ['grossWeight', '毛重 (KG)'],
                ['netWeight', '净重 (KG)'],
                ['volume', '体积 (CBM)']
            ]
                .map(
                    ([key, label]) =>
                        `<div class="form-group"><label class="form-label">${label}</label><input type="number" min="0" step="0.01" name="${key}" class="form-input" value="${App.escapeHtml(pending?.[key] ?? 0)}"></div>`
                )
                .join('')}</div>
        </form>`;
        App.showModal('建立出运记录', body, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal({discardDraft:true})">取消</button><button class="btn btn-primary" onclick="document.getElementById('shipmentForm').requestSubmit()">保存</button>`
        });
        this.attachDraft('shipmentForm', 'new:' + selected);
    },

    onOrderChange(select) {
        const order = DB.getOrder(select.value);
        if (!order) return;
        for (const key of ['loadingPort', 'overseasPort']) select.form.elements[key].value = order[key] || '';
        select.form.elements.cargoDesc.value = order.productName || '';
        select.form.elements.etd.value = order.expectedShipDate || '';
    },

    statusFields(shipment) {
        return `<div class="form-row"><div class="form-group"><label class="form-label">出运状态</label><select class="form-select" name="status">${['待出运', '已出运', '已到港', '已签收'].map(status => `<option value="${status}" ${status === shipment.status ? 'selected' : ''}>${status}</option>`).join('')}</select></div>
            <div class="form-group"><label class="form-label">报关状态</label><select class="form-select" name="customsStatus">${['未报关', '已报关', '清关中', '已清关'].map(status => `<option value="${status}" ${status === shipment.customsStatus ? 'selected' : ''}>${status}</option>`).join('')}</select></div></div>
            <div class="form-group"><label class="form-label">ETD (预计出运日期)</label><input type="date" class="form-input" name="etd" value="${App.escapeHtml(shipment.etd || '')}"></div>
            <div class="form-row">${[
                ['customsDate', '实际报关日期'],
                ['actualShipDate', '实际装船出运日期'],
                ['arrivalDate', '实际到港日期'],
                ['receivedDate', '实际签收日期']
            ]
                .map(
                    ([key, label]) =>
                        `<div class="form-group"><label class="form-label">${label}</label><input type="date" class="form-input" name="${key}" value="${App.escapeHtml(shipment[key] || '')}"></div>`
                )
                .join('')}</div>`;
    },

    validateShipment(value, creating = false) {
        if (!value.orderId || !String(value.loadingPort || '').trim()) return '请选择订单并填写起运港';
        const company = DB.companies.find(item => item.id === value.companyId);
        if (requiresOverseasPort(company) && !String(value.overseasPort || '').trim()) {
            return '香港公司出运记录须填写海外港口';
        }
        if (
            !['待出运', '已出运', '已到港', '已签收'].includes(value.status) ||
            !['未报关', '已报关', '清关中', '已清关'].includes(value.customsStatus)
        ) {
            return '出运或报关状态无效';
        }
        const validDate = date =>
            /^\d{4}-\d{2}-\d{2}$/.test(date || '') &&
            !Number.isNaN(Date.parse(date)) &&
            new Date(date).toISOString().slice(0, 10) === date;
        for (const key of ['etd', 'customsDate', 'actualShipDate', 'arrivalDate', 'receivedDate']) {
            if ((value[key] || (creating && key === 'etd')) && !validDate(value[key])) return '请填写有效日期';
        }
        const requiredMilestone = { 已出运: 'actualShipDate', 已到港: 'arrivalDate', 已签收: 'receivedDate' }[
            value.status
        ];
        if (requiredMilestone && !value[requiredMilestone]) return '请填写当前出运状态的实际发生日期';
        const dates = ['actualShipDate', 'arrivalDate', 'receivedDate'].map(key => value[key]).filter(Boolean);
        if (dates.some((date, index) => index > 0 && date < dates[index - 1])) {
            return '实际装船、到港及签收日期须按时间先后填写';
        }
        for (const key of ['grossWeight', 'netWeight', 'volume']) {
            if (Object.hasOwn(value, key) && (!Number.isFinite(value[key]) || value[key] < 0)) {
                return '重量和体积必须为非负数';
            }
        }
        if (Number(value.netWeight || 0) > Number(value.grossWeight || 0)) return '净重不能超过毛重';
        return '';
    },

    async saveShipment(event) {
        event.preventDefault();
        if (!FormDrafts.canSubmit(event.target)) return;
        if (!Auth.canEdit() || !DB._cloudReady) {
            App.toast('当前账号无编辑权限或数据库未连接', 'error');
            return;
        }
        const form = event.target;
        if (form.dataset.saving === 'true') return;
        const fd = new FormData(form);
        const order = DB.getOrder(fd.get('orderId'));
        if (!order || String(order.companyId) !== String(DB.currentCompanyId)) {
            App.toast('请选择当前法人的有效订单', 'error');
            return;
        }
        const value = { orderId: order.id, companyId: order.companyId };
        for (const key of [
            'invoiceNo',
            'loadingPort',
            'overseasPort',
            'cargoDesc',
            'status',
            'customsStatus',
            'etd',
            'customsDate',
            'actualShipDate',
            'arrivalDate',
            'receivedDate'
        ]) {
            value[key] = fd.get(key) || '';
        }
        for (const key of ['grossWeight', 'netWeight', 'volume']) value[key] = Number(fd.get(key) || 0);
        const invalid = this.validateShipment(value, true);
        if (invalid) {
            App.toast(invalid, 'error');
            return;
        }
        const saved = form.dataset.pendingRecordId
            ? DB.updateShipment(form.dataset.pendingRecordId, value)
            : DB.addShipment(value);
        if (!saved) return;
        form.dataset.pendingRecordId = saved.id;
        FormDrafts.stageRecord(form);
        DB.updateOrder(order.id, {
            shippingStatus: saved.status,
            ...(saved.actualShipDate ? { actualShipDate: saved.actualShipDate } : {})
        });
        form.dataset.saving = 'true';
        let ok = false;
        try {
            ok = await DB.flush();
        } catch {
            /* Keep this form and record for retry. */
        } finally {
            form.dataset.saving = 'false';
        }
        if (!ok) {
            App.toast('出运记录保存失败，草稿已保留，请重试', 'error');
            return;
        }
        if (!FormDrafts.acknowledgeStaged(form)) {
            App.toast('上一版已保存，当前新输入尚未保存，请再次保存', 'warning');
            return;
        }
        App.toast('出运记录已建立');
        App.closeModal();
        window.location.hash = '#/shipping/' + encodeURIComponent(saved.id);
    },

    updateStatus(shipmentId) {
        const shipment = DB.getShipment(shipmentId);
        if (!shipment || !Auth.canEdit()) return;
        App.showModal(
            '更新出运状态',
            `<form id="statusForm" onsubmit="Shipping.saveStatus(event, '${App.escapeHtml(shipmentId)}'); return false;">${this.statusFields(shipment)}</form>`,
            {
                footer: `<button class="btn btn-secondary" onclick="App.closeModal({discardDraft:true})">取消</button><button class="btn btn-primary" onclick="document.getElementById('statusForm').requestSubmit()">保存</button>`
            }
        );
        this.attachDraft('statusForm', shipmentId);
    },

    async saveStatus(event, shipmentId) {
        event.preventDefault();
        const form = event.target;
        if (form.dataset.saving === 'true') return;
        if (!FormDrafts.canSubmit(event.target)) return;
        if (!DB._cloudReady || !Auth.canEdit()) {
            App.toast('当前账号无编辑权限或数据库未连接', 'error');
            return;
        }
        const shipment = DB.getShipment(shipmentId);
        if (!shipment) return;
        const fd = new FormData(event.target);
        const updates = {};
        for (const key of [
            'status',
            'customsStatus',
            'etd',
            'customsDate',
            'actualShipDate',
            'arrivalDate',
            'receivedDate'
        ]) {
            if (fd.has(key)) updates[key] = fd.get(key) || '';
        }
        const invalid = this.validateShipment({ ...shipment, ...updates });
        if (invalid) {
            App.toast(invalid, 'error');
            return;
        }
        if (!DB.updateShipment(shipmentId, updates)) return;
        const order = DB.getOrder(shipment.orderId);
        if (order) {
            DB.updateOrder(order.id, {
                shippingStatus: updates.status || shipment.status,
                ...(updates.actualShipDate ? { actualShipDate: updates.actualShipDate } : {})
            });
        }
        FormDrafts.stageRecord(event.target);
        form.dataset.saving = 'true';
        let ok = false;
        try {
            ok = await DB.flush();
        } catch {
            /* Keep the current input for retry. */
        } finally {
            form.dataset.saving = 'false';
        }
        if (!ok) {
            App.toast('保存失败，草稿已保留，请重试', 'error');
            return;
        }
        if (!FormDrafts.acknowledgeStaged(form)) {
            App.toast('上一版已保存，当前新输入尚未保存，请再次保存', 'warning');
            return;
        }
        App.toast('出运状态已更新');
        App.closeModal();
        this.renderDetail(document.getElementById('pageContent'), shipmentId);
    },

    exportExcel() {
        const shipments = DB.getShipments();
        const headers = [
            'invoiceNo',
            'companyOperationNo',
            'orderId',
            'customerName',
            'loadingPort',
            'overseasPort',
            'etd',
            'customsDate',
            'actualShipDate',
            'arrivalDate',
            'receivedDate',
            'customsStatus',
            'status',
            'grossWeight',
            'netWeight',
            'volume'
        ];
        const labels = {
            invoiceNo: '发票号码',
            companyOperationNo: '操作单号',
            orderId: '关联订单ID',
            customerName: '客户',
            loadingPort: '起运港',
            overseasPort: '海外港口',
            etd: '预计离港',
            customsDate: '实际报关日期',
            actualShipDate: '实际装船日期',
            arrivalDate: '实际到港日期',
            receivedDate: '实际签收日期',
            customsStatus: '报关状态',
            status: '状态',
            grossWeight: '毛重(KG)',
            netWeight: '净重(KG)',
            volume: '体积(CBM)'
        };
        App.exportExcel(shipments, '出运列表_' + new Date().toISOString().split('T')[0] + '.xlsx', headers, labels);
    }
};

installBusinessModalHooks(App, FormDrafts);
window.Shipping = Shipping;
export { Shipping };
