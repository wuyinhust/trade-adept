/**
 * 订单管理模块
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';
import { escapeHtml, toast, validate } from './utils.js';
import { handleFileImport, processImportRows } from './order-import.js';

const Orders = {
    currentFilter: { status: 'all', paymentStatus: 'all', shippingStatus: 'all', search: '' },
    selectedOrders: new Set(),

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
                <select id="filterPayment" class="filter-select" onchange="Orders.filter()">
                    <option value="all">所有收款状态</option>
                    <option value="已收款">已收款</option>
                    <option value="部分收款">部分收款</option>
                    <option value="未收款">未收款</option>
                </select>
                <select id="filterShipping" class="filter-select" onchange="Orders.filter()">
                    <option value="all">所有出运状态</option>
                    <option value="待出运">待出运</option>
                    <option value="已出运">已出运</option>
                    <option value="已到港">已到港</option>
                    <option value="已签收">已签收</option>
                </select>
                ${Auth.isManager() || Auth.isSalesperson() || Auth.isDocument() ? `<span class="filter-info">👤 当前查看：${Auth.isManager() ? '我团队的订单' : (Auth.isDocument() ? '我团队及自己创建的订单' : '我的订单')}</span>` : ''}
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
                                ${showFinance ? '<th class="text-right">工厂成本(' + (DB.currentCompanyId === 'CO-GW' || DB.currentCompanyId === 'CO-LK' ? 'USD' : 'RMB') + ')</th><th class="text-right">利润率</th>' : ''}
                                <th>收款状态</th>
                                <th>工厂付款状态</th>
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
        const colSpan = showFinance ? 16 : 14;

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
                const isListHK = o.companyId === 'CO-GW' || o.companyId === 'CO-LK';
                return `
            <tr>
                <td class="checkbox-col"><input type="checkbox" ${checked} onchange="Orders.toggleSelect('${App.escapeHtml(o.id)}')"></td>
                <td><span class="table-link" onclick="window.location.hash='#/orders/${App.escapeHtml(o.id)}'">${App.escapeHtml(o.companyOperationNo) || '-'}</span></td>
                <td class="text-sm">${App.escapeHtml(o.customerOrderNo) || '-'}</td>
                <td>${App.escapeHtml(o.customerName)}</td>
                <td>${App.escapeHtml(o.contactPerson) || '-'}</td>
                <td class="text-sm">${App.escapeHtml(o.productName)}</td>
                <td>${App.formatDate(o.orderDate)}</td>
                <td>${o.actualShipDate ? App.formatDate(o.actualShipDate) : '<span class="text-gray">' + App.formatDate(o.expectedShipDate) + '</span>'}</td>
                <td class="text-right font-semi">${App.formatMoney(o.orderAmountUSD, 'USD')}</td>
                ${
                    showFinance
                        ? `
                <td class="text-right">${App.formatMoney(o.factoryCostRMB, isListHK ? 'USD' : 'CNY')}</td>
                <td class="text-right ${App.getProfitColor(o.profitRate)} font-semi">${o.profitRate.toFixed(1)}%</td>`
                        : ''
                }
                <td>${App.getPaymentBadge(o.paymentStatus)}</td>
                <td>${App.getFactoryPaidBadge(o.factoryPaidStatus)}</td>
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
                          totalAmount: order.factoryCostRMB,
                          prepayment: order.factoryPaidRMB || 0,
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
        const canDel = Auth.canDeleteOrder(order);
        const isDomestic = order.companyId === 'CO-GR' || order.companyId === 'CO-WY';
        const isHK = order.companyId === 'CO-GW' || order.companyId === 'CO-LK';
        const detailFinanceTitle = isDomestic ? '订单信息' : '财务明细';

        document.getElementById('pageTitle').textContent = '订单详情 - ' + orderId;

        container.innerHTML = `
            <div class="flex gap-3 mb-4">
                <button class="btn btn-secondary" onclick="window.location.hash='#/orders'">← 返回列表</button>
                <button class="btn btn-primary" onclick="Orders.showEditForm('${App.escapeHtml(order.id)}')">✏️ 编辑订单</button>
                ${showFinance ? `<button class="btn btn-secondary" onclick="Orders.updatePayment('${App.escapeHtml(order.id)}')">💰 更新付款</button>` : ''}
                ${canDel ? `<div style="margin-left:auto"><button class="btn btn-danger" onclick="Orders.deleteOrder('${App.escapeHtml(order.id)}')">🗑️ 删除订单</button></div>` : ''}
            </div>

            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon blue">💵</div></div>
                    <div class="stat-label">订单金额</div>
                    <div class="stat-value">${App.formatMoney(order.orderAmountUSD, 'USD')}</div>
                    ${isHK ? '' : `<div class="stat-sub">≈ ${App.formatMoney(order.orderAmountRMB, 'CNY')}</div>`}
                </div>
                ${
                    showFinance
                        ? `
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon orange">🏭</div></div>
                    <div class="stat-label">工厂成本</div>
                    <div class="stat-value">${App.formatMoney(order.factoryCostRMB, isHK ? 'USD' : 'CNY')}</div>
                    <div class="stat-sub">付款：${App.escapeHtml(order.factoryPaidStatus)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon green">📈</div></div>
                    <div class="stat-label">利润</div>
                    <div class="stat-value ${App.getProfitColor(order.profitRate)}">${App.formatMoney(order.profitRMB, isHK ? 'USD' : 'CNY')}</div>
                    <div class="stat-sub">利润率 ${order.profitRate.toFixed(2)}%</div>
                </div>`
                        : `
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon orange">📦</div></div>
                    <div class="stat-label">产品数量</div>
                    <div class="stat-value">${order.quantity || factoryDataList.reduce((s, f) => s + (f.totalQuantity || 0), 0)}</div>
                    <div class="stat-sub">${App.escapeHtml(order.unit)}</div>
                </div>`
                }
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon red">💳</div></div>
                    <div class="stat-label">收款进度</div>
                    <div class="stat-value">${App.formatMoney(order.paidAmountUSD, 'USD')}</div>
                    <div class="stat-sub">${App.escapeHtml(order.paymentStatus)} / 共 ${showFinance ? App.formatMoney(order.orderAmountUSD, 'USD') : '---'}</div>
                </div>
            </div>

            <div class="card mb-6">
                <div class="card-header"><span class="card-title">基本信息</span></div>
                <div class="card-body">
                    <div class="detail-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                        <div class="detail-item"><div class="detail-label">公司操作单号</div><div class="detail-value">${App.escapeHtml(order.id)}</div></div>
                        <div class="detail-item"><div class="detail-label">客户订单号</div><div class="detail-value">${App.escapeHtml(order.customerOrderNo) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">订单状态</div><div class="detail-value">${App.getStatusBadge(order.status)}</div></div>
                        <div class="detail-item"><div class="detail-label">客户</div><div class="detail-value">${App.escapeHtml(order.customerName)}</div></div>
                        <div class="detail-item"><div class="detail-label">客户联系人</div><div class="detail-value">${App.escapeHtml(order.contactPerson) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">工厂</div><div class="detail-value">${App.escapeHtml(factoryDisplay)}</div></div>
                        <div class="detail-item"><div class="detail-label">产品名称</div><div class="detail-value">${App.escapeHtml(order.productName)}</div></div>
                        <div class="detail-item"><div class="detail-label">产品类别</div><div class="detail-value">${App.escapeHtml(order.productCategory)}</div></div>
                        <div class="detail-item"><div class="detail-label">数量</div><div class="detail-value">${order.quantity} ${App.escapeHtml(order.unit)}</div></div>
                        <div class="detail-item"><div class="detail-label">下单日期</div><div class="detail-value">${App.formatDate(order.orderDate)}</div></div>
                        <div class="detail-item"><div class="detail-label">预计出运</div><div class="detail-value">${App.formatDate(order.expectedShipDate)}</div></div>
                        <div class="detail-item"><div class="detail-label">实际出运</div><div class="detail-value">${order.actualShipDate ? App.formatDate(order.actualShipDate) : '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">起运港</div><div class="detail-value">${App.escapeHtml(order.loadingPort)}</div></div>
                        <div class="detail-item"><div class="detail-label">目的港</div><div class="detail-value">${App.escapeHtml(order.destinationPort)}</div></div>
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
                            <div><span class="text-gray">产品类型：</span>${App.escapeHtml(f.productType) || '-'}</div>
                            <div><span class="text-gray">总数量：</span>${f.totalQuantity || 0}</div>
                            <div><span class="text-gray">总金额：</span>${App.formatMoney(f.totalAmount || 0, isHK ? 'USD' : 'CNY')}</div>
                            <div><span class="text-gray">预付款：</span>${App.formatMoney(f.prepayment || 0, isHK ? 'USD' : 'CNY')}</div>
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
                            <tr><td>订单总金额 (USD)</td><td class="text-right font-bold">${App.formatMoney(order.orderAmountUSD, 'USD')}</td></tr>
                            ${isHK ? '' : `<tr><td>订单总金额 (RMB)</td><td class="text-right">${App.formatMoney(order.orderAmountRMB, 'CNY')}</td></tr>`}
                            <tr><td>工厂成本 (${isHK ? 'USD' : 'RMB'})</td><td class="text-right text-danger">${App.formatMoney(order.factoryCostRMB, isHK ? 'USD' : 'CNY')}</td></tr>
                            ${
                                isHK
                                    ? ''
                                    : `
                            <tr><td>货代费 (RMB)</td><td class="text-right text-danger">${App.formatMoney(order.freightCostUSD, 'CNY')}</td></tr>
                            <tr><td>退税率 (%)</td><td class="text-right text-danger">${order.insuranceCostUSD.toFixed(2)}%</td></tr>`
                            }
                            <tr><td>${isDomestic ? '其他费用 (RMB)' : '其他费用 (USD)'}</td><td class="text-right text-danger">${App.formatMoney(order.otherCostUSD, isHK ? 'USD' : 'CNY')}</td></tr>
                            <tr style="border-top:2px solid var(--gray-300)"><td class="font-bold">利润 (${isHK ? 'USD' : 'RMB'})</td><td class="text-right font-bold ${App.getProfitColor(order.profitRate)}">${App.formatMoney(order.profitRMB, isHK ? 'USD' : 'CNY')}</td></tr>
                            <tr><td class="text-gray">利润率</td><td class="text-right font-bold ${App.getProfitColor(order.profitRate)}">${order.profitRate.toFixed(2)}%</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>`
                    : ''
            }

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
                        <div class="detail-item"><div class="detail-label">提单号</div><div class="detail-value">${App.escapeHtml(shipment.blNumber)}</div></div>
                        <div class="detail-item"><div class="detail-label">集装箱号</div><div class="detail-value">${App.escapeHtml(shipment.containerNo)}</div></div>
                        <div class="detail-item"><div class="detail-label">船名</div><div class="detail-value">${App.escapeHtml(shipment.vessel)} (${App.escapeHtml(shipment.voyage)})</div></div>
                        <div class="detail-item"><div class="detail-label">报关状态</div><div class="detail-value">${App.getCustomsBadge(shipment.customsStatus)}</div></div>
                        <div class="detail-item"><div class="detail-label">ETD (出运日)</div><div class="detail-value">${App.formatDate(shipment.etd)}</div></div>
                        <div class="detail-item"><div class="detail-label">ETA (到港日)</div><div class="detail-value">${App.formatDate(shipment.eta)}</div></div>
                        <div class="detail-item"><div class="detail-label">毛重 (kg)</div><div class="detail-value">${shipment.grossWeight.toLocaleString()}</div></div>
                        <div class="detail-item"><div class="detail-label">体积 (CBM)</div><div class="detail-value">${shipment.volume}</div></div>
                    </div>
                </div>
            </div>`
                    : ''
            }

            ${'' /* 单证管理模块已移除 */}
        `;
    },

    // ==================== 新建/编辑订单 ====================
    showAddForm() {
        this._factoryIndex = 1;
        const customers = DB.getCustomers();
        const factories = DB.getFactories();
        const today = new Date().toISOString().split('T')[0];
        const showFinance = Auth.canSeeFinancials();
        const showSalesSelect = Auth.canSeeAll();
        const isDomestic = DB.currentCompanyId === 'CO-GR' || DB.currentCompanyId === 'CO-WY';
        const isHK = DB.currentCompanyId === 'CO-GW' || DB.currentCompanyId === 'CO-LK';
        this._isHK = isHK; // 供工厂卡片使用
        const financeTitle = isDomestic ? '💰 订单信息' : '💰 财务信息 (USD)';
        const factoryCostLabel = isHK ? '工厂成本 (USD)' : '工厂成本 (RMB)';
        const otherLabel = isDomestic ? '其他费用 (RMB)' : '其他费用 (USD)';
        const profitLabel = isHK ? '预计利润 (USD)' : '预计利润 (RMB)';
        const freightLabel = isDomestic ? '货代费 (RMB)' : '';
        const insuranceLabel = isDomestic ? '退税率 (%)' : '';
        const opNoPreview = DB.generateCompanyOperationNo(DB.currentCompanyId, Auth.currentUser?.id || 'U005');

        const bodyHtml = `
            <form id="orderForm" onsubmit="Orders.saveOrder(event); return false;">
                ${
                    showSalesSelect
                        ? `
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">业务员 <span class="required">*</span></label>
                        <select class="form-select" name="salespersonId" required>
                            ${Auth.users
                                .filter(u => u.role === 'salesperson' || u.role === 'manager')
                                .map(
                                    u =>
                                        `<option value="${u.id}" ${Auth.currentUser && Auth.currentUser.id === u.id ? 'selected' : ''}>${u.name} (${u.role === 'manager' ? '经理' : '业务员'})</option>`
                                )
                                .join('')}
                        </select>
                    </div>
                </div>`
                        : `<input type="hidden" name="salespersonId" value="${Auth.currentUser ? Auth.currentUser.id : ''}">`
                }
                <div class="form-group">
                    <label class="form-label">客户 <span class="required">*</span></label>
                    <select class="form-select" name="customerId" required onchange="Orders.onCustomerChange(this)">
                        <option value="">请选择客户</option>
                        ${customers.map(c => `<option value="${c.id}" data-payment="${c.paymentTerms}">${c.company} (${c.country})</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">客户联系人 <span class="required">*</span></label>
                    <select class="form-select" name="contactPerson" required id="orderContactSelect">
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
                        isHK
                            ? `
                    <div class="form-group">
                        <label class="form-label">海外港口</label>
                        <input type="text" class="form-input" name="overseasPort" placeholder="例：Los Angeles / Hamburg / Dubai">
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
                        <input type="text" class="form-input" name="companyOperationNo" required placeholder="${isDomestic ? (DB.currentCompanyId === 'CO-GR' ? 'GR' : 'WY') : 'OP'}26A001（留空自动生成）" value="${opNoPreview}">
                    </div>
                </div>
                <hr style="border:none;border-top:1px solid var(--gray-200);margin:16px 0">
                <div class="form-section-header">
                    <h3 class="font-semi mb-1">🏭 工厂信息</h3>
                    <span class="text-xs text-gray">填写每个工厂的详细生产信息</span>
                </div>
                <div id="factoryCards">
                    ${this.createFactoryRow(0)}
                </div>
                <button type="button" class="btn btn-sm btn-secondary" onclick="Orders.addFactoryRow()" style="margin-top:8px">＋ 添加工厂</button>
                <input type="hidden" name="expectedShipDate" value="">`
                        : `
                <h3 class="font-semi mb-3">💰 金额信息</h3>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">订单金额 (USD) <span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input" name="orderAmountUSD" required placeholder="0.00">
                    </div>
                    <input type="hidden" name="factoryCostRMB" value="0">
                    <input type="hidden" name="freightCostUSD" value="0">
                    <input type="hidden" name="insuranceCostUSD" value="0">
                    <input type="hidden" name="otherCostUSD" value="0">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">公司操作单号 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="companyOperationNo" required placeholder="${isDomestic ? (DB.currentCompanyId === 'CO-GR' ? 'GR' : 'WY') : 'OP'}26A001（留空自动生成）" value="${opNoPreview}">
                    </div>
                </div>`
                }
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
                </div>
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
        App.showModal('新建订单', bodyHtml, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="document.getElementById('orderForm').requestSubmit()">💾 保存订单</button>`
        });
    },

    showEditForm(orderId) {
        this._factoryIndex = 1;
        const order = DB.getOrder(orderId);
        if (!order) return;
        const customers = DB.getCustomers();
        const customer = customers.find(c => String(c.id) === String(order.customerId));
        const showFinance = Auth.canSeeFinancials();
        const showSalesSelect = Auth.canSeeAll();
        const isDomestic = order.companyId === 'CO-GR' || order.companyId === 'CO-WY';
        const isHK = order.companyId === 'CO-GW' || order.companyId === 'CO-LK';
        this._isHK = isHK; // 供工厂卡片使用
        const financeTitle = isDomestic ? '💰 订单信息' : '💰 财务信息 (USD)';
        const factoryCostLabel = isHK ? '工厂成本 (USD)' : '工厂成本 (RMB)';
        const otherLabel = isDomestic ? '其他费用 (RMB)' : '其他费用 (USD)';
        const profitLabel = isHK ? '预计利润 (USD)' : '预计利润 (RMB)';
        const freightLabel = isDomestic ? '货代费 (RMB)' : '';
        const insuranceLabel = isDomestic ? '退税率 (%)' : '';

        // 构建工厂数据（新模型优先，兼容旧数据）
        const factoryDataList =
            order.factories && order.factories.length > 0
                ? order.factories
                : [
                      {
                          factoryId: order.factoryId,
                          productType: order.productCategory,
                          totalQuantity: order.quantity,
                          totalAmount: order.factoryCostRMB,
                          prepayment: 0,
                          inspectionDate: '',
                          estimatedShipDate: order.expectedShipDate
                      }
                  ];
        this._factoryIndex = factoryDataList.length;
        const factoryCardsHtml = factoryDataList.map((fd, idx) => this.createFactoryRow(idx, fd)).join('');

        const bodyHtml = `
            <form id="orderForm" onsubmit="Orders.saveOrder(event, '${orderId}'); return false;">
                ${
                    showSalesSelect
                        ? `
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">业务员</label>
                        <select class="form-select" name="salespersonId">
                            ${Auth.users
                                .filter(u => u.role === 'salesperson' || u.role === 'manager')
                                .map(
                                    u =>
                                        `<option value="${u.id}" ${u.id === (order.salespersonId || '') ? 'selected' : ''}>${u.name}</option>`
                                )
                                .join('')}
                        </select>
                    </div>
                </div>`
                        : `<input type="hidden" name="salespersonId" value="${order.salespersonId || ''}">`
                }
                <div class="form-group">
                    <label class="form-label">客户 <span class="required">*</span></label>
                    <select class="form-select" name="customerId" required onchange="Orders.onCustomerChange(this)">
                        ${customers.map(c => `<option value="${c.id}" ${String(c.id) === String(order.customerId) ? 'selected' : ''}>${c.company} (${c.country})</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">客户联系人 <span class="required">*</span></label>
                    <select class="form-select" name="contactPerson" required id="orderContactSelect">
                        ${this.getContactOptions(customer, order.contactPerson || '')}
                    </select>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">客户订单号 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="customerOrderNo" required value="${(order.customerOrderNo || '').replace(/"/g, '&quot;')}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">下单日期</label>
                        <input type="date" class="form-input" name="orderDate" value="${order.orderDate}">
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
                        isHK
                            ? `
                    <div class="form-group">
                        <label class="form-label">海外港口</label>
                        <input type="text" class="form-input" name="overseasPort" value="${(order.overseasPort || '').replace(/"/g, '&quot;')}" placeholder="例：Los Angeles / Hamburg / Dubai">
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
                        <input type="number" step="0.01" class="form-input" name="orderAmountUSD" value="${order.orderAmountUSD}" oninput="Orders.calcProfit()">
                    </div>
                    <div class="form-group">
                        <label class="form-label">${factoryCostLabel} <span class="text-xs text-gray" style="font-weight:400">自动计算</span></label>
                        <input type="number" step="0.01" class="form-input" name="factoryCostRMB" value="${order.factoryCostRMB}" readonly style="background:var(--gray-100);color:var(--gray-600)">
                    </div>
                    ${
                        isHK
                            ? ''
                            : `
                    <div class="form-group">
                        <label class="form-label">${freightLabel}</label>
                        <input type="number" step="0.01" class="form-input" name="freightCostUSD" value="${order.freightCostUSD}" oninput="Orders.calcProfit()">
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
                        <input type="number" step="0.01" class="form-input" name="insuranceCostUSD" value="${order.insuranceCostUSD}" oninput="Orders.calcProfit()">
                    </div>`
                    }
                    <div class="form-group">
                        <label class="form-label">${otherLabel}</label>
                        <input type="number" step="0.01" class="form-input" name="otherCostUSD" value="${order.otherCostUSD}" oninput="Orders.calcProfit()">
                    </div>
                    <div class="form-group">
                        <label class="form-label">${profitLabel}</label>
                        <input type="text" class="form-input" id="calcProfit" readonly value="${order.profitRMB}" style="font-weight:600;color:var(--success)">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">公司操作单号 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="companyOperationNo" required value="${(order.companyOperationNo || '').replace(/"/g, '&quot;')}">
                    </div>
                </div>
                <hr style="border:none;border-top:1px solid var(--gray-200);margin:16px 0">
                <div class="form-section-header">
                    <h3 class="font-semi mb-1">🏭 工厂信息</h3>
                    <span class="text-xs text-gray">填写每个工厂的详细生产信息</span>
                </div>
                <div id="factoryCards">
                    ${factoryCardsHtml}
                </div>
                <button type="button" class="btn btn-sm btn-secondary" onclick="Orders.addFactoryRow()" style="margin-top:8px">＋ 添加工厂</button>
                <input type="hidden" name="expectedShipDate" value="${order.expectedShipDate || ''}">
                <input type="hidden" name="actualShipDate" value="${order.actualShipDate || ''}">`
                        : `
                <h3 class="font-semi mb-3">💰 金额信息</h3>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">订单金额 (USD)</label>
                        <input type="number" step="0.01" class="form-input" name="orderAmountUSD" value="${order.orderAmountUSD}">
                    </div>
                    <input type="hidden" name="factoryCostRMB" value="${order.factoryCostRMB}">
                    <input type="hidden" name="freightCostUSD" value="${order.freightCostUSD}">
                    <input type="hidden" name="insuranceCostUSD" value="${order.insuranceCostUSD}">
                    <input type="hidden" name="otherCostUSD" value="${order.otherCostUSD}">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">公司操作单号 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="companyOperationNo" required value="${(order.companyOperationNo || '').replace(/"/g, '&quot;')}">
                    </div>
                </div>`
                }
                <hr style="border:none;border-top:1px solid var(--gray-200);margin:16px 0">
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">收款状态</label>
                        <select class="form-select" name="paymentStatus">
                            ${['未收款', '部分收款', '已收款'].map(s => `<option value="${s}" ${s === order.paymentStatus ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">已收款 (USD)</label>
                        <input type="number" step="0.01" class="form-input" name="paidAmountUSD" value="${order.paidAmountUSD}">
                    </div>
                </div>
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
                        <label class="form-label">已付工厂 (${isHK ? 'USD' : 'RMB'})</label>
                        <input type="number" step="0.01" class="form-input" name="factoryPaidRMB" value="${order.factoryPaidRMB || 0}">
                    </div>
                </div>`
                        : ''
                }
                <div class="form-group">
                    <label class="form-label">备注</label>
                    <textarea class="form-textarea" name="remarks">${order.remarks || ''}</textarea>
                </div>
            </form>
        `;
        App.showModal('编辑订单 - ' + orderId, bodyHtml, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="document.getElementById('orderForm').requestSubmit()">💾 保存修改</button>`
        });
        this.updateFactoryCost();
        this.calcProfit();
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

    /** 生成联系人下拉选项 HTML */
    getContactOptions(customer, selectedName = '') {
        if (!customer) return '<option value="">请先选择客户</option>';
        const contacts = customer.contacts || [];
        if (contacts.length === 0) {
            // 没有结构化联系人数据，用旧 contact 字段兜底
            const fallback = customer.contact || '';
            if (!fallback) return '<option value="">无联系人</option>';
            const sel = fallback === selectedName ? ' selected' : '';
            return `<option value="${fallback.replace(/"/g, '&quot;')}"${sel}>${fallback}</option>`;
        }
        return contacts
            .map(ct => {
                const selected = ct.name === selectedName ? ' selected' : '';
                return `<option value="${ct.name.replace(/"/g, '&quot;')}"${selected}>${ct.name}${ct.position ? ' (' + ct.position + ')' : ''}</option>`;
            })
            .join('');
    },

    createFactoryRow(index, data = {}) {
        const factories = DB.getFactories();
        const currency = this._isHK ? 'USD' : 'RMB';
        return `
            <div class="factory-card" data-factory-index="${index}">
                <div class="factory-card-header">
                    <span class="factory-card-title">工厂 ${index + 1}</span>
                    ${index > 0 ? `<button type="button" class="btn btn-sm btn-outline-danger" onclick="Orders.removeFactoryRow(this)">✕ 删除</button>` : ''}
                </div>
                <div class="form-row-3">
                    <div class="form-group">
                        <label class="form-label">工厂名称 <span class="required">*</span></label>
                        <select class="form-select" name="factory_${index}_id" required>
                            <option value="">请选择工厂</option>
                            ${factories.map(f => `<option value="${f.id}" ${data.factoryId === f.id ? 'selected' : ''}>${f.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">产品类型 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="factory_${index}_productType" value="${data.productType || ''}" placeholder="例：电子产品" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">总数量 <span class="required">*</span></label>
                        <input type="number" class="form-input" name="factory_${index}_quantity" value="${data.totalQuantity || ''}" placeholder="0" required>
                    </div>
                </div>
                <div class="form-row-3">
                    <div class="form-group">
                        <label class="form-label">总金额 (${currency}) <span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input factory-amount" name="factory_${index}_amount" value="${data.totalAmount || ''}" placeholder="0.00" oninput="Orders.updateFactoryCost()" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">预付款 (${currency}) <span class="required">*</span></label>
                        <input type="number" step="0.01" class="form-input" name="factory_${index}_prepayment" value="${data.prepayment || ''}" placeholder="0.00" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">预计验货日期 <span class="required">*</span></label>
                        <input type="date" class="form-input" name="factory_${index}_inspectionDate" value="${data.inspectionDate || ''}" required>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">预计出货日期 <span class="required">*</span></label>
                        <input type="date" class="form-input" name="factory_${index}_shipDate" value="${data.estimatedShipDate || ''}" required>
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
        const amounts = document.querySelectorAll('#factoryCards .factory-amount');
        let total = 0;
        amounts.forEach(input => {
            total += parseFloat(input.value) || 0;
        });
        const costInput = document.querySelector('input[name="factoryCostRMB"]');
        if (costInput) {
            costInput.value = total.toFixed(2);
        }
        if (typeof Orders !== 'undefined' && Orders.calcProfit) {
            Orders.calcProfit();
        }
    },

    calcProfit() {
        const form = document.getElementById('orderForm');
        if (!form) return;
        const usd = parseFloat(form.orderAmountUSD.value) || 0;
        const factoryRMB = parseFloat(form.factoryCostRMB.value) || 0;
        // HK 公司不渲染货代费和退税率字段，用可选链防止 TypeError
        const freight = parseFloat(form.freightCostUSD?.value) || 0;
        const insurance = parseFloat(form.insuranceCostUSD?.value) || 0;
        const other = parseFloat(form.otherCostUSD.value) || 0;

        // 实时预览利润：直接用当前登录公司判断公式（与表单标签一致）
        const companyId = DB.currentCompanyId;
        const profit = DB.calcOrderProfit(usd, factoryRMB, freight, insurance, other, companyId);
        const el = document.getElementById('calcProfit');
        if (el) {
            el.value = profit.toFixed(2);
            el.style.color = profit >= 0 ? 'var(--success)' : 'var(--danger)';
        }
    },

    async saveOrder(event, orderId = null) {
        event.preventDefault();

        if (!DB._cloudReady) {
            App.toast('⚠️ 云端未连接，请检查网络后刷新重试', 'error');
            return;
        }

        const form = event.target;
        const fd = new FormData(form);
        const customer = DB.getCustomer(fd.get('customerId'));

        // 收集工厂信息（从动态工厂卡片）
        const factoryCards = form.querySelectorAll('#factoryCards .factory-card');
        const factories = [];
        factoryCards.forEach(card => {
            const idx = card.dataset.factoryIndex;
            const factoryId = fd.get(`factory_${idx}_id`) || '';
            if (!factoryId) return; // 跳过未选工厂的行
            const f = DB.getFactory(factoryId);
            factories.push({
                factoryId: factoryId,
                factoryName: f ? f.name : factoryId,
                productType: fd.get(`factory_${idx}_productType`) || '',
                totalQuantity: parseFloat(fd.get(`factory_${idx}_quantity`)) || 0,
                totalAmount: parseFloat(fd.get(`factory_${idx}_amount`)) || 0,
                prepayment: parseFloat(fd.get(`factory_${idx}_prepayment`)) || 0,
                inspectionDate: fd.get(`factory_${idx}_inspectionDate`) || '',
                estimatedShipDate: fd.get(`factory_${idx}_shipDate`) || ''
            });
        });

        const factoryIds = factories.map(f => f.factoryId);
        const factoryNames = factories.map(f => f.factoryName).join('、');
        const primaryFactoryId = factories.length > 0 ? factories[0].factoryId : '';
        // 工厂成本 = 所有工厂总金额之和，优先以表单自动计算值为准
        const totalFactoryCost = factories.reduce((sum, f) => sum + f.totalAmount, 0);
        const factoryCostRMB = parseFloat(fd.get('factoryCostRMB')) || totalFactoryCost || 0;

        // 预计出运日期取最早出货工厂的日期
        const shipDates = factories
            .map(f => f.estimatedShipDate)
            .filter(Boolean)
            .sort();
        const expectedShipDate = shipDates.length > 0 ? shipDates[0] : fd.get('expectedShipDate') || '';

        const data = {
            customerId: fd.get('customerId'),
            customerName: customer?.company || '',
            contactPerson: fd.get('contactPerson') || '',
            factoryId: primaryFactoryId,
            factoryIds: factoryIds,
            factoryName: factoryNames,
            factories: factories,
            productCategory: factoryNames,
            productName:
                factories
                    .map(f => f.productType)
                    .filter(Boolean)
                    .join('、') || factoryNames,
            quantity: factories.reduce((sum, f) => sum + f.totalQuantity, 0),
            unit: 'PCS',
            orderDate: fd.get('orderDate'),
            expectedShipDate: expectedShipDate,
            actualShipDate: fd.get('actualShipDate') || null,
            orderAmountUSD: parseFloat(fd.get('orderAmountUSD')) || 0,
            factoryCostRMB: factoryCostRMB,
            freightCostUSD: parseFloat(fd.get('freightCostUSD')) || 0,
            insuranceCostUSD: parseFloat(fd.get('insuranceCostUSD')) || 0,
            otherCostUSD: parseFloat(fd.get('otherCostUSD')) || 0,
            paymentStatus: fd.get('paymentStatus'),
            paidAmountUSD: parseFloat(fd.get('paidAmountUSD')) || 0,
            status: fd.get('status'),
            shippingStatus: fd.get('shippingStatus') || '待出运',
            factoryPaidStatus: fd.get('factoryPaidStatus') || '未付款',
            factoryPaidRMB: parseFloat(fd.get('factoryPaidRMB')) || 0,
            paymentTerms: fd.get('paymentTerms') || '',
            loadingPort: fd.get('loadingPort') || '',
            destinationPort: customer?.country || '',
            overseasPort: fd.get('overseasPort') || '',
            remarks: fd.get('remarks') || '',
            customerOrderNo: fd.get('customerOrderNo') || '',
            companyOperationNo: fd.get('companyOperationNo') || '',
            salespersonId: fd.get('salespersonId') || (Auth.currentUser ? Auth.currentUser.id : null)
        };

        if (orderId) {
            const updated = DB.updateOrder(orderId, data);
            if (!updated) {
                App.toast('⚠️ 订单不存在，无法更新', 'error');
                return;
            }
        } else {
            const newOrder = DB.addOrder(data);
            if (!newOrder) {
                App.toast('⚠️ 订单创建失败，请检查必填字段', 'error');
                return;
            }
        }

        const ok = await DB.flush();
        if (!ok) {
            App.toast('⚠️ 保存到云端失败，请稍后重试', 'error');
            return;
        }

        App.toast(orderId ? '订单更新成功' : '订单创建成功');
        App.closeModal();
        if (orderId) {
            this.renderDetail(document.getElementById('pageContent'), orderId);
        } else {
            this.renderTable();
        }
    },

    updatePayment(orderId) {
        const order = DB.getOrder(orderId);
        if (!order) return;
        const remaining = order.orderAmountUSD - order.paidAmountUSD;
        const bodyHtml = `
            <form id="paymentForm" onsubmit="Orders.savePayment(event, '${orderId}'); return false;">
                <div class="detail-item mb-4">
                    <div class="detail-label">订单金额</div>
                    <div class="detail-value">${App.formatMoney(order.orderAmountUSD, 'USD')}</div>
                </div>
                <div class="detail-item mb-4">
                    <div class="detail-label">已收款</div>
                    <div class="detail-value">${App.formatMoney(order.paidAmountUSD, 'USD')}</div>
                </div>
                <div class="detail-item mb-4">
                    <div class="detail-label">待收余额</div>
                    <div class="detail-value text-warning">${App.formatMoney(remaining, 'USD')}</div>
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
        const amount = parseFloat(fd.get('amount')) || 0;
        const status = fd.get('paymentStatus');
        const order = DB.getOrder(orderId);
        const newPaid = order.paidAmountUSD + amount;
        const updated = DB.updateOrder(orderId, { paidAmountUSD: newPaid, paymentStatus: status });
        if (!updated) {
            App.toast('⚠️ 订单不存在，无法更新', 'error');
            return;
        }

        const ok = await DB.flush();
        if (!ok) {
            App.toast('⚠️ 保存到云端失败，请稍后重试', 'error');
            return;
        }

        App.toast('收款记录已更新');
        App.closeModal();
        this.renderDetail(document.getElementById('pageContent'), orderId);
    },

    deleteOrder(orderId) {
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

    exportExcel() {
        const orders = DB.getOrders(this.currentFilter);
        const isHK = DB.currentCompanyId === 'CO-GW' || DB.currentCompanyId === 'CO-LK';
        const cc = isHK ? 'USD' : 'RMB';
        const headers = [
            'id',
            'customerOrderNo',
            'companyOperationNo',
            'customerName',
            'contactPerson',
            'productName',
            'orderDate',
            'expectedShipDate',
            'actualShipDate',
            'orderAmountUSD',
            'orderAmountRMB',
            'factoryCostRMB',
            'freightCostUSD',
            'insuranceCostUSD',
            'otherCostUSD',
            'profitRMB',
            'profitRate',
            'paymentStatus',
            'paidAmountUSD',
            'factoryPaidStatus',
            'status',
            'shippingStatus',
            'loadingPort',
            'destinationPort',
            'overseasPort'
        ];
        const labels = {
            id: '订单号',
            customerOrderNo: '客户订单号',
            companyOperationNo: '公司操作单号',
            customerName: '客户',
            contactPerson: '联系人',
            productName: '产品',
            orderDate: '下单日期',
            expectedShipDate: '预计出运',
            actualShipDate: '实际出运',
            orderAmountUSD: '订单金额(USD)',
            orderAmountRMB: `订单金额(${cc})`,
            factoryCostRMB: `工厂成本(${cc})`,
            freightCostUSD: `运费(${cc})`,
            insuranceCostUSD: `保险费(${cc})`,
            otherCostUSD: `其他费用(${cc})`,
            profitRMB: `利润(${cc})`,
            profitRate: '利润率(%)',
            paymentStatus: '收款状态',
            paidAmountUSD: '已收款(USD)',
            factoryPaidStatus: '工厂收款状态',
            status: '订单状态',
            shippingStatus: '出运状态',
            loadingPort: '起运港',
            destinationPort: '目的港',
            overseasPort: '海外港口'
        };
        App.exportExcel(orders, '订单列表_' + new Date().toISOString().split('T')[0] + '.xlsx', headers, labels);
    },

    // ==================== Excel导入 ====================

    downloadTemplate() {
        const isHK = DB.currentCompanyId === 'CO-GW' || DB.currentCompanyId === 'CO-LK';
        const costLabel = isHK ? '工厂成本(USD)' : '工厂成本(RMB)';
        const headers = [
            '客户',
            '客户订单号',
            '下单日期',
            '订单金额(USD)',
            costLabel,
            '运费(USD)',
            '保险费(USD)',
            '其他费用(USD)',
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
            '2026-01-15',
            '50000.00',
            '35000.00',
            '1500.00',
            '300.00',
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

        const wsData = [headers, exampleRow];
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
                    <span style="color:var(--danger);font-size:13px">必填列：客户、订单金额(USD)</span>
                </p>
                <div style="display:flex;gap:8px;margin-bottom:16px">
                    <button class="btn btn-sm btn-secondary" onclick="Orders.downloadTemplate()">📋 下载导入模板</button>
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
            return o && Auth.canDeleteOrder(o);
        });
        const blocked = ids.length - deletable.length;
        if (deletable.length === 0) {
            App.toast('⚠️ 选中的订单均无删除权限（业务员仅可删除自己的订单）', 'error');
            this.selectedOrders.clear();
            this.renderTable();
            return;
        }
        const warnMsg = `<p style="margin-bottom:8px">确定要批量删除 <strong>${deletable.length}</strong> 笔订单吗？${blocked > 0 ? `<span style="color:var(--danger)">（另有 ${blocked} 笔无权限，已跳过）</span>` : ''}</p><p style="color:var(--danger);font-size:13px">⚠️ 关联的出运和单证信息也将被删除。此操作不可恢复！</p>`;

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
                        <option value="进行中">进行中</option>
                        <option value="已订船">已订船</option>
                        <option value="已取消">已取消</option>
                        <option value="推迟出货">推迟出货</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">收款状态</label>
                    <select class="form-select" name="batchPayment">
                        <option value="">不修改</option>
                        <option value="未收款">未收款</option>
                        <option value="部分收款">部分收款</option>
                        <option value="已收款">已收款</option>
                    </select>
                </div>
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
                <input type="hidden" name="batchIds" value="${ids.join(',')}">
            </form>
        `;
        App.showModal('批量修改状态', bodyHtml, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="document.getElementById('batchStatusForm').requestSubmit()">💾 应用</button>`
        });
    },

    saveBatchStatus(event) {
        const fd = new FormData(event.target);
        const ids = fd.get('batchIds').split(',');
        const status = fd.get('batchStatus');
        const payment = fd.get('batchPayment');
        const shipping = fd.get('batchShipping');

        const changes = {};
        if (status) changes.status = status;
        if (payment) changes.paymentStatus = payment;
        if (shipping) changes.shippingStatus = shipping;

        ids.forEach(id => DB.updateOrder(id, changes));
        // ★ 显式 flush（updateOrder 不再自动 flush）
        DB.flush().then(ok => {
            if (!ok) App.toast('⚠️ 批量更新保存失败，请重试', 'error');
        });
        this.selectedOrders.clear();
        App.toast(`已更新 ${ids.length} 笔订单`);
        App.closeModal();
        this.renderTable();
    }
};

window.Orders = Orders;
