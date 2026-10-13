import { DB } from './data.js';
import { Auth } from './auth.js';
import { App } from './app.js';
import { escapeHtml, toast } from './utils.js';
import { ItemCatalog } from './item-catalog.js';

const stages = { legacy: '历史参考', brief: '待完善订单', native: '正式订单' };
const documentTypes = {
    'Sales Order': '销售订单',
    'Purchase Order': '采购订单',
    'Payment Entry': '收付款凭证',
    'Delivery Note': '发货单',
    'Sales Invoice': '销售发票',
    'Purchase Invoice': '采购发票'
};
const documentState = status => (Number(status) === 1 ? '已提交' : Number(status) === 2 ? '已取消' : '草稿');
const api = () => window.Workspace.api;
const companyFor = order => DB.companies.find(company => String(company.id) === String(order.companyId));
const nativeSales = order => (order.nativeDocuments || []).find(doc => doc.doctype === 'Sales Order');

export function summarizeBusinessItems(lines, { currency, usdToCny }) {
    if (!['CNY', 'USD'].includes(currency)) throw new Error('当前商品采购支持 CNY 与 USD，请核对企业结算币种');
    let salesUSD = 0;
    let purchaseBase = 0;
    for (const line of lines) {
        const quantity = Number(line.quantity);
        const saleRate = Number(line.saleRate);
        const purchaseRate = Number(line.purchaseRate);
        const purchaseCurrency = line.purchaseCurrency || currency;
        if (!['CNY', 'USD'].includes(purchaseCurrency)) throw new Error('请使用明确的 CNY 或 USD 采购币种');
        if (
            ![quantity, saleRate, purchaseRate].every(Number.isFinite) ||
            quantity < 0 ||
            saleRate < 0 ||
            purchaseRate < 0
        ) {
            throw new Error('请填写有效的数量与单价');
        }
        let conversion = 1;
        if (purchaseCurrency !== currency) {
            const rate = Number(usdToCny);
            if (!Number.isFinite(rate) || rate <= 0) throw new Error('跨币种采购需要有效的 USD → CNY 配置汇率');
            conversion = currency === 'CNY' ? rate : 1 / rate;
        }
        salesUSD += quantity * saleRate;
        purchaseBase += quantity * purchaseRate * conversion;
    }
    return { salesUSD, purchaseBase, currency };
}

