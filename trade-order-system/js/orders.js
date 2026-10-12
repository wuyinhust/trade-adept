/**
 * 订单管理模块
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';
import { escapeHtml, toast, validate } from './utils.js';
import {
    handleFileImport,
    processImportRows,
    validateOrderData,
    requiresOverseasPort,
    canWriteFinancials
} from './order-import.js';

const Orders = {
    currentFilter: { status: 'all', paymentStatus: 'all', shippingStatus: 'all', salespersonId: 'all', search: '' },
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
        const isDomestic = Exchange.isDomestic(order.companyId);
        const isHK = !Exchange.isDomestic(order.companyId);
        const financials = Exchange.getOrderFinancials(order);
        const legacyRmbFees = financials.policy === 'grandware-v40';
        const detailFinanceTitle = isDomestic ? '订单信息' : '财务明细';

        document.getElementById('pageTitle').textContent = '订单详情 - ' + (order.companyOperationNo || orderId);

        container.innerHTML = `
            <div class="flex gap-3 mb-4">
                <button class="btn btn-secondary" onclick="window.location.hash='#/orders'">← 返回列表</button>
                <button class="btn btn-primary" onclick="Orders.showEditForm('${App.escapeHtml(order.id)}')">✏️ 编辑订单</button>
                ${!shipment && Auth.canEdit() ? `<button class="btn btn-secondary" onclick="Orders.createShipment('${App.escapeHtml(order.id)}')">🚢 建立出运记录</button>` : ''}
                ${canWriteFinancials() ? `<button class="btn btn-secondary" onclick="Orders.updatePayment('${App.escapeHtml(order.id)}')">💰 更新付款</button>` : ''}
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
                ${
                    showFinance
                        ? `<div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon red">💳</div></div>
                    <div class="stat-label">收款进度</div>
                    <div class="stat-value">${App.formatMoney(order.paidAmountUSD, 'USD')}</div>
                    <div class="stat-sub">${App.escapeHtml(order.paymentStatus)} / 共 ${App.formatMoney(order.orderAmountUSD, 'USD')}</div>
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
                            ${
                                showFinance
                                    ? `<div><span class="text-gray">总金额：</span>${App.formatMoney(f.totalAmount || 0, isHK ? 'USD' : 'CNY')}</div>
                            <div><span class="text-gray">预付款：</span>${App.formatMoney(f.prepayment || 0, isHK ? 'USD' : 'CNY')}</div>`
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
                            <tr><td>订单总金额 (USD)</td><td class="text-right font-bold">${App.formatMoney(order.orderAmountUSD, 'USD')}</td></tr>
                            ${isHK ? '' : `<tr><td>订单总金额 (RMB)</td><td class="text-right">${App.formatMoney(order.orderAmountRMB, 'CNY')}</td></tr>`}
                            <tr><td>工厂成本 (${isHK ? 'USD' : 'RMB'})</td><td class="text-right text-danger">${App.formatMoney(order.factoryCostRMB, isHK ? 'USD' : 'CNY')}</td></tr>
                            ${
                                isHK
                                    ? ''
                                    : `
                            <tr><td>${legacyRmbFees ? '货代费 (RMB)' : '运费 (USD)'}</td><td class="text-right text-danger">${App.formatMoney(order.freightCostUSD, legacyRmbFees ? 'CNY' : 'USD')}</td></tr>
                            <tr><td>${legacyRmbFees ? '退税率 (%)' : '保险费 (USD)'}</td><td class="text-right text-danger">${legacyRmbFees ? Number(order.insuranceCostUSD || 0).toFixed(2) + '%' : App.formatMoney(order.insuranceCostUSD, 'USD')}</td></tr>`
                            }
                            <tr><td>${isDomestic && legacyRmbFees ? '其他费用 (RMB)' : '其他费用 (USD)'}</td><td class="text-right text-danger">${App.formatMoney(order.otherCostUSD, isDomestic && legacyRmbFees ? 'CNY' : 'USD')}</td></tr>
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

    async createShipment(orderId) {
        const { Shipping } = await import('./shipping.js');
        window.Shipping = Shipping;
        Shipping.showAddForm(orderId);
    },

    // ==================== 新建/编辑订单 ====================
    showAddForm() {
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
            <form id="orderForm" data-company-id="${App.escapeHtml(DB.currentCompanyId)}" onsubmit="Orders.saveOrder(event); return false;">
                ${
                    showSalesSelect
                        ? `
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">业务员 <span class="required">*</span></label>
                        <select class="form-select" name="salespersonId" required>
                            ${Auth.users
                                .map(
                                    u =>
                                        `<option value="${App.escapeHtml(u.id)}" ${Auth.currentUser && Auth.currentUser.id === u.id ? 'selected' : ''}>${App.escapeHtml(u.name)}</option>`
                                )
                                .join('')}
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
                <div id="factoryCards">
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
        App.showModal('新建订单', bodyHtml, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="document.getElementById('orderForm').requestSubmit()">💾 保存订单</button>`
        });
    },

    showEditForm(orderId) {
        this._factoryIndex = 1;
        const order = DB.getOrder(orderId);
        if (!order) return;
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
        const legacyRmbFees = (order.formulaVersion || companyPolicy) === 'grandware-v40';
        const otherLabel = isDomestic && legacyRmbFees ? '其他费用 (RMB)' : '其他费用 (USD)';
        const profitLabel = isHK ? '预计利润 (USD)' : '预计利润 (RMB)';
        const freightLabel = isDomestic ? (legacyRmbFees ? '货代费 (RMB)' : '运费 (USD)') : '';
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
                          totalAmount: order.factoryCostRMB,
                          prepayment: 0,
                          inspectionDate: '',
                          estimatedShipDate: order.expectedShipDate
                      }
                  ];
        this._factoryIndex = factoryDataList.length;
        const factoryCardsHtml = factoryDataList.map((fd, idx) => this.createFactoryRow(idx, fd)).join('');

        const bodyHtml = `
            <form id="orderForm" data-company-id="${App.escapeHtml(order.companyId)}" data-formula-version="${App.escapeHtml(order.formulaVersion || '')}" onsubmit="Orders.saveOrder(event, '${orderId}'); return false;">
                ${
                    showSalesSelect
                        ? `
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">业务员</label>
                        <select class="form-select" name="salespersonId">
                            ${Auth.users
                                .map(
                                    u =>
                                        `<option value="${App.escapeHtml(u.id)}" ${u.id === (order.salespersonId || '') ? 'selected' : ''}>${App.escapeHtml(u.name)}</option>`
                                )
                                .join('')}
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
                    <select class="form-select" name="contactPerson" ${order.contactPerson ? 'required' : ''} id="orderContactSelect">
                        ${order.contactPerson ? '' : '<option value="" selected>历史订单未记录联系人</option>'}
                        ${this.getContactOptions(customer, order.contactPerson || '')}
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
                        <input type="number" step="0.01" class="form-input" name="factoryCostRMB" value="${App.escapeHtml(order.factoryCostRMB ?? '')}" readonly style="background:var(--gray-100);color:var(--gray-600)">
                    </div>
                    ${
                        isHK
                            ? ''
                            : `
                    <div class="form-group">
                        <label class="form-label">${freightLabel}</label>
                        <input type="number" step="0.01" class="form-input" name="freightCostUSD" value="${App.escapeHtml(order.freightCostUSD ?? '')}" oninput="Orders.calcProfit()">
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
                        <input type="number" step="0.01" class="form-input" name="otherCostUSD" value="${App.escapeHtml(order.otherCostUSD ?? '')}" oninput="Orders.calcProfit()">
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
                <div id="factoryCards">
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
                        <label class="form-label">已收款 (USD)</label>
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
                        <label class="form-label">已付工厂 (${isHK ? 'USD' : 'RMB'})</label>
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
        App.showModal('编辑订单 - ' + App.escapeHtml(order.companyOperationNo || orderId), bodyHtml, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="document.getElementById('orderForm').requestSubmit()">💾 保存修改</button>`
        });
        this.updateFactoryCost();
        this.calcProfit();
        const editor = document.getElementById('orderForm');
        if (editor) editor.dataset.originalValues = JSON.stringify(Object.fromEntries(new FormData(editor)));
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
        if (!customer) {
            return selectedName
                ? `<option value="${App.escapeHtml(selectedName)}" selected>${App.escapeHtml(selectedName)}（当前订单联系人）</option>`
                : '<option value="">请先选择客户</option>';
        }
        const contacts = customer.contacts || [];
        if (contacts.length === 0) {
            // 没有结构化联系人数据，用旧 contact 字段兜底
            const fallback = customer.contact || '';
            if (!fallback) {
                return selectedName
                    ? `<option value="${App.escapeHtml(selectedName)}" selected>${App.escapeHtml(selectedName)}（当前订单联系人）</option>`
                    : '<option value="">无联系人</option>';
            }
            const sel = fallback === selectedName ? ' selected' : '';
            return `<option value="${App.escapeHtml(fallback)}"${sel}>${App.escapeHtml(fallback)}</option>`;
        }
        const historical =
            selectedName && !contacts.some(contact => contact.name === selectedName)
                ? `<option value="${App.escapeHtml(selectedName)}" selected>${App.escapeHtml(selectedName)}（当前订单联系人）</option>`
                : '';
        return (
            historical +
            contacts
                .map(ct => {
                    const selected = ct.name === selectedName ? ' selected' : '';
                    return `<option value="${App.escapeHtml(ct.name)}"${selected}>${App.escapeHtml(ct.name)}${ct.position ? ' (' + App.escapeHtml(ct.position) + ')' : ''}</option>`;
                })
                .join('')
        );
    },

    createFactoryRow(index, data = {}) {
        const factories = DB.getFactories();
        const required = this._editingOrder ? '' : 'required';
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
        // Public production cards omit factory amounts. Their missing financial
        // inputs never become a submitted zero when an editor is opened.
        if (!document.getElementById('factoryCards')) return;
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
        const el = document.getElementById('calcProfit');
        if (!form || !el) return;
        const value = name => parseFloat(form.elements.namedItem(name)?.value) || 0;
        const usd = value('orderAmountUSD');
        const factoryRMB = value('factoryCostRMB');
        // HK 公司不渲染货代费和退税率字段，用可选链防止 TypeError
        const freight = value('freightCostUSD');
        const insurance = value('insuranceCostUSD');
        const other = value('otherCostUSD');

        // 实时预览利润：直接用当前登录公司判断公式（与表单标签一致）
        const companyId = form.dataset.companyId || DB.currentCompanyId;
        const financials =
            typeof Exchange.getOrderFinancials === 'function'
                ? Exchange.getOrderFinancials({
                      companyId,
                      formulaVersion: form.dataset.formulaVersion || undefined,
                      orderAmountUSD: usd,
                      factoryCostRMB: factoryRMB,
                      freightCostUSD: freight,
                      insuranceCostUSD: insurance,
                      otherCostUSD: other
                  })
                : null;
        const profit = financials
            ? financials.computedProfit
            : DB.calcOrderProfit(usd, factoryRMB, freight, insurance, other, companyId);
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
        const pendingId = orderId || form.dataset.pendingRecordId || null;
        const customer = DB.getCustomer(fd.get('customerId'));

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
            productCategory: productTypes,
            productName: productTypes,
            quantity: factories.reduce((sum, f) => sum + f.totalQuantity, 0),
            unit: 'PCS',
            orderDate: fd.get('orderDate'),
            expectedShipDate: expectedShipDate,
            actualShipDate: fd.get('actualShipDate') || null,
            orderAmountUSD: Number(fd.get('orderAmountUSD')),
            factoryCostRMB: factoryCostRMB,
            freightCostUSD: Number(fd.get('freightCostUSD') || 0),
            insuranceCostUSD: Number(fd.get('insuranceCostUSD') || 0),
            otherCostUSD: Number(fd.get('otherCostUSD') || 0),
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
                    'factoryCostRMB'
                ]) {
                    delete data[key];
                }
            }
        }
        if (!canWriteFinancials()) {
            for (const key of [
                'factoryCostRMB',
                'freightCostUSD',
                'insuranceCostUSD',
                'otherCostUSD',
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
            if (!canWriteFinancials()) {
                for (const key of [
                    'factoryCostRMB',
                    'freightCostUSD',
                    'insuranceCostUSD',
                    'otherCostUSD',
                    'factoryPaidStatus',
                    'factoryPaidRMB'
                ]) {
                    delete data[key];
                }
            }
        }

        const company = DB.companies.find(item => item.id === (form.dataset.companyId || DB.currentCompanyId));
        const existing = pendingId ? DB.getOrder(pendingId) : null;
        if (existing) {
            for (const key of Object.keys(data)) {
                if (JSON.stringify(data[key] ?? '') === JSON.stringify(existing[key] ?? '')) delete data[key];
            }
        }
        const invalid = validateOrderData({ ...existing, ...data }, data, !pendingId, company);
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
        if (!order || !canWriteFinancials()) return;
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
        const orders = DB.getOrders(this.currentFilter).map(order => {
            const financials = Exchange.getOrderFinancials(order);
            const domestic = financials.currency === 'CNY';
            const legacy = financials.policy === 'grandware-v40';
            return {
                ...order,
                settlementCurrency: financials.currency,
                formulaPolicy: financials.policy,
                feeCurrency: domestic && legacy ? 'CNY' : 'USD',
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
            freightCostUSD: '货代/运费(费用币种)',
            insuranceCostUSD: '退税率/保险费(原始值)',
            otherCostUSD: '其他费用(费用币种)',
            profitRMB: '利润(结算币种)',
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
        const financialHeaders = new Set([
            'factoryCostRMB',
            'freightCostUSD',
            'insuranceCostUSD',
            'otherCostUSD',
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

window.Orders = Orders;
