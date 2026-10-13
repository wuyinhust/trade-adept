/** Workspace overview — presentation-only aggregation, using authorized data. */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';
import { escapeHtml } from './utils.js';
import { icon } from './ui.js';

const metric = (label, value, note) =>
    '<div class="dashboard-metric"><div class="stat-label">' +
    escapeHtml(label) +
    '</div><div class="stat-value">' +
    escapeHtml(value) +
    '</div><div class="stat-sub">' +
    escapeHtml(note) +
    '</div></div>';

const queue = (label, value, name, href) =>
    '<a class="queue-item" href="' +
    href +
    '"><span class="queue-icon">' +
    icon(name) +
    '</span><span class="queue-copy"><strong>' +
    escapeHtml(value) +
    '</strong><span>' +
    escapeHtml(label) +
    '</span></span>' +
    icon('arrow') +
    '</a>';

function progress(label, paid, total, currency, color) {
    const percentage = total > 0 ? Math.max(0, Math.min(100, (paid / total) * 100)) : 0;
    return (
        '<div><div class="progress-label"><span>' +
        escapeHtml(label) +
        '</span><strong>' +
        percentage.toFixed(0) +
        '%</strong></div><div class="progress-bar" role="progressbar" aria-label="' +
        escapeHtml(label) +
        '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
        percentage.toFixed(1) +
        '"><div class="progress-fill" style="width:' +
        percentage +
        '%;background:' +
        color +
        '"></div></div><p class="progress-caption">' +
        App.formatMoney(paid, currency) +
        ' / ' +
        App.formatMoney(total, currency) +
        '</p></div>'
    );
}

