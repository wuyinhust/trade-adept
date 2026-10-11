/**
 * 利润分析模块
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';
import { escapeHtml, toast, validate } from './utils.js';

const Profit = {
    render(container) {
        const analysis = DB.getProfitAnalysis();
        const customers = DB.getCustomers();
        const months = Object.keys(analysis.byMonth).sort();
        const last6Months = months.slice(-6);
        const isHK = DB.currentCompanyId === 'CO-GW' || DB.currentCompanyId === 'CO-LK';
        const costCurrency = isHK ? 'USD' : 'CNY';
        const profitCurrency = isHK ? 'USD' : 'CNY';

        container.innerHTML = `
            <div class="filter-bar">
                <select id="profitCustomerFilter" class="filter-select" onchange="Profit.refresh()">
                    <option value="all">所有客户</option>
                    ${customers.map(c => `<option value="${c.id}">${c.company}</option>`).join('')}
                </select>
                <input type="date" id="profitStartDate" class="filter-input" onchange="Profit.refresh()">
                <input type="date" id="profitEndDate" class="filter-input" onchange="Profit.refresh()">
                <div style="margin-left:auto">
                    <button class="btn btn-secondary" onclick="Profit.exportExcel()">📥 导出利润明细</button>
                </div>
            </div>

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
                        const rate = DB.getExchangeRate();
                        const cr = isHK ? 1 : rate;
                        return App.formatMoney(
                            analysis.orders.reduce((s, o) => s + o.factoryCostRMB + ((o.freightCostUSD || 0) + (o.insuranceCostUSD || 0) + (o.otherCostUSD || 0)) * cr, 0),
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
                                    <td><span class="table-link" onclick="window.location.hash='#/orders/${o.id}'">${o.id}</span></td>
                                    <td>${o.customerName}</td>
                                    <td class="text-sm">${o.productName}</td>
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
        const filter = {
            customerId: document.getElementById('profitCustomerFilter')?.value || 'all',
            startDate: document.getElementById('profitStartDate')?.value || '',
            endDate: document.getElementById('profitEndDate')?.value || ''
        };
        const analysis = DB.getProfitAnalysis(filter);
        const isHK = DB.currentCompanyId === 'CO-GW' || DB.currentCompanyId === 'CO-LK';
        const costCurrency = isHK ? 'USD' : 'CNY';
        const profitCurrency = isHK ? 'USD' : 'CNY';
        // 更新统计
        const totalRev = analysis.orders.reduce((s, o) => s + (isHK ? o.orderAmountUSD : o.orderAmountRMB), 0);
        const rate = DB.getExchangeRate();
        const cr = isHK ? 1 : rate;
        const totalCost = analysis.orders.reduce((s, o) => s + o.factoryCostRMB + ((o.freightCostUSD || 0) + (o.insuranceCostUSD || 0) + (o.otherCostUSD || 0)) * cr, 0);
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
                    <td><span class="table-link" onclick="window.location.hash='#/orders/${App.escapeHtml(o.id)}'">${App.escapeHtml(o.id)}</span></td>
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
        const isHK = DB.currentCompanyId === 'CO-GW' || DB.currentCompanyId === 'CO-LK';
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
        const rate = DB.getExchangeRate();
        // HK 公司全部美金交易，不乘汇率
        const costRate = isHK ? 1 : rate;
        const totalFreight = analysis.orders.reduce((s, o) => s + o.freightCostUSD * costRate, 0);
        const totalInsurance = analysis.orders.reduce((s, o) => s + o.insuranceCostUSD * costRate, 0);
        const totalOther = analysis.orders.reduce((s, o) => s + o.otherCostUSD * costRate, 0);
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
        const analysis = DB.getProfitAnalysis(filter);
        const isHK = DB.currentCompanyId === 'CO-GW' || DB.currentCompanyId === 'CO-LK';
        const cc = isHK ? 'USD' : 'RMB';
        const headers = [
            'id',
            'customerName',
            'productName',
            'orderDate',
            'orderAmountRMB',
            'factoryCostRMB',
            'freightCostUSD',
            'insuranceCostUSD',
            'otherCostUSD',
            'profitRMB',
            'profitRate'
        ];
        const labels = {
            id: '订单号',
            customerName: '客户',
            productName: '产品',
            orderDate: '下单日期',
            orderAmountRMB: `订单金额(${cc})`,
            factoryCostRMB: `工厂成本(${cc})`,
            freightCostUSD: `运费(${cc})`,
            insuranceCostUSD: `保险费(${cc})`,
            otherCostUSD: `其他费用(${cc})`,
            profitRMB: `利润(${cc})`,
            profitRate: '利润率(%)'
        };
        App.exportExcel(
            analysis.orders,
            '利润明细_' + new Date().toISOString().split('T')[0] + '.xlsx',
            headers,
            labels
        );
    }
};

window.Profit = Profit;
