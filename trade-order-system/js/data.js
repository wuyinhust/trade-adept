/**
 * 数据层 - Grandware Group v6 (纯 CloudBase · 多人协作版)
 *
 * 所有数据实时读写 CloudBase 云端数据库。
 * 10 人团队共享同一份数据，每 10 秒自动检测远程更新。
 *
 * 数据流：
 *   保存 → CloudBase 推送 (防抖 500ms)
 *   加载 → CloudBase 拉取
 *   同步 → 每 10s 检测远程版本 → 自动拉取 + 通知
 */

import { CONSTANTS } from './constants.js';
import { Cloud } from './cloud.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';
import { App } from './app.js';
import { handleError, toast, validate, escapeHtml } from './utils.js';

/**
 * @typedef {Object} Company
 * @property {string} id - 公司 ID (如 'CO-GR')
 * @property {string} name - 公司全名
 * @property {string} shortName - 简称
 */

/**
 * @typedef {Object} Contact
 * @property {string} id - 联系人 ID
 * @property {string} name - 姓名
 * @property {string} position - 职位
 * @property {string} phone - 电话
 * @property {string} email - 邮箱
 */

/**
 * @typedef {Object} Customer
 * @property {string} id - 客户 ID (时间戳格式)
 * @property {string} company - 公司名称
 * @property {string} country - 国家
 * @property {Contact[]} contacts - 联系人列表
 * @property {string} paymentTerms - 付款条件
 * @property {boolean} [deleted] - 软删除标记
 * @property {string} [deletedAt] - 删除时间 ISO 字符串
 */

/**
 * @typedef {Object} Factory
 * @property {string} id - 工厂 ID
 * @property {string} name - 工厂名称
 * @property {string} address - 地址
 * @property {string} bankAccount - 银行账号
 * @property {boolean} [deleted] - 软删除标记
 */

/**
 * @typedef {Object} Order
 * @property {string} id - 订单 ID
 * @property {string} customerId - 客户 ID
 * @property {string} customerName - 客户名称
 * @property {string[]} factoryIds - 关联工厂 ID 列表
 * @property {string} productName - 产品名称
 * @property {string} orderDate - 下单日期 (YYYY-MM-DD)
 * @property {number} orderAmountUSD - 订单金额 (USD)
 * @property {number} factoryCostRMB - 工厂成本 (RMB)
 * @property {number} freightCostUSD - 货代费 (USD)
 * @property {string} status - 订单状态
 * @property {string} shippingStatus - 出运状态
 * @property {string} companyOperationNo - 公司操作单号
 * @property {string} customerOrderNo - 客户订单号
 * @property {boolean} [deleted] - 软删除标记
 */

/**
 * @typedef {Object} Shipment
 * @property {string} id - 出运记录 ID
 * @property {string} orderId - 关联订单 ID
 * @property {string} shippingStatus - 出运状态
 * @property {boolean} [deleted] - 软删除标记
 */

/**
 * @typedef {Object} Invoice
 * @property {string} id - 单证 ID
 * @property {string} orderId - 关联订单 ID
 * @property {string} docType - 单证类型 ('CI' | 'PL')
 * @property {string} docNumber - 单证编号
 * @property {string} status - 单证状态
 * @property {boolean} [deleted] - 软删除标记
 */

/**
 * @typedef {Object} AppData
 * @property {Customer[]} customers - 客户列表
 * @property {Order[]} orders - 订单列表
 * @property {Shipment[]} shipments - 出运列表
 * @property {Invoice[]} invoices - 单证列表
 * @property {Factory[]} factories - 工厂列表
 */

