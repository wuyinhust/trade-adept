/**
 * Shared presentation helpers. Business data and authorization stay in their modules.
 */
const paths = {
    overview:
        '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    orders: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v4H9zM9 12h6M9 16h4"/>',
    customers:
        '<circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M21 21v-2a6 6 0 0 0-4-5.65"/>',
    factory: '<path d="M3 21V10l6 3V8l6 3V3h4l2 18zM7 17h1M12 17h1M17 17h1"/>',
    chart: '<path d="M3 3v18h18M7 16l5-6 4 3 5-8"/>',
    shipping: '<path d="M3 16l9-4 9 4-2 5H5zM8 14V6h8v8M12 6V3M2 22c2 1 4-1 6 0s4 1 6 0 4-1 8 0"/>',
    settings:
        '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
    edit: '<path d="m16 3 5 5-12 12-6 1 1-6zM14 5l5 5"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
    wallet: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M16 14h3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
    moon: '<path d="M20 14A8.5 8.5 0 0 1 10 4 8.5 8.5 0 1 0 20 14z"/>',
    arrow: '<path d="m9 5 7 7-7 7"/>',
    back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
    refresh: '<path d="M20 8a8 8 0 0 0-14-3L3 8M3 3v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    logout: '<path d="M9 4H4v16h5M14 8l4 4-4 4M8 12h13"/>',
    box: '<path d="m3 7 9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10"/>',
    warning: '<path d="m12 3 10 18H2zM12 9v5M12 17h.01"/>'
};

function icon(name) {
    return (
        '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        (paths[name] || paths.orders) +
        '</svg>'
    );
}

const prefixes = [
    ['📊', 'chart'],
    ['📋', 'orders'],
    ['👥', 'customers'],
    ['👤', 'customers'],
    ['🏭', 'factory'],
    ['💰', 'wallet'],
    ['💵', 'wallet'],
    ['💳', 'wallet'],
    ['🚢', 'shipping'],
    ['⚙️', 'settings'],
    ['📥', 'download'],
    ['📤', 'upload'],
    ['➕', 'plus'],
    ['✏️', 'edit'],
    ['📝', 'edit'],
    ['🗑️', 'trash'],
    ['🔄', 'refresh'],
    ['🔍', 'search'],
    ['☀️', 'sun'],
    ['🌙', 'moon'],
    ['⏳', 'clock'],
    ['⏰', 'clock'],
    ['📦', 'box'],
    ['📈', 'chart'],
    ['🚪', 'logout'],
    ['⚠️', 'warning'],
    ['✅', 'check'],
    ['←', 'back'],
    ['🧪', 'settings'],
    ['🔌', 'refresh'],
    ['☁️', 'settings'],
    ['💱', 'wallet'],
    ['🛠️', 'settings'],
    ['💾', 'check'],
    ['📌', 'orders'],
    ['⏸️', 'clock'],
    ['▶️', 'refresh'],
    ['🏢', 'factory']
];

const fieldNames = {
    globalSearch: '搜索订单号、客户名',
    companySelect: '当前公司',
    orderSearchInput: '搜索订单',
    filterStatus: '订单状态',
    filterPayment: '收款状态',
    filterShipping: '出运状态',
    customerSearchInput: '搜索客户',
    factorySearchInput: '搜索工厂',
    shippingSearchInput: '搜索出运记录',
    filterShippingStatus: '出运状态',
    profitCustomerFilter: '筛选客户',
    profitStartDate: '开始日期',
    profitEndDate: '结束日期'
};