const BusinessBackendPanel = {
    _requests: new Map(),

    async render(target = 'workspaceBusinessBackend') {
        const element = typeof target === 'string' ? document.getElementById(target) : target;
        if (!element) return;
        try {
            const result = await api().backendStatus();
            const states = new Map((result.orders || []).map(order => [String(order.orderId), order]));
            const canWrite = Auth.hasCapability('finance.write') === true;
            const canCatalog = ['catalog.read', 'catalog.create', 'catalog.write', 'catalog.disable'].some(cap => Auth.hasCapability(cap) === true);
            element.innerHTML = `<div class="card"><div class="card-header"><span class="card-title">业务数据</span>${canCatalog ? '<button type="button" class="btn btn-secondary btn-sm" data-business-catalog>商品目录</button>' : ''}</div><div class="card-body">
                <p>订单、采购和收款保存在当前企业的业务数据库。</p>
                <p class="text-sm text-gray">可先建订单，后补商品明细。正式订单的金额和收款由业务单据计算；历史参考保留原始 Excel 数据，不生成收款记录。</p>
                <div class="table-responsive"><table class="table"><thead><tr><th>业务单号</th><th>记录类型</th><th>业务单据</th><th>操作</th></tr></thead><tbody>${
                    DB.data.orders
                        .filter(order => !order.deleted)
                        .map(order => {
                            const status = states.get(String(order.id)) || order;
                            const stage = status.stage || order.stage;
                            const documents = status.documents || order.nativeDocuments || [];
                            const sales = documents.find(doc => doc.doctype === 'Sales Order');
                            const detail = documents
                                .map(
                                    doc =>
                                        `${escapeHtml(documentTypes[doc.doctype] || doc.doctype)} ${escapeHtml(doc.name)}（${documentState(doc.docstatus)}）`
                                )
                                .join('<br>');
                            const actions = [];
                            if (canWrite && stage === 'brief' && result.capabilities?.convertOrder) {
                                actions.push(
                                    `<button type="button" class="btn btn-secondary btn-sm" data-business-items="${escapeHtml(order.id)}">商品明细</button>`
                                );
                                actions.push(
                                    `<button type="button" class="btn btn-secondary btn-sm" data-business-convert="${escapeHtml(order.id)}">建立正式订单</button>`
                                );
                            }
                            if (
                                canWrite &&
                                stage === 'native' &&
                                Number(sales?.docstatus) === 0 &&
                                result.capabilities?.submitOrder
                            ) {
                                actions.push(
                                    `<button type="button" class="btn btn-secondary btn-sm" data-business-submit="${escapeHtml(order.id)}">提交订单</button>`
                                );
                            }
                            if (
                                canWrite &&
                                stage === 'native' &&
                                Number(sales?.docstatus) === 1 &&
                                result.capabilities?.receivePayment &&
                                !order.nativeHasPostedSalesInvoices
                            ) {
                                actions.push(
                                    `<button type="button" class="btn btn-secondary btn-sm" data-business-payment="${escapeHtml(order.id)}">登记订单预收款</button>`
                                );
                            }
                            if (canWrite && order.nativeHasPostedSalesInvoices) {
                                actions.push('<a class="btn btn-secondary btn-sm" href="#/finance">到账单登记收付款</a>');
                            }
                            if (
                                canWrite &&
                                stage === 'native' &&
                                Number(sales?.docstatus) === 1 &&
                                result.capabilities?.cancelOrder
                            ) {
                                actions.push(
                                    `<button type="button" class="btn btn-secondary btn-sm" data-business-cancel="${escapeHtml(order.id)}">撤销正式订单</button>`
                                );
                            }
                            return `<tr><td>${escapeHtml(order.companyOperationNo || order.id)}</td><td>${escapeHtml(stages[stage] || '读取中')}</td><td>${detail || (stage === 'legacy' ? '原始数据与余额参考' : '完善明细后建立业务单据')}${this.settlementHtml(order)}</td><td>${actions.join(' ') || '—'}</td></tr>`;
                        })
                        .join('') || '<tr><td colspan="4">暂无订单</td></tr>'
                }</tbody></table></div><button class="btn btn-secondary btn-sm" type="button" data-business-refresh>刷新业务数据</button></div></div>`;
            element.querySelector('[data-business-refresh]')?.addEventListener('click', async () => {
                try {
                    await DB._initFromBusinessAPI();
                    await this.render(element);
                } catch (error) {
                    this.handleFailure(error);
                }
            });
            for (const button of element.querySelectorAll('[data-business-items]')) {
                button.addEventListener('click', () => this.editItems(button.dataset.businessItems, element));
            }
            element.querySelector('[data-business-catalog]')?.addEventListener('click', () =>
                ItemCatalog.open(DB.currentCompanyId, async () => {
                    await DB._initFromBusinessAPI();
                    await this.render(element);
                })
            );
            for (const button of element.querySelectorAll(
                '[data-business-convert], [data-business-submit], [data-business-cancel]'
            )) {
                const action = button.hasAttribute('data-business-convert')
                    ? 'convert'
                    : button.hasAttribute('data-business-cancel')
                      ? 'cancel'
                      : 'submit';
                const orderId =
                    button.dataset.businessConvert || button.dataset.businessSubmit || button.dataset.businessCancel;
                button.addEventListener('click', () => {
                    App.showConfirm(
                        action === 'convert'
                            ? '根据已保存的真实商品明细建立销售、采购订单草稿？'
                            : action === 'cancel'
                              ? '撤销正式销售、采购订单？已有收款、发货或发票时，需先完成对应业务处理。此操作会保留撤销记录。'
                              : '提交此订单及采购单据？提交后金额由业务单据维护，收款需单独登记。',
                        () => this.runAction(action, orderId, element, button)
                    );
                });
            }
            for (const button of element.querySelectorAll('[data-business-payment]')) {
                button.addEventListener('click', () => this.receivePayment(button.dataset.businessPayment, element));
            }
        } catch (error) {
            element.innerHTML = `<div class="card"><div class="card-body"><p>${escapeHtml(error.message)}</p><p class="text-sm text-gray">当前草稿保留在本机；连接恢复后再保存。</p></div></div>`;
        }
    },

    handleFailure(error) {
        if (error.code === 'CONFLICT') DB._handleSaveFailure(error);
        else toast(error.message || '业务操作失败', 'error');
    },

    settlementHtml(order) {
        if (!order.nativeSettlementProjection || Auth.hasCapability('finance.read') !== true) return '';
        const money = (value, currency) => value == null ? '—' : `${currency || '—'} ${Number(value).toFixed(2)}`;
        const currency = order.nativeSettlementCurrency || companyFor(order)?.settlementCurrency;
        const parts = [
            ['订单预收', order.salesAdvanceAmountUSD, 'USD'],
            ['销售账单已核销（含抵账）', order.salesInvoiceSettledAmountUSD, 'USD'],
            ['销售账单未结清', order.salesInvoiceOutstandingAmountUSD, 'USD'],
            ['采购预付', order.factoryAdvanceAmount, currency],
            ['采购账单已核销（含抵账）', order.factoryInvoiceSettledAmount, currency],
            ['采购账单未结清', order.factoryInvoiceOutstandingAmount, currency]
        ].filter(([, value]) => value != null);
        const receipts = order.nativeReceiptSummary || [];
        return `<details class="text-sm"><summary>结算与银行凭证</summary>${parts.map(([label, value, unit]) => `<div>${escapeHtml(label)}：${escapeHtml(money(value, unit))}</div>`).join('')}${receipts.map(row => `<div>${escapeHtml(row.name)} · ${escapeHtml(row.paymentType === 'Receive' ? '银行净收' : row.paymentType === 'Pay' ? '银行净付' : '账户划转')} ${escapeHtml(money(row.bankAmount, row.bankCurrency))} · 未分配 ${escapeHtml(money(row.unallocatedAmount, row.unallocatedCurrency))}</div>`).join('')}${receipts.length ? '<p class="text-gray">凭证金额可能关联多个订单；此处仅供核对，不按订单重复汇总。解除发票核销后，银行款仍保留。</p>' : ''}</details>`;
    },

    async refreshAfterAction(parent) {
        await DB._initFromBusinessAPI();
        App.updateSaveStatus('saved');
        if (parent?.isConnected) await this.render(parent);
        else await App.router();
    },

    async runAction(action, orderId, parent, button) {
        if (!['convert', 'submit', 'cancel'].includes(action)) return;
        if (Auth.hasCapability('finance.write') !== true) return;
        const order = DB.data.orders.find(item => String(item.id) === String(orderId) && !item.deleted);
        if (!order || (action === 'convert' ? order.stage !== 'brief' : order.stage !== 'native')) return;
        if (!(await DB.flush())) return;
        if (button) button.disabled = true;
        const requestKey = `${action}:${orderId}`;
        if (!this._requests.has(requestKey)) this._requests.set(requestKey, crypto.randomUUID());
        try {
            const method = { convert: 'convertOrder', submit: 'submitOrder', cancel: 'cancelOrder' }[action];
            await api()[method](orderId, {
                expectedVersion: DB._cloudVersion,
                idempotencyKey: this._requests.get(requestKey)
            });
            await this.refreshAfterAction(parent);
            this._requests.delete(requestKey);
            toast(
                action === 'convert' ? '正式订单草稿已建立' : action === 'cancel' ? '正式订单已撤销' : '订单已提交',
                'success'
            );
        } catch (error) {
            this.handleFailure(error);
            if (button) button.disabled = false;
        }
    },

    editItems(orderId, parent) {
        if (Auth.hasCapability('finance.write') !== true) return;
        const order = DB.data.orders.find(item => item.id === orderId && !item.deleted);
        if (!order || order.stage !== 'brief') return;
        const currency = companyFor(order)?.settlementCurrency || 'CNY';
        const factories = DB.data.factories.filter(
            factory => !factory.deleted && String(factory.companyId) === String(order.companyId)
        );
        const lines = (order.erpItems || []).map(line => ({ ...line }));
        const newLine = () => ({
            id: crypto.randomUUID(),
            itemCode: '',
            quantity: '',
            saleRate: '',
            purchaseRate: '',
            factoryId: '',
            purchaseCurrency: currency
        });
        if (!lines.length) lines.push(newLine());
        App.showModal(
            `商品明细 · ${escapeHtml(order.companyOperationNo || order.id)}`,
            `<form id="businessItemsForm"><p class="text-sm text-gray">使用企业商品目录中的真实编码。销售币种 USD，采购可选 CNY 或 USD，按当前企业配置汇率折算为 ${escapeHtml(currency)} 核对成本。缺少商品时可先保留待完善订单。</p><div class="table-responsive"><table class="table"><thead><tr><th>商品编码</th><th>数量</th><th>销售单价 (USD)</th><th>采购单价</th><th>采购币种</th><th>供应商</th><th></th></tr></thead><tbody id="businessItemsRows"></tbody></table></div><button type="button" class="btn btn-secondary btn-sm" id="addBusinessItem">添加明细</button><p class="text-sm text-gray" id="businessItemsTotals"></p></form>`,
            {
                large: true,
                footer: '<button type="button" class="btn btn-secondary" id="cancelBusinessItems">取消</button><button type="submit" form="businessItemsForm" class="btn btn-primary" id="saveBusinessItems">保存明细</button>'
            }
        );
        const form = document.getElementById('businessItemsForm');
        const readLines = () =>
            [...form.querySelectorAll('[data-business-line]')].map(row => {
                const read = key => row.querySelector(`[data-business-field="${key}"]`).value;
                return {
                    id: row.dataset.businessLine,
                    itemCode: read('itemCode').trim(),
                    quantity: read('quantity'),
                    saleRate: read('saleRate'),
                    purchaseRate: read('purchaseRate'),
                    factoryId: read('factoryId'),
                    purchaseCurrency: read('purchaseCurrency')
                };
            });
        const totals = () => {
            const entries = readLines();
            try {
                const summary = summarizeBusinessItems(entries, {
                    currency,
                    usdToCny: DB.exchangeRates[order.companyId]
                });
                form.querySelector('#businessItemsTotals').textContent =
                    `销售合计 USD ${summary.salesUSD.toFixed(2)} · 采购成本折合 ${currency} ${summary.purchaseBase.toFixed(2)} · 当前订单金额 USD ${Number(order.orderAmountUSD).toFixed(2)} · 当前采购成本 ${currency} ${Number(order.factoryCostUSD ?? order.factoryCostRMB ?? 0).toFixed(2)}`;
            } catch (error) {
                form.querySelector('#businessItemsTotals').textContent = error.message;
            }
        };
        const draw = () => {
            form.querySelector('#businessItemsRows').innerHTML = lines
                .map(
                    line =>
                        `<tr data-business-line="${escapeHtml(line.id)}"><td><input aria-label="商品编码" class="form-input" data-business-field="itemCode" required value="${escapeHtml(line.itemCode)}"></td><td><input aria-label="商品数量" class="form-input" type="number" step="any" min="0.000001" data-business-field="quantity" required value="${escapeHtml(String(line.quantity))}"></td><td><input aria-label="销售单价" class="form-input" type="number" step="any" min="0" data-business-field="saleRate" required value="${escapeHtml(String(line.saleRate))}"></td><td><input aria-label="采购单价" class="form-input" type="number" step="any" min="0" data-business-field="purchaseRate" required value="${escapeHtml(String(line.purchaseRate))}"></td><td><select aria-label="采购币种" class="form-select" data-business-field="purchaseCurrency" required>${line.purchaseCurrency && !['CNY', 'USD'].includes(line.purchaseCurrency) ? `<option value="${escapeHtml(line.purchaseCurrency)}" selected>${escapeHtml(line.purchaseCurrency)}（暂不支持）</option>` : ''}${['CNY', 'USD'].map(code => `<option value="${code}" ${code === (line.purchaseCurrency || currency) ? 'selected' : ''}>${code}</option>`).join('')}</select></td><td><select aria-label="商品供应商" class="form-select" data-business-field="factoryId" required><option value="">选择供应商</option>${factories.map(factory => `<option value="${escapeHtml(factory.id)}" ${factory.id === line.factoryId ? 'selected' : ''}>${escapeHtml(factory.name)}</option>`).join('')}</select></td><td><button aria-label="移除商品明细" type="button" class="btn btn-secondary btn-sm" data-business-remove="${escapeHtml(line.id)}">移除</button></td></tr>`
                )
                .join('');
            for (const button of form.querySelectorAll('[data-business-remove]')) {
                button.onclick = () => {
                    lines.splice(
                        0,
                        lines.length,
                        ...readLines().filter(line => line.id !== button.dataset.businessRemove)
                    );
                    draw();
                };
            }
            totals();
        };
        draw();
        form.addEventListener('input', totals);
        form.querySelector('#addBusinessItem').onclick = () => {
            lines.splice(0, lines.length, ...readLines(), newLine());
            draw();
        };
        document.getElementById('cancelBusinessItems').onclick = () => App.closeModal();
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
            let summary;
            try {
                summary = summarizeBusinessItems(entries, { currency, usdToCny: DB.exchangeRates[order.companyId] });
            } catch (error) {
                return toast(error.message, 'warning');
            }
            if (
                Math.abs(summary.salesUSD - Number(order.orderAmountUSD)) > 0.005 ||
                Math.abs(summary.purchaseBase - Number(order.factoryCostUSD ?? order.factoryCostRMB ?? 0)) > 0.005
            ) {
                return toast('明细合计与订单金额或采购成本不一致，请先核对订单', 'warning');
            }
            const button = document.getElementById('saveBusinessItems');
            button.disabled = true;
            if (!DB.updateOrder(orderId, { erpItems: entries }) || !(await DB.flush())) {
                button.disabled = false;
                return;
            }
            App.closeModal();
            toast('商品明细已保存', 'success');
            if (parent?.isConnected) await this.render(parent);
        };
    },

    receivePayment(orderId, parent) {
        if (Auth.hasCapability('finance.write') !== true) return;
        if (Auth.hasCapability('finance.payment_entry.create') !== true ||
            Auth.hasCapability('finance.payment_entry.submit') !== true) {
            toast('登记订单预收款需要收付款单创建和提交权限，请由管理员配置。', 'info');
            return;
        }
        const order = DB.data.orders.find(item => String(item.id) === String(orderId) && !item.deleted);
        if (!order || order.stage !== 'native' || Number(nativeSales(order)?.docstatus) !== 1) {
            return toast('请先提交正式订单，再登记实际收款', 'warning');
        }
        if (order.nativeHasPostedSalesInvoices) {
            return toast('此订单已开票，请在应收与应付账单中登记款项，避免重复登记订单预收。', 'info');
        }
        const remaining = Number(order.orderAmountUSD || 0) - Number(order.paidAmountUSD || 0);
        if (remaining <= 0) return toast('此订单已无待收余额', 'info');
        App.showModal(
            `登记收款 · ${escapeHtml(order.companyOperationNo || order.id)}`,
            `<form id="businessReceiptForm"><p class="text-sm text-gray">待收 USD ${remaining.toFixed(2)}。确认后保存实际收款单据，余额将重新计算。</p><div class="form-group"><label class="form-label" for="receiptAmount">本次收款 (USD)</label><input id="receiptAmount" class="form-input" name="amountUSD" type="number" min="0.01" max="${remaining}" step="0.01" required value="${remaining.toFixed(2)}"></div><div class="form-group"><label class="form-label" for="receiptReference">银行流水号</label><input id="receiptReference" class="form-input" name="referenceNo" required autocomplete="off"></div><div class="form-group"><label class="form-label" for="receiptDate">收款日期</label><input id="receiptDate" class="form-input" name="referenceDate" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div><div class="form-group"><label class="form-label" for="receiptBank">收款账户</label><input id="receiptBank" class="form-input" name="bankAccount" placeholder="留空使用企业默认收款账户"><p class="text-sm text-gray">填写企业已配置的业务账户名称。</p></div></form>`,
            {
                footer: '<button type="button" class="btn btn-secondary" id="cancelBusinessReceipt">取消</button><button type="submit" form="businessReceiptForm" class="btn btn-primary" id="saveBusinessReceipt">确认实际收款</button>'
            }
        );
        const form = document.getElementById('businessReceiptForm');
        const idempotencyKey = crypto.randomUUID();
        let pending = null;
        document.getElementById('cancelBusinessReceipt').onclick = () => App.closeModal();
        form.onsubmit = async event => {
            event.preventDefault();
            const input = new FormData(form);
            const details = {
                amountUSD: Number(input.get('amountUSD')),
                referenceNo: String(input.get('referenceNo') || '').trim(),
                referenceDate: String(input.get('referenceDate') || ''),
                bankAccount: String(input.get('bankAccount') || '').trim()
            };
            if (
                !Number.isFinite(details.amountUSD) ||
                details.amountUSD <= 0 ||
                details.amountUSD > remaining ||
                !details.referenceNo ||
                !details.referenceDate
            ) {
                return toast('请填写有效的实际收款金额、流水号和日期', 'warning');
            }
            if (pending && JSON.stringify(details) !== JSON.stringify(pending)) {
                return toast('此收款请求已发送，请保留相同信息重试，或先核对收款记录', 'warning');
            }
            if (!(await DB.flush())) return;
            pending = details;
            const button = document.getElementById('saveBusinessReceipt');
            button.disabled = true;
            try {
                await api().receivePayment(orderId, { ...details, idempotencyKey, expectedVersion: DB._cloudVersion });
                App.closeModal();
                await this.refreshAfterAction(parent);
                toast('实际收款已登记，余额已刷新', 'success');
            } catch (error) {
                this.handleFailure(error);
                button.disabled = false;
            }
        };
    }
};

// Keep this module URL stable for previously loaded workspace assets.
export { BusinessBackendPanel };
