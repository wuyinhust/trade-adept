import { DB } from './data.js';
import { Auth } from './auth.js';
import { App } from './app.js';
import { escapeHtml, toast } from './utils.js';
import { BusinessBackendPanel } from './erpnext-panel.js';

const RATE_PLACEHOLDER = '—';

function formatRate(value) {
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0 ? rate.toFixed(4) : RATE_PLACEHOLDER;
}

function formatDateTime(value, emptyText = '未提供') {
    if (!value) return emptyText;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return emptyText;
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(date);
}

function rateState(rate) {
    if (rate.stale) {
        return {
            label: '缓存已过期',
            badge: 'badge-warning',
            message: '供应商尚未发布新版本或上游暂不可用，系统保留最近一次成功汇率，并会在允许的检查时间自动重试。'
        };
    }
    if (rate.cached) {
        return {
            label: '缓存有效',
            badge: 'badge-success',
            message: '当前发布版本仍然有效，本次检查直接读取服务端缓存，没有重复请求上游。'
        };
    }
    return {
        label: '已获取最新发布',
        badge: 'badge-primary',
        message: '本次检查取得了新的发布汇率；在预计更新时间之前，后续检查会直接复用缓存。'
    };
}

function normalizeLiveRate(result) {
    if (!result || result.success === false) {
        throw new Error(result?.error || '实时汇率暂时不可用');
    }
    const current = typeof DB.getRateMeta === 'function' ? DB.getRateMeta() : {};
    const rate = { ...current, ...result };
    const rawRate = Number(rate.rawRate);
    const adjustedRate = Number(rate.adjustedRate ?? rate.effectiveRate ?? rate.rate);
    if (!Number.isFinite(rawRate) || rawRate <= 0 || !Number.isFinite(adjustedRate) || adjustedRate <= 0) {
        throw new Error('实时汇率响应缺少有效价格');
    }
    return { ...rate, rawRate, adjustedRate };
}

function formatProviderSchedule(rate) {
    if (!rate.nextUpdateAt) return '等待供应商公布';
    const schedule = new Date(rate.nextUpdateAt);
    const past = !Number.isNaN(schedule.getTime()) && schedule.getTime() <= Date.now();
    const suffix = rate.stale && past ? '（已过，等待新发布）' : '';
    return formatDateTime(rate.nextUpdateAt, '等待供应商公布') + suffix;
}

