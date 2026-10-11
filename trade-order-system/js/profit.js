/**
 * 利润分析模块
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';
import { escapeHtml, toast, validate } from './utils.js';

const Profit = {
    reportCurrency: null,

    getAnalysis(filter = {}) {
        // Use authorized records rather than the legacy mixed-currency aggregates.
        const visibleOrders = DB.getOrders();
        let rawOrders = visibleOrders;
        if (filter.startDate) rawOrders = rawOrders.filter(order => order.orderDate >= filter.startDate);
        if (filter.endDate) rawOrders = rawOrders.filter(order => order.orderDate <= filter.endDate);
        if (filter.customerId && filter.customerId !== 'all') {
            rawOrders = rawOrders.filter(order => String(order.customerId) === String(filter.customerId));
        }
        const financials = rawOrders.map(order => ({ order, metrics: Exchange.getOrderFinancials(order) }));
        const companyCurrency = Exchange.getOrderFinancials({ companyId: DB.currentCompanyId }).currency;
        const currencies = [
            ...new Set([companyCurrency, ...visibleOrders.map(order => Exchange.getOrderFinancials(order).currency)])
        ].sort();
        if (!currencies.includes(this.reportCurrency)) this.reportCurrency = companyCurrency;
        const orders = financials
            .filter(item => item.metrics.currency === this.reportCurrency)
            .map(({ order, metrics }) => ({
                ...order,
                // Report copies only: never persist normalized legacy display fields.
                orderAmountRMB: metrics.revenue,
                factoryCostRMB: metrics.factoryCost,
                freightCostUSD: metrics.freightCost,
                insuranceCostUSD: metrics.insuranceCost,
                otherCostUSD: metrics.otherCost,
                taxRebate: metrics.taxRebate,
                profitRMB: metrics.profit,
                profitRate: metrics.profitRate,
                settlementCurrency: metrics.currency,
                formulaPolicy: metrics.policy
            }));
        const byCustomer = Object.create(null);
        const byCategory = Object.create(null);
        const byMonth = Object.create(null);
        const aggregate = (target, key, order) => {
            target[key] ||= { revenue: 0, cost: 0, profit: 0, count: 0 };
            target[key].revenue += order.orderAmountRMB;
            target[key].cost +=
                order.factoryCostRMB + order.freightCostUSD + order.insuranceCostUSD + order.otherCostUSD;
            target[key].profit += order.profitRMB;
            target[key].count++;
        };
        orders.forEach(order => {
            aggregate(byCustomer, `${order.customerName || '未命名客户'} (${order.customerId || ''})`, order);
            aggregate(byCategory, order.productCategory || '未分类', order);
            aggregate(byMonth, String(order.orderDate || '').slice(0, 7) || '未填日期', order);
        });
        return { orders, byCustomer, byCategory, byMonth, currencies, currency: this.reportCurrency };
    },

    render(container) {
        this.reportCurrency = null;
        const analysis = this.getAnalysis();
        const customers = DB.getCustomers();
        const months = Object.keys(analysis.byMonth).sort();
        const last6Months = months.slice(-6);
        const isHK = analysis.currency === 'USD';
        const costCurrency = analysis.currency;
        const profitCurrency = analysis.currency;
        container.innerHTML = `
            <div class="filter-bar">
                <select id="profitCurrencyFilter" class="filter-select" aria-label="结算币种" onchange="Profit.refresh()">
                    ${analysis.currencies.map(currency => `<option value="${escapeHtml(currency)}" ${currency === analysis.currency ? 'selected' : ''}>${escapeHtml(currency)} · 分币种统计</option>`).join('')}
                </select>
                <select id="profitCustomerFilter" class="filter-select" onchange="Profit.refresh()">
                    <option value="all">所有客户</option>
                    ${customers.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.company)}</option>`).join('')}
                </select>
                <input type="date" id="profitStartDate" class="filter-input" onchange="Profit.refresh()">
                <input type="date" id="profitEndDate" class="filter-input" onchange="Profit.refresh()">
                <div style="margin-left:auto">
                    <button class="btn btn-secondary" onclick="Profit.exportExcel()">📥 导出利润明细</button>
                </div>
            </div>

            <p class="text-sm text-gray mb-4">金额按所选结算币种分别汇总，其他币种不会合并相加。利润保留订单已保存的核算结果；成本按订单公式版本显示。</p>

            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon blue">💵</div></div>
                    <div class="stat-label">总营收 (${isHK ? 'USD' : 'RMB'})</div>
                    <div class="stat-value" id="totalRevenue">${App.formatMoney(
                        analysis.orders.reduce((s, o) => s + (isHK ? o.orderAmountUSD : o.orderAmountRMB), 0),
                        profitCurrency
                    )}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon orange">🏭</div></div>
                    <div class="stat-label">总成本 (${costCurrency})</div>
                    <div class="stat-value" id="totalCost">${(() => {
                        return App.formatMoney(
                            analysis.orders.reduce(
                                (s, o) =>
                                    s +
                                    o.factoryCostRMB +
                                    (o.freightCostUSD || 0) +
                                    (o.insuranceCostUSD || 0) +
                                    (o.otherCostUSD || 0),
                                0
                            ),
                            costCurrency
                        );
                    })()}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon green">📈</div></div>
                    <div class="stat-label">总利润 (${profitCurrency})</div>
                    <div class="stat-value text-success" id="totalProfit">${App.formatMoney(
                        analysis.orders.reduce((s, o) => s + o.profitRMB, 0),
                        profitCurrency
                    )}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon cyan">📊</div></div>
                    <div class="stat-label">平均利润率</div>
                    <div class="stat-value" id="avgProfitRate">${(() => {
                        const orders = analysis.orders;
                        if (isHK) {
                            const rev = orders.reduce((s, o) => s + o.orderAmountUSD, 0);
                            const profit = orders.reduce((s, o) => s + o.profitRMB, 0);
                            return rev > 0 ? ((profit / rev) * 100).toFixed(2) : '0.00';
                        } else {
                            const rev = orders.reduce((s, o) => s + o.orderAmountRMB, 0);
                            const profit = orders.reduce((s, o) => s + o.profitRMB, 0);
                            return rev > 0 ? ((profit / rev) * 100).toFixed(2) : '0.00';
                        }
                    })()}%</div>
                </div>
            </div>

            <div class="chart-grid">
                <div class="card">
                    <div class="card-header"><span class="card-title">月度利润趋势</span></div>
                    <div class="card-body">
                        <div class="chart-container"><canvas id="profitTrendChart"></canvas></div>
                    </div>
                </div>
                <div class="card">
                    <div class="card-header"><span class="card-title">客户利润分布 (TOP 8)</span></div>
                    <div class="card-body">
                        <div class="chart-container"><canvas id="customerProfitChart"></canvas></div>
                    </div>
                </div>
            </div>

            <div class="chart-grid">
                <div class="card">
                    <div class="card-header"><span class="card-title">产品类别利润对比</span></div>
                    <div class="card-body">
                        <div class="chart-container"><canvas id="categoryChart"></canvas></div>
                    </div>
                </div>
                <div class="card">
                    <div class="card-header"><span class="card-title">成本结构分析</span></div>
                    <div class="card-body">
                        <div class="chart-container"><canvas id="costStructureChart"></canvas></div>
                    </div>
                </div>
            </div>

            <div class="card mt-6">
                <div class="card-header"><span class="card-title">利润明细表</span></div>
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>订单号</th>
                                <th>客户</th>
                                <th>产品</th>
                                <th>下单日期</th>
                                <th class="text-right">营收(${isHK ? 'USD' : 'RMB'})</th>
                                <th class="text-right">工厂成本(${costCurrency})</th>
                                <th class="text-right">其他费(${costCurrency})</th>
                                <th class="text-right">利润(${profitCurrency})</th>
                                <th class="text-right">利润率</th>
                            </tr>
                        </thead>
                        <tbody id="profitTableBody">
                            ${analysis.orders
                                .slice(0, 20)
                                .map(
                                    o => `
                                <tr>
                                    <td><span class="table-link" onclick="window.location.hash='#/orders/${encodeURIComponent(o.id)}'">${escapeHtml(o.companyOperationNo || o.id)}</span></td>
                                    <td>${escapeHtml(o.customerName)}</td>
                                    <td class="text-sm">${escapeHtml(o.productName)}</td>
                                    <td>${App.formatDate(o.orderDate)}</td>
                                    <td class="text-right">${App.formatMoney(isHK ? o.orderAmountUSD : o.orderAmountRMB, isHK ? 'USD' : 'CNY')}</td>
                                    <td class="text-right text-danger">${App.formatMoney(o.factoryCostRMB, costCurrency)}</td>
                                    <td class="text-right">${App.formatMoney(o.otherCostUSD, costCurrency)}</td>
                                    <td class="text-right font-bold ${App.getProfitColor(o.profitRate)}">${App.formatMoney(o.profitRMB, profitCurrency)}</td>
                                    <td class="text-right ${App.getProfitColor(o.profitRate)} font-semi">${o.profitRate.toFixed(1)}%</td>
                                </tr>
                            `
                                )
                                .join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
        setTimeout(() => {
            this.renderCharts(analysis);
        }, 100);
    },

    refresh() {
        this.reportCurrency = document.getElementById('profitCurrencyFilter')?.value || this.reportCurrency;
        const filter = {
            customerId: document.getElementById('profitCustomerFilter')?.value || 'all',
            startDate: document.getElementById('profitStartDate')?.value || '',
            endDate: document.getElementById('profitEndDate')?.value || ''
        };
        const analysis = this.getAnalysis(filter);
        const isHK = analysis.currency === 'USD';
        const costCurrency = analysis.currency;
        const profitCurrency = analysis.currency;
        // 更新统计
        const labels = {
            totalRevenue: `总营收 (${profitCurrency})`,
            totalCost: `总成本 (${costCurrency})`,
            totalProfit: `总利润 (${profitCurrency})`
        };
        Object.entries(labels).forEach(([id, label]) => {
            const title = document.getElementById(id)?.previousElementSibling;
            if (title) title.textContent = label;
        });
        const tableHeaders = document.getElementById('profitTableBody')?.closest('table')?.querySelectorAll('thead th');
        if (tableHeaders) {
            ['营收', '工厂成本', '其他费', '利润'].forEach((label, index) => {
                tableHeaders[index + 4].textContent = `${label}(${profitCurrency})`;
            });
        }
        const totalRev = analysis.orders.reduce((s, o) => s + (isHK ? o.orderAmountUSD : o.orderAmountRMB), 0);
        const totalCost = analysis.orders.reduce(
            (s, o) =>
                s + o.factoryCostRMB + (o.freightCostUSD || 0) + (o.insuranceCostUSD || 0) + (o.otherCostUSD || 0),
            0
        );
        const totalProfit = analysis.orders.reduce((s, o) => s + o.profitRMB, 0);
        document.getElementById('totalRevenue').textContent = App.formatMoney(totalRev, profitCurrency);
        document.getElementById('totalCost').textContent = App.formatMoney(totalCost, costCurrency);
        document.getElementById('totalProfit').textContent = App.formatMoney(totalProfit, profitCurrency);
        document.getElementById('avgProfitRate').textContent =
            (totalRev > 0 ? ((totalProfit / totalRev) * 100).toFixed(2) : '0.00') + '%';

        // 更新表格
        const tbody = document.getElementById('profitTableBody');
        if (tbody) {
            tbody.innerHTML =
                analysis.orders
                    .slice(0, 20)
                    .map(
                        o => `
                <tr>
                    <td><span class="table-link" onclick="window.location.hash='#/orders/${encodeURIComponent(o.id)}'">${App.escapeHtml(o.companyOperationNo || o.id)}</span></td>
                    <td>${App.escapeHtml(o.customerName)}</td>
                    <td class="text-sm">${App.escapeHtml(o.productName)}</td>
                    <td>${App.formatDate(o.orderDate)}</td>
                    <td class="text-right">${App.formatMoney(isHK ? o.orderAmountUSD : o.orderAmountRMB, isHK ? 'USD' : 'CNY')}</td>
                    <td class="text-right text-danger">${App.formatMoney(o.factoryCostRMB, costCurrency)}</td>
                    <td class="text-right">${App.formatMoney(o.otherCostUSD, costCurrency)}</td>
                    <td class="text-right font-bold ${App.getProfitColor(o.profitRate)}">${App.formatMoney(o.profitRMB, profitCurrency)}</td>
                    <td class="text-right ${App.getProfitColor(o.profitRate)} font-semi">${o.profitRate.toFixed(1)}%</td>
                </tr>
            `
                    )
                    .join('') ||
                '<tr><td colspan="9" class="text-center text-gray" style="padding:30px">暂无数据</td></tr>';
        }
        // 更新图表
        Object.values(App.charts).forEach(c => {
            if (c && c.destroy) c.destroy();
        });
        App.charts = {};
        this.renderCharts(analysis);
    },

    renderCharts(analysis) {
        const isHK = analysis.currency === 'USD';
        const currencySymbol = isHK ? '$' : '¥';
        // 月度利润趋势
        const months = Object.keys(analysis.byMonth).sort();
        const ctx1 = document.getElementById('profitTrendChart');
        if (ctx1) {
            App.charts.trend = new Chart(ctx1, {
                type: 'line',
                data: {
                    labels: months,
                    datasets: [
                        {
                            label: `营收(${currencySymbol})`,
                            data: months.map(m => Math.round(analysis.byMonth[m].revenue)),
                            borderColor: '#2563eb',
                            backgroundColor: 'rgba(37,99,235,0.1)',
                            fill: true,
                            tension: 0.4
                        },
                        {
                            label: `利润(${currencySymbol})`,
                            data: months.map(m => Math.round(analysis.byMonth[m].profit)),
                            borderColor: '#16a34a',
                            backgroundColor: 'rgba(22,163,74,0.1)',
                            fill: true,
                            tension: 0.4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { font: { size: 12 } } } },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: { callback: v => currencySymbol + (v / 10000).toFixed(0) + '万' }
                        }
                    }
                }
            });
        }

        // 客户利润分布 TOP 8
        const customerData = Object.entries(analysis.byCustomer)
            .sort((a, b) => b[1].profit - a[1].profit)
            .slice(0, 8);
        const ctx2 = document.getElementById('customerProfitChart');
        if (ctx2 && customerData.length > 0) {
            App.charts.customer = new Chart(ctx2, {
                type: 'bar',
                data: {
                    labels: customerData.map(d => d[0].substring(0, 15)),
                    datasets: [
                        {
                            label: `利润(${currencySymbol})`,
                            data: customerData.map(d => Math.round(d[1].profit)),
                            backgroundColor: [
                                '#16a34a',
                                '#2563eb',
                                '#0891b2',
                                '#d97706',
                                '#7c3aed',
                                '#dc2626',
                                '#059669',
                                '#db2777'
                            ],
                            borderRadius: 4
                        }
                    ]
                },
                options: {
                    indexAxis: 'y',
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: {
                            beginAtZero: true,
                            ticks: { callback: v => currencySymbol + (v / 10000).toFixed(0) + '万' }
                        }
                    }
                }
            });
        }

        // 产品类别利润
        const categoryData = Object.entries(analysis.byCategory).sort((a, b) => b[1].profit - a[1].profit);
        const ctx3 = document.getElementById('categoryChart');
        if (ctx3 && categoryData.length > 0) {
            App.charts.category = new Chart(ctx3, {
                type: 'bar',
                data: {
                    labels: categoryData.map(d => d[0]),
                    datasets: [
                        {
                            label: `营收(${currencySymbol})`,
                            data: categoryData.map(d => Math.round(d[1].revenue)),
                            backgroundColor: 'rgba(37,99,235,0.7)',
                            borderRadius: 4
                        },
                        {
                            label: `利润(${currencySymbol})`,
                            data: categoryData.map(d => Math.round(d[1].profit)),
                            backgroundColor: 'rgba(22,163,74,0.7)',
                            borderRadius: 4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { font: { size: 12 } } } },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: { callback: v => currencySymbol + (v / 10000).toFixed(0) + '万' }
                        }
                    }
                }
            });
        }

        // 成本结构
        const totalFactory = analysis.orders.reduce((s, o) => s + o.factoryCostRMB, 0);
        const totalFreight = analysis.orders.reduce((s, o) => s + o.freightCostUSD, 0);
        const totalInsurance = analysis.orders.reduce((s, o) => s + o.insuranceCostUSD, 0);
        const totalOther = analysis.orders.reduce((s, o) => s + o.otherCostUSD, 0);
        const ctx4 = document.getElementById('costStructureChart');
        if (ctx4) {
            App.charts.cost = new Chart(ctx4, {
                type: 'doughnut',
                data: {
                    labels: ['工厂成本', '运费', '保险费', '其他费用'],
                    datasets: [
                        {
                            data: [
                                Math.round(totalFactory),
                                Math.round(totalFreight),
                                Math.round(totalInsurance),
                                Math.round(totalOther)
                            ],
                            backgroundColor: ['#2563eb', '#d97706', '#0891b2', '#9ca3af'],
                            borderWidth: 2,
                            borderColor: '#fff'
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { font: { size: 12 }, padding: 12 } } }
                }
            });
        }
    },

    exportExcel() {
        const filter = {
            customerId: document.getElementById('profitCustomerFilter')?.value || 'all',
            startDate: document.getElementById('profitStartDate')?.value || '',
            endDate: document.getElementById('profitEndDate')?.value || ''
        };
        const analysis = this.getAnalysis(filter);
        const cc = analysis.currency;
        const headers = [
            'id',
            'customerName',
            'productName',
            'orderDate',
            'settlementCurrency',
            'formulaPolicy',
            'orderAmountRMB',
            'factoryCostRMB',
            'freightCostUSD',
            'insuranceCostUSD',
            'otherCostUSD',
            'taxRebate',
            'profitRMB',
            'profitRate'
        ];
        const labels = {
            id: '订单号',
            customerName: '客户',
            productName: '产品',
            orderDate: '下单日期',
            settlementCurrency: '结算币种',
            formulaPolicy: '核算公式版本',
            orderAmountRMB: `订单金额(${cc})`,
            factoryCostRMB: `工厂成本(${cc})`,
            freightCostUSD: `运费(${cc})`,
            insuranceCostUSD: `保险费(${cc})`,
            otherCostUSD: `其他费用(${cc})`,
            taxRebate: `退税(${cc})`,
            profitRMB: `利润(${cc})`,
            profitRate: '利润率(%)'
        };
        App.exportExcel(
            analysis.orders,
            '利润明细_' + cc + '_' + new Date().toISOString().split('T')[0] + '.xlsx',
            headers,
            labels
        );
    }
};

window.Profit = Profit;
