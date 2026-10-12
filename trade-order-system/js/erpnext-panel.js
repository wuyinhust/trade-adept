import { DB } from './data.js';
import { Auth } from './auth.js';
import { App } from './app.js';
import { escapeHtml, toast } from './utils.js';

const stateLabels = {
    pending: '等待同步',
    running: '正在同步',
    synced: 'ERP 单据已同步',
    failed: '同步失败，可重试',
    blocked: '需要处理映射或冲突'
};

async function request(path, body) {
    const response = await fetch(path, {
        method: body ? 'POST' : 'GET',
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'ERPNext 请求失败');
    return result;
}

const ERPNextPanel = {
    async render(target = 'workspaceERPNext') {
        const element = typeof target === 'string' ? document.getElementById(target) : target;
        if (!element) return;
        try {
            const result = await request('/api/erpnext/status');
            const orders = DB.data.orders.filter(order => !order.deleted);
            const canQueue = Auth.hasCapability('finance.write') === true;
            const jobs = new Map();
            for (const job of result.jobs || []) {
                if (!jobs.has(job.orderId)) jobs.set(job.orderId, job);
            }
            element.innerHTML = `
                <div class="card"><div class="card-header"><span class="card-title">ERPNext 业务同步</span></div><div class="card-body">
                <p>${result.enabled ? `ERPNext 连接已配置 · ${escapeHtml(result.site || '')}` : '尚未连接 ERPNext'}</p>
                <p class="text-sm text-gray">明确的商品、采购明细与法人映射完成后，可由财务角色将已保存订单同步为 ERP 销售单和采购单草稿。ERP 草稿不代表已出运或已收款。</p>
                <div class="table-responsive"><table class="table"><thead><tr><th>业务单号</th><th>同步状态</th><th>说明</th><th>操作</th></tr></thead><tbody>
                ${
                    orders
                        .map(order => {
                            const job = jobs.get(order.id);
                            return `<tr><td>${escapeHtml(order.companyOperationNo || order.id)}</td><td>${escapeHtml(job ? stateLabels[job.state] || job.state : '尚未同步')}</td><td>${escapeHtml(job?.message || (job ? `来源版本 ${job.sourceVersion}` : ''))}</td><td>${canQueue ? `<button type="button" class="btn btn-secondary btn-sm" data-erp-mapping="${escapeHtml(order.id)}">商品明细</button> ${result.enabled ? `<button type="button" class="btn btn-secondary btn-sm" data-erp-order="${escapeHtml(order.id)}">加入同步队列</button>` : ''}` : '—'}</td></tr>`;
                        })
                        .join('') || '<tr><td colspan="4">暂无订单</td></tr>'
                }
                </tbody></table></div>
                ${(result.documents || []).length ? `<p class="text-sm text-gray">上次确认的 ERP 单据：${result.documents.map(doc => `${escapeHtml(doc.doctype)} ${escapeHtml(doc.name)}（${Number(doc.docstatus) === 1 ? '已提交' : Number(doc.docstatus) === 2 ? '已取消' : '草稿'}）`).join(' · ')}</p>` : ''}
                <button class="btn btn-secondary btn-sm" type="button" data-erp-refresh>刷新同步状态</button></div></div>`;
            element.querySelector('[data-erp-refresh]')?.addEventListener('click', () => this.render(element));
            for (const button of element.querySelectorAll('[data-erp-mapping]')) {
                button.addEventListener('click', () => this.editMapping(button.dataset.erpMapping, element));
            }
            for (const button of element.querySelectorAll('[data-erp-order]')) {
                button.addEventListener('click', () => {
                    App.showConfirm(
                        '将此订单的已保存明细加入 ERPNext 同步队列？该操作会在隔离 ERP 中创建草稿。',
                        async () => {
                            if (!(await DB.flush())) return;
                            button.disabled = true;
                            try {
                                const response = await request('/api/erpnext/queue', {
                                    orderId: button.dataset.erpOrder,
                                    expectedVersion: DB._cloudVersion
                                });
                                const job = response.job;
                                toast(
                                    job.state === 'blocked' ? job.message || '请先配置明确映射' : '订单已加入同步队列',
                                    job.state === 'blocked' ? 'warning' : 'success'
                                );
                                await this.render(element);
                            } catch (error) {
                                toast(error.message, 'error');
                                button.disabled = false;
                            }
                        }
                    );
                });
            }
        } catch (error) {
            element.innerHTML = `<p class="text-sm text-gray">${escapeHtml(error.message)}</p>`;
        }
    },

    editMapping(orderId, parent) {
        if (Auth.hasCapability('finance.write') !== true) return;
        const order = DB.data.orders.find(item => item.id === orderId && !item.deleted);
        if (!order) return;
        const factories = DB.data.factories.filter(factory => !factory.deleted);
        const lines = (order.erpItems || []).map(line => ({ ...line }));
        const newLine = () => ({
            id: crypto.randomUUID(),
            itemCode: '',
            quantity: '',
            saleRate: '',
            purchaseRate: '',
            factoryId: ''
        });
        if (!lines.length) lines.push(newLine());
        App.showModal(
            `ERP 商品明细 · ${escapeHtml(order.companyOperationNo || order.id)}`,
            `<form id="erpMappingForm"><p class="text-sm text-gray">商品编码必须是 ERPNext 中已有的真实编码。数量与单价明确填写，销售合计应等于订单金额，采购合计应等于订单成本。每行保留独立标识。</p><div class="table-responsive"><table class="table"><thead><tr><th>商品编码</th><th>数量</th><th>销售单价</th><th>采购单价</th><th>供应商</th><th></th></tr></thead><tbody id="erpMappingRows"></tbody></table></div><button type="button" class="btn btn-secondary btn-sm" id="addERPMappingLine">添加明细</button><p class="text-sm text-gray" id="erpMappingTotals"></p></form>`,
            {
                large: true,
                footer: '<button type="button" class="btn btn-secondary" id="cancelERPMapping">取消</button><button type="submit" form="erpMappingForm" class="btn btn-primary" id="saveERPMapping">保存明细</button>'
            }
        );
        const form = document.getElementById('erpMappingForm');
        const readLines = () =>
            [...form.querySelectorAll('[data-erp-line]')].map(row => {
                const read = key => row.querySelector(`[data-erp-field="${key}"]`).value;
                return {
                    id: row.dataset.erpLine,
                    itemCode: read('itemCode').trim(),
                    quantity: read('quantity'),
                    saleRate: read('saleRate'),
                    purchaseRate: read('purchaseRate'),
                    factoryId: read('factoryId')
                };
            });
        const totals = () => {
            const entries = readLines();
            const sales = entries.reduce((sum, line) => sum + Number(line.quantity) * Number(line.saleRate), 0);
            const purchase = entries.reduce((sum, line) => sum + Number(line.quantity) * Number(line.purchaseRate), 0);
            form.querySelector('#erpMappingTotals').textContent =
                `明细销售合计 ${sales.toFixed(2)} · 明细采购合计 ${purchase.toFixed(2)} · 已存订单金额 ${Number(order.orderAmountUSD).toFixed(2)} · 已存订单成本 ${Number(order.factoryCostUSD ?? order.factoryCostRMB).toFixed(2)}`;
        };
        const draw = () => {
            form.querySelector('#erpMappingRows').innerHTML = lines
                .map(
                    line =>
                        `<tr data-erp-line="${escapeHtml(line.id)}"><td><input aria-label="商品编码" class="form-input" data-erp-field="itemCode" required value="${escapeHtml(line.itemCode)}"></td><td><input aria-label="商品数量" class="form-input" type="number" step="any" min="0.000001" data-erp-field="quantity" required value="${escapeHtml(String(line.quantity))}"></td><td><input aria-label="销售单价" class="form-input" type="number" step="any" min="0" data-erp-field="saleRate" required value="${escapeHtml(String(line.saleRate))}"></td><td><input aria-label="采购单价" class="form-input" type="number" step="any" min="0" data-erp-field="purchaseRate" required value="${escapeHtml(String(line.purchaseRate))}"></td><td><select aria-label="商品供应商" class="form-select" data-erp-field="factoryId" required><option value="">选择供应商</option>${factories.map(factory => `<option value="${escapeHtml(factory.id)}" ${factory.id === line.factoryId ? 'selected' : ''}>${escapeHtml(factory.name)}</option>`).join('')}</select></td><td><button aria-label="移除商品明细" type="button" class="btn btn-secondary btn-sm" data-erp-remove="${escapeHtml(line.id)}">移除</button></td></tr>`
                )
                .join('');
            for (const button of form.querySelectorAll('[data-erp-remove]')) {
                button.onclick = () => {
                    const updated = readLines().filter(line => line.id !== button.dataset.erpRemove);
                    lines.splice(0, lines.length, ...updated);
                    draw();
                };
            }
            totals();
        };
        draw();
        form.addEventListener('input', totals);
        form.querySelector('#addERPMappingLine').onclick = () => {
            lines.splice(0, lines.length, ...readLines(), newLine());
            draw();
        };
        document.getElementById('cancelERPMapping').onclick = () => App.closeModal();
        form.onsubmit = async event => {
            event.preventDefault();
            const entries = readLines().map(line => ({
                ...line,
                quantity: Number(line.quantity),
                saleRate: Number(line.saleRate),
                purchaseRate: Number(line.purchaseRate)
            }));
            if (
                !entries.length ||
                entries.some(
                    line =>
                        !line.itemCode ||
                        !line.factoryId ||
                        !Number.isFinite(line.quantity) ||
                        line.quantity <= 0 ||
                        !Number.isFinite(line.saleRate) ||
                        line.saleRate < 0 ||
                        !Number.isFinite(line.purchaseRate) ||
                        line.purchaseRate < 0
                )
            ) {
                return toast('请完整填写有效的商品明细', 'warning');
            }
            const sales = entries.reduce((sum, line) => sum + line.quantity * line.saleRate, 0);
            const purchase = entries.reduce((sum, line) => sum + line.quantity * line.purchaseRate, 0);
            if (
                Math.abs(sales - Number(order.orderAmountUSD)) > 0.005 ||
                Math.abs(purchase - Number(order.factoryCostUSD ?? order.factoryCostRMB)) > 0.005
            ) {
                return toast('明细合计与已保存订单金额或成本不一致', 'warning');
            }
            const button = document.getElementById('saveERPMapping');
            button.disabled = true;
            if (!DB.updateOrder(orderId, { erpItems: entries }) || !(await DB.flush())) {
                button.disabled = false;
                return;
            }
            App.closeModal();
            toast('ERP 商品明细已保存', 'success');
            await this.render(parent);
        };
    }
};

export { ERPNextPanel };
