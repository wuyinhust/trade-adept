/**
 * 客户管理模块
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';
import { escapeHtml, toast, validate, installBusinessModalHooks, businessDraftScope } from './utils.js';
import { FormDrafts } from './form-drafts.js';

const Customers = {
    selectedCustomers: new Set(),

    attachDraft(recordId = 'new') {
        const form = document.getElementById('customerForm');
        const pendingId = FormDrafts.pendingFor('customerForm', { scope: businessDraftScope(DB, Auth), recordId });
        const sourceId = recordId === 'new' ? pendingId : recordId;
        FormDrafts.attach(form, {
            scope: businessDraftScope(DB, Auth),
            getScope: () => businessDraftScope(DB, Auth),
            recordId,
            pendingExists: id => Boolean(DB.getCustomer(id)),
            getRecord: () => {
                const record = DB.getCustomer(form.dataset.pendingRecordId || sourceId);
                if (!record) return null;
                return Object.fromEntries(
                    ['company', 'companyAddress', 'country', 'paymentTerms', 'contacts'].map(key => [key, record[key]])
                );
            },
            dynamic: {
                capture: options => FormDrafts.contactRows(form, options),
                describe: contacts =>
                    contacts
                        .map(
                            (contact, index) =>
                                `联系人 ${index + 1}：${contact.name}\n职位：${contact.position}\n邮箱：${contact.email}\n电话：${contact.phone}\n手机：${contact.mobilePhone}\n家庭地址：${contact.homeAddress}`
                        )
                        .join('\n\n'),
                restore: contacts => {
                    form.querySelector('#contactsContainer').innerHTML = contacts
                        .map((contact, index) => this.renderContactRow(index, contact))
                        .join('');
                }
            }
        });
    },

    canDeleteCustomer(customer) {
        if (!customer) return false;
        return typeof Auth.canDeleteRecord === 'function'
            ? Auth.canDeleteRecord(customer, 'customers')
            : Auth.canDeleteOrder?.(customer) === true;
    },

    inlineArgument(value) {
        return escapeHtml(JSON.stringify(String(value)));
    },

    render(container, param) {
        if (param) {
            this.renderDetail(container, param);
            return;
        }
        this.selectedCustomers.clear();
        container.innerHTML = `
            <div class="filter-bar">
                <input type="text" id="customerSearchInput" class="filter-input" placeholder="搜索客户名称/联系人/国家/职位..." style="width:300px" oninput="Customers.filter()">
                ${Auth.isManager() || Auth.isSalesperson() ? `<span class="filter-info">👤 当前查看：${Auth.isManager() ? '我团队关联的客户' : '我的客户'}</span>` : ''}
                <div style="margin-left:auto;display:flex;gap:8px">
                    <button class="btn btn-secondary" onclick="Customers.importExcel()">📥 导入</button>
                    <button class="btn btn-secondary" onclick="Customers.exportExcel()">📤 导出</button>
                    <button class="btn btn-primary" onclick="Customers.showAddForm()">➕ 新建客户</button>
                </div>
            </div>
            <div id="customerBatchBar" class="batch-bar">
                <span>已选择 <span class="batch-count" id="batchCount">0</span> 个客户</span>
                ${Auth.canDelete?.() === true ? '<button class="btn btn-sm btn-danger" onclick="Customers.batchDelete()">🗑️ 批量删除</button>' : ''}
                <button class="btn btn-sm btn-secondary" onclick="Customers.clearSelection()">取消选择</button>
            </div>
            <div class="card">
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th class="checkbox-col"><input type="checkbox" id="selectAllCheckbox" onchange="Customers.toggleSelectAll()" title="全选"></th>
                                <th>客户编号</th>
                                <th>公司名称</th>
                                <th>联系人</th>
                                <th>国家</th>
                                <th>职位</th>

                                <th class="text-right">联系人数</th>
                                <th class="text-right">订单数</th>
                                <th class="text-right">交易总额(USD)</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="customersTableBody"></tbody>
                    </table>
                </div>
            </div>
        `;
        this.renderTable();
    },

    /** 获取当前用户可见的客户列表 — 由 DB.getCustomers() 统一过滤 */
    getFilteredCustomers(search = '') {
        return DB.getCustomers({ search });
    },

    filter() {
        const search = document.getElementById('customerSearchInput')?.value || '';
        this.renderTable(search);
    },

    renderTable(search = '') {
        const customers = this.getFilteredCustomers(search);
        for (const id of this.selectedCustomers) {
            if (!this.canDeleteCustomer(DB.getCustomer(id))) this.selectedCustomers.delete(id);
        }
        const tbody = document.getElementById('customersTableBody');
        if (!tbody) return;

        // 同步全选 checkbox 状态
        const selectAll = document.getElementById('selectAllCheckbox');
        if (selectAll) {
            const selectable = customers.filter(c => this.canDeleteCustomer(c));
            const selectedCount = selectable.filter(c => this.selectedCustomers.has(c.id)).length;
            selectAll.disabled = selectable.length === 0;
            selectAll.checked = selectable.length > 0 && selectedCount === selectable.length;
            selectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
        }

        if (customers.length === 0) {
            tbody.innerHTML =
                '<tr><td colspan="12" class="text-center text-gray" style="padding:40px">暂无匹配客户</td></tr>';
            return;
        }

        tbody.innerHTML = customers
            .map(c => {
                const allOrders = DB.getCustomerOrders(c.id);
                const orders = Auth.filterOrders(allOrders);
                const totalAmount = orders.reduce((sum, o) => sum + o.orderAmountUSD, 0);
                const checked = this.selectedCustomers.has(c.id) ? 'checked' : '';
                const contactCount = c.contacts ? c.contacts.length : 1;
                return `
                <tr>
                    <td class="checkbox-col"><input type="checkbox" ${checked} ${this.canDeleteCustomer(c) ? '' : 'disabled'} onchange="Customers.toggleSelect(${this.inlineArgument(c.id)})"></td>
                    <td>${App.escapeHtml(c.id)}</td>
                    <td><span class="table-link" onclick="window.location.hash='#/customers/${App.escapeHtml(c.id)}'">${App.escapeHtml(c.company)}</span></td>
                    <td>${App.escapeHtml(c.contact)}</td>
                    <td>${App.escapeHtml(c.country)}</td>
                    <td>${App.escapeHtml(c.position) || '-'}</td>
                    <td class="text-right font-semi">${contactCount}</td>
                    <td class="text-right font-semi">${orders.length}</td>
                    <td class="text-right font-semi">${App.formatMoney(totalAmount, 'USD')}</td>
                    <td>
                        <div class="flex gap-2">
                            <button class="btn btn-sm btn-secondary" onclick="window.location.hash='#/customers/${App.escapeHtml(c.id)}'">详情</button>
                            <button class="btn btn-sm btn-secondary" onclick="Customers.showEditForm('${App.escapeHtml(c.id)}')">编辑</button>
                            ${this.canDeleteCustomer(c) ? `<button class="btn btn-sm btn-danger" onclick="Customers.deleteCustomer(${this.inlineArgument(c.id)})">删除</button>` : ''}
                        </div>
                    </td>
                </tr>
            `;
            })
            .join('');

        this.updateBatchBar();
    },

    renderDetail(container, customerId) {
        const customer = DB.getCustomer(customerId);
        if (!customer) {
            container.innerHTML =
                '<div class="card"><div class="card-body text-center text-gray">客户不存在</div></div>';
            return;
        }
        const allOrders = DB.getCustomerOrders(customerId);
        const orders = Auth.filterOrders(allOrders);
        const showFinance = Auth.canSeeFinancials();
        const totalAmount = orders.reduce((sum, o) => sum + o.orderAmountUSD, 0);
        const totalPaid = orders.reduce((sum, o) => sum + o.paidAmountUSD, 0);
        const totalProfit = orders.reduce((sum, o) => sum + o.profitRMB, 0);
        const activeOrders = orders.filter(o => o.status === '进行中' || o.status === '已订船');
        const usedCredit = activeOrders.reduce((sum, o) => sum + o.orderAmountUSD - o.paidAmountUSD, 0);

        document.getElementById('pageTitle').textContent = '客户详情 - ' + customer.company;
        const contacts = customer.contacts || [];
        const contactCount = contacts.length;

        container.innerHTML = `
            <div class="flex gap-3 mb-4">
                <button class="btn btn-secondary" onclick="window.location.hash='#/customers'">← 返回列表</button>
                <button class="btn btn-primary" onclick="Customers.showEditForm('${App.escapeHtml(customer.id)}')">✏️ 编辑客户</button>
                <div style="margin-left:auto">
                    ${this.canDeleteCustomer(customer) ? `<button class="btn btn-danger" onclick="Customers.deleteCustomer(${this.inlineArgument(customer.id)})">🗑️ 删除客户</button>` : ''}
                </div>
            </div>

            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon blue">📋</div></div>
                    <div class="stat-label">订单总数</div>
                    <div class="stat-value">${orders.length}</div>
                    <div class="stat-sub">活跃订单 ${activeOrders.length} 单</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon green">💵</div></div>
                    <div class="stat-label">交易总额</div>
                    <div class="stat-value">${App.formatMoney(totalAmount, 'USD')}</div>
                    <div class="stat-sub">已收款 ${App.formatMoney(totalPaid, 'USD')}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon cyan">👥</div></div>
                    <div class="stat-label">联系人</div>
                    <div class="stat-value">${contactCount}</div>
                    <div class="stat-sub">主要联系人：${App.escapeHtml(customer.contact)}</div>
                </div>
                ${
                    showFinance
                        ? `
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon orange">💰</div></div>
                    <div class="stat-label">累计利润</div>
                    <div class="stat-value">${App.formatMoney(totalProfit, 'CNY')}</div>
                    <div class="stat-sub">利润率 ${totalAmount > 0 ? ((totalProfit / (totalAmount * DB.getExchangeRate())) * 100).toFixed(1) : 0}%</div>
                </div>`
                        : `
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon orange">📦</div></div>
                    <div class="stat-label">产品类别</div>
                    <div class="stat-value">${new Set(orders.map(o => o.productCategory)).size || 0}</div>
                    <div class="stat-sub">涉及类别数</div>
                </div>`
                }
            </div>

            <div class="card mb-6">
                <div class="card-header"><span class="card-title">客户信息</span></div>
                <div class="card-body">
                    <div class="detail-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">
                        <div class="detail-item"><div class="detail-label">客户编号</div><div class="detail-value">${App.escapeHtml(customer.id)}</div></div>
                        <div class="detail-item"><div class="detail-label">公司名称</div><div class="detail-value">${App.escapeHtml(customer.company)}</div></div>
                        <div class="detail-item"><div class="detail-label">公司地址</div><div class="detail-value" style="font-size:13px">${App.escapeHtml(customer.companyAddress) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">国家</div><div class="detail-value">${App.escapeHtml(customer.country)}</div></div>
                        <div class="detail-item"><div class="detail-label">主要联系人</div><div class="detail-value">${App.escapeHtml(customer.contact)}</div></div>
                        <div class="detail-item"><div class="detail-label">职位</div><div class="detail-value">${App.escapeHtml(customer.position) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">手机号码</div><div class="detail-value">${App.escapeHtml(customer.mobilePhone) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">家庭地址</div><div class="detail-value" style="font-size:13px">${App.escapeHtml(customer.homeAddress) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">付款条件</div><div class="detail-value" style="font-size:12px">${App.escapeHtml(customer.paymentTerms)}</div></div>
                    </div>
                </div>
            </div>

            <div class="card mb-6">
                <div class="card-header"><span class="card-title">👥 联系人名录 (${contactCount}人)</span></div>
                <div class="table-container">
                    <table>
                        <thead>
                            <tr><th>姓名</th><th>职位</th><th>邮箱</th><th>电话</th><th>手机号码</th><th>家庭地址</th></tr>
                        </thead>
                        <tbody>
                            ${
                                contacts.length > 0
                                    ? contacts
                                          .map(
                                              ct => `
                                <tr>
                                    <td class="font-semi">${App.escapeHtml(ct.name)}</td>
                                    <td>${App.escapeHtml(ct.position) || '-'}</td>
                                    <td class="text-sm">${App.escapeHtml(ct.email) || '-'}</td>
                                    <td class="text-sm">${App.escapeHtml(ct.phone) || '-'}</td>
                                    <td class="text-sm">${App.escapeHtml(ct.mobilePhone) || '-'}</td>
                                    <td class="text-sm">${App.escapeHtml(ct.homeAddress) || '-'}</td>
                                </tr>
                            `
                                          )
                                          .join('')
                                    : '<tr><td colspan="6" class="text-center text-gray" style="padding:30px">暂无联系人信息</td></tr>'
                            }
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="card">
                <div class="card-header"><span class="card-title">历史订单</span></div>
                <div class="table-container">
                    <table>
                        <thead>
                            <tr><th>订单号</th><th>下单日期</th><th>产品</th><th class="text-right">金额(USD)</th><th class="text-right">利润率</th><th>收款状态</th><th>订单状态</th></tr>
                        </thead>
                        <tbody>
                            ${
                                orders.length > 0
                                    ? orders
                                          .map(
                                              o => `
                                <tr>
                                    <td><span class="table-link" onclick="window.location.hash='#/orders/${o.id}'">${o.id}</span></td>
                                    <td>${App.formatDate(o.orderDate)}</td>
                                    <td class="text-sm">${o.productName}</td>
                                    <td class="text-right font-semi">${App.formatMoney(o.orderAmountUSD, 'USD')}</td>
                                    <td class="text-right ${App.getProfitColor(o.profitRate)}">${o.profitRate.toFixed(1)}%</td>
                                    <td>${App.getPaymentBadge(o.paymentStatus)}</td>
                                    <td>${App.getStatusBadge(o.status)}</td>
                                </tr>
                            `
                                          )
                                          .join('')
                                    : '<tr><td colspan="7" class="text-center text-gray" style="padding:30px">暂无订单</td></tr>'
                            }
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    },

    showAddForm() {
        const pendingId = FormDrafts.pendingFor('customerForm', {
            scope: businessDraftScope(DB, Auth),
            recordId: 'new'
        });
        if (pendingId && DB.getCustomer(pendingId)) {
            this.showEditForm(pendingId, { draftRecordId: 'new' });
            return;
        }
        const bodyHtml = `
            <form id="customerForm" onsubmit="Customers.saveCustomer(event); return false;">
                <div class="form-section-title">📋 公司信息</div>
                <div class="form-group">
                    <label class="form-label">公司名称 <span class="required">*</span></label>
                    <input type="text" class="form-input" name="company" required placeholder="例：Global Trade Solutions LLC">
                </div>
                <div class="form-group">
                    <label class="form-label">公司地址 <span class="required">*</span></label>
                    <input type="text" class="form-input" name="companyAddress" required placeholder="例：350 Fifth Avenue, Suite 1200, New York, NY 10118, USA">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">国家</label>
                        <input type="text" class="form-input" name="country" placeholder="例：美国">
                    </div>
                    <div class="form-group">
                        <label class="form-label">付款条件</label>
                        <select class="form-select" name="paymentTerms">
                            <option value="30% T/T advance, 70% before shipment">30% T/T advance, 70% before shipment</option>
                            <option value="L/C at sight">L/C at sight</option>
                            <option value="T/T 30 days">T/T 30 days</option>
                            <option value="T/T 45 days">T/T 45 days</option>
                            <option value="T/T 60 days">T/T 60 days</option>
                            <option value="100% T/T advance">100% T/T advance</option>
                            <option value="50% advance, 50% before shipment">50% advance, 50% before shipment</option>
                            <option value="L/C 60 days">L/C 60 days</option>
                            <option value="30% T/T, 70% against B/L copy">30% T/T, 70% against B/L copy</option>
                        </select>
                    </div>
                </div>
                <div class="form-section-title">👤 联系人名录 <button type="button" class="btn btn-sm btn-primary" onclick="Customers.addContactRow()" style="float:right">+ 添加联系人</button></div>
                <div id="contactsContainer">
                    ${this.renderContactRow(0, { name: '', position: '', email: '', phone: '', mobilePhone: '', homeAddress: '' })}
                </div>
            </form>
        `;
        App.showModal('新建客户', bodyHtml, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal({discardDraft:true})">取消</button><button class="btn btn-primary" onclick="document.getElementById('customerForm').requestSubmit()">💾 保存</button>`,
            large: true
        });
        this.attachDraft();
    },

    showEditForm(customerId, { draftRecordId = customerId } = {}) {
        const c = DB.getCustomer(customerId);
        if (!c) return;
        const contacts = c.contacts || [];
        const paymentTermsOptions = [
            '30% T/T advance, 70% before shipment',
            'L/C at sight',
            'T/T 30 days',
            'T/T 45 days',
            'T/T 60 days',
            '100% T/T advance',
            '50% advance, 50% before shipment',
            'L/C 60 days',
            '30% T/T, 70% against B/L copy'
        ];
        const termsHtml = paymentTermsOptions
            .map(t => `<option value="${t}" ${c.paymentTerms === t ? 'selected' : ''}>${t}</option>`)
            .join('');

        const contactsHtml =
            contacts.length > 0
                ? contacts.map((ct, i) => this.renderContactRow(i, ct)).join('')
                : this.renderContactRow(0, {
                      name: '',
                      position: '',
                      email: '',
                      phone: '',
                      mobilePhone: '',
                      homeAddress: ''
                  });

        const bodyHtml = `
            <form id="customerForm" onsubmit="Customers.saveCustomer(event${draftRecordId === 'new' ? '' : ', ' + this.inlineArgument(customerId)}); return false;">
                <div class="form-section-title">📋 公司信息</div>
                <div class="form-group">
                    <label class="form-label">公司名称 <span class="required">*</span></label>
                    <input type="text" class="form-input" name="company" required value="${escapeHtml(c.company)}">
                </div>
                <div class="form-group">
                    <label class="form-label">公司地址 <span class="required">*</span></label>
                    <input type="text" class="form-input" name="companyAddress" required value="${escapeHtml(c.companyAddress || '')}" placeholder="例：350 Fifth Avenue, Suite 1200, New York, NY 10118, USA">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">国家</label>
                        <input type="text" class="form-input" name="country" value="${escapeHtml(c.country)}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">付款条件</label>
                        <select class="form-select" name="paymentTerms">${termsHtml}</select>
                    </div>
                </div>
                <div class="form-section-title">👤 联系人名录 <button type="button" class="btn btn-sm btn-primary" onclick="Customers.addContactRow()" style="float:right">+ 添加联系人</button></div>
                <div id="contactsContainer">
                    ${contactsHtml}
                </div>
            </form>
        `;
        App.showModal('编辑客户 - ' + c.company, bodyHtml, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal({discardDraft:true})">取消</button><button class="btn btn-primary" onclick="document.getElementById('customerForm').requestSubmit()">💾 保存修改</button>`,
            large: true
        });
        this.attachDraft(draftRecordId);
    },

    async saveCustomer(event, customerId = null) {
        event.preventDefault();
        const form = event.target;
        if (form.dataset.saving === 'true') return;
        if (!FormDrafts.canSubmit(event.target)) return;

        if (!DB._cloudReady) {
            App.toast('⚠️ 云端未连接，请检查网络后刷新重试', 'error');
            return;
        }

        const fd = new FormData(event.target);
        const pendingId = customerId || event.target.dataset.pendingRecordId || null;
        const contacts = this.collectContacts();

        // 主要联系人为 contacts 第一项
        const primary = contacts.length > 0 ? contacts[0] : null;
        const data = {
            company: fd.get('company'),
            companyAddress: fd.get('companyAddress'),
            contact: primary ? primary.name : '',
            country: fd.get('country'),
            position: primary ? primary.position : '',
            mobilePhone: primary ? primary.mobilePhone : '',
            homeAddress: primary ? primary.homeAddress : '',

            paymentTerms: fd.get('paymentTerms'),
            contacts: contacts
        };
        if (pendingId) {
            const updated = DB.updateCustomer(pendingId, data);
            if (!updated) {
                App.toast('⚠️ 客户不存在，无法更新', 'error');
                return;
            }
        } else {
            const newCustomer = DB.addCustomer(data);
            if (!newCustomer) {
                App.toast('⚠️ 客户创建失败，请检查必填字段', 'error');
                return;
            }
            event.target.dataset.pendingRecordId = newCustomer.id;
        }

        FormDrafts.stageRecord(event.target);
        form.dataset.saving = 'true';
        let ok = false;
        try {
            ok = await DB.flush();
        } catch {
            /* Keep the staged record and all form input for retry. */
        } finally {
            form.dataset.saving = 'false';
        }
        if (!ok) {
            App.toast('⚠️ 保存到云端失败，请稍后重试', 'error');
            return;
        }

        if (!FormDrafts.acknowledgeStaged(form)) {
            App.toast('上一版已保存，当前新输入尚未保存，请再次保存', 'warning');
            return;
        }
        App.toast(customerId ? '客户信息已更新' : '客户创建成功');
        App.closeModal();
        if (customerId) {
            this.renderDetail(document.getElementById('pageContent'), customerId);
        } else {
            this.renderTable();
        }
    },

    async deleteCustomer(id) {
        const customer = DB.getCustomer(id);
        if (!customer) return;
        if (!this.canDeleteCustomer(customer)) {
            App.toast('当前账号无权删除此客户', 'warning');
            return;
        }
        const orders = DB.getCustomerOrders(id);
        const warnMsg =
            orders.length > 0
                ? `<p style="margin-bottom:8px">确定要删除客户 <strong>${escapeHtml(customer.company)}</strong> 吗？</p><p style="color:var(--danger);font-size:13px">⚠️ 该客户关联了 <strong>${orders.length}</strong> 笔订单，删除客户后这些订单仍会保留，但客户信息将无法查看。</p>`
                : `<p>确定要删除客户 <strong>${escapeHtml(customer.company)}</strong> 吗？此操作不可恢复。</p>`;

        App.showConfirm(warnMsg, async () => {
            if (!this.canDeleteCustomer(DB.getCustomer(id)) || !DB.deleteCustomer(id)) {
                App.toast('客户未删除，请检查权限或刷新数据', 'warning');
                return;
            }
            const ok = await DB.flush();
            if (!ok) {
                App.toast('⚠️ 删除保存失败，请刷新页面重试', 'error');
                return;
            }
            this.selectedCustomers.delete(id);
            App.toast('客户已删除');
            App.closeModal();
            // 判断当前是在列表页还是详情页
            if (window.location.hash === '#/customers/' + id) {
                window.location.hash = '#/customers';
            } else {
                const search = document.getElementById('customerSearchInput')?.value || '';
                this.renderTable(search);
            }
        });
    },

    // ==================== 多选功能 ====================

    toggleSelectAll() {
        const selectAll = document.getElementById('selectAllCheckbox');
        const customers = this.getFilteredCustomers(document.getElementById('customerSearchInput')?.value || '').filter(
            c => this.canDeleteCustomer(c)
        );
        if (selectAll.checked) {
            customers.forEach(c => this.selectedCustomers.add(c.id));
        } else {
            customers.forEach(c => this.selectedCustomers.delete(c.id));
        }
        this.renderTable(document.getElementById('customerSearchInput')?.value || '');
    },

    toggleSelect(id) {
        if (!this.canDeleteCustomer(DB.getCustomer(id))) return;
        if (this.selectedCustomers.has(id)) {
            this.selectedCustomers.delete(id);
        } else {
            this.selectedCustomers.add(id);
        }
        const selectAll = document.getElementById('selectAllCheckbox');
        const customers = this.getFilteredCustomers(document.getElementById('customerSearchInput')?.value || '').filter(
            c => this.canDeleteCustomer(c)
        );
        if (selectAll) {
            const selectedCount = customers.filter(c => this.selectedCustomers.has(c.id)).length;
            selectAll.checked = customers.length > 0 && selectedCount === customers.length;
            selectAll.indeterminate = selectedCount > 0 && selectedCount < customers.length;
        }
        this.updateBatchBar();
    },

    updateBatchBar() {
        const bar = document.getElementById('customerBatchBar');
        const count = document.getElementById('batchCount');
        if (bar && count) {
            bar.classList.toggle('visible', this.selectedCustomers.size > 0);
            count.textContent = this.selectedCustomers.size;
        }
    },

    clearSelection() {
        this.selectedCustomers.clear();
        this.renderTable(document.getElementById('customerSearchInput')?.value || '');
    },

    async batchDelete() {
        if (this.selectedCustomers.size === 0) return;
        const ids = [...this.selectedCustomers];
        const allowed = ids.filter(id => this.canDeleteCustomer(DB.getCustomer(id)));
        if (allowed.length === 0) {
            App.toast('所选客户均无删除权限', 'warning');
            return;
        }
        const totalOrders = allowed.reduce((sum, id) => sum + DB.getCustomerOrders(id).length, 0);
        const warnMsg =
            totalOrders > 0
                ? `<p style="margin-bottom:8px">确定要批量删除 <strong>${allowed.length}</strong> 个客户吗？</p><p style="color:var(--danger);font-size:13px">⚠️ 这些客户共关联了 <strong>${totalOrders}</strong> 笔订单，删除后订单仍会保留，但客户信息将无法查看。此操作不可恢复！</p>`
                : `<p>确定要批量删除 <strong>${allowed.length}</strong> 个客户吗？无权限的客户将跳过。此操作不可恢复。</p>`;

        App.showConfirm(warnMsg, async () => {
            let skipped = 0;
            const deleted = ids.filter(id => {
                if (!this.canDeleteCustomer(DB.getCustomer(id))) {
                    skipped++;
                    return false;
                }
                return DB.deleteCustomer(id) === true;
            });
            if (!deleted.length) {
                App.toast('没有客户被删除，请检查权限或刷新数据', 'warning');
                return;
            }
            const ok = await DB.flush();
            if (!ok) {
                App.toast('⚠️ 批量删除保存失败，请刷新页面重试', 'error');
                return;
            }
            deleted.forEach(id => this.selectedCustomers.delete(id));
            App.toast(`已删除 ${deleted.length} 个客户${skipped ? `，跳过 ${skipped} 个无权限客户` : ''}`);
            App.closeModal();
            const search = document.getElementById('customerSearchInput')?.value || '';
            this.renderTable(search);
        });
    },

    // ==================== 联系人管理 ====================

    renderContactRow(index, ct = {}) {
        const esc = s => App.escapeHtml(String(s || ''));
        return `
            <div class="contact-card" id="contactRow${index}" data-contact-id="${esc(ct.id)}">
                <div class="contact-card-header">
                    <span class="contact-card-title">联系人 #${index + 1}</span>
                    <button type="button" class="btn btn-sm btn-danger" onclick="Customers.removeContactRow(${index})">✕ 删除</button>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">姓名 <span class="required">*</span></label>
                        <input type="text" class="form-input contact-name" name="contact_name_${index}" value="${esc(ct.name || '')}" required placeholder="例：John Smith">
                    </div>
                    <div class="form-group">
                        <label class="form-label">职位 <span class="required">*</span></label>
                        <input type="text" class="form-input contact-position" name="contact_position_${index}" value="${esc(ct.position || '')}" required placeholder="例：采购总监">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">邮箱 <span class="required">*</span></label>
                        <input type="email" class="form-input" name="contact_email_${index}" value="${esc(ct.email || '')}" required placeholder="example@email.com">
                    </div>
                    <div class="form-group">
                        <label class="form-label">电话 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="contact_phone_${index}" value="${esc(ct.phone || '')}" required placeholder="+1-xxx-xxx-xxxx">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">手机号码 <span class="required">*</span></label>
                        <input type="text" class="form-input contact-mobile" name="contact_mobile_${index}" value="${esc(ct.mobilePhone || '')}" required placeholder="例：+1-212-555-0001">
                    </div>
                    <div class="form-group">
                        <label class="form-label">家庭地址</label>
                        <input type="text" class="form-input contact-address" name="contact_address_${index}" value="${esc(ct.homeAddress || '')}" placeholder="例：350 Fifth Avenue, New York">
                    </div>
                </div>
            </div>`;
    },

    addContactRow(data = null) {
        const container = document.getElementById('contactsContainer');
        if (!container) return;
        const rows = container.querySelectorAll('.contact-card');
        const index = rows.length;
        const ct = data || { name: '', position: '', email: '', phone: '', mobilePhone: '', homeAddress: '' };
        container.insertAdjacentHTML('beforeend', this.renderContactRow(index, ct));
        FormDrafts.persist(document.getElementById('customerForm'));
        // 滚动到新增的联系人卡片
        const newCard = document.getElementById('contactRow' + index);
        if (newCard) newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },

    removeContactRow(index) {
        const row = document.getElementById('contactRow' + index);
        if (!row) return;
        const container = document.getElementById('contactsContainer');
        const rows = container.querySelectorAll('.contact-card');
        if (rows.length <= 1) {
            App.toast('至少保留一个联系人', 'warning');
            return;
        }
        row.remove();
        // 重新编号剩余行
        this.reindexContactRows();
        FormDrafts.persist(document.getElementById('customerForm'));
    },

    reindexContactRows() {
        const container = document.getElementById('contactsContainer');
        if (!container) return;
        const rows = container.querySelectorAll('.contact-card');
        rows.forEach((row, i) => {
            row.id = 'contactRow' + i;
            const title = row.querySelector('.contact-card-title');
            if (title) title.textContent = '联系人 #' + (i + 1);
            const delBtn = row.querySelector('button');
            if (delBtn) delBtn.setAttribute('onclick', `Customers.removeContactRow(${i})`);
            // 更新 input name 属性
            row.querySelectorAll('input').forEach(input => {
                const name = input.getAttribute('name');
                if (name) {
                    input.setAttribute('name', name.replace(/_\d+$/, '_' + i));
                }
            });
        });
    },

    collectContacts() {
        const container = document.getElementById('contactsContainer');
        if (!container) return [];
        const rows = container.querySelectorAll('.contact-card');
        const contacts = [];
        rows.forEach(row => {
            const byField = suffix => {
                const el = row.querySelector(`[name*="${suffix}"]`);
                if (!el) return '';
                return ['contact_phone', 'contact_mobile'].includes(suffix) ? el.value : el.value.trim();
            };
            const name = byField('contact_name');
            if (!name) return; // 跳过空姓名的联系人
            // Preserve identity when editing; the API replaces the submitted array,
            // so removed rows remain removed instead of being unioned back in.
            const contactId = row.dataset.contactId || 'CONT-' + crypto.randomUUID();
            row.dataset.contactId = contactId;
            contacts.push({
                id: contactId,
                name: name,
                position: byField('contact_position'),
                email: byField('contact_email'),
                phone: byField('contact_phone'),
                mobilePhone: byField('contact_mobile'),
                homeAddress: byField('contact_address')
            });
        });
        return contacts;
    },

    // ==================== Excel 导入导出 ====================

    exportExcel() {
        const customers = this.getFilteredCustomers(document.getElementById('customerSearchInput')?.value || '');
        if (!customers.length) {
            App.toast('没有可导出的客户数据', 'warning');
            return;
        }
        // One row per contact; incomplete historical records remain exportable.
        const rows = customers.flatMap(c => {
            const contacts = c.contacts?.length
                ? c.contacts
                : [
                      {
                          name: c.contact,
                          position: c.position,
                          email: c.email,
                          phone: c.phone,
                          mobilePhone: c.mobilePhone,
                          homeAddress: c.homeAddress
                      }
                  ];
            return contacts.map(ct => ({
                客户编号: String(c.id ?? ''),
                客户编码: String(c.code ?? c.customerCode ?? ''),
                公司名称: c.company ?? '',
                公司地址: c.companyAddress ?? '',
                国家: c.country ?? '',
                联系人编号: String(ct.id ?? ''),
                联系人: ct.name ?? '',
                职位: ct.position ?? '',
                邮箱: ct.email ?? '',
                电话: String(ct.phone ?? ''),
                手机号码: String(ct.mobilePhone ?? ''),
                家庭地址: ct.homeAddress ?? '',
                付款条件: c.paymentTerms ?? ''
            }));
        });
        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [14, 14, 30, 45, 12, 22, 18, 16, 28, 22, 22, 35, 36].map(wch => ({ wch }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '客户列表');
        XLSX.writeFile(wb, '客户列表_' + new Date().toISOString().slice(0, 10) + '.xlsx');
        App.toast(`已导出 ${customers.length} 个客户、${rows.length} 行联系人`, 'success');
    },

    importExcel() {
        if (this._importing) return;
        if (this._importData?.some(c => c._pendingRecordId)) {
            this._reopenImportPreview?.();
            App.toast('上批客户尚未保存成功，请在预览中重试', 'warning');
            return;
        }
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.xlsx,.xls,.csv';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const wb = XLSX.read(ev.target.result, { type: 'binary', cellText: true, cellNF: true });
                    const ws = wb.Sheets[wb.SheetNames[0]];
                    // Use displayed cell text, including formatted leading-zero phone numbers.
                    const data = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
                    if (!data.length) {
                        App.toast('Excel 文件中没有数据', 'warning');
                        return;
                    }
                    this._showImportPreview(data);
                } catch (err) {
                    App.toast('文件解析失败: ' + err.message, 'error');
                }
            };
            reader.readAsBinaryString(file);
        };
        input.click();
    },

    importErrors(customer) {
        const errors = [];
        for (const [field, label] of [
            ['company', '公司名称'],
            ['companyAddress', '公司地址']
        ]) {
            if (!String(customer[field] ?? '').trim()) errors.push(`缺少${label}`);
        }
        if (!customer.contacts?.length) errors.push('至少填写一个联系人');
        for (const [index, contact] of (customer.contacts || []).entries()) {
            for (const [field, label] of [
                ['name', '姓名'],
                ['position', '职位'],
                ['email', '邮箱'],
                ['phone', '电话'],
                ['mobilePhone', '手机号码']
            ]) {
                if (!String(contact[field] ?? '').trim()) errors.push(`联系人${index + 1}缺少${label}`);
            }
            if (contact.email && !validate.email(contact.email)) errors.push(`联系人${index + 1}邮箱格式不正确`);
        }
        return errors;
    },

    _showImportPreview(rows) {
        if (this._importing) return;
        if (this._importData?.some(c => c._pendingRecordId)) {
            this._reopenImportPreview?.();
            App.toast('上批客户尚未保存成功，请先在原预览中重试', 'warning');
            return;
        }
        const aliases = {
            客户编号: 'sourceId',
            客户id: 'sourceId',
            customerid: 'sourceId',
            id: 'sourceId',
            客户编码: 'code',
            客户代码: 'code',
            customercode: 'code',
            code: 'code',
            公司名称: 'company',
            客户名称: 'company',
            company: 'company',
            companyname: 'company',
            customername: 'company',
            customer: 'company',
            公司地址: 'companyAddress',
            地址: 'companyAddress',
            companyaddress: 'companyAddress',
            address: 'companyAddress',
            国家: 'country',
            country: 'country',
            联系人编号: 'contactId',
            contactid: 'contactId',
            联系人: 'contact',
            姓名: 'contact',
            联系人姓名: 'contact',
            contact: 'contact',
            name: 'contact',
            contactname: 'contact',
            contactperson: 'contact',
            职位: 'position',
            position: 'position',
            title: 'position',
            contactposition: 'position',
            邮箱: 'email',
            电子邮箱: 'email',
            电子邮件: 'email',
            email: 'email',
            emailaddress: 'email',
            contactemail: 'email',
            contactemailaddress: 'email',
            电话: 'phone',
            电话号码: 'phone',
            phone: 'phone',
            telephone: 'phone',
            contactphone: 'phone',
            phonenumber: 'phone',
            手机号码: 'mobilePhone',
            手机: 'mobilePhone',
            mobilephone: 'mobilePhone',
            mobilephonenumber: 'mobilePhone',
            mobile: 'mobilePhone',
            contactmobile: 'mobilePhone',
            家庭地址: 'homeAddress',
            homeaddress: 'homeAddress',
            contactaddress: 'homeAddress',
            付款条件: 'paymentTerms',
            paymentterms: 'paymentTerms'
        };
        const groups = new Map();
        rows.forEach((row, index) => {
            const values = {};
            for (const [key, value] of Object.entries(row)) {
                const field =
                    aliases[
                        key
                            .trim()
                            .toLowerCase()
                            .replace(/[\s_-]/g, '')
                    ];
                if (field) {
                    values[field] = ['phone', 'mobilePhone'].includes(field)
                        ? String(value ?? '')
                        : String(value ?? '').trim();
                }
            }
            if (!Object.keys(values).length) return;
            const groupKey = JSON.stringify([
                values.sourceId || values.code || '',
                (values.company || '').toLowerCase(),
                // Keep a missing company row visible as an error rather than dropping it.
                values.company ? '' : index
            ]);
            let customer = groups.get(groupKey);
            if (!customer) {
                customer = {
                    company: values.company || '',
                    companyAddress: values.companyAddress || '',
                    country: values.country || '',
                    paymentTerms: values.paymentTerms || '',
                    code: values.code || '',
                    contacts: [],
                    _sourceId: values.sourceId || '',
                    _rowIndexes: []
                };
                groups.set(groupKey, customer);
            }
            customer._rowIndexes.push(index + 2);
            for (const field of ['companyAddress', 'country', 'paymentTerms', 'code']) {
                if (!customer[field]) customer[field] = values[field] || '';
                else if (values[field] && values[field] !== customer[field]) {
                    customer._conflict = `第${index + 2}行的客户资料与同一客户其他行不一致`;
                }
            }
            const contact = {
                id: values.contactId || 'CONT-' + crypto.randomUUID(),
                name: values.contact || '',
                position: values.position || '',
                email: values.email || '',
                phone: values.phone || '',
                mobilePhone: values.mobilePhone || '',
                homeAddress: values.homeAddress || ''
            };
            customer.contacts.push(contact);
        });
        const parsed = [...groups.values()];
        if (!parsed.length) {
            App.toast('未识别到客户数据，请检查 Excel 列名', 'warning');
            return;
        }
        this._importData = parsed;
        this._importSkipDuplicates = undefined;
        const contactRows = parsed.flatMap(c =>
            c.contacts.map((contact, index) => ({ c, contact, row: c._rowIndexes[index] }))
        );
        const previewHtml = contactRows
            .slice(0, 10)
            .map(({ c, contact, row }) => {
                const errors = c._conflict ? [c._conflict] : this.importErrors(c);
                return `<tr><td>${row}</td><td>${escapeHtml(c._sourceId || c.code)}</td>
                <td>${escapeHtml(c.company)}</td><td>${escapeHtml(c.companyAddress)}</td><td>${escapeHtml(c.country)}</td>
                <td>${escapeHtml(contact.name)}</td><td>${escapeHtml(contact.position)}</td><td>${escapeHtml(contact.email)}</td>
                <td>${escapeHtml(contact.phone)}</td><td>${escapeHtml(contact.mobilePhone)}</td><td>${escapeHtml(contact.homeAddress)}</td>
                <td>${escapeHtml(c.paymentTerms)}</td><td>${escapeHtml(errors.join('；') || '可导入')}</td></tr>`;
            })
            .join('');
        this._reopenImportPreview = () =>
            App.showModal(
                '导入客户预览',
                `
            <p>识别 ${parsed.length} 个客户、${contactRows.length} 行联系人。同一客户编号或编码及名称的多行会合并联系人。</p>
            <p class="text-gray">新客户须填写公司名称、地址；联系人须填写姓名、职位、邮箱、电话和手机。国家、家庭地址和付款条件可留空。历史重复客户可选择跳过。</p>
            <div class="table-container" style="max-height:300px;overflow:auto"><table><thead><tr>
                <th>Excel行</th><th>客户编号/编码</th><th>公司名称</th><th>公司地址</th><th>国家</th><th>联系人</th><th>职位</th>
                <th>邮箱</th><th>电话</th><th>手机</th><th>家庭地址</th><th>付款条件</th><th>检查结果</th>
            </tr></thead><tbody>${previewHtml}</tbody></table></div>
            ${contactRows.length > 10 ? `<p class="text-gray">还有 ${contactRows.length - 10} 行联系人未展示。</p>` : ''}
            <label><input type="checkbox" id="skipDuplicates" ${this._importSkipDuplicates !== false ? 'checked' : ''}> 跳过已有客户（编号、编码或公司名称相同）</label>
            <p id="customerImportStatus" role="status"></p>`,
                {
                    footer:
                        '<button class="btn btn-secondary" onclick="App.closeModal()">取消</button>' +
                        `<button id="customerImportConfirm" class="btn btn-primary" onclick="Customers._doImport()">确认导入 ${parsed.length} 个客户</button>`,
                    large: true
                }
            );
        this._reopenImportPreview();
    },

    async _doImport() {
        if (this._importing || !this._importData?.length) return;
        if (Auth.hasCapability?.('create') === false) {
            App.toast('当前账号无权导入新客户', 'warning');
            return;
        }
        if (!DB._cloudReady) {
            App.toast('云端未连接，客户尚未导入，请连接后重试', 'error');
            return;
        }
        const parsed = this._importData;
        const skipDuplicates = document.getElementById('skipDuplicates')?.checked ?? true;
        this._importSkipDuplicates = skipDuplicates;
        const existing = DB.getCustomers();
        const names = new Set(
            existing.map(c =>
                String(c.company || '')
                    .trim()
                    .toLowerCase()
            )
        );
        const ids = new Set(existing.map(c => String(c.id)));
        const codes = new Set(existing.map(c => String(c.code || c.customerCode || '')).filter(Boolean));
        const queue = [];
        let skipped = 0;
        for (const c of parsed) {
            if (c._pendingRecordId) {
                queue.push(c);
                continue;
            }
            const name = c.company.trim().toLowerCase();
            if (
                skipDuplicates &&
                (names.has(name) || (c._sourceId && ids.has(c._sourceId)) || (c.code && codes.has(c.code)))
            ) {
                skipped++;
                continue;
            }
            const errors = c._conflict ? [c._conflict] : this.importErrors(c);
            if (errors.length) {
                App.toast(
                    `第${c._rowIndexes?.join('、') || '?'}行无法导入：${errors.join('；')}。请补齐后重新选择文件。`,
                    'error',
                    8000
                );
                return;
            }
            names.add(name);
            if (c.code) codes.add(c.code);
            queue.push(c);
        }
        const button = document.getElementById('customerImportConfirm');
        const status = document.getElementById('customerImportStatus');
        this._importing = true;
        if (button) button.disabled = true;
        try {
            for (const c of queue) {
                if (c._pendingRecordId && DB.getCustomer(c._pendingRecordId)) continue;
                const primary = c.contacts[0];
                const saved = DB.addCustomer({
                    company: c.company,
                    companyAddress: c.companyAddress,
                    country: c.country,
                    code: c.code,
                    contact: primary.name,
                    position: primary.position,
                    email: primary.email,
                    phone: primary.phone,
                    mobilePhone: primary.mobilePhone,
                    homeAddress: primary.homeAddress,
                    paymentTerms: c.paymentTerms,
                    contacts: c.contacts.map(contact => ({ ...contact }))
                });
                if (!saved) throw new Error(`客户「${c.company}」创建失败，请检查字段和权限`);
                c._pendingRecordId = saved.id;
            }
            if ((await DB.flush()) !== true) throw new Error('云端保存失败');
            this._importData = null;
            this._reopenImportPreview = null;
            App.closeModal();
            App.toast(`成功导入 ${queue.length} 个客户${skipped ? `，跳过 ${skipped} 个重复客户` : ''}`, 'success');
            this.renderTable(document.getElementById('customerSearchInput')?.value || '');
        } catch (error) {
            const message = `${error.message}；预览和本批草稿已保留，请重试，不会重复添加。`;
            if (status) status.textContent = message;
            App.toast(message, 'error', 8000);
        } finally {
            this._importing = false;
            if (button) button.disabled = false;
        }
    }
};

installBusinessModalHooks(App, FormDrafts);
window.Customers = Customers;
