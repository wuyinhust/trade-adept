/**
 * 权限管理模块 - 登录、角色、数据过滤
 * 安全策略：密码使用 SHA-256 哈希存储，永不明文保存
 */

import { CONSTANTS } from './constants.js';
import { Cloud } from './cloud.js';

const Auth = {
    SESSION_KEY: 'trade_order_session',
    LOCKOUT_KEY: 'trade_order_lockout',

    // 当前登录用户
    currentUser: null,

    // ==================== 用户数据库（密码为 SHA-256 哈希） ====================
    users: [
        {
            id: 'U001',
            username: 'David',
            passwordHash: 'f283230b435d9874fd9ff9aa7c7522f4e67c437c2ed9222992bba1e50965eddf',
            name: 'David',
            role: 'admin',
            teamId: null
        },
        {
            id: 'U002',
            username: 'Lily',
            passwordHash: '72b1d48623678a54fe80bed51d3f6aa1112f1da46e655560001303933c3be7c2',
            name: 'Lily',
            role: 'finance',
            teamId: null
        },
        // Team A
        {
            id: 'U003',
            username: 'Vivian',
            passwordHash: '010f7a6cfc4661bdeac2e07948153bcf482f4dc778f45867911d9f9a67d789d0',
            name: 'Vivian',
            role: 'manager',
            teamId: 'TEAM-A'
        },
        {
            id: 'U005',
            username: 'Michale',
            passwordHash: '424bac2baf00bcf569229ec0aa4697e69ac8a9d5e9a4fe61c855be9e97950d53',
            name: 'Michale',
            role: 'salesperson',
            teamId: 'TEAM-A'
        },
        {
            id: 'U006',
            username: 'Alex',
            passwordHash: 'd457705b292a8019b8afddb270bb8719d59c9108269550e7591cec8b4d666afa',
            name: 'Alex',
            role: 'salesperson',
            teamId: 'TEAM-A',
            visibleCompanyIds: ['CO-WY', 'CO-GW']
        },
        {
            id: 'U007',
            username: 'Anna',
            passwordHash: '56c7604022a19e3faffc68489f9cf2a3db7b1fd51b2f2715c1d68b6371200bb0',
            name: 'Anna',
            role: 'document',
            teamId: 'TEAM-A'
        },
        {
            id: 'U011',
            username: 'Sue',
            passwordHash: 'eb03d0ca592799d39282dc9b06a037e392d3b70612bfea126ac73855983ab689',
            name: 'Sue',
            role: 'salesperson',
            teamId: 'TEAM-A',
            visibleCompanyIds: ['CO-LK']
        },
        // Team B
        {
            id: 'U004',
            username: 'Galen',
            passwordHash: 'd72836fb1445992a2aad026db748cb3cd2049685024be7797514d93352c362b9',
            name: 'Galen',
            role: 'manager',
            teamId: 'TEAM-B'
        },
        {
            id: 'U008',
            username: 'Nicole',
            passwordHash: '000474d5f9528881bf1e75c4a4dc0697f635a539d384525e22633b058dd92740',
            name: 'Nicole',
            role: 'salesperson',
            teamId: 'TEAM-B'
        },
        {
            id: 'U009',
            username: 'Jack',
            passwordHash: 'c0b9f3feb7f992d1d8384ad4a83d75ae99e161ed5f3bce64f4ab7a5e758f347d',
            name: 'Jack',
            role: 'document',
            teamId: 'TEAM-B'
        },
        {
            id: 'U010',
            username: 'Melody',
            passwordHash: '15834a6c8f827b82e53f5f6ef4aa2907b7c1f9ca2ac3d407c8690721c13755fd',
            name: 'Melody',
            role: 'document',
            teamId: 'TEAM-B'
        }
    ],

    // ==================== 团队定义 ====================
    teams: {
        'TEAM-A': {
            name: 'A组',
            managerId: 'U003',
            memberIds: ['U005', 'U006', 'U007', 'U011'],
            visibleCompanyIds: null
        },
        'TEAM-B': {
            name: 'B组',
            managerId: 'U004',
            memberIds: ['U008', 'U009', 'U010'],
            visibleCompanyIds: ['CO-WY', 'CO-GW']
        } // 为语 + Grandware HK
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
    init() {
        const saved = sessionStorage.getItem(this.SESSION_KEY);
        if (saved) {
            try {
                const session = JSON.parse(saved);
                const user = this.users.find(u => u.id === session.userId);
                if (user) {
                    this.currentUser = user;
                    return true;
                }
            } catch (e) {}
        }
        this.currentUser = null;
        return false;
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
        if (!username || !password) {
            return { success: false, error: '请输入用户名和密码' };
        }

        // 检查是否被锁定
        const lock = this._getLockoutState();
        if (lock && lock.lockedUntil) {
            const remaining = lock.lockedUntil - Date.now();
            if (remaining > 0) {
                const mins = Math.ceil(remaining / 60000);
                return { success: false, error: `登录尝试次数过多，请 ${mins} 分钟后重试` };
            }
            // 锁已过期，清除
            this._clearLockout();
        }

        const user = this.users.find(u => u.username === username);
        if (!user) {
            await this._hashPassword(password);
            this._recordFailedAttempt();
            return { success: false, error: '用户名或密码错误' };
        }
        const inputHash = await this._hashPassword(password);
        if (inputHash === user.passwordHash) {
            this.currentUser = user;
            sessionStorage.setItem(this.SESSION_KEY, JSON.stringify({ userId: user.id }));
            this._clearLockout();
            return { success: true, user };
        }
        this._recordFailedAttempt();
        return { success: false, error: '用户名或密码错误' };
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

    logout() {
        this.currentUser = null;
        sessionStorage.removeItem(this.SESSION_KEY);
        // 清理云端会话
        Cloud.resetSession();
    },

    // ==================== 角色判断 ====================
    isAdmin() {
        return this.currentUser?.role === 'admin';
    },
    isFinance() {
        return this.currentUser?.role === 'finance';
    },
    isManager() {
        return this.currentUser?.role === 'manager';
    },
    isSalesperson() {
        return this.currentUser?.role === 'salesperson';
    },
    isDocument() {
        return this.currentUser?.role === 'document';
    },

    /** 是否能看到全量数据（admin + finance） */
    canSeeAll() {
        return this.currentUser && (this.currentUser.role === 'admin' || this.currentUser.role === 'finance');
    },

    /** 是否能看到利润分析 */
    canSeeProfit() {
        return (
            this.currentUser &&
            (this.currentUser.role === 'admin' ||
                this.currentUser.role === 'finance' ||
                this.currentUser.role === 'manager' ||
                this.currentUser.role === 'salesperson')
        );
    },

    /** 是否能看到财务敏感数据（工厂成本、利润） */
    canSeeFinancials() {
        return (
            this.currentUser &&
            (this.currentUser.role === 'admin' ||
                this.currentUser.role === 'finance' ||
                this.currentUser.role === 'manager' ||
                this.currentUser.role === 'salesperson')
        );
    },

    /** 是否能看到系统设置 */
    canSeeSettings() {
        return (
            this.currentUser &&
            (this.currentUser.role === 'admin' ||
                this.currentUser.role === 'finance' ||
                this.currentUser.role === 'manager')
        );
    },

    /** 是否能修改订单 */
    canEdit() {
        return true; // 所有角色都能编辑自己的订单（经理能编辑团队的）
    },

    /** 是否能删除订单（admin/manager 全量可删，salesperson 可删自己的，具体见 canDeleteOrder） */
    canDelete() {
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
        if (this.canSeeAll()) return null; // admin/finance 看全部
        // 用户级限制优先于团队级
        if (this.currentUser.visibleCompanyIds) return this.currentUser.visibleCompanyIds;
        const team = this.teams[this.currentUser.teamId];
        if (!team) return null; // 无团队默认全部
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
        const ids = this.getVisibleSalespersonIds();
        if (ids === null) return shipments;
        const visibleOrderIds = new Set(allOrders.filter(o => ids.includes(o.salespersonId)).map(o => o.id));
        return shipments.filter(s => visibleOrderIds.has(s.orderId));
    },

    /** 过滤单证列表 */
    filterInvoices(invoices, allOrders) {
        const ids = this.getVisibleSalespersonIds();
        if (ids === null) return invoices;
        const visibleOrderIds = new Set(allOrders.filter(o => ids.includes(o.salespersonId)).map(o => o.id));
        return invoices.filter(d => visibleOrderIds.has(d.orderId));
    },

    /** 过滤客户列表 — 业务员只能看到自己订单关联的客户 + 自己创建的客户
     *  注：salespersonId 为 null/undefined 的旧数据，业务员不可见（仅 admin/finance/manager 可见）
     */
    filterCustomers(customers, allOrders) {
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
        const ids = this.getVisibleSalespersonIds();
        if (ids === null) return null;
        const visibleOrders = ids ? allOrders.filter(o => ids.includes(o.salespersonId)) : allOrders;
        return new Set(visibleOrders.map(o => o.customerId));
    },

    /** 获取页面可访问列表 */
    getVisiblePages() {
        // David(admin) 和 Lily(finance) 可以看到所有页面
        if (this.canSeeAll()) {
            return ['dashboard', 'orders', 'customers', 'factories', 'shipping', 'profit', 'settings'];
        }
        // 业务员：自己的订单/客户 + 全部工厂管理 + 自己订单的利润分析/物流单证
        if (this.isSalesperson()) {
            return ['dashboard', 'orders', 'customers', 'factories', 'shipping', 'profit'];
        }
        // 单证员：团队业务员的订单/物流单证 + 全部工厂管理（不可看利润分析、客户信息、总利润）
        if (this.isDocument()) {
            return ['dashboard', 'orders', 'factories', 'shipping'];
        }
        // 经理可以看到团队相关页面 + 利润分析 + 系统设置
        return ['dashboard', 'orders', 'customers', 'factories', 'shipping', 'profit', 'settings'];
    },

    /** 检查是否可以查看某个订单 */
    canViewOrder(orderId, allOrders) {
        if (!this.currentUser) return false;
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