const DB = {
    COMPANY_KEY: 'trade_current_company',

    _cloudReady: false,
    _cloudConnected: false,

    /** 云端数据库权限正常（可读写） */
    get CLOUD_READY() {
        return this._cloudReady;
    },

    /** CloudBase SDK 已初始化并登录成功 */
    get CLOUD_ENABLED() {
        return this._cloudConnected;
    },

    _cloudVersion: 0,
    _cloudUpdatedAt: null,
    _lastSaveTime: 0,
    _pollTimer: null,
    _pollInterval: CONSTANTS.POLL_INTERVAL_MS, // 10 秒轮询

    companies: [
        { id: 'CO-GR', name: '国润', shortName: '国润' },
        { id: 'CO-WY', name: '为语', shortName: '为语' },
        { id: 'CO-GW', name: 'Grandware HK', shortName: 'Grandware' },
        { id: 'CO-LK', name: 'Likeing HK', shortName: 'Likeing' }
    ],

    currentCompanyId: null,
    // 按公司独立汇率
    exchangeRates: {
        'CO-GR': CONSTANTS.DEFAULT_EXCHANGE_RATE,
        'CO-WY': CONSTANTS.DEFAULT_EXCHANGE_RATE,
        'CO-GW': CONSTANTS.HK_EXCHANGE_RATE,
        'CO-LK': CONSTANTS.HK_EXCHANGE_RATE
    },

    // 按公司独立的汇率元数据
    rateMetas: {
        'CO-GR': { source: '手动设置', updateTime: null, isAuto: false },
        'CO-WY': { source: '手动设置', updateTime: null, isAuto: false },
        'CO-GW': { source: '手动设置', updateTime: null, isAuto: false },
        'CO-LK': { source: '手动设置', updateTime: null, isAuto: false }
    },

    // 获取指定公司的汇率 (默认当前公司)
    getExchangeRate(companyId) {
        const cid = companyId || this.currentCompanyId;
        const val = this.exchangeRates[cid] !== undefined ? this.exchangeRates[cid] : CONSTANTS.DEFAULT_EXCHANGE_RATE;
        return parseFloat(val) || CONSTANTS.DEFAULT_EXCHANGE_RATE;
    },

    // 获取指定公司的汇率元数据
    getRateMeta(companyId) {
        const cid = companyId || this.currentCompanyId;
        return this.rateMetas[cid] || { source: '手动设置', updateTime: null, isAuto: false };
    },

    data: {
        customers: [],
        orders: [],
        shipments: [],
        invoices: [],
        factories: []
    },

    // ==================== 初始化 ====================
    /** 获取当前用户实际可用的公司 ID（当前公司不可见时自动回退到第一个可见公司） */
    _getEffectiveCompanyId() {
        const visibleIds = Auth.getVisibleCompanyIds();
        if (visibleIds === null) {
            return this.currentCompanyId || this.companies[0].id;
        }
        if (visibleIds.includes(this.currentCompanyId)) {
            return this.currentCompanyId;
        }
        const fallback = this.companies.find(c => visibleIds.includes(c.id));
        return fallback ? fallback.id : this.currentCompanyId;
    },

    async init() {
        this.currentCompanyId = sessionStorage.getItem(this.COMPANY_KEY) || this.companies[0]?.id;
        // ★ 校正：如果当前公司对登录用户不可见（如单证员可见公司不含默认的 CO-GR），
        // 自动切换到第一个可见公司，否则新建的数据会因公司过滤而“消失”
        const visibleIds = Auth.getVisibleCompanyIds();
        if (visibleIds !== null && !visibleIds.includes(this.currentCompanyId)) {
            const fallback = this.companies.find(c => visibleIds.includes(c.id));
            if (fallback) {
                this.currentCompanyId = fallback.id;
                sessionStorage.setItem(this.COMPANY_KEY, fallback.id);
                console.log('[DB] 当前公司对用户不可见，已自动切换到:', fallback.id, fallback.name);
            }
        }

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('CloudBase 连接超时，请检查网络后刷新页面')), CONSTANTS.INIT_TIMEOUT_MS);
        });

        try {
            return await Promise.race([this._doInit(), timeoutPromise]);
        } catch (err) {
            console.warn('[DB] init 超时 (' + CONSTANTS.INIT_TIMEOUT_MS + 'ms)，页面继续渲染');
            this._initError = err.message;
            handleError(err, '初始化', { silent: false });
            return false;
        }
    },

    async _doInit() {
        if (this._businessAPI) return this._initFromBusinessAPI();
        // Step 1: 连接 CloudBase
        console.log('[DB] 正在连接 CloudBase...');
        const cloudInit = await Cloud.init();

        if (cloudInit && cloudInit.ok) {
            this._cloudConnected = true;
            console.log('[DB] CloudBase 已连接 | uid:', cloudInit.uid);

            // 测试数据库权限
            const permTest = await Cloud.testPermission();
            if (permTest.ok) {
                this._cloudReady = true;
                console.log('[DB] 数据库读写权限正常');
            } else {
                console.warn('[DB] 数据库权限测试失败:', permTest.reason);
                this._initError = permTest.reason || '数据库权限测试失败';
                App.updateSaveStatus(
                    'error',
                    '云端权限测试失败: ' + (permTest.reason || '请检查 CloudBase 数据库权限')
                );
            }
        } else {
            console.error('[DB] CloudBase 连接失败:', (cloudInit || {}).message);
            this._initError = (cloudInit || {}).message || 'CloudBase 连接失败';
        }

        // Step 2: 从云端加载数据
        if (this._cloudReady) {
            let cloudData = await Cloud.loadData();
            // 如果第一次加载失败，等待1秒后重试一次（避免网络波动导致误判为空）
            if (!cloudData) {
                await new Promise(r => setTimeout(r, CONSTANTS.LOAD_RETRY_DELAY_MS));
                cloudData = await Cloud.loadData();
            }
            if (cloudData && cloudData.data) {
                this.data = cloudData.data;
                this._applyExchangeData(cloudData);
                if (cloudData.meta) {
                    this._cloudVersion = cloudData.meta.version || 0;
                    this._cloudUpdatedAt = cloudData.meta.updatedAt || null;
                }

                console.log(
                    '[DB] 云端数据加载成功 v' + this._cloudVersion,
                    '| 客户:',
                    (this.data.customers || []).length,
                    '| 订单:',
                    (this.data.orders || []).length,
                    '| 工厂:',
                    (this.data.factories || []).length,
                    '| 更新者:',
                    (cloudData.meta || {}).updatedBy
                );

                if (!this._preserveImportedValues) {
                    // ★ 修复 HK 公司利润数据（v45 之前旧代码错误地乘了汇率）
                    let hkFixed = 0;
                    (this.data.orders || []).forEach(o => {
                        const isHK = o.companyId === 'CO-GW' || o.companyId === 'CO-LK';
                        if (!isHK || o.orderAmountUSD <= 0) return;
                        // HK 公司：利润 = 订单金额 - 工厂成本 - 其他费用（全部美金，不乘汇率）
                        const correctProfit = o.orderAmountUSD - o.factoryCostRMB - (o.otherCostUSD || 0);
                        const correctOrderAmountRMB = o.orderAmountUSD;
                        const correctProfitRate =
                            o.orderAmountUSD > 0 ? Math.round((correctProfit / o.orderAmountUSD) * 10000) / 100 : 0;
                        // 检测是否被旧代码污染（profitRMB 异常地大，接近 orderAmountUSD * 6+）
                        const isCorrupted =
                            o.profitRMB > o.orderAmountUSD * 2 || Math.abs(o.profitRMB - correctProfit) > 1;
                        if (isCorrupted || Math.abs(o.orderAmountRMB - correctOrderAmountRMB) > 1) {
                            o.profitRMB = Math.round(correctProfit * 100) / 100;
                            o.orderAmountRMB = Math.round(correctOrderAmountRMB * 100) / 100;
                            o.profitRate = correctProfitRate;
                            hkFixed++;
                        }
                    });
                    if (hkFixed > 0) {
                        console.log('[DB] 已修正 ' + hkFixed + ' 笔 HK 公司订单利润数据（旧代码汇率污染）');
                        this._migrated = true; // 标记需要保存
                    }

                    // ★ 迁移客户数据：确保旧数据有 contacts 数组
                    this.migrateCustomerData();

                    // ★ v55 迁移：为老数据补齐归属字段（salespersonId）
                    // 权限过滤按 salespersonId 判断可见性，老数据缺失该字段会导致
                    // "只有 admin 能看到、其他账号看不到"的问题
                    let migOrders = 0;
                    (this.data.orders || []).forEach(o => {
                        if (!o.salespersonId && o.createdBy) {
                            o.salespersonId = o.createdBy;
                            migOrders++;
                        }
                    });
                    // 客户：仅当创建者是业务员角色时才回填（避免把 document/manager 创建的客户
                    // 从"经理可见的无归属客户"变成"团队外归属"）
                    const salespersonIds = new Set(
                        (Auth.users || []).filter(u => u.role === 'salesperson').map(u => u.id)
                    );
                    let migCustomers = 0;
                    (this.data.customers || []).forEach(c => {
                        if (!c.salespersonId && c.createdBy && salespersonIds.has(c.createdBy)) {
                            c.salespersonId = c.createdBy;
                            migCustomers++;
                        }
                    });
                    if (migOrders + migCustomers > 0) {
                        this._migrated = true; // Step 4 会保存到云端
                        console.log('[DB] 数据迁移：订单归属回填', migOrders, '条，客户归属回填', migCustomers, '条');
                    }
                }
            } else {
                console.warn('[DB] 云端无数据或加载失败，使用空白数据开始');
                // ★ 不再自动推送空白数据到云端，避免网络波动时覆盖真实数据
                // 第一个用户操作（增删改）时会自动保存到云端
            }
        } else {
            // CloudBase 完全不可用，但 _cloudConnected 可能为 true（连接成功但权限不足）
            console.error('[DB] CloudBase 不可用，无法加载数据');
        }

        // Step 3: 从 localStorage 恢复可能未同步到云的数据
        const recovered = this._recoverFromLocal();
        if (recovered) {
            console.log('[DB] localStorage 安全网：检测到未同步数据，已合并');
            if (this._cloudReady) {
                // 云端可用，立即将合并后的数据存回云端
                this._backupToLocal();
                this._doCloudSave();
            } else {
                // 云端不可用，保留 localStorage 备份，下次启动时再同步
                console.log('[DB] 云端不可用，保留 localStorage 备份');
            }
        } // Unrecognized drafts remain available; failed recovery is not proof of obsolescence.

        // Step 4: 启动后台轮询
        if (this._cloudReady) {
            // 如有迁移修正，先保存到云端
            if (this._migrated) {
                this._doCloudSave();
                this._migrated = false;
            }
            this._startPolling();
        }

        // Step 5: 启动汇率自动刷新（每1小时）
        Exchange.startAutoRefresh();

        // 更新 UI
        App.updateCloudStatus();
        App.updateExchangeRateDisplay();

        return this._cloudReady;
    },

    /** 统一应用云端汇率数据（消除重复代码）
     *  @param {object} source - 云端返回的数据对象
     */
    _applyExchangeData(source) {
        if (!source) return;
        if (source.exchangeRate !== undefined) {
            const legacyRate = parseFloat(source.exchangeRate) || CONSTANTS.LEGACY_DEFAULT_RATE;
            for (const cid of Object.keys(this.exchangeRates)) {
                this.exchangeRates[cid] = legacyRate;
            }
        }
        if (source.exchangeRates) {
            Object.assign(this.exchangeRates, source.exchangeRates);
        }
        if (source.rateMetas) {
            for (const [cid, meta] of Object.entries(source.rateMetas)) {
                this.rateMetas[cid] = { ...this.rateMetas[cid], ...meta };
            }
        }
        if (source.rateMeta && !source.rateMetas) {
            for (const cid of Object.keys(this.rateMetas)) {
                this.rateMetas[cid] = { ...this.rateMetas[cid], ...source.rateMeta };
            }
        }
    },

    // ==================== 多人协作轮询 ====================
    _startPolling() {
        if (this._pollTimer) return;
        console.log('[DB] 启动多人协作轮询 (每', this._pollInterval / 1000, '秒)');
        this._pollTimer = setInterval(() => this._checkRemoteUpdates(), this._pollInterval);
    },

    _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
            console.log('[DB] 停止协作轮询');
        }
    },

    async _checkRemoteUpdates() {
        if (
            this._saveConflict ||
            (this._businessAPI && document.querySelector('#modalContainer .modal-overlay')) ||
            (this._businessAPI && this._businessAPI.hasChanges(this.data, this.exchangeRates, this.rateMetas))
        ) {
            return;
        }
        if (!this._cloudReady) return;

        // ★ 最近 3 秒内刚保存过，跳过轮询（避免 CloudBase 读写延迟导致读到旧数据）
        if (this._lastSaveTime && Date.now() - this._lastSaveTime < CONSTANTS.POLL_SKIP_WINDOW_MS) {
            console.log('[DB] 轮询跳过：最近刚保存过');
            return;
        }

        // ★ 如果有未完成的保存操作，跳过轮询，避免覆盖本地修改
        if (Cloud._saveQueue.length > 0 || Cloud._saveRunning) {
            console.log('[DB] 轮询跳过：有未完成的保存操作');
            return;
        }

        try {
            const remote = await Cloud.checkRemoteVersion();
            if (!remote || !remote.updatedAt) return;

            // ★ 用 updatedAt 时间戳比较，适配 update() 单一文档模式
            if (remote.updatedAt !== this._cloudUpdatedAt) {
                console.log(
                    '[DB] 检测到远程更新',
                    remote.updatedAt,
                    '(本地',
                    this._cloudUpdatedAt,
                    ') by',
                    remote.updatedBy
                );

                const result = await Cloud.loadData();
                if (result && result.data) {
                    if (this._businessAPI) {
                        // An authorized empty collection is a legitimate deletion or scope change.
                        this.data = result.data;
                        this.exchangeRates = result.exchangeRates || {};
                        this.rateMetas = result.rateMetas || {};
                        this._cloudVersion = result.meta.version;
                        this._cloudUpdatedAt = result.meta.updatedAt;
                        this._businessAPI.bindWorkingData(this.data, this.exchangeRates, this.rateMetas);
                        App.updateExchangeRateDisplay();
                        await App.router();
                        return;
                    }
                    const oldOrders = this.data.orders.length;
                    const oldFactories = this.data.factories.length;
                    const oldCustomers = this.data.customers.length;
                    const newCustomers = (result.data.customers || []).length;
                    const newOrders = (result.data.orders || []).length;
                    const newFactories = (result.data.factories || []).length;

                    // ★ 安全保护：如果本地有客户数据但云端返回0客户，可能是异常，不要覆盖
                    if (oldCustomers > 0 && newCustomers === 0) {
                        console.warn('[DB] 轮询安全保护：本地有', oldCustomers, '个客户，但云端返回0个，拒绝覆盖');
                        toast('⚠️ 云端数据异常（客户数为0），已拒绝同步，请联系管理员', 'error');
                        return;
                    }

                    // ★ 安全保护：如果本地有订单但云端返回0订单，可能是异常
                    if (oldOrders > 0 && newOrders === 0) {
                        console.warn('[DB] 轮询安全保护：本地有', oldOrders, '个订单，但云端返回0个，拒绝覆盖');
                        toast('⚠️ 云端数据异常（订单数为0），已拒绝同步', 'error');
                        return;
                    }

                    // ★ 安全保护：如果本地有工厂数据但云端返回0工厂，可能是异常
                    if (oldFactories > 0 && newFactories === 0) {
                        console.warn('[DB] 轮询安全保护：本地有', oldFactories, '个工厂，但云端返回0个，拒绝覆盖');
                        toast('⚠️ 云端数据异常（工厂数为0），已拒绝同步', 'error');
                        return;
                    }

                    // ★ 安全保护：如果本地活跃数比云端多（且最近30秒内有过保存），
                    // 可能是 CloudBase 读写延迟导致读到旧数据，跳过本次同步
                    // 覆盖：订单、客户、工厂
                    if (this._lastSaveTime && Date.now() - this._lastSaveTime < 30000) {
                        const oldActiveOrders = this.data.orders.filter(o => !o.deleted).length;
                        const newActiveOrders = (result.data.orders || []).filter(o => !o.deleted).length;
                        const oldActiveCustomers = this.data.customers.filter(c => !c.deleted).length;
                        const newActiveCustomers = (result.data.customers || []).filter(c => !c.deleted).length;
                        const oldActiveFactories = this.data.factories.filter(f => !f.deleted).length;
                        const newActiveFactories = (result.data.factories || []).filter(f => !f.deleted).length;

                        if (oldActiveOrders > newActiveOrders) {
                            console.warn(
                                '[DB] 轮询安全保护：本地有',
                                oldActiveOrders,
                                '个活跃订单，云端只有',
                                newActiveOrders,
                                '个，且最近有保存操作，跳过本次同步（可能是读写延迟）'
                            );
                            return;
                        }
                        if (oldActiveCustomers > newActiveCustomers) {
                            console.warn(
                                '[DB] 轮询安全保护：本地有',
                                oldActiveCustomers,
                                '个活跃客户，云端只有',
                                newActiveCustomers,
                                '个，且最近有保存操作，跳过本次同步（可能是读写延迟）'
                            );
                            return;
                        }
                        if (oldActiveFactories > newActiveFactories) {
                            console.warn(
                                '[DB] 轮询安全保护：本地有',
                                oldActiveFactories,
                                '个活跃工厂，云端只有',
                                newActiveFactories,
                                '个，且最近有保存操作，跳过本次同步（可能是读写延迟）'
                            );
                            return;
                        }
                    }

                    this.data = result.data;
                    this._applyExchangeData(result);
                    this._businessAPI?.bindWorkingData(this.data, this.exchangeRates, this.rateMetas);
                    if (result.meta) {
                        this._cloudVersion = result.meta.version || 0;
                        this._cloudUpdatedAt = result.meta.updatedAt || null;
                    }

                    console.log(
                        '[DB] 数据已同步 | 订单:',
                        oldOrders,
                        '→',
                        this.data.orders.length,
                        '| 工厂:',
                        oldFactories,
                        '→',
                        this.data.factories.length,
                        '| 客户:',
                        oldCustomers,
                        '→',
                        this.data.customers.length
                    );

                    App.updateCloudStatus();
                    App.updateExchangeRateDisplay();
                    toast('数据已从云端同步 (' + remote.updatedBy + ' 更新)', 'info');
                    if (App.router) App.router();
                }
            }
        } catch (e) {
            // 轮询失败不影响使用
        }
    },

    async _initFromBusinessAPI() {
        const result = await Cloud.loadData();
        if (!result?.data) throw new Error('数据库未返回有效业务数据');
        this.data = result.data;
        this.exchangeRates = result.exchangeRates || {};
        this.rateMetas = result.rateMetas || {};
        this._cloudVersion = result.meta.version;
        this._cloudUpdatedAt = result.meta.updatedAt;
        this._cloudConnected = this._cloudReady = true;
        this._saveConflict = false;
        this._draftBaseVersion = undefined;
        const raw = localStorage.getItem(this._BACKUP_KEY);
        if (raw) {
            try {
                const draft = JSON.parse(raw);
                if (
                    draft.tenantId === Auth.currentUser?.tenantId &&
                    draft.actorId === Auth.currentUser?.id &&
                    draft.data
                ) {
                    this.data = draft.data;
                    this.exchangeRates = draft.exchangeRates;
                    this.rateMetas = draft.rateMetas;
                    if (draft.conflict || draft.baseVersion !== this._cloudVersion) {
                        this._draftBaseVersion = draft.baseVersion;
                        this._handleSaveFailure({ code: 'CONFLICT' });
                    } else toast('已恢复当前账号的未保存草稿，请检查后保存', 'info');
                }
            } catch (_) {
                toast('草稿格式无效，已保留原备份', 'warning');
            }
        }
        this._businessAPI.bindWorkingData(this.data, this.exchangeRates, this.rateMetas);
        this._startPolling();
        return true;
    },

    _handleSaveFailure(error) {
        if (error?.code === 'CONFLICT') {
            this._draftBaseVersion ??= this._cloudVersion;
            this._saveConflict = true;
            this._backupToLocal();
            App.updateSaveStatus('error', '版本冲突，修改尚未保存');
            this.onSaveConflict?.();
            toast('其他人已保存新版本；本次修改已保留为草稿', 'warning', 8000);
        } else App.updateSaveStatus('error', error?.message || '保存失败，草稿已保留');
    },

    // ==================== localStorage 安全网 ====================
    _BACKUP_KEY: 'gw_local_backup',
    _draftSequence: 0,
    _saveConflict: false,

    /** 将当前数据立即写入 localStorage（同步，刷新不丢） */
    _backupToLocal() {
        if (
            this._businessAPI &&
            !this._saveConflict &&
            !this._businessAPI.hasChanges(this.data, this.exchangeRates, this.rateMetas)
        ) {
            return;
        }
        try {
            const backup = {
                data: this.data,
                exchangeRates: this.exchangeRates,
                rateMetas: this.rateMetas,
                savedAt: new Date().toISOString(),
                backupId: `${Date.now()}-${++this._draftSequence}`,
                baseVersion:
                    this._saveConflict && this._draftBaseVersion !== undefined
                        ? this._draftBaseVersion
                        : this._cloudVersion,
                conflict: this._saveConflict,
                actorId: Auth.currentUser?.id,
                tenantId: Auth.currentUser?.tenantId
            };
            localStorage.setItem(this._BACKUP_KEY, JSON.stringify(backup));
        } catch (e) {
            console.warn('[DB] localStorage 备份失败:', e.message);
        }
    },

    /** 清除 localStorage 备份（云端保存成功后调用） */
    _clearLocalBackup(expectedBackup) {
        try {
            if (expectedBackup !== undefined && localStorage.getItem(this._BACKUP_KEY) !== expectedBackup) return;
            localStorage.removeItem(this._BACKUP_KEY);
        } catch (_) {}
    },

    /** 从 localStorage 恢复未同步到云的数据（仅合并云端没有的条目）
     *  ★ 关键安全规则：
     *     1. 决不恢复 deleted: true 的条目（删除不应复活）
     *     2. 如果 localStorage 条目标记为 deleted 但云端同一 ID 未标记，则传播删除标记
     */
    _recoverFromLocal() {
        try {
            const raw = localStorage.getItem(this._BACKUP_KEY);
            if (!raw) return false;
            const backup = JSON.parse(raw);
            if (!backup || !backup.data) return false;

            let merged = false;
            const localData = backup.data;
            const cloudData = this.data;

            const categories = [
                { key: 'factories', label: '工厂', nameKey: 'name' },
                { key: 'customers', label: '客户', nameKey: 'company' },
                { key: 'orders', label: '订单', nameKey: 'id' }
            ];

            for (const { key, label, nameKey } of categories) {
                const localItems = localData[key];
                if (!localItems || localItems.length === 0) continue;

                const cloudIds = new Set((cloudData[key] || []).map(item => item.id));
                const localById = new Map(localItems.map(item => [item.id, item]));

                // ★ 第一遍：传播删除标记（localStorage 有 deleted: true 但云端没有 → 标记云端条目）
                let propagatedCount = 0;
                for (const cloudItem of cloudData[key] || []) {
                    const localItem = localById.get(cloudItem.id);
                    if (localItem && localItem.deleted && !cloudItem.deleted) {
                        cloudItem.deleted = true;
                        cloudItem.deletedAt = localItem.deletedAt || new Date().toISOString();
                        propagatedCount++;
                    }
                }
                if (propagatedCount > 0) {
                    console.log('[DB] 传播删除标记: ' + propagatedCount + ' 个' + label);
                    merged = true;
                }

                // ★ 第二遍：恢复未同步条目（排除 deleted: true 的条目）
                const skippedDeleted = [];
                const missing = localItems.filter(item => {
                    if (cloudIds.has(item.id)) return false;
                    if (item.deleted) {
                        skippedDeleted.push(item);
                        return false;
                    }
                    return true;
                });

                if (skippedDeleted.length > 0) {
                    console.log(
                        '[DB] 跳过 ' + skippedDeleted.length + ' 个已删除' + label + '（防止复活）:',
                        skippedDeleted.map(item => item[nameKey] || item.id).join(', ')
                    );
                }

                if (missing.length > 0) {
                    (cloudData[key] || []).push(...missing);
                    console.log(
                        '[DB] 从 localStorage 恢复 ' + missing.length + ' 个' + label + ':',
                        missing.map(item => item[nameKey] || item.id).join(', ')
                    );
                    merged = true;
                }
            }

            return merged;
        } catch (e) {
            console.warn('[DB] localStorage 恢复失败:', e.message);
            return false;
        }
    },

    // ==================== 保存 ====================
    /** 立即保存到云端（无防抖，数据安全优先） */
    async save() {
        this._backupToLocal(); // ★ 先同步写入 localStorage，再异步存云
        App.updateSaveStatus('saving');
        const ok = await this._doCloudSave();
        if (ok) {
            App.updateSaveStatus('saved');
        }
        return ok;
    },

    async _doCloudSave() {
        if (this._saveConflict) return false;
        const acknowledgedBackup = localStorage.getItem(this._BACKUP_KEY);
        if (!this._cloudReady) {
            console.warn('[DB] CloudBase 不可用，数据未保存到云端');
            App.updateSaveStatus('error', '云端未连接，数据未保存');
            return false;
        }
        try {
            const ok = await Cloud.saveData(this.data, this.exchangeRates, this.rateMetas);
            if (ok) {
                // ★ 同步时间戳，防止轮询误判为远程更新 → 触发不必要的 reload
                const meta = Cloud.getLastMeta();
                this._cloudVersion = meta.version || 0;
                this._cloudUpdatedAt = meta.updatedAt || null;
                this._lastSaveTime = Date.now(); // 用于轮询保护
                this._clearLocalBackup(acknowledgedBackup); // Only this acknowledged draft may be removed
            }
            return ok;
        } catch (e) {
            console.error('[DB] 云端保存异常:', e);
            this._handleSaveFailure(e);
            return false;
        }
    },

    /**
     * 强制立即保存到云端（用于 beforeunload / 关键操作后）
     * 先写 localStorage 安全网，再推送到 CloudBase
     * @returns {Promise<boolean>} 是否保存成功
     */
    async flush() {
        if (this._saveConflict) return false;
        this._backupToLocal(); // ★ 先同步写 localStorage
        if (!this._cloudReady) {
            console.warn('[DB] flush: CloudBase 未连接');
            App.updateSaveStatus('error', '云端未连接');
            return false;
        }

        // 先排空保存队列（确保之前的保存都已完成）
        try {
            await Cloud._drainQueue();
        } catch (_) {}

        const acknowledgedBackup = localStorage.getItem(this._BACKUP_KEY);
        try {
            const ok = await Cloud.saveData(this.data, this.exchangeRates, this.rateMetas, { keepalive: true });
            if (ok) {
                App.updateSaveStatus('saved');
                // ★ 同步时间戳，防止轮询误判
                const meta = Cloud.getLastMeta();
                this._cloudVersion = meta.version || 0;
                this._cloudUpdatedAt = meta.updatedAt || null;
                this._lastSaveTime = Date.now();
                this._clearLocalBackup(acknowledgedBackup); // Only this acknowledged draft may be removed
            } else {
                App.updateSaveStatus('error', '保存失败');
            }
            return ok;
        } catch (e) {
            console.error('[DB] flush 异常:', e);
            this._handleSaveFailure(e);
            return false;
        }
    },

    /** 手动从云端刷新 */
    async refreshFromCloud() {
        if (
            this._saveConflict ||
            (this._businessAPI && document.querySelector('#modalContainer .modal-overlay')) ||
            (this._businessAPI && this._businessAPI.hasChanges(this.data, this.exchangeRates, this.rateMetas))
        ) {
            return { ok: false, message: '请先保存修改，或在冲突提示中下载草稿并明确放弃后重载' };
        }
        if (!this._cloudReady) return { ok: false, message: 'CloudBase 未连接' };

        const result = await Cloud.loadData();
        if (result && result.data) {
            this.data = result.data;
            if (result.exchangeRate !== undefined) {
                const legacyRate = parseFloat(result.exchangeRate) || 7.2;
                for (const cid of Object.keys(this.exchangeRates)) {
                    this.exchangeRates[cid] = legacyRate;
                }
            }
            if (result.exchangeRates) Object.assign(this.exchangeRates, result.exchangeRates);
            if (result.rateMetas) {
                for (const [cid, meta] of Object.entries(result.rateMetas)) {
                    this.rateMetas[cid] = { ...this.rateMetas[cid], ...meta };
                }
            }
            if (result.rateMeta && !result.rateMetas) {
                for (const cid of Object.keys(this.rateMetas)) {
                    this.rateMetas[cid] = { ...this.rateMetas[cid], ...result.rateMeta };
                }
            }
            if (result.meta) {
                this._cloudVersion = result.meta.version || 0;
                this._cloudUpdatedAt = result.meta.updatedAt || null;
            }
            this._businessAPI?.bindWorkingData(this.data, this.exchangeRates, this.rateMetas);
            console.log('[DB] 手动刷新完成 v' + this._cloudVersion);
            return { ok: true, meta: result.meta };
        }
        return { ok: false, message: '云端无数据' };
    },

    // ==================== 公司管理 ====================
    getCompanies() {
        return this.companies;
    },

    getAccessibleCompanies() {
        const visibleIds = Auth.getVisibleCompanyIds();
        if (visibleIds === null) return this.companies;
        return this.companies.filter(c => visibleIds.includes(c.id));
    },

    getCurrentCompany() {
        return this.companies.find(c => c.id === this.currentCompanyId) || this.companies[0];
    },

    setCurrentCompany(companyId) {
        if (this.companies.some(c => c.id === companyId)) {
            this.currentCompanyId = companyId;
            sessionStorage.setItem(this.COMPANY_KEY, companyId);
        }
    },

    filterByCompany(items) {
        let result = items;
        // 非 admin/finance 用户按当前公司过滤；currentCompanyId 已在 init 时校正为可见公司
        if (this.currentCompanyId && !Auth.canSeeAll()) {
            result = result.filter(item => item.companyId === this.currentCompanyId || item.companyId === undefined);
        }
        const visibleIds = Auth.getVisibleCompanyIds();
        if (visibleIds !== null) {
            const myId = Auth.currentUser ? Auth.currentUser.id : null;
            result = result.filter(
                item =>
                    item.companyId === undefined ||
                    visibleIds.includes(item.companyId) ||
                    (item.createdBy && myId && item.createdBy === myId) // 自己创建的数据始终可见
            );
        }
        return result;
    },

    // ==================== 汇率 ====================
    saveExchangeRate(rate, companyId = null, meta = null) {
        const cid = companyId || this.currentCompanyId;
        this.exchangeRates[cid] = parseFloat(rate) || 7.25;
        if (meta) {
            this.rateMetas[cid] = { ...this.getRateMeta(cid), ...meta };
        } else {
            this.rateMetas[cid] = { source: '手动设置', updateTime: new Date().toISOString(), isAuto: false };
        }
        this.save().catch(e => {
            handleError(e, '自动保存');
        });
    },

    recalcAllOrders() {
        Exchange.recalcAllOrders();
    },

    async fetchExchangeRate() {
        return Exchange.fetchRate();
    },

    async tryAutoFetchRate() {
        return Exchange.autoFetchIfStale();
    },

    /**
     * 数据可见性体检（管理员诊断用）
     * 统计数据在「公司归属 / 业务员归属」维度下的分布，
     * 帮助定位"哪些数据对哪些用户不可见"。
     * @returns {Object} 统计数据
     */
    diagnoseVisibility() {
        const users = Auth.users || [];
        const nameOf = id => {
            if (!id) return '(无)';
            const u = users.find(u => u.id === id);
            return u ? u.name + ' (' + id + ')' : id;
        };
        const companyName = id => {
            if (!id) return '(无归属)';
            const c = this.companies.find(c => c.id === id);
            return c ? c.shortName + ' (' + id + ')' : id;
        };

        const orderBySp = {};
        const orderByCo = {};
        let orderTotal = 0;
        let orderNoSp = 0;
        let orderNoCo = 0;
        (this.data.orders || []).forEach(o => {
            if (o.deleted) return;
            orderTotal++;
            const spKey = nameOf(o.salespersonId);
            orderBySp[spKey] = (orderBySp[spKey] || 0) + 1;
            if (!o.salespersonId) orderNoSp++;
            const coKey = companyName(o.companyId);
            orderByCo[coKey] = (orderByCo[coKey] || 0) + 1;
            if (!o.companyId) orderNoCo++;
        });

        const custBySp = {};
        const custByCo = {};
        let custTotal = 0;
        let custNoSp = 0;
        (this.data.customers || []).forEach(c => {
            if (c.deleted) return;
            custTotal++;
            const spKey = nameOf(c.salespersonId);
            custBySp[spKey] = (custBySp[spKey] || 0) + 1;
            if (!c.salespersonId) custNoSp++;
            const coKey = companyName(c.companyId);
            custByCo[coKey] = (custByCo[coKey] || 0) + 1;
        });

        const facByCo = {};
        let facTotal = 0;
        (this.data.factories || []).forEach(f => {
            if (f.deleted) return;
            facTotal++;
            const coKey = companyName(f.companyId);
            facByCo[coKey] = (facByCo[coKey] || 0) + 1;
        });

        return {
            orders: {
                total: orderTotal,
                bySalesperson: orderBySp,
                byCompany: orderByCo,
                noSalesperson: orderNoSp,
                noCompany: orderNoCo
            },
            customers: {
                total: custTotal,
                bySalesperson: custBySp,
                byCompany: custByCo,
                noSalesperson: custNoSp
            },
            factories: { total: facTotal, byCompany: facByCo }
        };
    },

    resetData() {
        this.data.customers = [];
        this.data.orders = [];
        this.data.shipments = [];
        this.data.invoices = [];
        this.data.factories = [];
        this._backupToLocal();
        this.flush().catch(e => {
            handleError(e, '重置数据');
        });
    },

    // ==================== 汇率工具（委托 Exchange 模块） ====================
    usdToRmb(usd, companyId) {
        return Exchange.usdToRmb(usd, companyId);
    },
    rmbToUsd(rmb, companyId) {
        return Exchange.rmbToUsd(rmb, companyId);
    },

    isDomesticCompany(companyId) {
        return Exchange.isDomestic(companyId);
    },

    calcOrderProfit(orderAmountUSD, factoryCostRMB, freightCostUSD, insuranceCostUSD, otherCostUSD, companyId, policy) {
        return Exchange.calcOrderProfit(
            orderAmountUSD,
            factoryCostRMB,
            freightCostUSD,
            insuranceCostUSD,
            otherCostUSD,
            companyId,
            policy
        );
    },

    /** 为新/更新的订单计算并设置利润相关字段（修改传入对象） */
    _applyProfitFields(order) {
        const isHK = !this.isDomesticCompany(order.companyId);
        const rate = this.getExchangeRate(order.companyId);
        const profit = this.calcOrderProfit(
            order.orderAmountUSD,
            order.factoryCostRMB,
            order.freightCostUSD,
            order.insuranceCostUSD,
            order.otherCostUSD,
            order.companyId,
            order.formulaVersion
        );
        // HK 公司全部美金交易，orderAmountRMB = orderAmountUSD（不乘汇率）
        const totalRevenueRMB = isHK ? order.orderAmountUSD : order.orderAmountUSD * rate;
        order.orderAmountRMB = Math.round(totalRevenueRMB * 100) / 100;
        order.profitRMB = Math.round(profit * 100) / 100;
        const profitRateBase = isHK ? order.orderAmountUSD : totalRevenueRMB;
        order.profitRate = profitRateBase > 0 ? Math.round((profit / profitRateBase) * 100 * 100) / 100 : 0;
        return order;
    },

    formatMoney(amount, currency = 'CNY') {
        if (currency === 'USD') {
            return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        return '¥' + amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    formatDate(dateStr) {
        if (!dateStr) return '-';
        const d = new Date(dateStr);
        return (
            d.getFullYear() +
            '-' +
            String(d.getMonth() + 1).padStart(2, '0') +
            '-' +
            String(d.getDate()).padStart(2, '0')
        );
    },

    // ==================== 数据迁移 ====================
    migrateCustomerData() {
        let migrated = false;
        this.data.customers.forEach(c => {
            if (c.position === undefined) {
                c.position = '';
                migrated = true;
            }
            if (c.mobilePhone === undefined) {
                c.mobilePhone = '';
                migrated = true;
            }
            if (c.homeAddress === undefined) {
                c.homeAddress = '';
                migrated = true;
            }
            if (c.companyAddress === undefined) {
                c.companyAddress = '';
                migrated = true;
            }
            if (!c.contacts || !Array.isArray(c.contacts)) {
                const fallbackName = c.contact || '';
                if (fallbackName) {
                    c.contacts = [
                        {
                            id: 'CONT-MIG-' + c.id,
                            name: fallbackName,
                            position: c.position || '',
                            email: c.email || '',
                            phone: c.phone || '',
                            mobilePhone: c.mobilePhone || '',
                            homeAddress: c.homeAddress || ''
                        }
                    ];
                } else {
                    c.contacts = [];
                }
                migrated = true;
            }
        });
        if (migrated) {
            this.save().catch(e => {
                handleError(e, '自动保存');
            });
            console.log('[数据迁移] 客户数据已升级');
        }
    },

    // ==================== CRUD: 订单 ====================

    /**
     * 获取订单列表（自动过滤已删除、按公司和业务员过滤）
     * @param {Object} [filter={}] - 过滤条件
     * @param {string} [filter.status] - 按订单状态过滤
     * @param {string} [filter.shippingStatus] - 按出运状态过滤
     * @param {string} [filter.search] - 搜索关键词（操作单号/客户名/产品名）
     * @returns {Order[]} 过滤后的订单列表
     */
    getOrders(filter = {}) {
        let result = this.data.orders.filter(o => !o.deleted);
        result = this.filterByCompany(result);
        result = Auth.filterOrders(result);
        if (filter.status && filter.status !== 'all') result = result.filter(o => o.status === filter.status);
        if (filter.paymentStatus && filter.paymentStatus !== 'all') {
            result = result.filter(o => o.paymentStatus === filter.paymentStatus);
        }
        if (filter.shippingStatus && filter.shippingStatus !== 'all') {
            result = result.filter(o => o.shippingStatus === filter.shippingStatus);
        }
        if (filter.search) {
            const q = filter.search.toLowerCase();
            result = result.filter(
                o =>
                    o.id.toLowerCase().includes(q) ||
                    o.customerName.toLowerCase().includes(q) ||
                    o.productName.toLowerCase().includes(q) ||
                    (o.customerOrderNo || '').toLowerCase().includes(q) ||
                    (o.companyOperationNo || '').toLowerCase().includes(q) ||
                    (o.contactPerson || '').toLowerCase().includes(q)
            );
        }
        result.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));
        return result;
    },

    /**
     * 按 ID 获取单个订单（不含已删除的）
     * @param {string} id - 订单 ID
     * @returns {Order|undefined} 订单对象，未找到返回 undefined
     */
    getOrder(id) {
        const order = this.data.orders.find(o => String(o.id) === String(id));
        return order && !order.deleted ? order : null;
    },

    generateCompanyOperationNo(companyId, salespersonId) {
        const prefixMap = { 'CO-GR': 'GR', 'CO-WY': 'WY' };
        const company = this.companies.find(c => String(c.id) === String(companyId));
        const prefix = company?.orderPrefix || prefixMap[companyId] || 'OP';
        const yearSuffix = String(new Date().getFullYear()).slice(2);
        const salesperson = (Auth.users || []).find(u => String(u.id) === String(salespersonId)) || Auth.currentUser;
        const initial = salesperson ? (salesperson.name || '?').charAt(0).toUpperCase() : '?';
        const pattern = prefix + yearSuffix + initial;
        const existing = this.data.orders
            .filter(o => String(o.companyId) === String(companyId) && (o.companyOperationNo || '').startsWith(pattern))
            .map(o => parseInt((o.companyOperationNo || '').slice(pattern.length)) || 0);
        const nextSeq = existing.length > 0 ? Math.max(...existing) + 1 : 1;
        return pattern + String(nextSeq).padStart(3, '0');
    },

    /**
     * 创建新订单（含输入验证 + 自动生成 ID + 利润计算）
     * @param {Partial<Order>} order - 订单数据
     * @returns {Order} 新创建的订单对象
     * @throws {Error} 必填字段缺失或订单金额无效时抛出
     */
    addOrder(order) {
        order.companyId = order.companyId || this._getEffectiveCompanyId();
        order.createdBy = Auth.currentUser ? Auth.currentUser.id : null;
        order.salespersonId = order.salespersonId || order.createdBy;
        order.companyOperationNo =
            String(order.companyOperationNo || '').trim() ||
            this.generateCompanyOperationNo(order.companyId, order.salespersonId);
        // 输入验证
        const missing = validate.required(order, ['customerId', 'companyOperationNo']);
        if (missing) {
            toast(`请填写必填字段：${missing}`, 'warning');
            return null;
        }
        if (!Number.isFinite(Number(order.orderAmountUSD)) || Number(order.orderAmountUSD) <= 0) {
            toast('订单金额(USD) 必须大于 0', 'warning');
            return null;
        }
        const duplicate = this.data.orders.some(
            o =>
                String(o.companyId) === String(order.companyId) &&
                String(o.companyOperationNo || '')
                    .trim()
                    .toUpperCase() === order.companyOperationNo.toUpperCase()
        );
        if (duplicate) {
            toast('公司操作单号已存在（含已删除订单），请更换单号', 'warning');
            return null;
        }
        // Separate immutable identity from editable business numbering. Existing
        // records keep their historical IDs; the server enforces uniqueness too.
        order.id = 'ORD-' + crypto.randomUUID();
        order.orderAmountUSD = Number(order.orderAmountUSD);
        order.createdAt = new Date().toISOString();
        this._applyProfitFields(order);
        this.data.orders.unshift(order);
        this._backupToLocal();
        // ★ 不在此处 flush，由调用方 (saveOrder / processImportRows) 显式 flush
        // 避免 double-flush 竞态条件导致数据丢失
        return order;
    },

    updateOrder(id, updates) {
        const idx = this.data.orders.findIndex(o => String(o.id) === String(id));
        if (idx >= 0) {
            const current = this.data.orders[idx];
            if (current.deleted) return null;
            const patch = { ...updates };
            // Identity and legal entity cannot be changed by an edit form.
            for (const key of ['id', 'companyId', 'createdBy', 'createdAt']) delete patch[key];
            const canSeeFinancials = typeof Auth.canSeeFinancials !== 'function' || Auth.canSeeFinancials();
            if (!canSeeFinancials) {
                for (const key of [
                    'factoryCostRMB',
                    'freightCostUSD',
                    'insuranceCostUSD',
                    'otherCostUSD',
                    'factoryPaidRMB',
                    'factoryPaidStatus',
                    'orderAmountRMB',
                    'profitRMB',
                    'profitRate'
                ]) {
                    delete patch[key];
                }
            }
            if ('orderAmountUSD' in patch) {
                if (!Number.isFinite(Number(patch.orderAmountUSD)) || Number(patch.orderAmountUSD) <= 0) {
                    toast('订单金额(USD) 必须大于 0', 'warning');
                    return null;
                }
                patch.orderAmountUSD = Number(patch.orderAmountUSD);
            }
            if ('companyOperationNo' in patch) {
                patch.companyOperationNo = String(patch.companyOperationNo || '').trim();
                if (
                    !patch.companyOperationNo ||
                    this.data.orders.some(
                        (o, i) =>
                            i !== idx &&
                            String(o.companyId) === String(current.companyId) &&
                            String(o.companyOperationNo || '')
                                .trim()
                                .toUpperCase() === patch.companyOperationNo.toUpperCase()
                    )
                ) {
                    toast('公司操作单号不能为空或与已有订单重复', 'warning');
                    return null;
                }
            }
            const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
            const numericFinanceInputs = [
                'orderAmountUSD',
                'exchangeRate',
                'factoryCostRMB',
                'freightCostUSD',
                'insuranceCostUSD',
                'otherCostUSD'
            ];
            const financeChanged =
                numericFinanceInputs.some(
                    key => Object.hasOwn(patch, key) && Number(patch[key] ?? 0) !== Number(current[key] ?? 0)
                ) ||
                (Object.hasOwn(patch, 'formulaVersion') && patch.formulaVersion !== current.formulaVersion);
            if (canSeeFinancials && (!this._preserveImportedValues || financeChanged)) {
                this._applyProfitFields(merged);
            }
            this.data.orders[idx] = merged;
            this._backupToLocal();
            // ★ 不在此处 flush，由调用方显式 flush
            return merged;
        }
        return null;
    },

    /**
     * 软删除订单（标记 deleted + 同步关联出运/单证）
     * @param {string} id - 订单 ID
     */
    deleteOrder(id) {
        const order = this.data.orders.find(o => String(o.id) === String(id));
        if (!order) return;
        order.deleted = true;
        order.deletedAt = new Date().toISOString();
        // 关联数据同步标记删除
        this.data.shipments.forEach(s => {
            if (String(s.orderId) === String(id)) {
                s.deleted = true;
                s.deletedAt = order.deletedAt;
            }
        });
        this.data.invoices.forEach(d => {
            if (String(d.orderId) === String(id)) {
                d.deleted = true;
                d.deletedAt = order.deletedAt;
            }
        });
        console.log(`[DB] deleteOrder: 订单 ${id} 已标记删除`);
        this._backupToLocal();
        // ★ 不在此处 flush，由调用方显式 flush
    },

    // ==================== CRUD: 客户 ====================

    /**
     * 获取客户列表（自动过滤已删除 + 按业务员权限过滤）
     * @param {Object} [filter={}] - 过滤条件
     * @param {string} [filter.search] - 搜索关键词
     * @returns {Customer[]} 过滤后的客户列表
     */
    getCustomers(filter = {}) {
        let result = this.data.customers.filter(c => !c.deleted);
        const visibleIds = Auth.getVisibleCompanyIds();
        const myId = Auth.currentUser ? Auth.currentUser.id : null;
        if (visibleIds !== null) {
            result = result.filter(
                c =>
                    c.companyId === undefined ||
                    visibleIds.includes(c.companyId) ||
                    (c.createdBy && myId && c.createdBy === myId) // 自己创建的客户始终可见
            );
        }
        result = Auth.filterCustomers(result, this.data.orders);
        if (filter.search) {
            const q = filter.search.toLowerCase();
            result = result.filter(
                c =>
                    c.company.toLowerCase().includes(q) ||
                    c.contact.toLowerCase().includes(q) ||
                    c.country.toLowerCase().includes(q) ||
                    c.position.toLowerCase().includes(q)
            );
        }
        return result;
    },

    /**
     * 按 ID 获取单个客户
     * @param {string} id - 客户 ID
     * @returns {Customer|null} 客户对象，未找到或已删除返回 null
     */
    getCustomer(id) {
        const c = this.data.customers.find(c => String(c.id) === String(id));
        return c && !c.deleted ? c : null;
    },

    /**
     * 获取指定客户的所有订单
     * @param {string} customerId - 客户 ID
     * @returns {Order[]} 该客户的订单列表
     */
    getCustomerOrders(customerId) {
        const result = this.data.orders.filter(o => !o.deleted && String(o.customerId) === String(customerId));
        return Auth.filterOrders(result);
    },

    /**
     * 创建新客户（含输入验证 + 自动生成 ID）
     * @param {Partial<Customer>} customer - 客户数据
     * @returns {Customer|null} 新创建的客户对象，验证失败返回 null
     */
    addCustomer(customer) {
        // 输入验证
        const missing = validate.required(customer, ['company']);
        if (missing) {
            toast(`请填写必填字段：${missing}`, 'warning');
            return null;
        }
        customer.id =
            'C' +
            Date.now().toString(36).toUpperCase().slice(-6) +
            Math.random().toString(36).toUpperCase().slice(2, 4);
        customer.companyId = customer.companyId || this._getEffectiveCompanyId();
        customer.createdBy = customer.createdBy || (Auth.currentUser ? Auth.currentUser.id : null);
        customer.salespersonId = customer.salespersonId || (Auth.currentUser ? Auth.currentUser.id : null);
        this.data.customers.push(customer);
        this._backupToLocal();
        // ★ 不在此处 flush，由调用方显式 flush
        // 避免 double-flush 竞态条件导致数据丢失
        return customer;
    },

    updateCustomer(id, updates) {
        const idx = this.data.customers.findIndex(c => String(c.id) === String(id));
        if (idx >= 0) {
            this.data.customers[idx] = { ...this.data.customers[idx], ...updates };
            this._backupToLocal();
            // ★ 不在此处 flush，由调用方显式 flush
            return this.data.customers[idx];
        }
        return null;
    },

    /**
     * 软删除客户（标记 deleted + 同步关联订单）
     * @param {string} id - 客户 ID
     */
    deleteCustomer(id) {
        const customer = this.data.customers.find(c => String(c.id) === String(id));
        if (!customer) return false;
        customer.deleted = true;
        customer.deletedAt = new Date().toISOString();
        console.log(`[DB] deleteCustomer: 客户 ${id} 已标记删除`);
        this._backupToLocal();
        // ★ 不在此处 flush，由调用方显式 flush
        return true;
    },

    // ==================== CRUD: 出运 ====================
    getShipments(filter = {}) {
        let result = this.data.shipments.filter(s => !s.deleted);
        result = this.filterByCompany(result);
        result = Auth.filterShipments(result, this.data.orders);
        result = result.map(s => {
            const order = this.data.orders.find(o => String(o.id) === String(s.orderId) && !o.deleted);
            return { ...s, overseasPort: order ? order.overseasPort || '' : '' };
        });
        if (filter.status && filter.status !== 'all') result = result.filter(s => s.status === filter.status);
        if (filter.search) {
            const q = filter.search.toLowerCase();
            result = result.filter(
                s =>
                    s.orderId.toLowerCase().includes(q) ||
                    s.blNumber.toLowerCase().includes(q) ||
                    s.customerName.toLowerCase().includes(q) ||
                    s.containerNo.toLowerCase().includes(q)
            );
        }
        result.sort((a, b) => new Date(b.etd || 0) - new Date(a.etd || 0));
        return result;
    },

    getShipment(id) {
        const s = this.data.shipments.find(s => String(s.id) === String(id));
        if (s && !s.deleted) {
            const order = this.data.orders.find(o => String(o.id) === String(s.orderId) && !o.deleted);
            return { ...s, overseasPort: order ? order.overseasPort || '' : '' };
        }
        return null;
    },

    getShipmentByOrder(orderId) {
        return this.data.shipments.find(s => String(s.orderId) === String(orderId) && !s.deleted);
    },

    addShipment(shipment) {
        shipment.id =
            'SHP-' +
            Date.now().toString(36).toUpperCase().slice(-6) +
            Math.random().toString(36).toUpperCase().slice(2, 4);
        this.data.shipments.unshift(shipment);
        this._backupToLocal();
        // ★ 不在此处 flush，由调用方显式 flush
        return shipment;
    },

    updateShipment(id, updates) {
        const idx = this.data.shipments.findIndex(s => String(s.id) === String(id));
        if (idx >= 0) {
            this.data.shipments[idx] = { ...this.data.shipments[idx], ...updates };
            this._backupToLocal();
            // ★ 不在此处 flush，由调用方显式 flush
            return this.data.shipments[idx];
        }
        return null;
    },

    // ==================== CRUD: 单证 ====================
    getInvoices(filter = {}) {
        let result = this.data.invoices.filter(d => !d.deleted);
        result = this.filterByCompany(result);
        result = Auth.filterInvoices(result, this.data.orders);
        if (filter.docType && filter.docType !== 'all') result = result.filter(d => d.docType === filter.docType);
        if (filter.search) {
            const q = filter.search.toLowerCase();
            result = result.filter(
                d =>
                    d.docNumber.toLowerCase().includes(q) ||
                    d.orderId.toLowerCase().includes(q) ||
                    d.customerName.toLowerCase().includes(q)
            );
        }
        result.sort((a, b) => new Date(b.date) - new Date(a.date));
        return result;
    },

    getInvoice(id) {
        const d = this.data.invoices.find(d => String(d.id) === String(id));
        return d && !d.deleted ? d : null;
    },
    getInvoicesByOrder(orderId) {
        return this.data.invoices.filter(d => String(d.orderId) === String(orderId) && !d.deleted);
    },

    addInvoice(invoice) {
        invoice.id =
            'DOC-' +
            Date.now().toString(36).toUpperCase().slice(-6) +
            Math.random().toString(36).toUpperCase().slice(2, 4) +
            '-' +
            invoice.docType;
        this.data.invoices.push(invoice);
        this._backupToLocal();
        // ★ 不在此处 flush，由调用方显式 flush
        return invoice;
    },

    bulkAddInvoices(invoices) {
        const ts = Date.now().toString(36).toUpperCase();
        invoices.forEach((inv, i) => {
            inv.id = 'DOC-' + ts + '-' + String(i).padStart(2, '0') + '-' + inv.docType;
            inv.companyId = inv.companyId || this._getEffectiveCompanyId();
            this.data.invoices.push(inv);
        });
        this._backupToLocal();
        // ★ 不在此处 flush，由调用方显式 flush
        return invoices.length;
    },

    // ==================== CRUD: 工厂 ====================

    /**
     * 获取工厂列表（自动过滤已删除 + 按公司权限过滤）
     * @param {string} [search=''] - 搜索关键词（工厂名/联系人/产品/ID）
     * @returns {Factory[]} 过滤后的工厂列表
     */
    getFactories(search = '') {
        const visibleIds = Auth.getVisibleCompanyIds();
        const myId = Auth.currentUser ? Auth.currentUser.id : null;
        let result = this.data.factories.filter(f => !f.deleted);
        if (visibleIds !== null) {
            result = result.filter(
                f =>
                    f.companyId === undefined ||
                    visibleIds.includes(f.companyId) ||
                    (f.createdBy && myId && f.createdBy === myId) // 自己创建的工厂始终可见
            );
        }
        if (search) {
            const kw = search.toLowerCase();
            result = result.filter(
                f =>
                    f.name.toLowerCase().includes(kw) ||
                    f.contact.toLowerCase().includes(kw) ||
                    f.products.toLowerCase().includes(kw) ||
                    f.id.toLowerCase().includes(kw)
            );
        }
        return result;
    },

    /**
     * 按 ID 获取单个工厂
     * @param {string} id - 工厂 ID
     * @returns {Factory|null} 工厂对象，未找到或已删除返回 null
     */
    getFactory(id) {
        const f = this.data.factories.find(f => String(f.id) === String(id));
        return f && !f.deleted ? f : null;
    },
    getFactoryOrders(factoryId) {
        const fid = String(factoryId);
        return this.data.orders.filter(o => !o.deleted && o.factoryIds && o.factoryIds.some(id => String(id) === fid));
    },

    /**
     * 创建新工厂（含输入验证 + 自动生成 ID）
     * @param {Partial<Factory>} data - 工厂数据
     * @returns {Factory|null} 新创建的工厂对象，验证失败返回 null
     */
    addFactory(data) {
        // 输入验证
        const missing = validate.required(data, ['name']);
        if (missing) {
            toast(`请填写必填字段：${missing}`, 'warning');
            return null;
        }
        const prefix = this.currentCompanyId ? this.currentCompanyId.replace('CO-', '') : 'FC';
        const id =
            'F-' +
            prefix +
            '-' +
            Date.now().toString(36).toUpperCase().slice(-6) +
            Math.random().toString(36).toUpperCase().slice(2, 4);
        const factory = {
            id: id,
            companyId: this._getEffectiveCompanyId(),
            createdBy: Auth.currentUser ? Auth.currentUser.id : null,
            name: data.name,
            contact: data.contact || '',
            phone: data.phone || '',
            mobilePhone: data.mobilePhone || '',
            products: data.products || '',
            address: data.address || '',
            bankInfo: data.bankInfo || ''
        };
        this.data.factories.push(factory);
        this._backupToLocal();
        // ★ 不在此处 flush，由调用方显式 flush
        // 避免 double-flush 竞态条件导致数据丢失
        return factory;
    },

    updateFactory(id, data) {
        const factory = this.getFactory(id);
        if (!factory) return null;
        factory.name = data.name;
        factory.contact = data.contact || '';
        factory.phone = data.phone || '';
        factory.mobilePhone = data.mobilePhone || '';
        factory.products = data.products || '';
        factory.address = data.address || '';
        if (Object.hasOwn(data, 'bankInfo')) factory.bankInfo = data.bankInfo || '';
        this._backupToLocal();
        // ★ 不在此处 flush，由调用方显式 flush
        return factory;
    },

    /**
     * 软删除工厂（标记 deleted + 同步关联订单的 factoryIds）
     * @param {string} id - 工厂 ID
     */
    deleteFactory(id) {
        const factory = this.data.factories.find(f => String(f.id) === String(id));
        if (!factory) return false;
        factory.deleted = true;
        factory.deletedAt = new Date().toISOString();
        console.log(`[DB] deleteFactory: 工厂 ${id} 已标记删除`);
        this._backupToLocal();
        // ★ 不在此处 flush，由调用方显式 flush
        return true;
    },

    // ==================== 统计数据 ====================

    /**
     * 获取总览页统计数据（订单数、收入、成本、利润等）
     * @returns {Object} 仪表盘统计数据对象
     */
    getDashboardStats() {
        const orders = this.filterByCompany(Auth.filterOrders(this.data.orders.filter(o => !o.deleted)));
        const activeOrders = orders.filter(o => o.status !== '已取消');
        const completedOrders = orders.filter(o => o.status === '已订船');
        const pendingShipmentOrders = orders.filter(o => o.shippingStatus === '待出运');
        const totalRevenueUSD = orders.reduce((sum, o) => sum + o.orderAmountUSD, 0);
        const totalRevenueRMB = orders.reduce((sum, o) => sum + o.orderAmountRMB, 0);
        const totalFactoryCostRMB = orders.reduce((sum, o) => sum + o.factoryCostRMB, 0);
        const totalFactoryPaidRMB = orders.reduce((sum, o) => sum + (o.factoryPaidRMB || 0), 0);
        const totalFactoryUnpaidRMB = totalFactoryCostRMB - totalFactoryPaidRMB;
        const totalProfitRMB = orders.reduce((sum, o) => sum + o.profitRMB, 0);
        const totalPaidUSD = orders.reduce((sum, o) => sum + o.paidAmountUSD, 0);
        const unpaidAmount = totalRevenueUSD - totalPaidUSD;
        const isHK = this.currentCompanyId === 'CO-GW' || this.currentCompanyId === 'CO-LK';
        const avgProfitRate = isHK
            ? totalRevenueUSD > 0
                ? (totalProfitRMB / totalRevenueUSD) * 100
                : 0
            : totalRevenueRMB > 0
              ? (totalProfitRMB / totalRevenueRMB) * 100
              : 0;

        const monthlyStats = {};
        orders.forEach(o => {
            const month = o.orderDate.substring(0, 7);
            if (!monthlyStats[month]) monthlyStats[month] = { revenue: 0, cost: 0, profit: 0, count: 0 };
            const isOrderHK = o.companyId === 'CO-GW' || o.companyId === 'CO-LK';
            monthlyStats[month].revenue += isOrderHK ? o.orderAmountUSD : o.orderAmountRMB;
            monthlyStats[month].cost += o.factoryCostRMB;
            monthlyStats[month].profit += o.profitRMB;
            monthlyStats[month].count++;
        });

        const statusStats = {};
        orders.forEach(o => {
            statusStats[o.status] = (statusStats[o.status] || 0) + 1;
        });

        const upcomingShipments = Auth.filterShipments(
            this.data.shipments.filter(s => !s.deleted && (s.status === '已出运' || s.status === '待出运')),
            this.data.orders
        )
            .sort((a, b) => new Date(a.etd) - new Date(b.etd))
            .slice(0, 5)
            .map(s => {
                const order = this.data.orders.find(o => o.id === s.orderId && !o.deleted);
                return { ...s, overseasPort: order ? order.overseasPort || '' : '' };
            });

        return {
            totalOrders: orders.length,
            activeOrders: activeOrders.length,
            completedOrders: completedOrders.length,
            pendingShipmentCount: pendingShipmentOrders.length,
            totalRevenueUSD,
            totalRevenueRMB,
            totalFactoryCostRMB,
            totalFactoryPaidRMB,
            totalFactoryUnpaidRMB,
            totalProfitRMB,
            totalPaidUSD,
            unpaidAmount,
            avgProfitRate,
            customerCount: Auth.filterCustomers(
                this.filterByCompany(this.data.customers.filter(c => !c.deleted)),
                this.data.orders
            ).length,
            monthlyStats,
            statusStats,
            upcomingShipments
        };
    },

    /**
     * 获取利润分析数据（支持按时间/客户/状态过滤）
     * @param {Object} [filter={}] - 过滤条件
     * @param {string} [filter.startDate] - 开始日期
     * @param {string} [filter.endDate] - 结束日期
     * @param {string} [filter.customerId] - 客户 ID
     * @returns {Object} 利润分析数据
     */
    getProfitAnalysis(filter = {}) {
        let orders = this.filterByCompany(Auth.filterOrders(this.data.orders.filter(o => !o.deleted)));
        if (filter.startDate) orders = orders.filter(o => o.orderDate >= filter.startDate);
        if (filter.endDate) orders = orders.filter(o => o.orderDate <= filter.endDate);
        if (filter.customerId && filter.customerId !== 'all') {
            orders = orders.filter(o => o.customerId === filter.customerId);
        }

        const byCustomer = {};
        orders.forEach(o => {
            if (!byCustomer[o.customerName]) byCustomer[o.customerName] = { revenue: 0, cost: 0, profit: 0, count: 0 };
            const isOrderHK = o.companyId === 'CO-GW' || o.companyId === 'CO-LK';
            byCustomer[o.customerName].revenue += isOrderHK ? o.orderAmountUSD : o.orderAmountRMB;
            byCustomer[o.customerName].cost += o.factoryCostRMB;
            byCustomer[o.customerName].profit += o.profitRMB;
            byCustomer[o.customerName].count++;
        });

        const byCategory = {};
        orders.forEach(o => {
            if (!byCategory[o.productCategory]) {
                byCategory[o.productCategory] = { revenue: 0, cost: 0, profit: 0, count: 0 };
            }
            const isOrderHK = o.companyId === 'CO-GW' || o.companyId === 'CO-LK';
            byCategory[o.productCategory].revenue += isOrderHK ? o.orderAmountUSD : o.orderAmountRMB;
            byCategory[o.productCategory].cost += o.factoryCostRMB;
            byCategory[o.productCategory].profit += o.profitRMB;
            byCategory[o.productCategory].count++;
        });

        const byMonth = {};
        orders.forEach(o => {
            const month = o.orderDate.substring(0, 7);
            if (!byMonth[month]) byMonth[month] = { revenue: 0, cost: 0, profit: 0, count: 0 };
            const isOrderHK = o.companyId === 'CO-GW' || o.companyId === 'CO-LK';
            byMonth[month].revenue += isOrderHK ? o.orderAmountUSD : o.orderAmountRMB;
            byMonth[month].cost += o.factoryCostRMB;
            byMonth[month].profit += o.profitRMB;
            byMonth[month].count++;
        });

        return { orders, byCustomer, byCategory, byMonth };
    }
};

export { DB };

window.DB = DB;