const UI = {
    icon,
    _fieldId: 0,
    init() {
        this.decorate(document);
        this.updateChartDefaults();
        const observer = new window.MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node.nodeType === 1) {
                        this.decorate(node);
                        const table = node.closest('table');
                        if (table) this.decorate(table);
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    },
    decorate(root) {
        const select = selector => [...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)];
        for (const holder of select('[data-icon]')) {
            if (!holder.querySelector('svg')) holder.innerHTML = icon(holder.dataset.icon);
        }
        for (const node of select(
            '.btn, .stat-icon, .card-title, .form-section-title, .modal-body h3, .search-icon, .logout-item'
        )) {
            const first = node.firstChild;
            if (!first || first.nodeType !== 3) continue;
            const text = first.textContent.trimStart();
            const match = prefixes.find(([prefix]) => text.startsWith(prefix));
            if (!match) continue;
            first.textContent = text.slice(match[0].length).trimStart();
            node.insertAdjacentHTML('afterbegin', icon(match[1]));
        }
        for (const input of select('input, select, textarea')) {
            if (input.id && fieldNames[input.id]) input.setAttribute('aria-label', fieldNames[input.id]);
            const label = input.closest('.form-group')?.querySelector('.form-label');
            if (label && label.tagName === 'LABEL') {
                if (!input.id) {
                    do {
                        input.id = 'uiField' + ++this._fieldId;
                    } while (document.getElementById(input.id) !== input);
                }
                label.htmlFor = input.id;
            }
            if (!input.hasAttribute('aria-label') && !label && input.placeholder) {
                input.setAttribute('aria-label', input.placeholder);
            }
        }
        for (const table of select('table')) {
            const headings = Array.from(table.querySelectorAll('thead th'));
            headings.forEach((heading, index) => {
                if (!/金额|成本|利润|数量|总额|毛重|净重|体积/.test(heading.textContent)) return;
                heading.classList.add('numeric');
                for (const row of table.querySelectorAll('tbody tr')) row.children[index]?.classList.add('numeric');
            });
        }
        for (const canvas of select('canvas')) {
            const title = canvas.closest('.card')?.querySelector('.card-title')?.textContent;
            if (title) {
                canvas.setAttribute('role', 'img');
                canvas.setAttribute('aria-label', title.trim());
            }
        }
    },
    colors() {
        const style = window.getComputedStyle(document.documentElement);
        return {
            text: style.getPropertyValue('--text-secondary').trim(),
            border: style.getPropertyValue('--border').trim(),
            surface: style.getPropertyValue('--surface').trim()
        };
    },
    updateChartDefaults() {
        if (!window.Chart) return;
        const colors = this.colors();
        window.Chart.defaults.color = colors.text;
        window.Chart.defaults.font.family = window.getComputedStyle(document.body).fontFamily;
        window.Chart.defaults.font.size = 11;
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.Chart.defaults.animation.duration = reduceMotion ? 0 : 200;
        window.Chart.defaults.transitions.active.animation.duration = reduceMotion ? 0 : 140;
        window.Chart.defaults.scale.grid.color = colors.border;
        window.Chart.defaults.scale.border.display = false;
        window.Chart.defaults.plugins.legend.labels.usePointStyle = true;
        window.Chart.defaults.plugins.legend.labels.pointStyle = 'circle';
        window.Chart.defaults.plugins.legend.labels.boxWidth = 6;
        window.Chart.defaults.plugins.legend.labels.boxHeight = 6;
    },
    refreshCharts(charts) {
        this.updateChartDefaults();
        const colors = this.colors();
        for (const chart of Object.values(charts)) {
            chart.options.plugins.legend.labels.color = colors.text;
            for (const scale of Object.values(chart.options.scales || {})) {
                scale.ticks.color = colors.text;
                scale.grid.color = colors.border;
            }
            if (chart.config.type === 'doughnut') {
                for (const data of chart.data.datasets) data.borderColor = colors.surface;
            }
            chart.update('none');
        }
    },
    focusDialog(container, onClose) {
        const modal = container.querySelector('.modal');
        if (!modal) return;
        const title = modal.querySelector('.modal-title');
        if (title) title.id = 'activeModalTitle';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'activeModalTitle');
        modal.tabIndex = -1;
        this.decorate(modal);
        const focusables = () =>
            Array.from(
                modal.querySelectorAll(
                    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'
                )
            ).filter(node => node.getClientRects().length);
        modal.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
                return;
            }
            if (event.key !== 'Tab') return;
            const elements = focusables();
            const first = elements[0];
            const last = elements[elements.length - 1];
            if (!first) {
                event.preventDefault();
                modal.focus();
                return;
            }
            if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === modal)) {
                event.preventDefault();
                first.focus();
            }
        });
        (
            modal.querySelector('input:not([type="hidden"]), select') ||
            modal.querySelector('.modal-close') ||
            modal
        ).focus();
    }
};

export { UI, icon };
