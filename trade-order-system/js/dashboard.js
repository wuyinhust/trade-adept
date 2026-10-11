/**
 * 仪表盘模块
 */

import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { escapeHtml, toast } from './utils.js';

const Dashboard = {
    render(container) {
        const stats = DB.getDashboardStats();
        const showFinance = Auth.canSeeFinancials();
        const isDocument = Auth.isDocument();
        const isHK = DB.currentCompanyId === 'CO-GW' || DB.currentCompanyId === 'CO-LK';
        const profitCurrency = isHK ? 'USD' : 'CNY';
        container.innerHTML = `
            <!-- 统计卡片 -->
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-card-header">
                        <div class="stat-icon blue">📋</div>
                        <span class="stat-trend up">↑ ${stats.activeOrders} 进行中</span>
                    </div>
                    <div class="stat-label">订单总数</div>
                    <div class="stat-value">${stats.totalOrders}</div>
                    <div class="stat-sub">已出运 ${stats.completedOrders} 单</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header">
                        <div class="stat-icon green">💵</div>
                        <span class="stat-trend up">↑ 活跃</span>
                    </div>
                    <div class="stat-label">总营收</div>
                    <div class="stat-value">${App.formatMoney(stats.totalRevenueUSD, 'USD')}</div>
                    ${isHK ? '<div class="stat-sub">美金交易</div>' : `<div class="stat-sub">≈ ${App.formatMoney(stats.totalRevenueRMB, 'CNY')}</div>`}
                </div>
                ${
                    showFinance
                        ? `
                <div class="stat-card">
                    <div class="stat-card-header">
                        <div class="stat-icon orange">💰</div>
                        <span class="stat-trend up">↑ ${stats.avgProfitRate.toFixed(1)}%</span>
                    </div>
                    <div class="stat-label">总利润</div>
                    <div class="stat-value">${App.formatMoney(stats.totalProfitRMB, profitCurrency)}</div>
                    <div class="stat-sub">平均利润率 ${stats.avgProfitRate.toFixed(2)}%</div>
                </div>`
                        : isDocument
                          ? `
                <div class="stat-card">
                    <div class="stat-card-header">
                        <div class="stat-icon orange">📦</div>
                        <span class="stat-trend up">↑ 待出运</span>
                    </div>
                    <div class="stat-label">待出运订单</div>
                    <div class="stat-value">${stats.pendingShipmentCount}</div>
                    <div class="stat-sub">共 ${stats.totalOrders} 个订单</div>
                </div>`
                          : `
                <div class="stat-card">
                    <div class="stat-card-header">
                        <div class="stat-icon orange">👥</div>
                        <span class="stat-trend up">↑ 活跃</span>
                    </div>
                    <div class="stat-label">客户数量</div>
                    <div class="stat-value">${stats.customerCount}</div>
                    <div class="stat-sub">涉及 ${stats.customerCount} 家客户</div>
                </div>`
                }
                <div class="stat-card">
                    <div class="stat-card-header">
                        <div class="stat-icon red">⏳</div>
                        <span class="stat-trend ${stats.unpaidAmount > 0 ? 'down' : 'up'}">${stats.unpaidAmount > 0 ? '待收' : '已结清'}</span>
                    </div>
                    <div class="stat-label">待收款项</div>
                    <div class="stat-value">${App.formatMoney(stats.unpaidAmount, 'USD')}</div>
                    <div class="stat-sub">已收款 ${App.formatMoney(stats.totalPaidUSD, 'USD')}</div>
                </div>
                ${
                    showFinance && !isDocument
                        ? `
                <div class="stat-card">
                    <div class="stat-card-header">
                        <div class="stat-icon purple">🏭</div>
                        <span class="stat-trend ${stats.totalFactoryUnpaidRMB > 0 ? 'down' : 'up'}">${stats.totalFactoryUnpaidRMB > 0 ? '待付' : '已结清'}</span>
                    </div>
                    <div class="stat-label">总待付货款</div>
                    <div class="stat-value">${App.formatMoney(stats.totalFactoryUnpaidRMB, profitCurrency)}</div>
                    <div class="stat-sub">已付 ${App.formatMoney(stats.totalFactoryPaidRMB, profitCurrency)}</div>
                </div>`
                        : ''
                }
            </div>

            <!-- 图表区 -->
            <div class="chart-grid">
                ${
                    !isDocument
                        ? `
                <div class="card">
                    <div class="card-header">
                        <span class="card-title">月度营收与利润趋势</span>
                    </div>
                    <div class="card-body">
                        <div class="chart-container">
                            <canvas id="monthlyChart"></canvas>
                        </div>
                    </div>
                </div>`
                        : ''
                }
                <div class="card">
                    <div class="card-header">
                        <span class="card-title">订单状态分布</span>
                    </div>
                    <div class="card-body">
                        <div class="chart-container">
                            <canvas id="statusChart"></canvas>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 近期出运 -->
            <div class="card mt-4">
                <div class="card-header">
                    <span class="card-title">近期出运安排</span>
                    <a href="#/shipping" class="btn btn-sm btn-secondary">查看全部</a>
                </div>
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>操作单号</th>
                                <th>客户</th>
                                <th>提单号</th>
                                <th>船名/航次</th>
                                <th>起运港</th>
                                <th>目的港</th>
                                <th>海外港口</th>
                                <th>预计出运</th>
                                <th>预计到港</th>
                                <th>状态</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${
                                stats.upcomingShipments.length > 0
                                    ? stats.upcomingShipments
                                          .map(
                                              s => `
                                <tr>
                                    <td><span class="table-link" onclick="window.location.hash='#/orders/${s.orderId}'">${s.orderId}</span></td>
                                    <td>${s.customerName}</td>
                                    <td>${s.blNumber}</td>
                                    <td>${s.vessel}<br><span class="text-xs text-gray">${s.voyage}</span></td>
                                    <td>${s.loadingPort}</td>
                                    <td>${s.destinationPort}</td>
                                    <td>${s.overseasPort || '-'}</td>
                                    <td>${App.formatDate(s.etd)}</td>
                                    <td>${App.formatDate(s.eta)}</td>
                                    <td>${App.getShippingBadge(s.status)}</td>
                                </tr>
                            `
                                          )
                                          .join('')
                                    : '<tr><td colspan="9" class="text-center text-gray" style="padding:40px">暂无近期出运</td></tr>'
                            }
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- 收款进度 -->
            <div class="card mt-4">
                <div class="card-header">
                    <span class="card-title">收款进度概览</span>
                </div>
                <div class="card-body">
                    <div class="flex justify-between mb-2">
                        <span class="text-sm text-gray">已收款 / 总金额</span>
                        <span class="text-sm font-semi">${App.formatMoney(stats.totalPaidUSD, 'USD')} / ${App.formatMoney(stats.totalRevenueUSD, 'USD')}</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${stats.totalRevenueUSD > 0 ? ((stats.totalPaidUSD / stats.totalRevenueUSD) * 100).toFixed(1) : 0}%; background: var(--success);"></div>
                    </div>
                    ${
                        showFinance
                            ? `
                    <div class="flex justify-between mt-4 mb-2">
                        <span class="text-sm text-gray">工厂成本 / 已付工厂</span>
                        <span class="text-sm font-semi">${App.formatMoney(stats.totalFactoryCostRMB, isHK ? 'USD' : 'CNY')}</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: 65%; background: var(--warning);"></div>
                    </div>`
                            : ''
                    }
                </div>
            </div>
        `;
        // 渲染图表
        setTimeout(() => {
            this.renderMonthlyChart(stats.monthlyStats);
            this.renderStatusChart(stats.statusStats);
        }, 100);
    },

    renderMonthlyChart(monthlyStats) {
        const ctx = document.getElementById('monthlyChart');
        if (!ctx) return;
        const isHK = DB.currentCompanyId === 'CO-GW' || DB.currentCompanyId === 'CO-LK';
        const currencySymbol = isHK ? '$' : '¥';
        const months = Object.keys(monthlyStats).sort();
        const revenues = months.map(m => Math.round(monthlyStats[m].revenue));
        const profits = months.map(m => Math.round(monthlyStats[m].profit));

        App.charts.monthly = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: months,
                datasets: [
                    {
                        label: `营收 (${currencySymbol})`,
                        data: revenues,
                        backgroundColor: 'rgba(37, 99, 235, 0.7)',
                        borderRadius: 4
                    },
                    {
                        label: `利润 (${currencySymbol})`,
                        data: profits,
                        backgroundColor: 'rgba(22, 163, 74, 0.7)',
                        borderRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom', labels: { font: { size: 12 } } } },
                scales: {
                    y: { beginAtZero: true, ticks: { callback: v => currencySymbol + (v / 10000).toFixed(0) + '万' } }
                }
            }
        });
    },

    renderStatusChart(statusStats) {
        const ctx = document.getElementById('statusChart');
        if (!ctx) return;
        const labels = Object.keys(statusStats);
        const data = Object.values(statusStats);
        const colors = ['#16a34a', '#0891b2', '#2563eb', '#9ca3af'];

        App.charts.status = new Chart(ctx, {
            type: 'doughnut',
            data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom', labels: { font: { size: 12 }, padding: 12 } } }
            }
        });
    }
};

window.Dashboard = Dashboard;
