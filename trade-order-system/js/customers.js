/**
 * 客户管理模块
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { Exchange } from './exchange.js';
import { escapeHtml, toast, validate } from './utils.js';

const Customers = {
    selectedCustomers: new Set(),

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
                <button class="btn btn-sm btn-danger" onclick="Customers.batchDelete()">🗑️ 批量删除</button>
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
        const tbody = document.getElementById('customersTableBody');
        if (!tbody) return;

        // 同步全选 checkbox 状态
        const selectAll = document.getElementById('selectAllCheckbox');
        if (selectAll && customers.length > 0) {
            selectAll.checked = this.selectedCustomers.size === customers.length;
            selectAll.indeterminate = this.selectedCustomers.size > 0 && this.selectedCustomers.size < customers.length;
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
                    <td class="checkbox-col"><input type="checkbox" ${checked} onchange="Customers.toggleSelect('${App.escapeHtml(c.id)}')"></td>
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
                            <button class="btn btn-sm btn-danger" onclick="Customers.deleteCustomer('${App.escapeHtml(c.id)}')">删除</button>
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
                    <button class="btn btn-danger" onclick="Customers.deleteCustomer('${App.escapeHtml(customer.id)}')">🗑️ 删除客户</button>
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
                        <label class="form-label">国家 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="country" required placeholder="例：美国">
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
            footer: `<button class="btn btn-secondary" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="document.getElementById('customerForm').requestSubmit()">💾 保存</button>`,
            large: true
        });
    },

    showEditForm(customerId) {
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
            <form id="customerForm" onsubmit="Customers.saveCustomer(event, '${customerId}'); return false;">
                <div class="form-section-title">📋 公司信息</div>
                <div class="form-group">
                    <label class="form-label">公司名称 <span class="required">*</span></label>
                    <input type="text" class="form-input" name="company" required value="${c.company.replace(/"/g, '&quot;')}">
                </div>
                <div class="form-group">
                    <label class="form-label">公司地址 <span class="required">*</span></label>
                    <input type="text" class="form-input" name="companyAddress" required value="${(c.companyAddress || '').replace(/"/g, '&quot;')}" placeholder="例：350 Fifth Avenue, Suite 1200, New York, NY 10118, USA">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">国家 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="country" required value="${c.country}">
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
            footer: `<button class="btn btn-secondary" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="document.getElementById('customerForm').requestSubmit()">💾 保存修改</button>`,
            large: true
        });
    },

    async saveCustomer(event, customerId = null) {
        event.preventDefault();

        if (!DB._cloudReady) {
            App.toast('⚠️ 云端未连接，请检查网络后刷新重试', 'error');
            return;
        }

        const fd = new FormData(event.target);
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
        if (customerId) {
            const updated = DB.updateCustomer(customerId, data);
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
        }

        const ok = await DB.flush();
        if (!ok) {
            App.toast('⚠️ 保存到云端失败，请稍后重试', 'error');
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
        const orders = DB.getCustomerOrders(id);
        const warnMsg =
            orders.length > 0
                ? `<p style="margin-bottom:8px">确定要删除客户 <strong>${customer.company}</strong> 吗？</p><p style="color:var(--danger);font-size:13px">⚠️ 该客户关联了 <strong>${orders.length}</strong> 笔订单，删除客户后这些订单仍会保留，但客户信息将无法查看。</p>`
                : `<p>确定要删除客户 <strong>${customer.company}</strong> 吗？此操作不可恢复。</p>`;

        App.showConfirm(warnMsg, async () => {
            App.toast('正在删除...', 'info');
            DB.deleteCustomer(id);
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
        const customers = this.getFilteredCustomers(document.getElementById('customerSearchInput')?.value || '');
        if (selectAll.checked) {
            customers.forEach(c => this.selectedCustomers.add(c.id));
        } else {
            customers.forEach(c => this.selectedCustomers.delete(c.id));
        }
        this.renderTable(document.getElementById('customerSearchInput')?.value || '');
    },

    toggleSelect(id) {
        if (this.selectedCustomers.has(id)) {
            this.selectedCustomers.delete(id);
        } else {
            this.selectedCustomers.add(id);
        }
        const selectAll = document.getElementById('selectAllCheckbox');
        const customers = this.getFilteredCustomers(document.getElementById('customerSearchInput')?.value || '');
        if (selectAll) {
            selectAll.checked = this.selectedCustomers.size === customers.length;
            selectAll.indeterminate = this.selectedCustomers.size > 0 && this.selectedCustomers.size < customers.length;
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
        const totalOrders = ids.reduce((sum, id) => sum + DB.getCustomerOrders(id).length, 0);
        const warnMsg =
            totalOrders > 0
                ? `<p style="margin-bottom:8px">确定要批量删除 <strong>${ids.length}</strong> 个客户吗？</p><p style="color:var(--danger);font-size:13px">⚠️ 这些客户共关联了 <strong>${totalOrders}</strong> 笔订单，删除后订单仍会保留，但客户信息将无法查看。此操作不可恢复！</p>`
                : `<p>确定要批量删除 <strong>${ids.length}</strong> 个客户吗？此操作不可恢复。</p>`;

        App.showConfirm(warnMsg, async () => {
            App.toast('正在批量删除...', 'info');
            ids.forEach(id => DB.deleteCustomer(id));
            const ok = await DB.flush();
            if (!ok) {
                App.toast('⚠️ 批量删除保存失败，请刷新页面重试', 'error');
                return;
            }
            this.selectedCustomers.clear();
            App.toast(`已删除 ${ids.length} 个客户`);
            App.closeModal();
            const search = document.getElementById('customerSearchInput')?.value || '';
            this.renderTable(search);
        });
    },

    // ==================== 联系人管理 ====================

    renderContactRow(index, ct = {}) {
        const esc = s => (s || '').replace(/"/g, '&quot;');
        return `
            <div class="contact-card" id="contactRow${index}">
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
        let contactIdCounter = Date.now();
        rows.forEach(row => {
            const byField = suffix => {
                const el = row.querySelector(`[name*="${suffix}"]`);
                return el ? el.value.trim() : '';
            };
            const name = byField('contact_name');
            if (!name) return; // 跳过空姓名的联系人
            contacts.push({
                id: 'CONT-NEW-' + contactIdCounter++,
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
        if (customers.length === 0) {
            App.toast('没有可导出的客户数据', 'warning');
            return;
        }

        const rows = customers.map(c => ({
            客户编号: c.id,
            公司名称: c.company,
            公司地址: c.companyAddress || '',
            国家: c.country,
            联系人: c.contact,
            职位: c.position || '',
            手机号码: c.mobilePhone || '',
            家庭地址: c.homeAddress || '',
            付款条件: c.paymentTerms || ''
        }));

        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [
            { wch: 14 },
            { wch: 30 },
            { wch: 45 },
            { wch: 12 },
            { wch: 18 },
            { wch: 16 },
            { wch: 18 },
            { wch: 35 },
            { wch: 36 }
        ];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '客户列表');
        XLSX.writeFile(wb, '客户列表_' + new Date().toISOString().slice(0, 10) + '.xlsx');
        App.toast('已导出 ' + customers.length + ' 个客户', 'success');
    },

    importExcel() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.xlsx,.xls,.csv';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const wb = XLSX.read(ev.target.result, { type: 'binary' });
                    const ws = wb.Sheets[wb.SheetNames[0]];
                    const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
                    if (data.length === 0) {
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

    _showImportPreview(rows) {
        const FIELD_MAP = {
            公司名称: 'company',
            客户名称: 'company',
            公司地址: 'companyAddress',
            地址: 'companyAddress',
            国家: 'country',
            联系人: 'contact',
            姓名: 'contact',
            职位: 'position',
            手机号码: 'mobilePhone',
            手机: 'mobilePhone',
            家庭地址: 'homeAddress',
            付款条件: 'paymentTerms'
        };

        const parsed = rows
            .map((row, i) => {
                const c = {};
                Object.keys(row).forEach(key => {
                    const field = FIELD_MAP[key.trim()];
                    if (field) c[field] = String(row[key]).trim();
                });
                if (!c.company) return null;
                c.country = c.country || '未知';
                c.paymentTerms = c.paymentTerms || '30% T/T advance, 70% before shipment';
                c._rowIndex = i + 1;
                return c;
            })
            .filter(Boolean);

        if (parsed.length === 0) {
            App.toast('未识别到有效客户数据，请检查 Excel 列名', 'warning');
            return;
        }

        const previewHtml = parsed
            .slice(0, 10)
            .map(
                c => `
            <tr>
                <td class="text-sm">${c._rowIndex}</td>
                <td class="font-semi">${c.company || '-'}</td>
                <td class="text-sm">${(c.companyAddress || '').slice(0, 30)}</td>
                <td>${c.country}</td>
                <td>${c.contact || '-'}</td>
                <td>${c.position || '-'}</td>
                <td class="text-sm">${c.mobilePhone || '-'}</td>
                <td class="text-sm">${c.paymentTerms}</td>
            </tr>
        `
            )
            .join('');

        const moreHint =
            parsed.length > 10
                ? '<p class="text-gray" style="font-size:13px;margin-top:8px">... 还有 ' +
                  (parsed.length - 10) +
                  ' 条数据</p>'
                : '';

        const bodyHtml = `
            <div style="margin-bottom:12px">
                <p>共识别 <strong>${parsed.length}</strong> 条客户数据，预览前 ${Math.min(parsed.length, 10)} 条：</p>
            </div>
            <div class="table-container" style="max-height:300px;overflow-y:auto">
                <table>
                    <thead>
                        <tr>
                            <th>#</th><th>公司名称</th><th>地址</th><th>国家</th><th>联系人</th><th>职位</th><th>手机</th><th>付款条件</th>
                        </tr>
                    </thead>
                    <tbody>${previewHtml}</tbody>
                </table>
            </div>
            ${moreHint}
            <div class="mt-3" style="display:flex;align-items:center;gap:8px">
                <input type="checkbox" id="skipDuplicates" checked>
                <label for="skipDuplicates" style="font-size:13px">跳过重复客户（相同公司名称）</label>
            </div>
        `;

        App.showModal('导入客户预览', bodyHtml, {
            footer:
                '<button class="btn btn-secondary" onclick="App.closeModal()">取消</button>' +
                '<button class="btn btn-primary" onclick="Customers._doImport()">确认导入 ' +
                parsed.length +
                ' 条</button>',
            large: true
        });

        // 暂存待导入数据，避免 JSON.stringify 特殊字符问题
        this._importData = parsed.map(c => {
            const { _rowIndex, ...rest } = c;
            return rest;
        });
    },

    _doImport() {
        const parsed = this._importData || [];
        this._importData = null;
        const skipDup = document.getElementById('skipDuplicates');
        const skipDuplicates = skipDup ? skipDup.checked : true;
        const existingCustomers = DB.getCustomers();
        const existingNames = new Set(existingCustomers.map(c => c.company.toLowerCase().trim()));

        let imported = 0;
        let skipped = 0;

        parsed.forEach(c => {
            if (skipDuplicates && existingNames.has(c.company.toLowerCase().trim())) {
                skipped++;
                return;
            }

            DB.addCustomer({
                company: c.company,
                companyAddress: c.companyAddress || '',
                country: c.country || '未知',
                contact: c.contact || '',
                position: c.position || '',
                mobilePhone: c.mobilePhone || '',
                homeAddress: c.homeAddress || '',
                paymentTerms: c.paymentTerms || '30% T/T advance, 70% before shipment',
                contacts: [
                    {
                        id: 'CONT-' + Date.now() + '-' + imported,
                        name: c.contact || '',
                        position: c.position || '',
                        email: '',
                        phone: '',
                        mobilePhone: c.mobilePhone || '',
                        homeAddress: c.homeAddress || ''
                    }
                ]
            });
            existingNames.add(c.company.toLowerCase().trim());
            imported++;
        });

        App.closeModal();
        let msg = '成功导入 ' + imported + ' 个客户';
        if (skipped > 0) msg += '，跳过 ' + skipped + ' 个重复';
        App.toast(msg, 'success');
        this.renderTable(document.getElementById('customerSearchInput')?.value || '');
        // ★ 显式 flush（addCustomer 不再自动 flush）
        if (imported > 0) {
            DB.flush().then(ok => {
                if (!ok) App.toast('⚠️ 导入的客户云端保存失败，请勿刷新页面并重试', 'error', 8000);
            });
        }
    }
};

window.Customers = Customers;
