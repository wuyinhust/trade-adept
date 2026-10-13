/**
 * 权限管理模块 - 登录、角色、数据过滤
 * 身份来自服务端会话；浏览器不包含账号凭据。
 */

import { CONSTANTS } from './constants.js';
import { Cloud } from './cloud.js';

const Auth = {
    SESSION_KEY: 'trade_order_session',
    LOCKOUT_KEY: 'trade_order_lockout',

    // 当前登录用户
    currentUser: null,

    // Directory and roles are supplied by the authenticated business API.
    users: [],
    teams: {},
    roles: {},
    onboarding: null,
    _provider: null,
    _serverDataAuthorized: false,
    configureProvider(provider) {
        this._provider = provider;
    },

    // ==================== 密码安全 ====================
    /** 使用 Web Crypto API 计算 SHA-256 哈希（hex 格式） */
    async _hashPassword(password) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    },

    // ==================== 登录 ====================
    async init() {
        this.currentUser = null;
        sessionStorage.removeItem(this.SESSION_KEY);
        if (!this._provider) return false;
        try {
            const user = await this._provider.restoreSession();
            this.currentUser = user || null;
            return !!user;
        } catch (_) {
            return false;
        }
    },

    /** 读取锁状态：{ attempts, lockedUntil } 或 null */
    _getLockoutState() {
        try {
            const raw = sessionStorage.getItem(this.LOCKOUT_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    },

    /** 写入锁状态 */
    _setLockoutState(state) {
        sessionStorage.setItem(this.LOCKOUT_KEY, JSON.stringify(state));
    },

    /** 清除锁状态（登录成功后调用） */
    _clearLockout() {
        sessionStorage.removeItem(this.LOCKOUT_KEY);
    },

    async login(username, password) {
        if (!username || !password) return { success: false, error: '请输入用户名和密码' };
        if (!this._provider) return { success: false, error: '请启动数据库服务后登录工作区' };
        try {
            const user = await this._provider.login(username, password);
            if (!user) return { success: false, error: '用户名或密码错误' };
            this.currentUser = user;
            this._clearLockout();
            return { success: true, user };
        } catch (e) {
            return { success: false, error: e.message || '登录失败，请稍后重试' };
        }
    },

    /** 记录一次失败尝试，达到上限则锁定 */
    _recordFailedAttempt() {
        const state = this._getLockoutState() || { attempts: 0 };
        state.attempts += 1;
        if (state.attempts >= CONSTANTS.MAX_LOGIN_ATTEMPTS) {
            state.lockedUntil = Date.now() + CONSTANTS.LOCKOUT_DURATION_MS;
        }
        this._setLockoutState(state);
    },

    async logout() {
        if (this._provider) await this._provider.logout();
        this.currentUser = null;
        this.onboarding = null;
        sessionStorage.removeItem(this.SESSION_KEY);
        // 清理云端会话
        Cloud.resetSession();
    },

    // ==================== 角色判断 ====================
    roleType() {
        return this.currentUser?.baseRole || this.currentUser?.role;
    },
    isAdmin() {
        return this.roleType() === 'admin';
    },
    isFinance() {
        return this.roleType() === 'finance';
    },
    isManager() {
        return this.roleType() === 'manager';
    },
    isSalesperson() {
        return this.roleType() === 'salesperson';
    },
    isDocument() {
        return this.roleType() === 'document';
    },

    /** 是否能看到全量数据（admin + finance） */
    canSeeAll() {
        if (!this.currentUser) return false;
        if (this._serverDataAuthorized) return this.currentUser.scope === 'tenant';
        return this.isAdmin() || this.isFinance();
    },

    hasCapability(name) {
        const caps = this.currentUser?.permissions;
        if (Array.isArray(caps)) return caps.includes(name) || caps.includes('*');
        if (caps && typeof caps === 'object') return !!(caps[name] || caps['*']);
        return null;
    },

    canSeeProfit() {
        const permitted = this.hasCapability('finance.read');
        return permitted === null ? !!(this.isAdmin() || this.isFinance()) : permitted;
    },
    canSeeFinancials() {
        const permitted = this.hasCapability('finance.read');
        return permitted === null ? !!(this.isAdmin() || this.isFinance()) : permitted;
    },
    canSeeSettings() {
        if (this._serverDataAuthorized) {
            return ['rates.write', 'snapshots.read'].some(cap => this.hasCapability(cap));
        }
        return !!(this.isAdmin() || this.isFinance());
    },
    canManageEnterprise() {
        return this.hasCapability('accounts.configure') === true && this.currentUser?.scope === 'tenant';
    },

    /** 是否能修改订单 */
    canEdit() {
        const permitted = this.hasCapability('edit');
        if (permitted !== null) return permitted;
        return true; // 所有角色都能编辑自己的订单（经理能编辑团队的）
    },

    /** 是否能删除订单（admin/manager 全量可删，salesperson 可删自己的，具体见 canDeleteOrder） */
    canDelete() {
        const permitted = this.hasCapability('delete');
        if (permitted !== null) return permitted;
        return (
            this.currentUser &&
            (this.currentUser.role === 'admin' ||
                this.currentUser.role === 'manager' ||
                this.currentUser.role === 'salesperson')
        );
    },

    /** 是否能删除某笔具体订单：admin/manager 可删任意可见订单，salesperson 仅可删自己创建/归属自己的订单 */
    canDeleteOrder(order) {
        if (!this.currentUser || !order) return false;
        if (this.hasCapability('delete') === false) return false;
        if (this._serverDataAuthorized) {
            if (this.currentUser.scope === 'tenant') return true;
            const actors =
                this.currentUser.scope === 'team'
                    ? [
                          this.currentUser.id,
                          ...(this.teams[this.currentUser.teamId]?.memberIds || []),
                          this.teams[this.currentUser.teamId]?.managerId
                      ]
                    : [this.currentUser.id];
            return actors.includes(order.createdBy) || actors.includes(order.salespersonId);
        }
        if (this.currentUser.role === 'admin' || this.currentUser.role === 'manager') return true;
        if (this.currentUser.role === 'salesperson') {
            return Boolean(
                (order.salespersonId && order.salespersonId === this.currentUser.id) ||
                (order.createdBy && order.createdBy === this.currentUser.id)
            );
        }
        return false; // finance / document 不可删除
    },

    /** 获取当前用户可见的公司ID列表。null = 全部公司可见 */
    getVisibleCompanyIds() {
        if (!this.currentUser) return [];
        if (this._serverDataAuthorized) return this.currentUser.visibleCompanyIds || [];
        if (this.canSeeAll()) return null; // admin/finance 看全部
        // 用户级限制优先于团队级
        if (this.currentUser.visibleCompanyIds) return this.currentUser.visibleCompanyIds;
        const team = this.teams[this.currentUser.teamId];
        if (!team) return []; // 未配置授权默认拒绝
        return team.visibleCompanyIds || null; // null = 团队无限制
    },

    /** 是否能看到单证管理（已移除该模块，始终返回 false） */
    canSeeInvoices() {
        return false;
    },

    // ==================== 数据过滤 ====================
    /** 获取当前用户可见的订单ID集合 */
    getVisibleSalespersonIds() {
        if (!this.currentUser) return [];
        if (this.canSeeAll()) return null; // null = 全部
        if (this.isManager() || this.isDocument()) {
            const team = this.teams[this.currentUser.teamId];
            if (!team) return [];
            // 团队业务员ID
            const salesIds = team.memberIds.filter(mid => {
                const user = this.users.find(u => u.id === mid);
                return user && user.role === 'salesperson';
            });
            // 经理也做业务时，加上经理自己
            if (!salesIds.includes(team.managerId)) {
                salesIds.push(team.managerId);
            }
            // 单证员/其他协作用户自己创建的数据也要能看到
            if (!salesIds.includes(this.currentUser.id)) {
                salesIds.push(this.currentUser.id);
            }
            return salesIds;
        }
        if (this.isSalesperson()) {
            return [this.currentUser.id];
        }
        return [];
    },

    /** 过滤订单列表
     *  规则：
     *  1. 业务员/经理/单证员按可见 salespersonId 集合过滤（原有语义）
     *  2. 自己创建的数据（createdBy）始终可见 —— 与公司过滤语义一致，防止归属字段异常时丢数据
     *  3. 经理/单证员：团队内所有成员（含单证员，他们也有新建订单权限）创建的订单对团队可见
     */
    filterOrders(orders) {
        if (this._serverDataAuthorized) return orders;
        const ids = this.getVisibleSalespersonIds();
        if (ids === null) return orders; // 全部可见
        const myId = this.currentUser ? this.currentUser.id : null;
        let teamMemberIds = null;
        if (this.isManager() || this.isDocument()) {
            const team = this.teams[this.currentUser.teamId];
            if (team) {
                teamMemberIds = new Set([...team.memberIds, team.managerId]);
            }
        }
        return orders.filter(o => {
            if (ids.includes(o.salespersonId)) return true;
            if (myId && o.createdBy && o.createdBy === myId) return true; // 自己创建始终可见
            if (teamMemberIds && o.createdBy && teamMemberIds.has(o.createdBy)) return true;
            return false;
        });
    },

    /** 过滤出运列表 */
    filterShipments(shipments, allOrders) {
        if (this._serverDataAuthorized) return shipments;
        const ids = this.getVisibleSalespersonIds();
        if (ids === null) return shipments;
        const visibleOrderIds = new Set(allOrders.filter(o => ids.includes(o.salespersonId)).map(o => o.id));
        return shipments.filter(s => visibleOrderIds.has(s.orderId));
    },

    /** 过滤单证列表 */
    filterInvoices(invoices, allOrders) {
        if (this._serverDataAuthorized) return invoices;
        const ids = this.getVisibleSalespersonIds();
        if (ids === null) return invoices;
        const visibleOrderIds = new Set(allOrders.filter(o => ids.includes(o.salespersonId)).map(o => o.id));
        return invoices.filter(d => visibleOrderIds.has(d.orderId));
    },

    /** 过滤客户列表 — 业务员只能看到自己订单关联的客户 + 自己创建的客户
     *  注：salespersonId 为 null/undefined 的旧数据，业务员不可见（仅 admin/finance/manager 可见）
     */
    filterCustomers(customers, allOrders) {
        if (this._serverDataAuthorized) return customers;
        const ids = this.getVisibleSalespersonIds();
        if (ids === null) return customers; // null = 全部可见
        const myId = this.currentUser ? this.currentUser.id : null;
        const visibleCustomerIds = new Set(allOrders.filter(o => ids.includes(o.salespersonId)).map(o => o.customerId));
        return customers.filter(
            c =>
                visibleCustomerIds.has(c.id) ||
                (c.salespersonId && ids.includes(c.salespersonId)) ||
                (myId && c.createdBy && c.createdBy === myId) || // 自己创建的客户始终可见
                (!c.salespersonId && this.isManager()) // 无归属客户仅经理可见
        );
    },

    /** 获取可见客户的 ID 集合（基于可见订单） */
    getVisibleCustomerIds(allOrders) {
        if (this._serverDataAuthorized) return null;
        const ids = this.getVisibleSalespersonIds();
        if (ids === null) return null;
        const visibleOrders = ids ? allOrders.filter(o => ids.includes(o.salespersonId)) : allOrders;
        return new Set(visibleOrders.map(o => o.customerId));
    },

    /** 获取页面可访问列表 */
    getVisiblePages() {
        if (!this.currentUser) return [];
        let pages = Array.isArray(this.currentUser.pages)
            ? [...this.currentUser.pages]
            : ['dashboard', 'orders', 'customers', 'factories', 'shipping'];
        if (!Array.isArray(this.currentUser.pages) && this.canSeeProfit()) pages.push('profit');
        if (!Array.isArray(this.currentUser.pages) && this.canSeeSettings()) pages.push('settings');
        pages = pages.filter(
            page => (page !== 'profit' || this.canSeeProfit()) && (page !== 'settings' || this.canSeeSettings())
        );
        if (this.canManageEnterprise()) pages.push('admin', 'onboarding');
        else pages = pages.filter(page => !['admin', 'onboarding'].includes(page));
        return [...new Set(pages)];
    },

    /** 检查是否可以查看某个订单 */
    canViewOrder(orderId, allOrders) {
        if (!this.currentUser) return false;
        if (this._serverDataAuthorized) return allOrders.some(order => order.id === orderId && !order.deleted);
        if (this.canSeeAll()) return true;
        const order = allOrders.find(o => o.id === orderId);
        if (!order) return false;
        const ids = this.getVisibleSalespersonIds();
        if (ids && ids.includes(order.salespersonId)) return true;
        // 自己创建的订单始终可见
        return !!(order.createdBy && this.currentUser.id && order.createdBy === this.currentUser.id);
    }
};

export { Auth };

window.Auth = Auth;