const Settings = {
    _lastLiveRate: null,
    _rateRequest: null,
    _liveRateTimer: null,

    async render() {
        if (this._liveRateTimer) clearTimeout(this._liveRateTimer);
        this._liveRateTimer = null;
        this._lastLiveRate = null;
        const canSnapshots = Auth.hasCapability('snapshots.read') === true;
        document.getElementById('pageContent').innerHTML = `
            <section class="card live-rate-card mb-6" aria-labelledby="liveRateTitle">
                <div class="card-header live-rate-header">
                    <div class="live-rate-heading">
                        <span class="live-rate-kicker">实时汇率</span>
                        <h2 class="card-title" id="liveRateTitle">USD → CNY</h2>
                    </div>
                    <div class="live-rate-header-actions">
                        <span class="badge badge-default" id="liveRateStateBadge" role="status" aria-live="polite">正在读取</span>
                        <button class="btn btn-secondary btn-sm" id="checkLiveRate" type="button" aria-describedby="liveRatePolicy">检查更新</button>
                    </div>
                </div>
                <div class="card-body" id="workspaceLiveRate" aria-busy="true">
                    ${this.renderLiveRateLoading()}
                </div>
            </section>
            <section class="card mb-6" aria-labelledby="workspaceCompanyTitle"><div class="card-header"><span class="card-title" id="workspaceCompanyTitle">企业工作区</span></div><div class="card-body">
                <p>当前企业：${escapeHtml(Auth.currentUser?.tenantId || '')} · 数据库版本 ${DB._cloudVersion}</p>
                <p class="text-sm text-gray">账号与角色由管理员配置。法人主体属于当前企业，记录与历史按企业隔离。</p>
                <div class="table-responsive"><table class="table"><thead><tr><th>法人主体</th><th>结算币种</th><th>汇率规则</th></tr></thead><tbody>
                ${DB.companies.map(company => this.renderCompanyRateRow(company)).join('')}
                </tbody></table></div>
                <p class="text-sm text-gray workspace-rate-policy">USD → CNY 由实时接口统一提供，不在工作区内手工覆盖。新汇率用于后续业务计算，已保存的历史订单金额不会追溯改写。</p>
            </div></section>
            <div id="workspaceBusinessBackend" class="mb-6"></div>
            ${canSnapshots ? '<div class="card"><div class="card-header"><span class="card-title">业务快照</span></div><div class="card-body" id="workspaceSnapshots">正在读取…</div></div>' : ''}`;

        document.getElementById('checkLiveRate')?.addEventListener('click', () => {
            void this.loadLiveRate({ announce: true });
        });

        const tasks = [this.loadLiveRate(), BusinessBackendPanel.render()];
        if (canSnapshots) tasks.push(this.renderSnapshots());
        await Promise.all(tasks);
    },

    renderCompanyRateRow(company) {
        const settlementCurrency = company.settlementCurrency || '';
        const usesCnyRate = settlementCurrency === 'CNY';
        const rule = usesCnyRate
            ? `<strong data-company-live-rate="${escapeHtml(company.id)}">${RATE_PLACEHOLDER}</strong><span class="text-sm text-gray"> · 实时 USD → CNY</span>`
            : `<span>${escapeHtml(settlementCurrency || '当前币种')} 结算，无需 USD → CNY 换算</span>`;
        return `<tr><td>${escapeHtml(company.name)}</td><td>${escapeHtml(settlementCurrency)}</td><td class="workspace-company-rate">${rule}</td></tr>`;
    },

    renderLiveRateLoading() {
        return `<div class="live-rate-overview" aria-hidden="true">
            <div class="live-rate-primary"><span class="live-rate-label">系统有效汇率</span><strong class="live-rate-value">${RATE_PLACEHOLDER}</strong><span class="live-rate-caption">正在读取实时汇率…</span></div>
            <div class="live-rate-reference"><span class="live-rate-label">市场参考价</span><strong class="live-rate-reference-value">${RATE_PLACEHOLDER}</strong></div>
        </div><p class="live-rate-policy" id="liveRatePolicy">系统只在预计更新时间到达后向上游检查一次；其余检查直接读取服务端缓存。</p>`;
    },

    renderLiveRate(rate) {
        const target = document.getElementById('workspaceLiveRate');
        if (!target) return;
        const state = rateState(rate);
        const adjustment = Number(rate.adjustment);
        const adjustmentText = Number.isFinite(adjustment) ? adjustment.toFixed(4) : '-0.0200';
        const provider = rate.provider || 'ExchangeRate-API';
        const source = rate.source ? ` · ${rate.source}` : '';
        target.setAttribute('aria-busy', 'false');
        target.dataset.rateLastResult = rate.stale ? 'stale' : rate.cached ? 'cached' : 'fresh';
        target.innerHTML = `
            <div class="live-rate-overview">
                <div class="live-rate-primary">
                    <span class="live-rate-label">系统有效汇率</span>
                    <strong class="live-rate-value" data-live-rate-effective>${formatRate(rate.adjustedRate ?? rate.effectiveRate ?? rate.rate)}</strong>
                    <span class="live-rate-caption">1 USD = <span data-live-rate-effective-caption>${formatRate(rate.adjustedRate ?? rate.effectiveRate ?? rate.rate)}</span> CNY</span>
                </div>
                <div class="live-rate-reference">
                    <span class="live-rate-label">市场参考价</span>
                    <strong class="live-rate-reference-value" data-live-rate-raw>${formatRate(rate.rawRate)}</strong>
                    <span class="live-rate-caption">业务调整 ${escapeHtml(adjustmentText)} 后作为系统有效汇率</span>
                </div>
            </div>
            <dl class="live-rate-details">
                <div class="live-rate-detail"><dt>行情发布时间</dt><dd>${escapeHtml(formatDateTime(rate.publishedAt, '数据源未提供精确时间'))}</dd></div>
                <div class="live-rate-detail"><dt>系统获取时间</dt><dd>${escapeHtml(formatDateTime(rate.fetchedAt))}</dd></div>
                <div class="live-rate-detail"><dt>供应商预计发布时间</dt><dd>${escapeHtml(formatProviderSchedule(rate))}</dd></div>
                <div class="live-rate-detail"><dt>系统下次检查</dt><dd>${escapeHtml(formatDateTime(rate.systemNextCheckAt ?? rate.scheduledRefreshAt, rate.stale ? '服务端退避调度中' : '等待供应商公布'))}</dd></div>
                <div class="live-rate-detail"><dt>数据源</dt><dd><a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(provider)} 数据源说明">Rates By Exchange Rate API</a>${escapeHtml(source)}</dd></div>
                <div class="live-rate-detail"><dt>缓存状态</dt><dd>${escapeHtml(state.label)}</dd></div>
            </dl>
            <div class="live-rate-state ${rate.stale ? 'is-stale' : ''}">
                <span class="live-rate-state-dot" aria-hidden="true"></span>
                <p>${escapeHtml(state.message)}</p>
            </div>
            <p class="live-rate-policy" id="liveRatePolicy">系统只在预计更新时间到达后向上游检查一次；其余检查直接读取服务端缓存，因此无需频繁点击。</p>`;

        const badge = document.getElementById('liveRateStateBadge');
        if (badge) {
            badge.className = `badge ${state.badge}`;
            badge.textContent = state.label;
        }
        const effectiveRate = Number(rate.adjustedRate ?? rate.effectiveRate ?? rate.rate);
        if (Number.isFinite(effectiveRate) && effectiveRate > 0) {
            for (const element of document.querySelectorAll('[data-company-live-rate]')) {
                element.textContent = effectiveRate.toFixed(4);
            }
        }
    },

    renderLiveRateError(error) {
        const target = document.getElementById('workspaceLiveRate');
        if (!target) return;
        target.setAttribute('aria-busy', 'false');
        const message = error?.message || '实时汇率暂时不可用';
        if (!this._lastLiveRate) {
            target.dataset.rateLastResult = 'error';
            target.innerHTML = `<div class="live-rate-error" role="alert"><strong>暂时无法读取实时汇率</strong><p>${escapeHtml(message)}</p><p class="text-sm text-gray">系统不会用手工汇率覆盖。请稍后使用“检查更新”重试。</p></div><p class="live-rate-policy" id="liveRatePolicy">检查更新由服务端限频；未到下一次更新时间时只读取缓存。</p>`;
        } else {
            target.dataset.rateLastResult = 'error';
            target.querySelector('.live-rate-state')?.classList.add('is-error');
            const notice = target.querySelector('.live-rate-state p');
            if (notice) notice.textContent = `检查失败：${message}。页面继续保留上一次成功读取的汇率。`;
        }
        const badge = document.getElementById('liveRateStateBadge');
        if (badge) {
            badge.className = 'badge badge-danger';
            badge.textContent = '读取失败';
        }
    },

    scheduleLiveRateCheck(rate) {
        if (this._liveRateTimer) clearTimeout(this._liveRateTimer);
        this._liveRateTimer = null;
        const nextCheck = new Date(rate.systemNextCheckAt ?? rate.scheduledRefreshAt ?? rate.nextUpdateAt).getTime();
        if (!Number.isFinite(nextCheck) || nextCheck <= Date.now()) return;
        const delay = Math.min(nextCheck - Date.now(), 2_147_000_000);
        this._liveRateTimer = setTimeout(() => {
            this._liveRateTimer = null;
            if (document.getElementById('workspaceLiveRate')) void this.loadLiveRate();
        }, delay);
    },

    async loadLiveRate({ announce = false } = {}) {
        if (this._rateRequest) return this._rateRequest;
        const button = document.getElementById('checkLiveRate');
        const badge = document.getElementById('liveRateStateBadge');
        if (button) {
            button.disabled = true;
            button.textContent = '检查中…';
        }
        if (badge && this._lastLiveRate) badge.textContent = '正在检查';

        this._rateRequest = (async () => {
            try {
                const result =
                    typeof DB.fetchExchangeRate === 'function'
                        ? await DB.fetchExchangeRate()
                        : await window.Workspace.api.getExchangeRate();
                const rate = normalizeLiveRate(result);
                this._lastLiveRate = rate;
                this.renderLiveRate(rate);
                this.scheduleLiveRateCheck(rate);
                if (typeof App.updateExchangeRateDisplay === 'function') App.updateExchangeRateDisplay();
                if (announce) {
                    if (rate.stale) toast('供应商尚未发布新版本，已继续使用最近一次缓存汇率', 'warning');
                    else if (rate.cached) toast('尚未到下一次更新时间，当前有效缓存已是最新版本', 'info');
                    else toast('已获取最新发布的汇率', 'success');
                }
                return rate;
            } catch (error) {
                this.renderLiveRateError(error);
                if (announce) toast(error?.message || '实时汇率检查失败', 'error');
                return null;
            } finally {
                this._rateRequest = null;
                if (button?.isConnected) {
                    button.disabled = false;
                    button.textContent = '检查更新';
                }
            }
        })();
        return this._rateRequest;
    },

    async renderSnapshots() {
        const result = await window.Workspace.api.listSnapshots();
        const snapshots = Array.isArray(result) ? result : result.snapshots || [];
        const target = document.getElementById('workspaceSnapshots');
        if (!target) return;
        target.innerHTML = `<div class="table-responsive"><table class="table"><thead><tr><th>版本</th><th>时间</th><th>原因</th><th>操作</th></tr></thead><tbody>${snapshots.map(s => `<tr><td>${s.version ?? s.revision}</td><td>${escapeHtml(s.createdAt || s.updatedAt || s.created_at || '')}</td><td>${escapeHtml(s.reason || s.kind || '')}</td><td>${Auth.hasCapability('snapshots.restore') === true ? `<button class="btn btn-secondary" data-restore-snapshot="${escapeHtml(String(s.id))}">恢复此版本</button>` : '只读'}</td></tr>`).join('')}</tbody></table></div><p class="text-sm text-gray">恢复会创建新的业务版本并保留历史，不会恢复账号或权限。已提交订单、收款和账务记录保护期间，恢复操作将被阻止。</p>`;
        for (const button of target.querySelectorAll('[data-restore-snapshot]')) {
            button.onclick = async () => {
                const api = window.Workspace.api;
                if (DB._saveConflict || api.hasChanges(DB.data, DB.exchangeRates, DB.rateMetas)) {
                    return toast('请先保存或处理当前草稿', 'warning');
                }
                const expectedVersion = DB._cloudVersion;
                App.showConfirm(
                    '将当前企业业务数据恢复为所选快照，并创建新版本？此操作会改变当前业务记录。',
                    async () => {
                        try {
                            await api.restore(button.dataset.restoreSnapshot, { expectedVersion });
                            await DB._initFromBusinessAPI();
                            await this.render();
                            App.updateSaveStatus('saved');
                            toast('快照已恢复，新版本已保存', 'success');
                        } catch (e) {
                            DB._handleSaveFailure(e);
                        }
                    }
                );
            };
        }
    }
};

window.Settings = Settings;
export { Settings, formatDateTime, formatRate, normalizeLiveRate, rateState };
