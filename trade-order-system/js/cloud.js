/**
 * CloudBase 云数据适配层 v13 — 自定义登录 + 降级匿名
 *
 * 多人协作架构：
 * - 每次 save 创建新文档（append-only，避免并发覆盖）
 * - load 按 updatedAt 降序取最新文档 + 多文档合并
 * - 后台标记旧文档 active=false
 *
 * 登录策略（优先级从高到低）：
 * 1. 自定义登录 — 已部署 customLogin 云函数时使用，提供用户身份（auth.uid = 用户ID）
 * 2. 匿名登录 — 降级方案，无需额外部署，但无用户身份
 *
 * CloudBase 控制台必须配置：
 * 1. 用户管理 → 登录设置 → 开启匿名登录（降级必需）
 * 2. 云函数 → 部署 customLogin（自定义登录必需，见 cloudfunctions/customLogin/）
 * 3. 数据库 → app_data 集合 → 权限设置 → 自定义安全规则（见下方）
 * 4. 安全配置 → 添加部署域名到安全域名列表
 *
 * ===== 数据库安全规则（匿名登录模式，当前使用） =====
 * {
 *   "read": "doc.dataType != null",
 *   "write": "doc.dataType in ['gw_data', '_diag_test']",
 *   "create": "doc.dataType in ['gw_data', '_diag_test']",
 *   "update": "doc.dataType in ['gw_data', '_diag_test']",
 *   "delete": false
 * }
 *
 * ===== 数据库安全规则（自定义登录模式，部署 customLogin 云函数后升级） =====
 * // 需要登录才能访问，并限制 _diag_test 只能由 admin 创建
 * {
 *   "read": "auth != null",
 *   "write": "auth != null && doc.dataType in ['gw_data', '_diag_test']",
 *   "create": "auth != null && (doc.dataType == 'gw_data' || (doc.dataType == '_diag_test' && auth.custom.role == 'admin'))",
 *   "update": "auth != null && doc.dataType in ['gw_data', '_diag_test']",
 *   "delete": false
 * }
 * // 说明：使用自定义登录后，auth.uid 为用户 ID，auth.custom.role 为角色
 */

import { CONSTANTS } from './constants.js';
import { Auth } from './auth.js';

