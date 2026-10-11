/**
 * 物流单证跟踪模块
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';
import { escapeHtml, toast, validate } from './utils.js';

const Shipping = {
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
                </div>
            </div>

            <div class="stats-grid">
                ${(() => {
                    const orders = DB.getOrders();
                    const unshipped = orders.filter(o => o.shippingStatus === '待出运');
                    const shipped = orders.filter(o => o.shippingStatus !== '待出运');
                    const isHK = DB.currentCompanyId === 'CO-GW' || DB.currentCompanyId === 'CO-LK';
                    let freightCards = '';
                    if (!isHK) {
                        const totalFreightUSD = orders.reduce((s, o) => s + (o.freightCostUSD || 0), 0);
                        const totalFreightRMB = Math.round(DB.usdToRmb(totalFreightUSD) * 100) / 100;
                        const totalAmount = orders.reduce((s, o) => s + (o.orderAmountUSD || 0), 0);
                        const freightRatio =
                            totalAmount > 0 ? ((totalFreightUSD / totalAmount) * 100).toFixed(2) : '0.00';
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
                <td><span class="table-link" onclick="window.location.hash='#/shipping/${App.escapeHtml(s.id)}'">${App.escapeHtml(s.id)}</span></td>
                <td><span class="table-link" onclick="window.location.hash='#/orders/${App.escapeHtml(s.orderId)}'">${App.escapeHtml(s.orderId)}</span></td>
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

        document.getElementById('pageTitle').textContent = '出运详情 - ' + shipment.id;

        container.innerHTML = `
            <div class="flex gap-3 mb-4">
                <button class="btn btn-secondary" onclick="window.location.hash='#/shipping'">← 返回列表</button>
                ${order ? `<button class="btn btn-primary" onclick="window.location.hash='#/orders/${App.escapeHtml(order.id)}'">查看关联操作单</button>` : ''}
                <button class="btn btn-secondary" onclick="Shipping.updateStatus('${App.escapeHtml(shipment.id)}')">更新状态</button>
            </div>

            <div class="card mb-6">
                <div class="card-header"><span class="card-title">物流时间线</span></div>
                <div class="card-body">
                    <div class="timeline">
                        <div class="timeline-item">
                            <div class="timeline-dot ${shipment.status !== '待出运' ? 'done' : 'current'}"></div>
                            <div class="timeline-content">
                                <div class="timeline-title">货物备妥</div>
                                <div class="timeline-date">${order ? App.formatDate(order.orderDate) : '-'}</div>
                                <div class="timeline-desc">订单已确认，工厂开始生产</div>
                            </div>
                        </div>
                        <div class="timeline-item">
                            <div class="timeline-dot ${['已出运', '已到港', '已签收'].includes(shipment.status) ? 'done' : shipment.status === '待出运' ? 'current' : 'pending'}"></div>
                            <div class="timeline-content">
                                <div class="timeline-title">报关完成</div>
                                <div class="timeline-date">${App.formatDate(shipment.etd)}</div>
                                <div class="timeline-desc">${App.escapeHtml(shipment.customsStatus)}</div>
                            </div>
                        </div>
                        <div class="timeline-item">
                            <div class="timeline-dot ${['已出运', '已到港', '已签收'].includes(shipment.status) ? 'done' : shipment.status === '待出运' ? 'current' : 'pending'}"></div>
                            <div class="timeline-content">
                                <div class="timeline-title">货物装船出运</div>
                                <div class="timeline-date">${App.formatDate(shipment.etd)}</div>
                                <div class="timeline-desc">${App.escapeHtml(shipment.loadingPort)} → ${App.escapeHtml(shipment.overseasPort) || App.escapeHtml(shipment.destinationPort)}</div>
                            </div>
                        </div>
                        <div class="timeline-item">
                            <div class="timeline-dot ${shipment.status === '已签收' ? 'done' : shipment.status === '已到港' ? 'current' : 'pending'}"></div>
                            <div class="timeline-content">
                                <div class="timeline-title">客户签收</div>
                                <div class="timeline-date">${shipment.status === '已签收' ? App.formatDate(shipment.etd) : '待签收'}</div>
                                <div class="timeline-desc">货物已交付客户</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="card mb-6">
                <div class="card-header"><span class="card-title">出运信息</span></div>
                <div class="card-body">
                    <div class="detail-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                        <div class="detail-item"><div class="detail-label">发票号码</div><div class="detail-value">${App.escapeHtml(shipment.id)}</div></div>
                        <div class="detail-item"><div class="detail-label">关联操作单号</div><div class="detail-value">${App.escapeHtml(shipment.orderId)}</div></div>
                        <div class="detail-item"><div class="detail-label">客户</div><div class="detail-value">${App.escapeHtml(shipment.customerName)}</div></div>
                        <div class="detail-item"><div class="detail-label">货物描述</div><div class="detail-value">${App.escapeHtml(shipment.cargoDesc)}</div></div>
                        <div class="detail-item"><div class="detail-label">起运港</div><div class="detail-value">${App.escapeHtml(shipment.loadingPort)}</div></div>
                        <div class="detail-item"><div class="detail-label">海外港口</div><div class="detail-value">${App.escapeHtml(shipment.overseasPort) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">ETD (预计出运)</div><div class="detail-value">${App.formatDate(shipment.etd)}</div></div>
                        <div class="detail-item"><div class="detail-label">毛重 (KG)</div><div class="detail-value">${shipment.grossWeight.toLocaleString()}</div></div>
                        <div class="detail-item"><div class="detail-label">净重 (KG)</div><div class="detail-value">${shipment.netWeight.toLocaleString()}</div></div>
                        <div class="detail-item"><div class="detail-label">体积 (CBM)</div><div class="detail-value">${shipment.volume}</div></div>
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
                            <tr><td>操作单号</td><td>${App.escapeHtml(order.id)}</td></tr>
                            <tr><td>客户</td><td>${App.escapeHtml(order.customerName)}</td></tr>
                            <tr><td>产品</td><td>${App.escapeHtml(order.productName)}</td></tr>
                            <tr><td>订单金额</td><td>${App.formatMoney(order.orderAmountUSD, 'USD')}</td></tr>
                            <tr><td>收款状态</td><td>${App.getPaymentBadge(order.paymentStatus)}</td></tr>
                            <tr><td>订单状态</td><td>${App.getStatusBadge(order.status)}</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>`
                    : ''
            }
        `;
    },

    updateStatus(shipmentId) {
        const shipment = DB.getShipment(shipmentId);
        if (!shipment) return;
        const bodyHtml = `
            <form id="statusForm" onsubmit="Shipping.saveStatus(event, '${shipmentId}'); return false;">
                <div class="form-group">
                    <label class="form-label">出运状态</label>
                    <select class="form-select" name="status">
                        ${['待出运', '已出运', '已到港', '已签收'].map(s => `<option value="${s}" ${s === shipment.status ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">报关状态</label>
                    <select class="form-select" name="customsStatus">
                        ${['未报关', '已报关', '清关中', '已清关'].map(s => `<option value="${s}" ${s === shipment.customsStatus ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">实际出运日期 (ETD)</label>
                    <input type="date" class="form-input" name="etd" value="${shipment.etd}">
                </div>
            </form>
        `;
        App.showModal('更新出运状态', bodyHtml, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="document.getElementById('statusForm').requestSubmit()">💾 保存</button>`
        });
    },

    saveStatus(event, shipmentId) {
        const fd = new FormData(event.target);
        DB.updateShipment(shipmentId, {
            status: fd.get('status'),
            customsStatus: fd.get('customsStatus'),
            etd: fd.get('etd')
        });
        // 同步更新订单状态
        const shipment = DB.getShipment(shipmentId);
        if (shipment) {
            const orderUpdates = { shippingStatus: fd.get('status') };
            if (fd.get('status') === '已出运' && !DB.getOrder(shipment.orderId).actualShipDate) {
                orderUpdates.actualShipDate = fd.get('etd');
                orderUpdates.status = '已订船';
            }
            if (fd.get('status') === '已签收') {
                orderUpdates.status = '已订船';
            }
            DB.updateOrder(shipment.orderId, orderUpdates);
        }
        // ★ 显式 flush（updateOrder / updateShipment 不再自动 flush）
        DB.flush().then(ok => {
            if (!ok) App.toast('⚠️ 保存失败，请重试', 'error');
        });
        App.toast('出运状态已更新');
        App.closeModal();
        this.renderDetail(document.getElementById('pageContent'), shipmentId);
    },

    exportExcel() {
        const shipments = DB.getShipments();
        const headers = [
            'id',
            'orderId',
            'customerName',
            'loadingPort',
            'overseasPort',
            'etd',
            'customsStatus',
            'status',
            'grossWeight',
            'netWeight',
            'volume'
        ];
        const labels = {
            id: '发票号码',
            orderId: '操作单号',
            customerName: '客户',
            loadingPort: '起运港',
            overseasPort: '海外港口',
            etd: '预计离港',
            customsStatus: '报关状态',
            status: '状态',
            grossWeight: '毛重(KG)',
            netWeight: '净重(KG)',
            volume: '体积(CBM)'
        };
        App.exportExcel(shipments, '出运列表_' + new Date().toISOString().split('T')[0] + '.xlsx', headers, labels);
    }
};

window.Shipping = Shipping;