const Dashboard = {
    getMonthlyData(orders, showFinance = Auth.canSeeFinancials()) {
        const byCurrency = {};
        const monthSet = new Set();
        for (const order of orders) {
            const month = String(order.orderDate || '').slice(0, 7);
            if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) continue;
            const metrics = Exchange.getOrderFinancials(order);
            if (!Number.isFinite(metrics.revenue)) continue;
            const currency = metrics.currency;
            byCurrency[currency] ||= {};
            byCurrency[currency][month] ||= { revenue: 0, ...(showFinance ? { profit: null } : {}) };
            byCurrency[currency][month].revenue += Number(metrics.revenue) || 0;
            if (showFinance && Number.isFinite(metrics.profit)) {
                byCurrency[currency][month].profit = (byCurrency[currency][month].profit ?? 0) + metrics.profit;
            }
            monthSet.add(month);
        }
        return {
            byCurrency,
            months: [...monthSet].sort().slice(-6),
            currencies: Object.keys(byCurrency).sort(),
            showFinance
        };
    },

    render(container) {
        const stats = DB.getDashboardStats();
        const orders = DB.getOrders();
        const visibleOrderIds = new Set(orders.map(order => String(order.id)));
        const showFinance = Auth.canSeeFinancials();
        const isDocument = Auth.isDocument();
        const company = DB.companies.find(item => item.id === DB.currentCompanyId)?.name || '';
        const scope = Auth.canSeeAll() ? '全部公司数据 · 当前账套：' + company : '当前账套：' + company;
        const totals = {
            CNY: { profit: 0, profitKnown: 0, cost: 0, paid: 0 },
            USD: { profit: 0, profitKnown: 0, cost: 0, paid: 0 }
        };
        const unknownHistoryCount = showFinance
            ? orders.filter(
                  order =>
                      Exchange.getOrderFinancials(order).incompleteHistory ||
                      !Number.isFinite(order.paidAmountUSD) ||
                      !Number.isFinite(order.factoryPaidRMB)
              ).length
            : 0;
        const knownBalanceOrders = orders.filter(order => Number.isFinite(order.paidAmountUSD));
        const financialCurrencies = new Set();
        if (showFinance) {
            for (const order of orders) {
                const metrics = Exchange.getOrderFinancials(order);
                const currency = metrics.currency;
                totals[currency] ||= { profit: 0, profitKnown: 0, cost: 0, paid: 0 };
                financialCurrencies.add(currency);
                if (Number.isFinite(metrics.profit)) {
                    totals[currency].profit += metrics.profit;
                    totals[currency].profitKnown++;
                }
                if (Number.isFinite(metrics.factoryCost) && Number.isFinite(order.factoryPaidRMB)) {
                    totals[currency].cost += metrics.factoryCost;
                    totals[currency].paid += order.factoryPaidRMB;
                }
            }
        }
        const primaryCurrency = financialCurrencies.has('CNY')
            ? 'CNY'
            : [...financialCurrencies].sort()[0] ||
              Exchange.getOrderFinancials({ companyId: DB.currentCompanyId }).currency;
        totals[primaryCurrency] ||= { profit: 0, profitKnown: 0, cost: 0, paid: 0 };
        const secondaryNote =
            [...financialCurrencies]
                .filter(currency => currency !== primaryCurrency)
                .map(currency => currency + ' 利润 ' + App.formatMoney(totals[currency].profit, currency))
                .join(' · ') || '结算币种 · ' + primaryCurrency;
        const thirdMetric = showFinance
            ? metric(
                  '订单利润 · ' + primaryCurrency,
                  totals[primaryCurrency].profitKnown || !orders.length
                      ? App.formatMoney(totals[primaryCurrency].profit, primaryCurrency)
                      : '—',
                  secondaryNote
              )
            : metric(
                  isDocument ? '待出运订单' : '客户数量',
                  String(isDocument ? stats.pendingShipmentCount : stats.customerCount),
                  isDocument ? '持续跟进每一笔交付' : '当前公司 · ' + company
              );
        const factoryUnpaid =
            Object.keys(totals)
                .sort()
                .filter(currency => totals[currency].cost > 0)
                .map(currency => App.formatMoney(totals[currency].cost - totals[currency].paid, currency))
                .join(' / ') || (unknownHistoryCount ? '—' : App.formatMoney(0, primaryCurrency));
        const rows = stats.upcomingShipments
            .filter(shipment => visibleOrderIds.has(String(shipment.orderId)))
            .map(
                shipment =>
                    '<tr><td><a class="table-link" href="#/orders/' +
                    encodeURIComponent(shipment.orderId) +
                    '">' +
                    escapeHtml(shipment.orderId) +
                    '</a></td><td>' +
                    escapeHtml(shipment.customerName) +
                    '</td><td>' +
                    escapeHtml(shipment.loadingPort || '-') +
                    '<span class="text-gray"> → </span>' +
                    escapeHtml(shipment.overseasPort || shipment.destinationPort || '-') +
                    '</td><td>' +
                    App.formatDate(shipment.etd) +
                    '</td><td>' +
                    App.getShippingBadge(shipment.status) +
                    '</td></tr>'
            )
            .join('');
        const factoryProgress = showFinance
            ? Object.keys(totals)
                  .sort()
                  .filter(currency => totals[currency].cost > 0)
                  .map(currency =>
                      progress(
                          '工厂付款 · ' + currency,
                          totals[currency].paid,
                          totals[currency].cost,
                          currency,
                          'var(--success)'
                      )
                  )
                  .join('')
            : '';
        const monthlyData = this.getMonthlyData(orders, showFinance);
        const monthlyCards = isDocument
            ? ''
            : (monthlyData.currencies.length ? monthlyData.currencies : ['empty'])
                  .map(
                      currency =>
                          '<div class="card"><div class="card-header"><span class="card-title">月度经营趋势' +
                          (currency === 'empty' ? '' : ' · ' + escapeHtml(currency)) +
                          '</span><span class="section-caption">同一图表仅汇总一种结算币种</span></div><div class="card-body"><div class="chart-container"><canvas id="monthlyChart-' +
                          escapeHtml(currency) +
                          '" role="img" aria-label="' +
                          escapeHtml(
                              currency === 'empty'
                                  ? '月度经营趋势'
                                  : currency + (showFinance ? ' 月度营收与利润趋势' : ' 月度营收趋势')
                          ) +
                          '"></canvas></div></div></div>'
                  )
                  .join('');
        const quotedRevenueUSD = orders.reduce((sum, order) => sum + (Number(order.orderAmountUSD) || 0), 0);
        const customerPaidUSD = showFinance
            ? knownBalanceOrders.reduce((sum, order) => sum + order.paidAmountUSD, 0)
            : 0;
        const knownBalanceRevenueUSD = knownBalanceOrders.reduce(
            (sum, order) => sum + (Number(order.orderAmountUSD) || 0),
            0
        );
        container.innerHTML =
            '<section class="page-intro"><div><div class="page-eyebrow">TRADE WORKSPACE</div>' +
            '<h2>业务总览</h2><p class="page-description">订单进展与出运安排，集中掌握。</p><span class="scope-label">' +
            escapeHtml(scope) +
            '</span></div><div class="page-intro-actions"><a class="btn btn-secondary" href="#/orders">查看订单</a>' +
            '<button class="btn btn-primary" onclick="App.openNewOrder()">' +
            icon('plus') +
            '新建订单</button></div></section>' +
            '<section class="dashboard-metrics" aria-label="业务指标">' +
            metric(
                '订单总数',
                String(stats.totalOrders),
                stats.activeOrders + ' 笔未取消 · ' + stats.completedOrders + ' 笔已订船'
            ) +
            metric('订单营收 · USD', App.formatMoney(quotedRevenueUSD, 'USD'), '按当前可见订单报价汇总') +
            thirdMetric +
            (showFinance || isDocument
                ? metric('客户数量', String(stats.customerCount), '当前公司 · ' + company)
                : '') +
            metric('工厂数量', String(stats.factoryCount ?? '—'), '当前公司 · ' + company) +
            '</section>' +
            (unknownHistoryCount
                ? '<p class="text-sm text-gray">部分历史金额或余额未知；汇总只使用已知值，不按当前汇率补算历史。</p>'
                : '') +
            '<section class="work-queue" aria-label="工作进度">' +
            queue('待出运订单', stats.pendingShipmentCount + ' 笔', 'shipping', '#/shipping') +
            (showFinance
                ? queue(
                      '待收款 · USD',
                      knownBalanceOrders.length || !orders.length
                          ? App.formatMoney(knownBalanceRevenueUSD - customerPaidUSD, 'USD')
                          : '—',
                      'wallet',
                      '#/orders'
                  )
                : '') +
            (showFinance ? queue('待付工厂货款', factoryUnpaid, 'factory', '#/orders') : '') +
            '</section>' +
            '<section class="card dashboard-shipping"><div class="card-header"><span class="card-title">近期出运安排</span>' +
            '<a class="btn btn-sm btn-secondary" href="#/shipping">全部出运 ' +
            icon('arrow') +
            '</a></div>' +
            '<div class="table-container"><table><thead><tr><th>操作单号</th><th>客户</th><th>航线</th><th>预计出运</th><th>出运状态</th></tr></thead>' +
            '<tbody>' +
            (rows ||
                '<tr><td colspan="5" class="text-center text-gray" style="padding:36px">暂无近期出运记录</td></tr>') +
            '</tbody></table></div></section>' +
            '<section class="chart-grid">' +
            monthlyCards +
            '<div class="card"><div class="card-header"><span class="card-title">订单状态分布</span><span class="section-caption">' +
            stats.totalOrders +
            ' 笔订单</span></div><div class="card-body"><div class="chart-container"><canvas id="statusChart" role="img" aria-label="订单状态分布"></canvas></div></div></div></section>' +
            (showFinance
                ? '<section class="card mt-6"><div class="card-header"><span class="card-title">收付款进度</span><span class="section-caption">依据实际收付金额</span></div>' +
                  '<div class="card-body dashboard-progress">' +
                  progress('客户收款 · USD', customerPaidUSD, quotedRevenueUSD, 'USD', 'var(--accent)') +
                  factoryProgress +
                  '</div></section>'
                : '');
        this.renderMonthlyChart(monthlyData);
        this.renderStatusChart(stats.statusStats);
    },

    renderMonthlyChart(monthlyData = this.getMonthlyData(DB.getOrders())) {
        const { months, currencies, byCurrency, showFinance } = monthlyData;
        if (!months.length) {
            const canvas = document.getElementById('monthlyChart-empty');
            if (canvas) {
                canvas.parentElement.innerHTML = '<div class="empty-state text-gray">有订单后显示经营趋势</div>';
            }
            return;
        }
        for (const unit of currencies) {
            const canvas = document.getElementById('monthlyChart-' + unit);
            if (!canvas) continue;
            const datasets = [
                {
                    label: '营收 · ' + unit,
                    data: months.map(month => byCurrency[unit][month]?.revenue || 0),
                    backgroundColor: '#0071e3',
                    borderRadius: 5,
                    maxBarThickness: 48,
                    yAxisID: 'y'
                }
            ];
            if (showFinance && Auth.canSeeFinancials()) {
                datasets.push({
                    label: '利润 · ' + unit,
                    data: months.map(month =>
                        byCurrency[unit][month]?.profit === null ? null : byCurrency[unit][month]?.profit || 0
                    ),
                    backgroundColor: '#80b8a4',
                    borderRadius: 5,
                    maxBarThickness: 48,
                    yAxisID: 'y'
                });
            }
            App.charts['monthly-' + unit] = new Chart(canvas, {
                type: 'bar',
                data: { labels: months, datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { padding: 16, font: { size: 10 } } } },
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: { display: true, text: unit },
                            ticks: { callback: value => App.formatMoney(value, unit) }
                        }
                    }
                }
            });
        }
    },

    renderStatusChart(statusStats) {
        const canvas = document.getElementById('statusChart');
        if (!canvas) return;
        const labels = Object.keys(statusStats);
        if (!labels.length) {
            canvas.parentElement.innerHTML = '<div class="empty-state text-gray">有订单后显示状态分布</div>';
            return;
        }
        const palette = { 进行中: '#0071e3', 已订船: '#80b8a4', 推迟出货: '#d8b277', 已取消: '#a2a7af' };
        App.charts.status = new Chart(canvas, {
            type: 'doughnut',
            data: {
                labels,
                datasets: [
                    {
                        data: Object.values(statusStats),
                        backgroundColor: labels.map(label => palette[label] || '#a2a7af'),
                        borderWidth: 0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '76%',
                plugins: { legend: { position: 'bottom', labels: { padding: 16, font: { size: 10 } } } }
            }
        });
    }
};

window.Dashboard = Dashboard;
export { Dashboard };
