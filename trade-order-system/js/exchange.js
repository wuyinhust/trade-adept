/**
 * 公司汇率与报价展示；正式订单使用后端冻结的单据汇率。
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
        if (formula === 'generic-native') {
            const conversion = this.isDomestic(companyId) ? rate : 1;
            return (
                orderAmountUSD * conversion -
                factoryCostRMB -
                ((freightCostUSD || 0) + (insuranceCostUSD || 0) + (otherCostUSD || 0)) * conversion
            );
        }
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
        const rate =
            order.stage === 'native' && Number.isFinite(order.exchangeRateUsed) && order.exchangeRateUsed > 0
                ? order.exchangeRateUsed
                : DB.getExchangeRate(order.companyId);
        const policy =
            order.profitPolicy ||
            order.formulaVersion ||
            DB.companies?.find(c => c.id === order.companyId)?.profitPolicy ||
            'legacy-usd-v56';
        const n = value => Number(value) || 0;
        const currency = domestic ? 'CNY' : 'USD';
        if (order.stage === 'legacy' || (order.historicalReference && order.stage !== 'native')) {
            const known = value => (Number.isFinite(value) ? value : null);
            const storedRevenue = known(domestic ? order.orderAmountRMB : order.orderAmountUSD);
            const factoryCost = known(order.factoryCostRMB);
            const legacy = policy === 'grandware-v40';
            const historicRate =
                Number.isFinite(order.exchangeRateUsed) && order.exchangeRateUsed > 0 ? order.exchangeRateUsed : null;
            const convertedExpense = value => {
                const amount = known(value);
                if (amount === null) return null;
                if (!domestic || legacy || amount === 0) return amount;
                return historicRate === null ? null : amount * historicRate;
            };
            const freightCost = !domestic && legacy ? 0 : convertedExpense(order.freightCostUSD);
            const insuranceCost = legacy ? 0 : convertedExpense(order.insuranceCostUSD);
            const otherCost = convertedExpense(order.otherCostUSD);
            const taxRebate =
                domestic && legacy
                    ? factoryCost !== null && known(order.insuranceCostUSD) !== null
                        ? ((factoryCost / 1.13) * order.insuranceCostUSD) / 100
                        : null
                    : 0;
            const totalCost = [factoryCost, freightCost, insuranceCost, otherCost].every(Number.isFinite)
                ? factoryCost + freightCost + insuranceCost + otherCost
                : null;
            const profit = known(order.profitRMB);
            return {
                currency,
                revenue: storedRevenue,
                factoryCost,
                freightCost,
                insuranceCost,
                otherCost,
                taxRebate,
                totalCost,
                profit,
                computedProfit: null,
                profitRate:
                    known(order.profitRate) ??
                    (Number.isFinite(profit) && Number.isFinite(storedRevenue) && storedRevenue > 0
                        ? (profit / storedRevenue) * 100
                        : null),
                policy,
                incompleteHistory: [storedRevenue, totalCost, profit].some(value => value === null)
            };
        }
        const revenue =
            domestic && Number.isFinite(order.orderAmountRMB)
                ? order.orderAmountRMB
                : n(order.orderAmountUSD) * (domestic ? rate : 1);
        const factoryCost = n(order.factoryCostRMB);
        const legacy = policy === 'grandware-v40';
        const generic = policy === 'generic-native';
        const freightCost = domestic
            ? n(order.freightCostUSD) * (legacy ? 1 : rate)
            : generic
              ? n(order.freightCostUSD)
              : 0;
        const insuranceCost = !legacy ? n(order.insuranceCostUSD) * (domestic ? rate : generic ? 1 : 0) : 0;
        const otherCost = n(order.otherCostUSD) * (domestic && !legacy ? rate : 1);
        const taxRebate =
            domestic && !generic ? (factoryCost / 1.13) * (legacy ? n(order.insuranceCostUSD) / 100 : 0.13) : 0;
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
    recalcAllOrders({ persist = true } = {}) {
        let changed = 0;
        DB.data.orders.forEach(o => {
            // 历史参考与已进入 ERPNext 单据流的正式订单必须沿用 exchangeRateUsed。
            // 行情刷新只影响待完善订单以及之后的新计算。
            const frozen =
                o.stage === 'legacy' ||
                o.stage === 'native' ||
                o.historicalReference === true ||
                (Array.isArray(o.nativeDocuments) && o.nativeDocuments.length > 0) ||
                (Number.isFinite(o.exchangeRateUsed) && o.exchangeRateUsed > 0);
            if (frozen) return;
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
            changed++;
        });
        if (persist && changed > 0) {
            DB.save().catch(e => {
                handleError(e, '自动保存');
            });
        }
        return changed;
    },

    // ==================== 汇率 API 核心 ====================

    _isValidRate(value) {
        return (
            Number.isFinite(Number(value)) &&
            Number(value) > CONSTANTS.EXCHANGE_RATE_MIN &&
            Number(value) < CONSTANTS.EXCHANGE_RATE_MAX
        );
    },

    _toIso(value) {
        if (!value) return null;
        const time = new Date(value).getTime();
        return Number.isFinite(time) ? new Date(time).toISOString() : null;
    },

    /** 当前租户需要实时 USD → CNY 的法人主体。 */
    _liveRateCompanyIds() {
        const companies = DB.companies || [];
        const hasCurrencyMetadata = companies.some(company => Boolean(company.settlementCurrency));
        const ids = companies
            .filter(company =>
                hasCurrencyMetadata ? company.settlementCurrency === 'CNY' : this.isDomestic(company.id)
            )
            .map(company => company.id);
        if (hasCurrencyMetadata) return ids;
        return ids.length ? ids : CONSTANTS.COMPANY_DOMESTIC.filter(cid => this.isDomestic(cid));
    },

    /** 校验同源服务给出的后端权威结果，防止错误口径进入业务计算。 */
    _normalizeBusinessRate(payload) {
        const rawRate = Number(payload?.rawRate);
        const adjustment = Number(payload?.adjustment);
        const adjustedRate = Number(payload?.adjustedRate);
        const expected = Number((rawRate - CONSTANTS.EXCHANGE_RATE_ADJUST).toFixed(4));
        if (
            !this._isValidRate(rawRate) ||
            !this._isValidRate(adjustedRate) ||
            Math.abs(adjustment + CONSTANTS.EXCHANGE_RATE_ADJUST) > 0.000001 ||
            Math.abs(adjustedRate - expected) > 0.0001
        ) {
            return null;
        }
        return {
            base: payload.base || 'USD',
            quote: payload.quote || 'CNY',
            rawRate,
            adjustment,
            adjustedRate,
            provider: payload.provider || 'ExchangeRate-API',
            source: payload.source || payload.provider || 'ExchangeRate-API',
            publishedAt: this._toIso(payload.publishedAt),
            fetchedAt: this._toIso(payload.fetchedAt) || new Date().toISOString(),
            nextUpdateAt: this._toIso(payload.nextUpdateAt),
            cached: payload.cached === true,
            stale: payload.stale === true
        };
    },

    /**
     * 获取原始汇率。
     * BusinessAPI 模式只访问同源网关；旧 CloudBase 模式保留浏览器直连作为兼容路径。
     */
    async _fetchRawRate() {
        this._lastFetchError = null;
        if (DB._businessAPI?.getExchangeRate) {
            try {
                const payload = await DB._businessAPI.getExchangeRate();
                const normalized = this._normalizeBusinessRate(payload);
                if (!normalized) {
                    const error = new Error('汇率服务返回的调整口径无效');
                    error.code = 'INVALID_EXCHANGE_RATE';
                    throw error;
                }
                return normalized;
            } catch (error) {
                this._lastFetchError = error;
                console.warn('[汇率] 同源汇率服务不可用:', error.message);
                return null;
            }
        }

        const apis = [
            {
                name: 'ExchangeRate-API',
                url: 'https://api.exchangerate-api.com/v4/latest/USD',
                parser: data => ({
                    rate: data.rates?.CNY,
                    publishedAt: data.date ? `${data.date}T00:00:00Z` : null,
                    nextUpdateAt: null
                })
            },
            {
                name: 'Open Exchange Rates',
                url: 'https://open.er-api.com/v6/latest/USD',
                parser: data => ({
                    rate: data.rates?.CNY,
                    publishedAt: data.time_last_update_unix
                        ? new Date(data.time_last_update_unix * 1000).toISOString()
                        : null,
                    nextUpdateAt: data.time_next_update_unix
                        ? new Date(data.time_next_update_unix * 1000).toISOString()
                        : null
                })
            }
        ];

        for (const api of apis) {
            try {
                const resp = await fetch(api.url, { signal: AbortSignal.timeout(CONSTANTS.EXCHANGE_API_TIMEOUT_MS) });
                if (!resp.ok) continue;
                const data = await resp.json();
                const parsed = api.parser(data);
                if (this._isValidRate(parsed.rate)) {
                    const rawRate = Number(parsed.rate);
                    const adjustedRate = Number((rawRate - CONSTANTS.EXCHANGE_RATE_ADJUST).toFixed(4));
                    const fetchedAt = new Date().toISOString();
                    console.log(`[汇率] 从 ${api.name} 获取: ${rawRate}, 调整后: ${adjustedRate}`);
                    return {
                        base: 'USD',
                        quote: 'CNY',
                        rawRate,
                        adjustment: -CONSTANTS.EXCHANGE_RATE_ADJUST,
                        adjustedRate,
                        provider: api.name,
                        source: api.name,
                        sourceEndpoint: api.url,
                        publishedAt: this._toIso(parsed.publishedAt),
                        fetchedAt,
                        nextUpdateAt: this._toIso(parsed.nextUpdateAt),
                        cached: false,
                        stale: false
                    };
                }
            } catch (error) {
                this._lastFetchError = error;
            }
        }
        return null;
    },

    _rateMeta(result) {
        return {
            base: result.base,
            quote: result.quote,
            source: result.source,
            sourceEndpoint: result.sourceEndpoint || null,
            provider: result.provider,
            publishedAt: result.publishedAt,
            fetchedAt: result.fetchedAt,
            nextUpdateAt: result.nextUpdateAt,
            scheduledRefreshAt: result.scheduledRefreshAt || result.nextUpdateAt,
            systemNextCheckAt: result.systemNextCheckAt || result.scheduledRefreshAt || result.nextUpdateAt,
            updateTime: result.fetchedAt,
            rawRate: result.rawRate,
            adjustment: result.adjustment,
            adjustedRate: result.adjustedRate,
            effectiveRate: result.adjustedRate,
            cached: result.cached,
            stale: result.stale,
            isAuto: true,
            note: `市场参考汇率 ${result.rawRate} - ${CONSTANTS.EXCHANGE_RATE_ADJUST.toFixed(2)} = ${result.adjustedRate}`
        };
    },

    _markBusinessRateUnavailable(message) {
        if (!DB._businessAPI) return null;
        const retryAt = new Date(Date.now() + CONSTANTS.EXCHANGE_FAILURE_RETRY_MS).toISOString();
        for (const cid of this._liveRateCompanyIds()) {
            const previous = DB.liveRateMetas?.[cid] || DB.rateMetas?.[cid] || {};
            DB.liveRateMetas[cid] = {
                ...previous,
                stale: true,
                cached: Boolean(DB.liveExchangeRates?.[cid]),
                fallback: !DB.liveExchangeRates?.[cid],
                error: message,
                nextUpdateAt: retryAt,
                scheduledRefreshAt: retryAt,
                systemNextCheckAt: retryAt
            };
        }
        DB._overlayLiveExchangeData?.();
        return retryAt;
    },

    _effectiveRefreshAt(result) {
        const providerNext = result.nextUpdateAt ? new Date(result.nextUpdateAt).getTime() : NaN;
        if (result.stale && (!Number.isFinite(providerNext) || providerNext <= Date.now())) {
            return new Date(Date.now() + CONSTANTS.EXCHANGE_FAILURE_RETRY_MS).toISOString();
        }
        return result.nextUpdateAt;
    },

    /** 获取实时美元汇率。BusinessAPI 模式应用到所有 CNY 结算法人。 */
    async fetchRate({ recalculate = true, updateDisplay = true } = {}) {
        const result = await this._fetchRawRate();
        if (!result) {
            const diagnostic = this._lastFetchError?.message || '所有汇率源均不可用';
            const error = `实时汇率不可用：${diagnostic}`;
            const retryAt = this._markBusinessRateUnavailable(error);
            if (this._autoRefreshEnabled && retryAt) this._scheduleBusinessRefresh(retryAt);
            if (updateDisplay) this.updateDisplay();
            return { success: false, error, stale: true, nextUpdateAt: retryAt };
        }

        const scheduledRefreshAt = this._effectiveRefreshAt(result);
        const runtimeResult = { ...result, scheduledRefreshAt, systemNextCheckAt: scheduledRefreshAt };
        const meta = this._rateMeta(runtimeResult);
        if (DB._businessAPI) {
            DB.liveExchangeRates ||= {};
            DB.liveRateMetas ||= {};
            for (const cid of this._liveRateCompanyIds()) {
                DB.liveExchangeRates[cid] = result.adjustedRate;
                DB.liveRateMetas[cid] = { ...meta };
                // 兼容仍直接读取这两个对象的旧模块；BusinessAPI 不会持久化这些运行时覆盖。
                DB.exchangeRates[cid] = result.adjustedRate;
                DB.rateMetas[cid] = { ...meta };
            }
        } else {
            meta.source = '实时汇率';
            DB.exchangeRates[DB.currentCompanyId] = result.adjustedRate;
            DB.rateMetas[DB.currentCompanyId] = { ...meta };
        }

        this._lastAutoRefresh = Date.now();
        this._lastRateResult = { ...runtimeResult };
        this._nextRefreshAt = scheduledRefreshAt;
        if (recalculate) this.recalcAllOrders({ persist: !DB._businessAPI });
        if (updateDisplay) this.updateDisplay();
        if (DB._businessAPI && this._autoRefreshEnabled) this._scheduleBusinessRefresh(scheduledRefreshAt);
        return { success: true, rate: result.adjustedRate, ...runtimeResult };
    },

    /** 获取汇率并应用到所有国内公司（旧 CloudBase 定时刷新兼容）。 */
    async _autoRefreshAll() {
        if (DB._businessAPI) return this.fetchRate();
        const result = await this._fetchRawRate();
        if (!result) {
            console.warn('[汇率] 自动刷新失败：所有汇率源均不可用');
            return { success: false, error: '所有汇率源均不可用' };
        }
        const meta = this._rateMeta(result);
        meta.source = '自动刷新';
        for (const cid of CONSTANTS.COMPANY_DOMESTIC) {
            DB.exchangeRates[cid] = result.adjustedRate;
            DB.rateMetas[cid] = { ...meta };
        }
        this._lastAutoRefresh = Date.now();
        this.recalcAllOrders();
        this.updateDisplay();
        return { success: true, rate: result.adjustedRate, ...result };
    },

    /** 启动检查：BusinessAPI 以 nextUpdateAt 判断，旧模式保留一小时兼容策略。 */
    async autoFetchIfStale() {
        if (DB._businessAPI) {
            const ids = this._liveRateCompanyIds();
            const firstId = ids[0];
            const hasRuntimeRate = ids.length > 0 && ids.every(cid => this._isValidRate(DB.liveExchangeRates?.[cid]));
            const meta = firstId ? DB.getRateMeta(firstId) : {};
            const effectiveNext = meta.systemNextCheckAt || meta.scheduledRefreshAt || meta.nextUpdateAt;
            const next = effectiveNext ? new Date(effectiveNext).getTime() : NaN;
            if (!hasRuntimeRate || (Number.isFinite(next) && Date.now() >= next)) return this.fetchRate();
            return {
                ...meta,
                success: true,
                rate: firstId ? DB.getExchangeRate(firstId) : null,
                cached: true,
                stale: meta.stale === true,
                nextUpdateAt: meta.nextUpdateAt || null,
                scheduledRefreshAt: effectiveNext || null,
                systemNextCheckAt: effectiveNext || null
            };
        }
        const meta = DB.getRateMeta();
        const lastUpdate = meta.updateTime ? new Date(meta.updateTime) : null;
        if (!lastUpdate || Date.now() - lastUpdate.getTime() > CONSTANTS.ONE_HOUR_MS) return this.fetchRate();
        return { success: true, cached: true };
    },

    // ==================== 定时自动刷新 ====================

    _autoRefreshTimer: null,
    _autoRefreshEnabled: false,
    _lastAutoRefresh: null,
    _nextRefreshAt: null,
    _lastFetchError: null,
    _lastRateResult: null,

    _scheduleBusinessRefresh(nextUpdateAt) {
        if (this._autoRefreshTimer) clearTimeout(this._autoRefreshTimer);
        this._autoRefreshTimer = null;
        this._nextRefreshAt = this._toIso(nextUpdateAt);
        if (!this._autoRefreshEnabled || !this._nextRefreshAt) return;

        const due = new Date(this._nextRefreshAt).getTime();
        const remaining = due - Date.now();
        const delay = Math.min(
            CONSTANTS.MAX_TIMER_DELAY_MS,
            Math.max(CONSTANTS.EXCHANGE_REFRESH_MIN_DELAY_MS, remaining)
        );
        this._autoRefreshTimer = setTimeout(async () => {
            this._autoRefreshTimer = null;
            if (!this._autoRefreshEnabled) return;
            // 超长 setTimeout 分段唤醒时，只重排定时器，不请求接口。
            if (Date.now() < due) {
                this._scheduleBusinessRefresh(this._nextRefreshAt);
                return;
            }
            await this._autoRefreshAll();
        }, delay);
    },

    /** BusinessAPI 按供应商下次发布时间唤醒；旧 CloudBase 保留每小时刷新。 */
    startAutoRefresh({ skipInitial = false } = {}) {
        this.stopAutoRefresh();
        this._autoRefreshEnabled = true;

        if (DB._businessAPI) {
            const firstId = this._liveRateCompanyIds()[0];
            if (skipInitial) {
                const meta = firstId ? DB.getRateMeta(firstId) : {};
                this._scheduleBusinessRefresh(meta.systemNextCheckAt || meta.scheduledRefreshAt || meta.nextUpdateAt);
                return;
            }
            this.autoFetchIfStale().then(result => {
                if (this._autoRefreshEnabled) {
                    this._scheduleBusinessRefresh(
                        result?.systemNextCheckAt || result?.scheduledRefreshAt || result?.nextUpdateAt
                    );
                }
            });
            return;
        }

        console.log('[汇率] 启动定时自动刷新 (每1小时)');
        this.autoFetchIfStale().then(result => {
            if (result && !result.cached) console.log('[汇率] 启动时自动获取完成');
        });
        this._autoRefreshTimer = setInterval(() => this._autoRefreshAll(), CONSTANTS.ONE_HOUR_MS);
        this._lastAutoRefresh = Date.now();
    },

    stopAutoRefresh() {
        this._autoRefreshEnabled = false;
        if (this._autoRefreshTimer) {
            clearTimeout(this._autoRefreshTimer);
            this._autoRefreshTimer = null;
            console.log('[汇率] 已停止定时自动刷新');
        }
        this._nextRefreshAt = null;
    },

    isAutoRefreshActive() {
        return this._autoRefreshEnabled || Boolean(this._autoRefreshTimer);
    },

    getNextRefreshTime() {
        if (!this.isAutoRefreshActive()) return null;
        if (DB._businessAPI) return this._nextRefreshAt;
        if (!this._lastAutoRefresh) return null;
        return new Date(this._lastAutoRefresh + CONSTANTS.ONE_HOUR_MS).toISOString();
    },

    /** 更新汇率显示 UI */
    updateDisplay() {
        if (window.App) window.App.updateExchangeRateDisplay();
    }
};

export { Exchange };

window.Exchange = Exchange;
