/**
 * 汇率与利润计算模块 — Grandware Group
 *
 * 职责：实时汇率获取、利润公式计算、全量订单重算
 * 依赖：DB 实例（exchangeRates, rateMetas, data, save）
 */

import { CONSTANTS } from './constants.js';
import { handleError, toast } from './utils.js';
import { DB } from './data.js';

const Exchange = {
    /** 判断是否国内公司（人民币结算） */
    isDomestic(companyId) {
        const company = DB.companies?.find(c => c.id === companyId);
        return company?.settlementCurrency
            ? company.settlementCurrency === 'CNY'
            : companyId === 'CO-GR' || companyId === 'CO-WY';
    },

    /** 获取当前公司汇率 */
    currentRate() {
        return DB.getExchangeRate();
    },

    /** 汇率转换 */
    usdToRmb(usd, companyId) {
        return usd * DB.getExchangeRate(companyId);
    },
    rmbToUsd(rmb, companyId) {
        return rmb / DB.getExchangeRate(companyId);
    },

    /** 计算单笔订单利润(RMB)
     *  国内公司：含退税 = (收入 - 工厂成本) + 退税 - 货代费 - 其他
     *  HK 公司：美金结算，不含退税 = 订单金额 - 工厂成本 - 其他
     */
    calcOrderProfit(orderAmountUSD, factoryCostRMB, freightCostUSD, insuranceCostUSD, otherCostUSD, companyId, policy) {
        const rate = DB.getExchangeRate(companyId);
        const formula = policy || DB.companies?.find(c => c.id === companyId)?.profitPolicy;
        if (this.isDomestic(companyId) && formula === 'grandware-v40') {
            const rebate = (factoryCostRMB / 1.13) * ((insuranceCostUSD || 0) / 100);
            return orderAmountUSD * rate - factoryCostRMB - (freightCostUSD || 0) - (otherCostUSD || 0) + rebate;
        }
        if (this.isDomestic(companyId)) {
            // 国内公司：含退税，所有 USD 费用需按汇率转为 RMB
            const revenue = orderAmountUSD * rate;
            const freightRMB = (freightCostUSD || 0) * rate;
            const insuranceRMB = (insuranceCostUSD || 0) * rate;
            const otherRMB = (otherCostUSD || 0) * rate;
            const taxRebate = (factoryCostRMB / 1.13) * 0.13; // 退税按不含税成本的 13%
            return revenue - factoryCostRMB - freightRMB - insuranceRMB - otherRMB + taxRebate;
        }
        // HK 公司：美金结算
        return orderAmountUSD - factoryCostRMB - otherCostUSD;
    },

    getOrderFinancials(order) {
        const domestic = this.isDomestic(order.companyId);
        const rate = DB.getExchangeRate(order.companyId);
        const policy =
            order.formulaVersion || DB.companies?.find(c => c.id === order.companyId)?.profitPolicy || 'legacy-usd-v56';
        const n = value => Number(value) || 0;
        const currency = domestic ? 'CNY' : 'USD';
        const revenue =
            domestic && Number.isFinite(order.orderAmountRMB)
                ? order.orderAmountRMB
                : n(order.orderAmountUSD) * (domestic ? rate : 1);
        const factoryCost = n(order.factoryCostRMB);
        const legacy = policy === 'grandware-v40';
        const freightCost = domestic ? n(order.freightCostUSD) * (legacy ? 1 : rate) : 0;
        const insuranceCost = domestic && !legacy ? n(order.insuranceCostUSD) * rate : 0;
        const otherCost = n(order.otherCostUSD) * (domestic && !legacy ? rate : 1);
        const taxRebate = domestic ? (factoryCost / 1.13) * (legacy ? n(order.insuranceCostUSD) / 100 : 0.13) : 0;
        const totalCost = factoryCost + freightCost + insuranceCost + otherCost;
        const computedProfit = revenue - totalCost + taxRebate;
        const profit = Number.isFinite(order.profitRMB) ? order.profitRMB : computedProfit;
        return {
            currency,
            revenue,
            factoryCost,
            freightCost,
            insuranceCost,
            otherCost,
            taxRebate,
            totalCost,
            profit,
            computedProfit,
            profitRate: revenue ? (profit / revenue) * 100 : 0,
            policy
        };
    },

    /** 重算全量订单利润（汇率变更后调用）
     *  国内公司：orderAmountRMB = orderAmountUSD * rate（USD→RMB 换算）
     *  HK 公司：orderAmountRMB = orderAmountUSD（全部美金，不换算）
     */
    recalcAllOrders() {
        DB.data.orders.forEach(o => {
            const rate = DB.getExchangeRate(o.companyId);
            const isHK = !this.isDomestic(o.companyId);
            const profit = this.calcOrderProfit(
                o.orderAmountUSD,
                o.factoryCostRMB,
                o.freightCostUSD,
                o.insuranceCostUSD,
                o.otherCostUSD,
                o.companyId
            );
            // HK 公司全部美金交易，不乘汇率
            o.orderAmountRMB = isHK
                ? Math.round(o.orderAmountUSD * 100) / 100
                : Math.round(o.orderAmountUSD * rate * 100) / 100;
            o.profitRMB = Math.round(profit * 100) / 100;
            const denominator = isHK ? o.orderAmountUSD : o.orderAmountRMB;
            o.profitRate = denominator > 0 ? Math.round((profit / denominator) * 10000) / 100 : 0;
        });
        DB.save().catch(e => {
            handleError(e, '自动保存');
        });
    },

    // ==================== 汇率 API 核心 ====================

    /** 从公开 API 获取原始汇率数据（内部方法）
     *  @returns {object|null} { rawRate, adjustedRate, source } 或 null
     */
    async _fetchRawRate() {
        const apis = [
            {
                name: 'ExchangeRate-API',
                url: 'https://api.exchangerate-api.com/v4/latest/USD',
                parser: data => data.rates?.CNY
            },
            {
                name: 'Open Exchange Rates',
                url: 'https://open.er-api.com/v6/latest/USD',
                parser: data => data.rates?.CNY
            }
        ];

        for (const api of apis) {
            try {
                const resp = await fetch(api.url, { signal: AbortSignal.timeout(CONSTANTS.EXCHANGE_API_TIMEOUT_MS) });
                if (!resp.ok) continue;
                const data = await resp.json();
                const rate = api.parser(data);
                if (rate && rate > CONSTANTS.EXCHANGE_RATE_MIN && rate < CONSTANTS.EXCHANGE_RATE_MAX) {
                    const adjustedRate = parseFloat((rate - CONSTANTS.EXCHANGE_RATE_ADJUST).toFixed(4));
                    console.log(`[汇率] 从 ${api.name} 获取: ${rate}, 调整后: ${adjustedRate}`);
                    return { rawRate: rate, adjustedRate, source: api.name };
                }
            } catch (e) {
                continue;
            }
        }
        return null;
    },

    /** 从公开 API 获取实时美元汇率并应用到当前公司（参考价 -0.02） */
    async fetchRate() {
        const result = await this._fetchRawRate();
        if (!result) return { success: false, error: '所有汇率源均不可用' };

        DB.exchangeRates[DB.currentCompanyId] = result.adjustedRate;
        DB.rateMetas[DB.currentCompanyId] = {
            source: '实时汇率',
            updateTime: new Date().toISOString(),
            isAuto: true,
            note: `市场参考汇率 ${result.rawRate} - 0.02 = ${result.adjustedRate}`
        };
        this.recalcAllOrders();
        return { success: true, rate: result.adjustedRate, source: result.source };
    },

    /** 获取汇率并应用到所有国内公司（自动定时刷新用） */
    async _autoRefreshAll() {
        const result = await this._fetchRawRate();
        if (!result) {
            console.warn('[汇率] 自动刷新失败：所有汇率源均不可用');
            return { success: false, error: '所有汇率源均不可用' };
        }

        const now = new Date().toISOString();
        const meta = {
            source: '自动刷新',
            updateTime: now,
            isAuto: true,
            note: `市场参考汇率 ${result.rawRate} - 0.02 = ${result.adjustedRate}`
        };

        // 应用到所有国内公司（HK 公司使用独立汇率，不在此更新）
        for (const cid of CONSTANTS.COMPANY_DOMESTIC) {
            DB.exchangeRates[cid] = result.adjustedRate;
            DB.rateMetas[cid] = { ...meta };
        }

        console.log(`[汇率] 自动刷新: ${result.adjustedRate} (来源: ${result.source})，已应用到所有国内公司`);
        this._lastAutoRefresh = Date.now();
        this.recalcAllOrders();
        this.updateDisplay();
        return { success: true, rate: result.adjustedRate, source: result.source };
    },

    /** 自动获取汇率（仅当前公司，启动时检查用） */
    async autoFetchIfStale() {
        const meta = DB.getRateMeta();
        const lastUpdate = meta.updateTime ? new Date(meta.updateTime) : null;
        if (!lastUpdate || Date.now() - lastUpdate.getTime() > CONSTANTS.ONE_HOUR_MS) {
            return await this.fetchRate();
        }
        return { success: true, cached: true };
    },

    // ==================== 定时自动刷新 ====================

    /** 自动刷新定时器 ID */
    _autoRefreshTimer: null,

    /** 上次自动刷新完成时间戳 */
    _lastAutoRefresh: null,

    /** 启动每小时自动刷新汇率 */
    startAutoRefresh() {
        this.stopAutoRefresh(); // 防止重复启动

        console.log('[汇率] 启动定时自动刷新 (每1小时)');

        // 首次立即检查是否需要刷新（启动时汇率过期则立即获取）
        this.autoFetchIfStale().then(result => {
            if (result && !result.cached) {
                console.log('[汇率] 启动时自动获取完成');
            }
        });

        // 之后每小时自动刷新一次（应用于所有国内公司）
        this._autoRefreshTimer = setInterval(() => {
            this._autoRefreshAll();
        }, CONSTANTS.ONE_HOUR_MS);

        // 记录启动时间
        this._lastAutoRefresh = Date.now();
    },

    /** 停止自动刷新 */
    stopAutoRefresh() {
        if (this._autoRefreshTimer) {
            clearInterval(this._autoRefreshTimer);
            this._autoRefreshTimer = null;
            console.log('[汇率] 已停止定时自动刷新');
        }
    },

    /** 是否正在自动刷新 */
    isAutoRefreshActive() {
        return !!this._autoRefreshTimer;
    },

    /** 获取下次自动刷新时间（ISO 字符串），无自动刷新时返回 null */
    getNextRefreshTime() {
        if (!this._autoRefreshTimer || !this._lastAutoRefresh) return null;
        return new Date(this._lastAutoRefresh + CONSTANTS.ONE_HOUR_MS).toISOString();
    },

    /** 更新汇率显示 UI */
    updateDisplay() {
        if (window.App) window.App.updateExchangeRateDisplay();
    }
};

export { Exchange };

window.Exchange = Exchange;
