/**
 * 主应用控制器 - 路由、登录、权限、公共工具
 */

import { CONSTANTS } from './constants.js';
import { Auth } from './auth.js';
import { Cloud } from './cloud.js';
import { DB } from './data.js';
import { Exchange } from './exchange.js';
import { escapeHtml, handleError, toast, safeCall, validate, EventBus } from './utils.js';
import { UI } from './ui.js';

const App = {
    currentPage: 'dashboard',
    charts: {},

    // ==================== 页面模块懒加载 ====================
    _pageModules: {},
    _pageModulePaths: {
        dashboard: './dashboard.js',
        orders: './orders.js',
        customers: './customers.js',
        factories: './factories.js',
        profit: './profit.js',
        shipping: './shipping.js',
        settings: './workspace-settings.js',
        admin: './administrator.js',
        onboarding: './administrator.js'
    },
    _pendingSearch: null,

    /**
     * 按需动态加载页面模块（带缓存）
     * @param {string} page - 页面名称
     * @returns {Promise<Object>} 模块对象
     */
    async _loadPageModule(page) {
        if (this._pageModules[page]) return this._pageModules[page];
        const path = this._pageModulePaths[page];
        if (!path) throw new Error(`Unknown page: ${page}`);
        const mod = await import(path);
        this._pageModules[page] = mod;
        return mod;
    },

    // ==================== 事件总线（委托给 utils） ====================
    on: EventBus.on.bind(EventBus),
    off: EventBus.off.bind(EventBus),
    emit: EventBus.emit.bind(EventBus),

    // ==================== 安全/错误/Toast 工具（委托给 utils） ====================
    escapeHtml,
    handleError,
    toast,
    safeCall,
    validate,

    async init() {
        UI.init();
        this.initTheme();
        // === 全局错误边界 ===
        window.addEventListener('error', e => {
            // 只处理应用代码错误，忽略资源加载失败和 SDK 内部错误
            if (!e.filename || e.filename.includes('cloudbase-sdk')) return;
            console.error('[App] 未捕获错误:', e.message, e.filename, e.lineno);
            toast('应用出现意外错误，请刷新页面后重试', 'error', 8000);
        });

        window.addEventListener('unhandledrejection', e => {
            const msg = e.reason?.message || String(e.reason);
            // 忽略 AbortError（fetch 取消、用户导航取消等）
            if (msg.includes('AbortError') || msg.includes('aborted')) return;
            console.error('[App] 未处理的 Promise 拒绝:', msg);
            toast('操作失败: ' + (msg.length > 50 ? msg.substring(0, 50) + '...' : msg), 'error', 6000);
        });

        // 检查登录状态
        const loggedIn = await Auth.init();
        if (loggedIn) {
            await this.showApp();
        } else {
            this.showLogin();
        }
    },

    // ==================== 登录 ====================
    showLogin() {
        document.getElementById('loginPage').style.display = 'flex';
        document.getElementById('app').style.display = 'none';
    },

    async showApp() {
        const loading = document.getElementById('loadingOverlay');
        try {
            document.getElementById('loginPage').style.display = 'none';
            document.getElementById('app').style.display = 'flex';

            // 初始化主题（保留已保存的偏好，首次默认浅色）
            this.initTheme();

            // 显示加载遮罩
            if (loading) {
                const text = loading.querySelector('.loading-text');
                if (text) text.textContent = '正在连接云端...';
                loading.style.display = 'flex';
            }

            const ok = await DB.init();

            // 隐藏加载遮罩
            if (loading) loading.style.display = 'none';

            if (!ok) {
                toast('云端连接失败，数据可能未同步。请检查网络后刷新页面。', 'error', 6000);
            }

            // 强制修复旧版本污染的利润数据（v45+ 一次性数据迁移）
            // 旧代码对 HK 公司错误地乘了汇率，导致 profitRMB / orderAmountRMB 异常
            if (!DB._preserveImportedValues) Exchange.recalcAllOrders();

            this.updateCloudStatus();
            this.renderCompanySelect();
            this.updateExchangeRateDisplay();
            this.updateUserDisplay();
            this.updateCompanyDisplay();
            this.updateSidebarVisibility();
            this.setupRouter();
            this.setupGlobalSearch();
            // 默认跳转总览
            if (!window.location.hash || window.location.hash === '#/') {
                window.location.hash = '#/dashboard';
            } else {
                this.router();
            }

            // A closing tab preserves a local draft. All business writes use the
            // authenticated, version-checked API; unload never bypasses that API.
            window.addEventListener('beforeunload', () => {
                DB._stopPolling();
                DB._backupToLocal();
            });

            // 页面隐藏时（切到后台/锁屏）也尝试保存
            document.addEventListener('visibilitychange', () => {
                if (document.hidden && DB._cloudReady) {
                    DB.flush().catch(() => {});
                }
            });
        } catch (err) {
            console.error('[App] showApp 异常:', err);
            if (loading) loading.style.display = 'none';
            const content = document.getElementById('pageContent');
            if (content) {
                content.innerHTML = `
                    <div style="text-align:center;padding:60px 20px">
                        <div style="font-size:48px;margin-bottom:16px">⚠️</div>
                        <h2 style="margin-bottom:12px">页面加载出错</h2>
                        <p style="color:#EF4444;margin-bottom:16px;font-family:monospace;font-size:12px;max-width:600px;margin-left:auto;margin-right:auto;word-break:break-all">${escapeHtml(err.message)}</p>
                        <p style="color:var(--gray-500);margin-bottom:24px">请尝试按 <strong>Ctrl+F5</strong> 强制刷新页面，或返回登录重试。</p>
                        <button class="btn btn-primary" onclick="location.reload(true)">🔄 强制刷新 (Ctrl+F5)</button>
                        <button class="btn btn-secondary" style="margin-left:8px" onclick="document.getElementById('app').style.display='none';document.getElementById('loginPage').style.display='flex'">🔙 返回登录</button>
                    </div>
                `;
            }
        }
    },

    async handleLogin(event) {
        event.preventDefault();
        const username = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;
        const errorEl = document.getElementById('loginError');

        if (!username || !password) {
            errorEl.textContent = '请输入用户名和密码';
            errorEl.style.display = 'block';
            return;
        }

        const result = await Auth.login(username, password);
        if (result.success) {
            errorEl.style.display = 'none';
            await this.showApp();
        } else {
            errorEl.textContent = result.error;
            errorEl.style.display = 'block';
        }
    },

    async handleLogout() {
        // 停止云同步轮询 + 强制保存
        DB._stopPolling();
        if (DB._pendingSave) {
            try {
                await DB.flush();
                console.log('[App] 退出登录前数据已刷新');
            } catch (e) {
                console.warn('[App] 退出登录前刷新失败:', e.message);
            }
        }
        await Auth.logout();
        // 清理状态
        this.charts = {};
        document.getElementById('pageContent').innerHTML = '';
        this.showLogin();
        document.getElementById('loginUsername').value = '';
        document.getElementById('loginPassword').value = '';
    },

    // ==================== 主题切换 ====================
    THEME_KEY: 'trade_workspace_theme',

    toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        this._applyTheme(next);
    },

    _applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
        localStorage.setItem(this.THEME_KEY, theme);
        this._updateThemeToggleUI(theme);
        UI.refreshCharts(this.charts);
    },

    _updateThemeToggleUI(theme) {
        const icon = document.getElementById('themeToggleIcon');
        const label = document.getElementById('themeToggleLabel');
        if (icon) icon.innerHTML = UI.icon(theme === 'dark' ? 'sun' : 'moon');
        if (label) label.textContent = theme === 'dark' ? '浅色模式' : '暗色模式';
    },

    initTheme() {
        const saved = localStorage.getItem(this.THEME_KEY);
        const theme = saved || 'light';
        this._applyTheme(theme);
    },

    // ==================== 云状态 ====================
    updateCloudStatus() {
        const bar = document.getElementById('cloudStatusBar');
        const icon = document.getElementById('cloudStatusIcon');
        const text = document.getElementById('cloudStatusText');
        if (!bar || !icon || !text) return;

        if (DB._cloudReady) {
            bar.style.display = 'block';
            bar.style.background = 'rgba(48,209,88,0.1)';
            bar.style.color = '#1b8a3d';
            icon.textContent = '';
            const meta = Cloud.getLastMeta();
            let statusText = 'Cloud Synced';
            if (meta && meta.updatedAt) {
                const ago = this._timeAgo(meta.updatedAt);
                statusText = 'Synced ' + ago;
                if (meta.updatedBy && meta.updatedBy !== 'unknown') {
                    statusText += ' by ' + meta.updatedBy;
                }
            }
            text.textContent = statusText;
            bar.title = 'Multi-user sync active — tap to refresh';
            bar.onclick = () => {
                App.refreshCloud();
            };
        } else {
            bar.style.display = 'block';
            bar.style.background = 'rgba(255,59,48,0.1)';
            bar.style.color = '#ff3b30';
            icon.textContent = '';
            text.textContent = 'Offline';
            bar.title = 'CloudBase not connected. Check configuration.';
            bar.onclick = () => {
                location.reload();
            };
        }
    },

    /** 简单的"多久前"格式化 */
    _timeAgo(isoStr) {
        if (!isoStr) return '';
        const diff = Date.now() - new Date(isoStr).getTime();
        const sec = Math.floor(diff / 1000);
        if (sec < 60) return '刚刚';
        const min = Math.floor(sec / 60);
        if (min < 60) return min + '分钟前';
        const hr = Math.floor(min / 60);
        if (hr < 24) return hr + '小时前';
        return Math.floor(hr / 24) + '天前';
    },

    /** 更新自动保存状态指示器 */
    _saveStatusTimer: null,
    updateSaveStatus(status, message) {
        const el = document.getElementById('saveStatusText');
        if (!el) return;
        // 清除之前的自动隐藏定时器
        if (this._saveStatusTimer) {
            clearTimeout(this._saveStatusTimer);
            this._saveStatusTimer = null;
        }

        switch (status) {
            case 'saving':
                el.textContent = '⏳ 保存中...';
                el.style.color = '#92400E';
                break;
            case 'saved':
                el.textContent = '✅ 已保存';
                el.style.color = 'var(--success)';
                // 3 秒后自动变回空白
                this._saveStatusTimer = setTimeout(() => {
                    el.textContent = '';
                }, 3000);
                break;
            case 'error':
                el.textContent = '❌ ' + (message || '保存失败');
                el.style.color = 'var(--danger)';
                break;
            default:
                el.textContent = '';
        }
    },

    async refreshCloud() {
        if (!DB._cloudReady) {
            toast('云端未连接，请检查 CloudBase 配置后刷新页面', 'warning');
            return;
        }
        const text = document.getElementById('cloudStatusText');
        if (text) text.textContent = '同步中...';
        try {
            const result = await DB.refreshFromCloud();
            if (result && result.ok) {
                const meta = result.meta;
                let msg = '云端数据已刷新';
                if (meta && meta.updatedBy && meta.updatedBy !== 'unknown') {
                    msg += ' (最后编辑: ' + meta.updatedBy + ')';
                }
                toast(msg, 'success');
                // 刷新当前页面
                this.router();
                this.updateCloudStatus();
                this.updateExchangeRateDisplay();
            } else {
                toast('云端暂无数据', 'info');
            }
        } catch (e) {
            toast('刷新失败: ' + e.message, 'error');
        }
        this.updateCloudStatus();
    },

    // ==================== 公司选择 ====================
    /** 动态渲染公司选择下拉框 */
    renderCompanySelect() {
        const selectEl = document.getElementById('companySelect');
        if (!selectEl) return;
        const companies = DB.getAccessibleCompanies();
        selectEl.innerHTML = companies.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        // 如果当前公司不在可访问列表中，自动切换到第一个
        const visibleIds = companies.map(c => c.id);
        if (!visibleIds.includes(DB.currentCompanyId)) {
            DB.setCurrentCompany(visibleIds[0]);
        }
    },

    selectCompany(companyId) {
        if (DB.currentCompanyId === companyId) return;
        DB.setCurrentCompany(companyId);
        this.updateCompanyDisplay();
        this.updateExchangeRateDisplay();
        // 清除图表缓存，重新渲染当前页面
        Object.values(this.charts).forEach(c => {
            if (c && c.destroy) c.destroy();
        });
        this.charts = {};
        this.router();
        toast('已切换到：' + DB.getCurrentCompany().name, 'info');
    },

    updateCompanyDisplay() {
        const company = DB.getCurrentCompany();
        const displayEl = document.getElementById('companyDisplayName');
        const selectEl = document.getElementById('companySelect');
        if (displayEl) displayEl.textContent = company ? company.name : '选择公司';
        if (selectEl) selectEl.value = company ? company.id : '';
    },

    // ==================== 用户显示 ====================
    updateUserDisplay() {
        const user = Auth.currentUser;
        if (!user) return;

        document.getElementById('userAvatar').textContent = user.name.charAt(0);
        document.getElementById('userNameDisplay').textContent = user.name;

        const roleNames = {
            admin: '管理员',
            finance: '财务',
            manager: '经理',
            salesperson: '业务员',
            document: '单证'
        };
        const roleName =
            Auth.roles?.[user.role]?.label ||
            Auth.roles?.[user.role]?.name ||
            roleNames[user.baseRole || user.role] ||
            user.role;
        const roleBadge = document.getElementById('userRoleBadge');
        roleBadge.textContent = roleName;
        roleBadge.className = 'user-role-badge role-' + user.role;

        document.getElementById('dropdownName').textContent = user.name;
        document.getElementById('dropdownRole').textContent =
            roleName + (user.teamId ? ' | ' + (Auth.teams[user.teamId]?.name || user.teamId) : '');
    },

    toggleUserMenu() {
        const dropdown = document.getElementById('userDropdown');
        const isVisible = dropdown.style.display === 'block';
        dropdown.style.display = isVisible ? 'none' : 'block';
    },

    // ==================== 移动端侧边栏 ====================
    toggleMobileSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        const isOpen = sidebar.classList.contains('open');
        if (isOpen) {
            sidebar.classList.remove('open');
            overlay.classList.remove('visible');
        } else {
            sidebar.classList.add('open');
            overlay.classList.add('visible');
        }
    },
    closeMobileSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        sidebar.classList.remove('open');
        overlay.classList.remove('visible');
    },

    // ==================== 侧边栏可见性 ====================
    updateSidebarVisibility() {
        const visible = Auth.getVisiblePages();
        const allNavs = ['dashboard', 'orders', 'customers', 'factories', 'profit', 'shipping', 'settings', 'admin'];

        allNavs.forEach(page => {
            const nav = document.getElementById('nav-' + page);
            if (nav) {
                nav.style.display = visible.includes(page) ? '' : 'none';
            }
        });
        const adminLabel = document.getElementById('adminNavLabel');
        if (adminLabel) adminLabel.style.display = visible.includes('admin') ? '' : 'none';
    },

    // ==================== 路由 ====================
    setupRouter() {
        window.addEventListener('hashchange', () => this.router());
    },

    async router() {
        // 移动端：路由跳转时关闭侧边栏
        this.closeMobileSidebar();

        const hash = window.location.hash.slice(2) || 'dashboard';
        const [page, encodedParam] = hash.split('/');
        let param = encodedParam;
        if (encodedParam) {
            try {
                param = decodeURIComponent(encodedParam);
            } catch (_) {
                /* Keep malformed routes inert. */
            }
        }

        if (
            Auth.onboarding &&
            Auth.onboarding.status !== 'complete' &&
            Auth.canManageEnterprise() &&
            !['onboarding', 'admin'].includes(page)
        ) {
            window.location.hash = '#/onboarding';
            return;
        }

        // 权限检查：不允许访问的页面重定向到总览
        const visible = Auth.getVisiblePages();
        if (!visible.includes(page)) {
            window.location.hash = '#/dashboard';
            return;
        }

        // 更新导航高亮
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.page === page);
            if (item.dataset.page === page) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        });

        // 更新页面标题
        const titles = {
            dashboard: '总览',
            orders: '订单管理',
            customers: '客户管理',
            factories: '工厂管理',
            profit: '利润分析',
            shipping: '物流单证',
            settings: '系统设置',
            admin: '管理中心',
            onboarding: '企业初始化'
        };
        document.getElementById('pageTitle').textContent = titles[page] || '总览';

        // 销毁旧图表
        Object.values(this.charts).forEach(c => {
            if (c && c.destroy) c.destroy();
        });
        this.charts = {};

        // 显示加载状态
        const content = document.getElementById('pageContent');
        content.innerHTML =
            '<div style="display:flex;justify-content:center;align-items:center;height:200px"><div class="spinner" style="width:32px;height:32px;border:3px solid var(--gray-200);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite"></div></div>';

        try {
            // 动态加载页面模块（带缓存，首次访问才加载）
            await this._loadPageModule(page);

            // 模块通过 side-effect 注册到 window，直接引用
            const moduleMap = {
                dashboard: () => Dashboard.render(content),
                orders: () => Orders.render(content, param),
                customers: () => Customers.render(content, param),
                factories: () => Factories.render(content, param),
                profit: () => Profit.render(content),
                shipping: () => Shipping.render(content, param),
                settings: () => Settings.render(content),
                admin: () => window.AdminCenter.render(content),
                onboarding: () => window.Onboarding.render(content)
            };

            const renderFn = moduleMap[page] || moduleMap.dashboard;
            await renderFn();
            content.dataset.page = page;
            if (!['dashboard', 'admin', 'onboarding'].includes(page) && !param) {
                this.renderPageIntro(content, page, titles[page]);
            }
            UI.decorate(content);

            // 处理待执行的全局搜索
            if (this._pendingSearch && page === 'orders') {
                const q = this._pendingSearch;
                this._pendingSearch = null;
                setTimeout(() => {
                    const orderSearch = document.getElementById('orderSearchInput');
                    if (orderSearch) {
                        orderSearch.value = q;
                        Orders.filter();
                    }
                }, 100);
            }
        } catch (err) {
            handleError(err, '路由加载');
            content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger)">
                <p>⚠️ 页面加载失败</p>
                <p style="font-size:13px;margin-top:8px">${escapeHtml(err.message)}</p>
                <button class="btn btn-primary" style="margin-top:16px" onclick="App.router()">重试</button>
            </div>`;
        }

        this.currentPage = page;
    },

    // ==================== 全局搜索 ====================
    renderPageIntro(content, page, title) {
        const descriptions = {
            orders: '跟进订单、生产与收款，让每一步进展清晰可见。',
            customers: '维护客户与联系人，连接每一段业务往来。',
            factories: '集中管理合作工厂、生产资料与关联订单。',
            profit: '查看经营结果与成本结构，掌握每笔订单的收益。',
            shipping: '跟进出运、报关与单证，让交付有据可查。',
            settings: '管理法人汇率与业务快照。'
        };
        const company = DB.companies.find(item => item.id === DB.currentCompanyId)?.name || '';
        const scope = Auth.canSeeAll() ? '全部公司数据 · 当前账套：' + company : '当前账套：' + company;
        const intro = document.createElement('section');
        intro.className = 'page-intro';
        intro.innerHTML =
            '<div><div class="page-eyebrow">' +
            escapeHtml(this.workspaceName || 'Tradept') +
            '</div><h2>' +
            escapeHtml(title) +
            '</h2><p class="page-description">' +
            escapeHtml(descriptions[page] || '') +
            '</p><span class="scope-label">' +
            escapeHtml(scope) +
            '</span></div>';
        content.prepend(intro);
    },

    async openNewOrder() {
        await this._loadPageModule('orders');
        Orders.showAddForm();
    },

    setupGlobalSearch() {
        const input = document.getElementById('globalSearch');
        let debounceTimer;
        input.addEventListener('input', e => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const q = e.target.value.trim();
                if (q.length >= 2) {
                    // 存储搜索词，router 加载完 Orders 模块后会自动应用
                    this._pendingSearch = q;
                    window.location.hash = '#/orders';
                }
            }, 300);
        });
    },

    // ==================== 汇率显示 ====================
    updateExchangeRateDisplay() {
        const businessMode = Boolean(DB._businessAPI);
        const rateCompanyId = DB.companies?.find(company =>
            company.settlementCurrency
                ? company.settlementCurrency === 'CNY'
                : businessMode && DB.usesLiveExchangeRate?.(company.id)
        )?.id;
        const fallbackResult = Exchange._lastRateResult || {};
        const fallbackRate = businessMode
            ? fallbackResult.adjustedRate
            : (fallbackResult.adjustedRate ?? DB.getExchangeRate());
        const rate = Number(rateCompanyId ? DB.getExchangeRate(rateCompanyId) : fallbackRate);
        const meta = rateCompanyId
            ? DB.getRateMeta(rateCompanyId)
            : businessMode
              ? { ...fallbackResult }
              : { ...DB.getRateMeta(), ...fallbackResult };
        const el = document.getElementById('exchangeRateDisplay');
        if (el) {
            el.textContent = Number.isFinite(rate) && rate > 0 ? rate.toFixed(4) : '—';
            const parts = [];
            const provider = [meta.provider, meta.source].filter(Boolean).join(' · ');
            if (provider) parts.push(`数据源: ${provider}`);
            if (Number.isFinite(Number(meta.rawRate))) {
                parts.push(`市场参考价: ${Number(meta.rawRate).toFixed(4)}`);
            }
            if (meta.publishedAt) parts.push(`行情发布: ${new Date(meta.publishedAt).toLocaleString('zh-CN')}`);
            const fetchedAt = meta.fetchedAt || meta.updateTime;
            if (fetchedAt) parts.push(`系统获取: ${new Date(fetchedAt).toLocaleString('zh-CN')}`);
            if (meta.stale) parts.push('状态: 上游暂不可用，使用最近一次缓存');
            const nextTime = Exchange.getNextRefreshTime?.() || meta.systemNextCheckAt || meta.scheduledRefreshAt;
            if (nextTime) {
                parts.push(`系统下次检查: ${new Date(nextTime).toLocaleString('zh-CN')}`);
            }
            el.title = parts.join('\n');
        }

        const srcEl = document.getElementById('rateSourceText');
        if (srcEl) {
            if (!Number.isFinite(rate) || rate <= 0) {
                srcEl.textContent = '实时汇率不可用';
            } else {
                const stamp = meta.publishedAt || meta.fetchedAt || meta.updateTime;
                const time = stamp ? new Date(stamp) : null;
                const validTime = time && !Number.isNaN(time.getTime());
                const timeStr = validTime
                    ? `${time.toLocaleDateString('zh-CN')} ${time.toTimeString().slice(0, 5)}`
                    : '当前会话';
                srcEl.textContent = `${meta.stale ? '旧缓存' : '实时行情'} · ${timeStr}`;
            }
        }
    },

    // ==================== 模态框 ====================
    showModal(title, bodyHtml, options = {}) {
        this._modalTrigger = document.activeElement;
        const container = document.getElementById('modalContainer');
        const sizeClass = options.large ? 'modal-large' : '';
        const footerHtml =
            options.footer ||
            `
            <button class="btn btn-secondary" onclick="App.closeModal()">取消</button>
            <button class="btn btn-primary" onclick="App.closeModal()">确定</button>
        `;
        container.innerHTML = `
            <div class="modal-overlay">
                <div class="modal ${sizeClass}">
                    <div class="modal-header">
                        <h2 class="modal-title">${title}</h2>
                        <button class="modal-close" onclick="App.closeModal()" title="关闭弹窗">关闭</button>
                    </div>
                    <div class="modal-body">${bodyHtml}</div>
                    ${options.hideFooter ? '' : `<div class="modal-footer">${footerHtml}</div>`}
                </div>
            </div>
        `;
        UI.focusDialog(container, () => this.closeModal());
    },

    closeModal() {
        document.getElementById('modalContainer').innerHTML = '';
        if (this._modalTrigger?.isConnected) this._modalTrigger.focus();
    },

    showConfirm(message, onConfirm) {
        this._modalTrigger = document.activeElement;
        const container = document.getElementById('modalContainer');
        container.innerHTML = `
            <div class="modal-overlay">
                <div class="modal" style="max-width:400px">
                    <div class="modal-header">
                        <h2 class="modal-title">确认操作</h2>
                        <button class="modal-close" onclick="App.closeModal()" title="关闭弹窗">关闭</button>
                    </div>
                    <div class="modal-body"><p>${escapeHtml(message)}</p></div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" onclick="App.closeModal()">取消</button>
                        <button class="btn btn-danger" id="confirmBtn">确认</button>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('confirmBtn').addEventListener('click', () => {
            App.closeModal();
            onConfirm();
        });
        UI.focusDialog(container, () => this.closeModal());
    },

    // ==================== 工具方法 ====================
    formatMoney(amount, currency = 'CNY') {
        return DB.formatMoney(amount, currency);
    },
    formatDate(dateStr) {
        return DB.formatDate(dateStr);
    },

    getPaymentBadge(status) {
        const map = { 已收款: 'badge-success', 部分收款: 'badge-warning', 未收款: 'badge-danger' };
        return `<span class="badge ${map[status] || 'badge-default'}">${status}</span>`;
    },

    getFactoryPaidBadge(status) {
        const map = { 已付清: 'badge-success', 部分付款: 'badge-warning', 未付款: 'badge-danger' };
        return `<span class="badge ${map[status] || 'badge-default'}">${status || '未付款'}</span>`;
    },

    getStatusBadge(status) {
        const map = {
            进行中: 'badge-primary',
            已订船: 'badge-success',
            已取消: 'badge-default',
            推迟出货: 'badge-warning'
        };
        return `<span class="badge ${map[status] || 'badge-default'}">${status}</span>`;
    },

    getShippingBadge(status) {
        const map = { 已签收: 'badge-success', 已到港: 'badge-info', 已出运: 'badge-primary', 待出运: 'badge-warning' };
        return `<span class="badge ${map[status] || 'badge-default'}">${status}</span>`;
    },

    getCustomsBadge(status) {
        const map = { 已清关: 'badge-success', 清关中: 'badge-warning', 已报关: 'badge-info', 未报关: 'badge-default' };
        return `<span class="badge ${map[status] || 'badge-default'}">${status}</span>`;
    },

    getProfitColor(rate) {
        if (rate >= 25) return 'text-success';
        if (rate >= 15) return 'text-primary';
        if (rate >= 0) return 'text-warning';
        return 'text-danger';
    },

    // ==================== 导出Excel ====================
    exportExcel(data, filename, headers, labels) {
        // labels: optional, maps field key to Chinese display name for header row
        const headerLabels = labels || {};
        const headerRow = headers.map(h => headerLabels[h] || h);
        const rows = [
            headerRow,
            ...data.map(row =>
                headers.map(h => {
                    const val = row[h];
                    // Handle numeric values for proper Excel formatting
                    if (typeof val === 'number') return val;
                    if (val === null || val === undefined) return '';
                    return String(val);
                })
            )
        ];
        const ws = XLSX.utils.aoa_to_sheet(rows);
        // Auto column width
        ws['!cols'] = headers.map(() => ({ wch: 16 }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
        const finalName = filename.replace(/\.csv$/i, '.xlsx');
        XLSX.writeFile(wb, finalName);
        toast('导出成功', 'success');
    },

    handleResize() {}
};

export { App };

// 暴露到全局作用域（兼容 HTML onclick 等内联调用）
window.App = App;
