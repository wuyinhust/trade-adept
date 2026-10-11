import { DB } from './data.js';
import { Auth } from './auth.js';
import { App } from './app.js';
import { escapeHtml, toast } from './utils.js';

const Settings = {
    async render() {
        const canRates = Auth.hasCapability('rates.write') === true;
        const canSnapshots = Auth.hasCapability('snapshots.read') === true;
        document.getElementById('pageContent').innerHTML = `
            <div class="card mb-6"><div class="card-header"><span class="card-title">企业工作区</span></div><div class="card-body">
                <p>当前企业：${escapeHtml(Auth.currentUser?.tenantId || '')} · 数据库版本 ${DB._cloudVersion}</p>
                <p class="text-sm text-gray">账号与角色由管理员在服务器配置。法人主体属于当前企业，记录与历史按企业隔离。</p>
                <div class="table-responsive"><table class="table"><thead><tr><th>法人主体</th><th>结算币种</th><th>USD → CNY 汇率</th></tr></thead><tbody>
                ${DB.companies.map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.settlementCurrency || '')}</td><td>${canRates ? `<input class="form-input" aria-label="${escapeHtml(c.name)} 汇率" data-rate-company="${escapeHtml(c.id)}" type="number" min="0.000001" step="0.000001" value="${Number(DB.getExchangeRate(c.id))}">` : Number(DB.getExchangeRate(c.id))}</td></tr>`).join('')}
                </tbody></table></div>
                ${canRates ? '<button class="btn btn-primary" id="saveWorkspaceRates">保存汇率</button><p class="text-sm text-gray">修改配置用于后续计算；不会自动改写历史订单利润。</p>' : ''}
            </div></div>
            ${canSnapshots ? '<div class="card"><div class="card-header"><span class="card-title">业务快照</span></div><div class="card-body" id="workspaceSnapshots">正在读取…</div></div>' : ''}`;
        document.getElementById('saveWorkspaceRates')?.addEventListener('click', async () => {
            const inputs = [...document.querySelectorAll('[data-rate-company]')];
            if (inputs.some(input => !Number.isFinite(Number(input.value)) || Number(input.value) <= 0)) {
                return toast('汇率必须为有效正数', 'warning');
            }
            for (const input of inputs) {
                const id = input.dataset.rateCompany;
                if (Number(input.value) === DB.exchangeRates[id]) continue;
                DB.exchangeRates[id] = Number(input.value);
                DB.rateMetas[id] = { source: '人工配置', updateTime: new Date().toISOString(), isAuto: false };
            }
            if (await DB.flush()) {
                toast('汇率已保存', 'success');
                App.updateExchangeRateDisplay();
            }
        });
        if (canSnapshots) await this.renderSnapshots();
    },

    async renderSnapshots() {
        const result = await window.Workspace.api.listSnapshots();
        const snapshots = Array.isArray(result) ? result : result.snapshots || [];
        const target = document.getElementById('workspaceSnapshots');
        if (!target) return;
        target.innerHTML = `<div class="table-responsive"><table class="table"><thead><tr><th>版本</th><th>时间</th><th>原因</th><th>操作</th></tr></thead><tbody>${snapshots.map(s => `<tr><td>${s.version ?? s.revision}</td><td>${escapeHtml(s.createdAt || s.updatedAt || s.created_at || '')}</td><td>${escapeHtml(s.reason || s.kind || '')}</td><td>${Auth.hasCapability('snapshots.restore') === true ? `<button class="btn btn-secondary" data-restore-snapshot="${escapeHtml(String(s.id))}">恢复此版本</button>` : '只读'}</td></tr>`).join('')}</tbody></table></div><p class="text-sm text-gray">恢复会创建新的数据库版本并保留历史，不会恢复账号或权限配置。</p>`;
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
export { Settings };