const Cloud = {
    // 默认配置（会被手动配置覆盖）
    DEFAULT_ENV_ID: 'grandware-d9gb4owez89cb9df9',
    DEFAULT_REGION: 'ap-shanghai',

    // === 自定义登录配置 ===
    // 部署 customLogin 云函数后，在云函数环境变量中设置 SHARED_SECRET，并同步修改此处
    CLOUD_SECRET: '',
    // 云函数 HTTP 触发器地址（部署后从 CloudBase 控制台获取）
    CLOUD_FN_URL: '',

    _app: null,
    _db: null,
    _ready: false,
    _syncing: false,
    _docId: null,
    _lastMeta: { version: 0, updatedAt: null, updatedBy: null },
    _loginType: 'none', // 'custom' | 'anonymous' | 'none'
    _customLoginTried: false, // 避免每次 init 都重试自定义登录

    COLLECTION: 'app_data',
    DATA_TYPE: 'gw_data',

    // 当前生效配置
    envId: 'grandware-d9gb4owez89cb9df9',
    region: 'ap-shanghai',

    _status: {
        sdkLoaded: false,
        authDone: false,
        dbReady: false,
        lastError: null,
        lastErrorTime: null
    },

    /**
     * 从 localStorage 加载手动配置并覆盖默认值
     */
    loadConfig() {
        try {
            const raw = localStorage.getItem('grandware_cloud_config');
            if (!raw) return null;
            const cfg = JSON.parse(raw);
            if (cfg.envId && typeof cfg.envId === 'string') {
                this.envId = cfg.envId.trim();
            }
            if (cfg.region && typeof cfg.region === 'string') {
                this.region = cfg.region.trim();
            }
            if (typeof cfg.cloudFnUrl === 'string') {
                this.CLOUD_FN_URL = cfg.cloudFnUrl.trim();
            }
            if (typeof cfg.cloudSecret === 'string') {
                this.CLOUD_SECRET = cfg.cloudSecret.trim();
            }
            return cfg;
        } catch (e) {
            console.warn('[Cloud] 加载手动配置失败:', e.message);
            return null;
        }
    },

    /**
     * 保存手动配置到 localStorage
     */
    saveConfig(cfg) {
        try {
            localStorage.setItem('grandware_cloud_config', JSON.stringify(cfg));
            if (cfg.envId) this.envId = cfg.envId.trim();
            if (cfg.region) this.region = cfg.region.trim();
            if (typeof cfg.cloudFnUrl === 'string') this.CLOUD_FN_URL = cfg.cloudFnUrl.trim();
            if (typeof cfg.cloudSecret === 'string') this.CLOUD_SECRET = cfg.cloudSecret.trim();
            return true;
        } catch (e) {
            console.error('[Cloud] 保存手动配置失败:', e.message);
            return false;
        }
    },

    /**
     * 获取当前完整配置（供 UI 显示）
     */
    getConfig() {
        return {
            envId: this.envId,
            region: this.region,
            cloudFnUrl: this.CLOUD_FN_URL,
            cloudSecret: this.CLOUD_SECRET ? '••••••••' + this.CLOUD_SECRET.slice(-4) : ''
        };
    },

    /**
     * 清除手动配置，恢复默认值
     */
    clearConfig() {
        localStorage.removeItem('grandware_cloud_config');
        this.envId = this.DEFAULT_ENV_ID;
        this.region = this.DEFAULT_REGION;
        this.CLOUD_FN_URL = '';
        this.CLOUD_SECRET = '';
    },

    /** 完整诊断：返回每一步的详细结果 */
    async diagnose() {
        const log = [];
        const sdk = typeof cloudbase !== 'undefined' ? cloudbase : typeof tcb !== 'undefined' ? tcb : null;

        log.push({
            step: '1. SDK 检查',
            ok: !!sdk,
            detail: sdk ? `SDK 类型: ${sdk === cloudbase ? 'cloudbase' : 'tcb'}` : 'cloudbase SDK 未在 window 上找到'
        });

        if (!sdk) return { ok: false, log };

        // 检查 init
        let initOk = false;
        try {
            if (!this._app) {
                this._app = sdk.init({
                    env: this.envId,
                    region: this.region
                });
                this._db = this._app.database();
            }
            initOk = true;
            log.push({
                step: '2. SDK init',
                ok: true,
                detail: `env=${this.envId}, region=${this.region}`
            });
        } catch (e) {
            const initErr = e.message || String(e);
            log.push({
                step: '2. SDK init',
                ok: false,
                detail: initErr
            });
        }

        if (!initOk) return { ok: false, log };

        // 登录测试
        try {
            const auth = this._app.auth();
            log.push({
                step: '3. auth() 对象',
                ok: true,
                detail: 'auth 实例创建成功'
            });
            const loginResult = await auth.signInAnonymously();
            log.push({
                step: '4. signInAnonymously',
                ok: true,
                detail: '匿名登录调用成功（' + JSON.stringify(loginResult).slice(0, 200) + '）'
            });
            const loginState = await auth.getLoginState();
            log.push({
                step: '5. getLoginState',
                ok: !!(loginState && loginState.user && loginState.user.uid),
                detail:
                    loginState && loginState.user
                        ? `uid: ${loginState.user.uid.substring(0, 16)}...`
                        : '登录状态无效: ' + JSON.stringify(loginState).slice(0, 200)
            });

            // 权限测试
            const coll = this._db.collection(this.COLLECTION);
            const writeResult = await coll.add({
                dataType: '_diag_test',
                timestamp: new Date().toISOString(),
                msg: 'diagnose test'
            });
            log.push({
                step: '6. 写入测试',
                ok: !!(writeResult && writeResult.id),
                detail: '写入成功，doc id: ' + (writeResult?.id || 'null')
            });
            if (writeResult && writeResult.id) {
                await coll
                    .doc(writeResult.id)
                    .remove()
                    .catch(() => {});
            }

            const readResult = await coll.where({ dataType: this.DATA_TYPE }).limit(1).get();
            log.push({
                step: '7. 读取测试',
                ok: true,
                detail: '读取成功，文档数: ' + (readResult.data || []).length
            });

            return {
                ok: log.every(l => l.ok),
                log
            };
        } catch (err) {
            const errMsg = err.message || String(err);
            log.push({
                step: '3+. 登录/权限测试',
                ok: false,
                detail: errMsg
            });
            return { ok: false, log };
        }
    },

    _toInt(val) {
        if (typeof val === 'number') return val;
        if (val && typeof val === 'object' && val.$numberInt) return parseInt(val.$numberInt, 10) || 0;
        return parseInt(val, 10) || 0;
    },

    /** 获取当前状态（供诊断使用） */
    getStatus() {
        return {
            ready: this._ready,
            ...this._status,
            lastMeta: this._lastMeta,
            envId: this.envId
        };
    },

    /** 确保 SDK 已加载 */
    _ensureSDK() {
        // 兼容多种全局变量名
        const sdk = typeof cloudbase !== 'undefined' ? cloudbase : typeof tcb !== 'undefined' ? tcb : null;

        if (!sdk) {
            this._status.lastError = 'CloudBase SDK 未加载';
            this._status.lastErrorTime = new Date().toISOString();
            throw new Error('CloudBase SDK 未加载，请刷新页面');
        }

        this._status.sdkLoaded = true;

        if (!this._app) {
            this._app = sdk.init({
                env: this.envId,
                region: this.region
            });
            this._db = this._app.database();
            this._status.dbReady = true;
        }
    },

    // ==================== 初始化（自定义登录优先，降级匿名登录） ====================
    async init() {
        // ★ 先加载手动配置（如果有）
        this.loadConfig();

        // 已初始化则直接返回，避免重复调用
        if (this._ready && this._app && this._db) {
            return { ok: true, uid: 'cached', loginType: this._loginType };
        }

        try {
            this._ensureSDK();

            // ★ 策略1：尝试自定义登录（需要 customLogin 云函数已部署）
            if (!this._customLoginTried) {
                const customResult = await this._tryCustomLogin();
                if (customResult && customResult.ok) {
                    this._loginType = 'custom';
                    console.log('[Cloud] 自定义登录成功 | uid:', customResult.uid, '| role:', customResult.role);
                    return { ok: true, uid: customResult.uid, loginType: 'custom' };
                }
                if (customResult && customResult.skipped) {
                    console.log('[Cloud] 自定义登录未配置，使用匿名登录');
                } else {
                    console.warn('[Cloud] 自定义登录失败，降级匿名登录:', customResult?.error);
                }
            }

            // ★ 策略2：降级匿名登录
            const auth = this._app.auth();
            const loginResult = await auth.signInAnonymously();
            console.log('[Cloud] signInAnonymously 返回:', loginResult);

            let loginState = null;
            try {
                loginState = await auth.getLoginState();
                console.log('[Cloud] getLoginState:', loginState);
            } catch (e) {
                console.warn('[Cloud] getLoginState 失败:', e.message);
            }

            const isValidLogin =
                loginState &&
                loginState.user &&
                typeof loginState.user.uid === 'string' &&
                loginState.user.uid.length > 0;

            if (isValidLogin) {
                this._ready = true;
                this._status.authDone = true;
                this._loginType = 'anonymous';
                const uid = loginState.user.uid.substring(0, 12);
                console.log('[Cloud] 匿名登录成功 | uid:', uid);
                return { ok: true, uid: uid, loginType: 'anonymous' };
            }

            // 回退：尝试 getCurrentUser
            try {
                const user = await auth.getCurrentUser();
                if (user && user.uid) {
                    this._ready = true;
                    this._status.authDone = true;
                    this._loginType = 'anonymous';
                    console.log('[Cloud] 匿名登录成功 (getCurrentUser) | uid:', user.uid.substring(0, 12));
                    return { ok: true, uid: user.uid.substring(0, 12), loginType: 'anonymous' };
                }
            } catch (e) {
                // 继续
            }

            throw new Error('匿名登录后无法确认登录状态');
        } catch (err) {
            const errMsg = err.message || String(err);
            this._status.lastError = errMsg;
            this._status.lastErrorTime = new Date().toISOString();
            console.error('[Cloud] 初始化失败:', errMsg);

            if (errMsg.includes('CORS') || errMsg.includes('fetch') || errMsg.includes('NetworkError')) {
                return { ok: false, reason: 'network', message: '网络错误：请确认 CloudBase 安全域名已添加当前域名' };
            }
            if (errMsg.includes('not enabled') || errMsg.includes('未开启') || errMsg.includes('anonymous')) {
                return {
                    ok: false,
                    reason: 'auth_disabled',
                    message: '匿名登录未开启：CloudBase 控制台 → 用户管理 → 登录设置 → 开启匿名登录'
                };
            }
            if (errMsg.includes('SDK 未加载')) {
                return {
                    ok: false,
                    reason: 'sdk_failed',
                    message: 'SDK 加载失败：请刷新页面或检查 js/cloudbase-sdk.js 是否存在'
                };
            }
            return { ok: false, reason: 'unknown', message: errMsg };
        }
    },

    /**
     * 尝试自定义登录
     * 调用 customLogin 云函数获取 ticket，然后用 signInWithTicket 建立会话
     * @returns {{ok:boolean, uid?:string, role?:string, skipped?:boolean, error?:string}}
     */
    async _tryCustomLogin() {
        this._customLoginTried = true;

        // 检查是否已配置自定义登录
        if (!this.CLOUD_FN_URL && !this.CLOUD_SECRET) {
            return { ok: false, skipped: true, error: '自定义登录未配置 CLOUD_FN_URL 和 CLOUD_SECRET' };
        }

        const currentUser = Auth && Auth.currentUser;
        if (!currentUser || !currentUser.username) {
            return { ok: false, skipped: true, error: '用户未登录本地系统' };
        }

        // 如果没有配置云函数 URL，尝试使用默认地址
        const fnUrl = this.CLOUD_FN_URL || `https://${this.envId}.service.tcloudbase.com/customLogin`;

        try {
            const response = await fetch(fnUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: currentUser.username,
                    passwordHash: currentUser.passwordHash,
                    secret: this.CLOUD_SECRET
                })
            });

            if (!response.ok) {
                const text = await response.text();
                return { ok: false, error: `云函数返回 ${response.status}: ${text}` };
            }

            const result = await response.json();

            if (!result.ok || !result.ticket) {
                return { ok: false, error: result.error || '云函数未返回 ticket' };
            }

            // 使用 ticket 建立 CloudBase 自定义登录会话
            const auth = this._app.auth();
            await auth.signInWithTicket(result.ticket);

            // 验证登录状态
            const loginState = await auth.getLoginState();
            if (!loginState || !loginState.user || !loginState.user.uid) {
                return { ok: false, error: 'ticket 登录后无法确认状态' };
            }

            this._ready = true;
            this._status.authDone = true;

            return {
                ok: true,
                uid: loginState.user.uid,
                role: currentUser.role,
                teamId: currentUser.teamId
            };
        } catch (err) {
            // 网络错误、CORS 等 → 降级匿名登录
            return { ok: false, error: err.message || String(err) };
        }
    },

    /** 获取当前登录类型 */
    getLoginType() {
        return this._loginType;
    },

    /** 是否使用自定义登录（有用户身份） */
    isCustomLogin() {
        return this._loginType === 'custom';
    },

    isReady() {
        return this._ready && !!this._app && !!this._db;
    },

    getLastMeta() {
        return this._lastMeta;
    },

    /** 重置连接状态（用于手动重连） */
    reset() {
        this._ready = false;
        this._status.authDone = false;
        // 保留 sdkLoaded / dbReady，因为 SDK 通常已加载
        // 保留 lastError 以便排查问题
        this._loginType = 'none';
    },

    // ==================== 数据加载 ====================

    /**
     * 从 CloudBase 加载数据（查询最近 active 文档 + 多文档合并）
     * @returns {Promise<{data: AppData, meta: Object}|null>} 合并后的数据和元数据，未就绪返回 null
     */
    async loadData() {
        if (!this.isReady()) {
            console.warn('[Cloud] loadData: CloudBase 未就绪');
            return null;
        }

        try {
            const coll = this._db.collection(this.COLLECTION);

            // ★ 拉取最近 20 条活跃文档（追加模式下会有多个并存文档）
            let result = await coll
                .where({ dataType: this.DATA_TYPE, active: true })
                .orderBy('updatedAt', 'desc')
                .limit(20)
                .get();

            let docs = result.data || [];
            console.log('[Cloud] loadData (active=true): 拉取到', docs.length, '条文档');

            // Fallback: 旧文档可能没有 active 字段
            if (docs.length === 0) {
                result = await coll.where({ dataType: this.DATA_TYPE }).orderBy('updatedAt', 'desc').limit(200).get();
                docs = result.data || [];
                console.log('[Cloud] loadData (fallback): 拉取到', docs.length, '条文档');
            }

            if (docs.length === 0) {
                console.log('[Cloud] 集合为空，无历史数据');
                return null;
            }

            // 过滤有效 gw_data 文档
            let validDocs = docs.filter(d => d.dataType === this.DATA_TYPE && d.payload && d.active !== false);

            if (validDocs.length === 0) {
                validDocs = docs.filter(d => d.dataType === this.DATA_TYPE && d.payload);
                if (validDocs.length > 0) {
                    console.warn('[Cloud] 文档无 active 字段，使用兼容模式加载');
                }
            }

            if (validDocs.length === 0) {
                console.log('[Cloud] 无有效 gw_data 文档');
                return null;
            }

            // ★ 多文档合并：解决多用户并发保存时互相覆盖的问题
            // 按 updatedAt 降序合并，相同 ID 的项目以最新文档为准
            // 这样即使 Nicole 在 David 之后保存了不带 David 新工厂的版本，
            // David 的工厂仍会从更早的文档中被合并进来
            const merged = this._mergeMultipleDocs(validDocs);
            const latestDoc = validDocs[0];

            this._docId = latestDoc._id;
            const version = this._toInt(latestDoc.version);
            this._lastMeta = {
                version: version,
                updatedAt: latestDoc.updatedAt || null,
                updatedBy: latestDoc.updatedBy || 'unknown'
            };

            const cCount = (merged.customers || []).length;
            const oCount = (merged.orders || []).length;
            const fCount = (merged.factories || []).length;

            console.log(
                '[Cloud] 数据加载成功 (合并了 ' + validDocs.length + ' 条文档)',
                '| 客户:',
                cCount,
                '| 订单:',
                oCount,
                '| 工厂:',
                fCount,
                '| v' + version,
                '| by:',
                latestDoc.updatedBy
            );

            return {
                data: merged,
                meta: this._lastMeta,
                exchangeRate: latestDoc.exchangeRate || null,
                exchangeRates: latestDoc.exchangeRates || null,
                rateMetas: latestDoc.rateMetas || null
            };
        } catch (err) {
            const errMsg = err.message || String(err);
            console.error('[Cloud] loadData 失败:', errMsg);

            if (errMsg.includes('permission') || errMsg.includes('403')) {
                this._status.lastError =
                    '数据库权限不足：请在 CloudBase 控制台设置 app_data 集合权限为 {"read":true,"write":true}';
            } else {
                this._status.lastError = errMsg;
            }
            this._status.lastErrorTime = new Date().toISOString();
            return null;
        }
    },

    /**
     * 合并多条文档的数据：相同 ID 的项目以最新文档为准
     * 用于解决多用户并发保存时后保存者覆盖前保存者数据的问题
     * ★ 特别处理：客户的 contacts 数组也会跨文档深度合并，防止联系人被覆盖丢失
     * ★ Delete-wins 策略：任何文档中标记 deleted:true 的项目在最终结果中也是 deleted
     * @param {Array<Object>} docs - 文档数组（已按 updatedAt 降序排列）
     * @returns {AppData} 合并后的数据对象
     */
    _mergeMultipleDocs(docs) {
        // docs 已经按 updatedAt 降序排列
        const merged = {
            customers: [],
            orders: [],
            shipments: [],
            invoices: [],
            factories: []
        };

        const seenIds = {
            customers: new Set(),
            orders: new Set(),
            shipments: new Set(),
            invoices: new Set(),
            factories: new Set()
        };

        // ★ 收集所有客户的 contacts（按 contact.id 或 contact.name 去重）
        // 因为 contacts 嵌套在 customer 内，按 customer.id 合并会丢失旧文档中的 contacts
        const customerContactsMap = {}; // { customerId: Map<contactKey, contact> }

        // 第一遍：从最早到最新，收集所有 ID + 追踪软删除状态
        const allIds = {
            customers: new Set(),
            orders: new Set(),
            shipments: new Set(),
            invoices: new Set(),
            factories: new Set()
        };
        // ★ 追踪每个 ID 在任何文档中的 deleted: true 状态（删除优先策略）
        // 一旦被标记删除，即使后续文档没有 deleted 标记，也保持删除状态
        // 这防止"用户B未同步时保存导致已删除数据复活"的问题
        const deletedTracker = {
            customers: {},
            orders: {},
            shipments: {},
            invoices: {},
            factories: {}
        };

        for (let i = docs.length - 1; i >= 0; i--) {
            const doc = docs[i];
            const payload = doc.payload || {};
            for (const key of ['customers', 'orders', 'shipments', 'invoices', 'factories']) {
                (payload[key] || []).forEach(item => {
                    if (item.id) {
                        allIds[key].add(item.id);
                        if (item.deleted) {
                            const existing = deletedTracker[key][item.id];
                            const ts = item.deletedAt || '';
                            if (!existing || ts > existing) {
                                deletedTracker[key][item.id] = ts;
                            }
                        }
                    }
                });
            }
            // ★ 同时收集所有 contacts（从最早到最新，确保不遗漏）
            for (const customer of payload.customers || []) {
                if (!customer.id || !customer.contacts || !Array.isArray(customer.contacts)) continue;
                if (!customerContactsMap[customer.id]) {
                    customerContactsMap[customer.id] = new Map();
                }
                customer.contacts.forEach((contact, idx) => {
                    // 健壮的联系人 key：name + position + phone（避免同名覆盖）
                    const keyParts = [
                        contact.name || '',
                        contact.position || '',
                        contact.phone || '',
                        contact.email || ''
                    ];
                    const key = keyParts.join('|') || `_unknown_${idx}`;
                    if (!customerContactsMap[customer.id].has(key)) {
                        customerContactsMap[customer.id].set(key, contact);
                    }
                });
            }
        }

        // 第二遍：从最新到最早合并（最新的覆盖旧的相同 ID）
        for (const doc of docs) {
            const payload = doc.payload || {};
            for (const key of ['customers', 'orders', 'shipments', 'invoices', 'factories']) {
                const items = payload[key] || [];
                for (const item of items) {
                    if (item.id && !seenIds[key].has(item.id)) {
                        seenIds[key].add(item.id);
                        merged[key].push(item);
                    }
                }
            }
        }

        // ★ 第三遍：把跨文档合并后的 contacts 写回 merged customers
        // 始终使用合并结果（确保不同用户添加的联系人不会互相覆盖丢失）
        for (const customer of merged.customers) {
            if (customer.id && customerContactsMap[customer.id]) {
                const mergedContacts = Array.from(customerContactsMap[customer.id].values());
                const oldLen = (customer.contacts || []).length;
                customer.contacts = mergedContacts;
                if (mergedContacts.length !== oldLen) {
                    console.log(
                        '[Cloud] 合并 contacts:',
                        customer.company || customer.id,
                        oldLen,
                        '→',
                        mergedContacts.length
                    );
                }
            }
        }

        // ★ 第四遍：应用删除优先策略
        // 如果任何文档中某 ID 被标记为 deleted: true，则合并结果中也标记为删除
        // 这防止"用户B未同步时保存导致已删除数据复活"的问题
        for (const key of ['customers', 'orders', 'shipments', 'invoices', 'factories']) {
            const tracker = deletedTracker[key];
            for (const item of merged[key]) {
                if (item.id && tracker[item.id] && !item.deleted) {
                    item.deleted = true;
                    item.deletedAt = tracker[item.id];
                    console.log('[Cloud] 删除优先: ' + key + ' ' + item.id + ' 在旧文档中已被删除，保持删除状态');
                }
            }
        }

        return merged;
    },

    /** 仅拉取最新版本信息（用于轮询检测远程更新） */
    async checkRemoteVersion() {
        if (!this.isReady()) return null;
        try {
            const coll = this._db.collection(this.COLLECTION);
            const result = await coll
                .where({ dataType: this.DATA_TYPE, active: true })
                .orderBy('updatedAt', 'desc')
                .limit(1)
                .get();

            if (result.data && result.data.length > 0) {
                const doc = result.data[0];
                if (doc.dataType === this.DATA_TYPE && doc.payload) {
                    return {
                        version: this._toInt(doc.version),
                        updatedAt: doc.updatedAt || null,
                        updatedBy: doc.updatedBy || 'unknown'
                    };
                }
            }
            return null;
        } catch (err) {
            return null;
        }
    },

    /** 测试读写权限 */
    async testPermission() {
        if (!this.isReady()) {
            const reason = 'CloudBase 未连接';
            this._status.lastError = reason;
            this._status.lastErrorTime = new Date().toISOString();
            return { ok: false, reason };
        }
        try {
            const coll = this._db.collection(this.COLLECTION);
            const result = await coll.add({
                dataType: '_diag_test',
                timestamp: new Date().toISOString()
            });
            if (result && result.id) {
                await coll
                    .doc(result.id)
                    .remove()
                    .catch(() => {});
                // 权限测试成功后清除之前的错误
                this._status.lastError = null;
                this._status.lastErrorTime = null;
                return { ok: true, message: '数据库读写正常' };
            }
            const reason = '写入返回异常: ' + JSON.stringify(result);
            this._status.lastError = reason;
            this._status.lastErrorTime = new Date().toISOString();
            return { ok: false, reason };
        } catch (err) {
            const reason = err.message || String(err);
            this._status.lastError = reason;
            this._status.lastErrorTime = new Date().toISOString();
            return { ok: false, reason };
        }
    },

    // ==================== 数据保存（队列版，永不丢失） ====================
    _saveQueue: [],
    _saveRunning: false,
    _saveRetryMax: 3,
    _saveRetryDelay: 800,

    /** 强制排空队列（用于 beforeunload） */
    async _drainQueue() {
        while (this._saveQueue.length > 0 || this._saveRunning) {
            await new Promise(r => setTimeout(r, 100));
        }
    },

    /**
     * 保存数据到 CloudBase（加入保存队列，append-only 模式）
     * @param {AppData} data - 应用数据
     * @param {Object} exchangeRatesData - 按公司汇率
     * @param {Object} rateMetasData - 汇率元数据
     * @param {Object} [options={}] - 保存选项
     * @returns {Promise<boolean>} 是否保存成功
     */
    async saveData(data, exchangeRatesData, rateMetasData, options = {}) {
        // 加入保存队列，返回 promise 等待本次保存完成
        return new Promise((resolve, reject) => {
            const task = { data, exchangeRatesData, rateMetasData, options, resolve, reject };
            this._saveQueue.push(task);
            this._processQueue();
        });
    },

    async _processQueue() {
        if (this._saveRunning || this._saveQueue.length === 0) return;
        if (!this.isReady()) {
            while (this._saveQueue.length > 0) {
                const task = this._saveQueue.shift();
                task.reject(new Error('CloudBase 未就绪'));
            }
            return;
        }

        this._saveRunning = true;

        // 取队列中最后一个任务（合并中间的所有保存）
        const last = this._saveQueue[this._saveQueue.length - 1];
        const merged = { ...last };
        // ★ 清理被合并的早期任务：它们的 resolve 也需要被调用，否则 await 会永远挂起
        for (let i = 0; i < this._saveQueue.length - 1; i++) {
            const _task = this._saveQueue[i];
            // 不 resolve 也不 reject，因为最新任务的结果会覆盖它们
            // 如果最新任务失败，这些早期任务也应该失败
            // 所以我们保存引用，最后一起处理
        }
        // 保存被合并的任务引用
        const mergedTasks = this._saveQueue.slice(0, -1);
        this._saveQueue.length = 0;

        let attempt = 0;
        let lastError = null;

        while (attempt < this._saveRetryMax) {
            try {
                const currentUser = Auth && Auth.currentUser ? Auth.currentUser.name : 'unknown';
                const now = new Date().toISOString();

                const newDoc = {
                    dataType: this.DATA_TYPE,
                    payload: merged.data,
                    version: (this._lastMeta.version || 0) + 1 + attempt,
                    updatedAt: now,
                    updatedBy: currentUser,
                    active: true
                };
                if (merged.exchangeRatesData) newDoc.exchangeRates = merged.exchangeRatesData;
                if (merged.rateMetasData) newDoc.rateMetas = merged.rateMetasData;

                const coll = this._db.collection(this.COLLECTION);
                let result = null;

                // ★ 追加模式：每次保存创建新文档，不更新现有文档
                // 避免多用户共享 _docId 时互相覆盖
                // 旧文档通过 active:true 查询自动忽略，不会被读取
                result = await coll.add(newDoc);

                if (result && result.id) {
                    this._docId = result.id;
                    this._lastMeta = {
                        version: newDoc.version,
                        updatedAt: newDoc.updatedAt,
                        updatedBy: newDoc.updatedBy
                    };
                    console.log(
                        '[Cloud] 保存成功 v' + newDoc.version,
                        '| 客户:',
                        (merged.data.customers || []).length,
                        '| 订单:',
                        (merged.data.orders || []).length,
                        '| 工厂:',
                        (merged.data.factories || []).length,
                        attempt > 0 ? '| 重试 ' + attempt + ' 次后成功' : '',
                        '(append)'
                    );

                    merged.resolve(true);
                    // ★ 同时 resolve 被合并的早期任务
                    mergedTasks.forEach(t => t.resolve(true));
                    this._saveRunning = false;
                    // ★ 清理：把 5 分钟前的旧 active 文档标记为 inactive，避免 append 模式堆积
                    this._cleanupOldDocs().catch(e => console.warn('[Cloud] 清理旧文档失败:', e.message));
                    if (this._saveQueue.length > 0) {
                        this._processQueue();
                    }
                    return;
                }

                throw new Error('CloudBase 保存返回异常: ' + JSON.stringify(result));
            } catch (err) {
                lastError = err;
                attempt++;
                if (attempt < this._saveRetryMax) {
                    const delay = this._saveRetryDelay * Math.pow(2, attempt - 1);
                    console.warn('[Cloud] 保存失败 (第' + attempt + '次), ' + delay + 'ms 后重试:', err.message || err);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }

        console.error('[Cloud] 保存彻底失败 (重试' + this._saveRetryMax + '次):', lastError?.message || lastError);
        this._status.lastError = lastError?.message || String(lastError);
        this._status.lastErrorTime = new Date().toISOString();

        merged.reject(lastError || new Error('保存失败'));
        // ★ 同时 reject 被合并的早期任务
        mergedTasks.forEach(t => t.reject(lastError || new Error('保存失败')));
        while (this._saveQueue.length > 0) {
            const task = this._saveQueue.shift();
            task.reject(lastError || new Error('保存失败'));
        }
        this._saveRunning = false;
    },

    /** 后台清理旧文档（追加模式下避免堆积）—— 仅清理 5 分钟前的旧文档，避免干扰其他用户的活跃会话 */
    async _cleanupOldDocs() {
        if (!this.isReady()) return;
        if (this._cleaning) return; // 防止并发竞争
        this._cleaning = true;

        try {
            const coll = this._db.collection(this.COLLECTION);
            const fiveMinAgo = new Date(Date.now() - CONSTANTS.ONE_HOUR_MS / 12).toISOString();

            // 仅清理 5 分钟前的 active 文档（其他用户的活跃会话不会被影响）
            const result = await coll
                .where({
                    dataType: this.DATA_TYPE,
                    active: true,
                    updatedAt: this._db.command.lt(fiveMinAgo)
                })
                .limit(50)
                .get();

            const oldDocs = (result.data || []).filter(d => d._id !== this._docId);
            if (oldDocs.length === 0) return;

            let count = 0;
            for (const doc of oldDocs) {
                try {
                    await coll.doc(doc._id).update({
                        active: false,
                        deactivatedAt: new Date().toISOString()
                    });
                    count++;
                } catch (e) {
                    // 单个失败不影响其他
                }
            }

            if (count > 0) {
                console.log('[Cloud] 清理旧文档:', count, '条');
            }
        } catch (err) {
            console.warn('[Cloud] _cleanupOldDocs:', err.message);
        } finally {
            this._cleaning = false;
        }
    },

    // ==================== 会话清理 ====================
    resetSession() {
        this._ready = false;
        this._app = null;
        this._db = null;
        this._docId = null;
        this._status.authDone = false;
        this._loginType = 'none';
        this._customLoginTried = false;
        this._lastMeta = { version: 0, updatedAt: null, updatedBy: null };
    }
};

export { Cloud };

// 暴露到全局作用域（兼容 HTML onclick 等内联调用）
window.Cloud = Cloud;
