/**
 * 工厂管理模块
 */
import { App } from './app.js';
import { DB } from './data.js';
import { Auth } from './auth.js';
import { escapeHtml } from './utils.js';

const Factories = {
    selectedFactories: new Set(),

    canMutate(action, factory = null) {
        const actor = Auth.currentUser;
        if (!actor || Auth.hasCapability(action) !== true) return false;
        if (!factory && action !== 'create') return false;
        const scope = actor.scope;
        if (!['self', 'team', 'tenant'].includes(scope)) return false;
        if (factory?.tenantId != null && String(factory.tenantId) !== String(actor.tenantId)) return false;
        const companyId = factory ? factory.companyId : DB.currentCompanyId;
        const knownCompany = DB.companies.some(c => String(c.id) === String(companyId));
        const grants = actor.visibleCompanyIds;
        const companyAllowed =
            knownCompany && Array.isArray(grants) && grants.some(id => String(id) === String(companyId));
        if (!companyAllowed) return false;
        if (scope === 'tenant') return true;
        if (scope === 'team' && !actor.teamId) return false;
        if (!factory) return action === 'create';
        const owners = ['createdBy', 'salespersonId', 'ownerId']
            .filter(key => factory[key] != null)
            .map(key => String(factory[key]));
        if (scope === 'self') return owners.includes(String(actor.id));
        return [...(Auth.users || []), actor].some(
            user => owners.includes(String(user.id)) && user.teamId === actor.teamId
        );
    },

    denyMutation() {
        App.toast('当前账号无权修改此工厂，请联系有权限的账号', 'warning');
    },

    inlineArgument(value) {
        return escapeHtml(JSON.stringify(String(value)));
    },

    render(container, param) {
        if (param) {
            this.renderDetail(container, param);
            return;
        }
        this.selectedFactories.clear();
        container.innerHTML = `
            <div class="filter-bar">
                <input type="text" id="factorySearchInput" class="filter-input" placeholder="搜索工厂名称/联系人/产品..." style="width:300px" oninput="Factories.filter()">
                <span class="filter-info">🏢 当前公司：${escapeHtml(DB.getCurrentCompany().name)}</span>
                <div style="margin-left:auto">
                    ${this.canMutate('create') ? '<button class="btn btn-primary" onclick="Factories.showAddForm()">➕ 新建工厂</button>' : ''}
                </div>
            </div>
            <div id="factoryBatchBar" class="batch-bar">
                <span>已选择 <span class="batch-count" id="batchCount">0</span> 个工厂</span>
                ${Auth.hasCapability('delete') === true ? '<button class="btn btn-sm btn-danger" onclick="Factories.batchDelete()">🗑️ 批量删除</button>' : ''}
                <button class="btn btn-sm btn-secondary" onclick="Factories.clearSelection()">取消选择</button>
            </div>
            <div class="card">
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th class="checkbox-col"><input type="checkbox" id="selectAllCheckbox" onchange="Factories.toggleSelectAll()" title="全选"></th>
                                <th>工厂编号</th>
                                <th>工厂名称</th>
                                <th>联系人</th>
                                <th>电话</th>
                                <th>手机</th>
                                <th>产品类型</th>
                                <th class="text-right">关联订单</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="factoriesTableBody"></tbody>
                    </table>
                </div>
            </div>
        `;
        this.renderTable();
    },

    filter() {
        const search = document.getElementById('factorySearchInput')?.value || '';
        this.renderTable(search);
    },

    renderTable(search = '') {
        const factories = DB.getFactories(search);
        for (const id of this.selectedFactories) {
            if (!this.canMutate('delete', DB.getFactory(id))) this.selectedFactories.delete(id);
        }
        const tbody = document.getElementById('factoriesTableBody');
        if (!tbody) return;

        const selectAll = document.getElementById('selectAllCheckbox');
        if (selectAll) {
            const selectable = factories.filter(f => this.canMutate('delete', f));
            const selectedCount = selectable.filter(f => this.selectedFactories.has(f.id)).length;
            selectAll.disabled = selectable.length === 0;
            selectAll.checked = selectable.length > 0 && selectedCount === selectable.length;
            selectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
        }

        if (factories.length === 0) {
            tbody.innerHTML =
                '<tr><td colspan="9" class="text-center text-gray" style="padding:40px">暂无工厂数据</td></tr>';
            return;
        }

        tbody.innerHTML = factories
            .map(f => {
                const orders = DB.getFactoryOrders(f.id);
                const checked = this.selectedFactories.has(f.id) ? 'checked' : '';
                return `
                <tr>
                    <td class="checkbox-col"><input type="checkbox" ${checked} ${this.canMutate('delete', f) ? '' : 'disabled'} onchange="Factories.toggleSelect(${this.inlineArgument(f.id)})"></td>
                    <td>${escapeHtml(f.id)}</td>
                    <td><span class="table-link" onclick="window.location.hash=${this.inlineArgument('#/factories/' + encodeURIComponent(f.id))}">${escapeHtml(f.name)}</span></td>
                    <td>${escapeHtml(f.contact) || '-'}</td>
                    <td class="text-sm">${escapeHtml(f.phone) || '-'}</td>
                    <td class="text-sm">${escapeHtml(f.mobilePhone) || '-'}</td>
                    <td>${escapeHtml(f.products)}</td>
                    <td class="text-right font-semi">${orders.length}</td>
                    <td>
                        <div class="flex gap-2">
                            <button class="btn btn-sm btn-secondary" onclick="window.location.hash=${this.inlineArgument('#/factories/' + encodeURIComponent(f.id))}">详情</button>
                            ${this.canMutate('edit', f) ? `<button class="btn btn-sm btn-secondary" onclick="Factories.showEditForm(${this.inlineArgument(f.id)})">编辑</button>` : ''}
                            ${this.canMutate('delete', f) ? `<button class="btn btn-sm btn-danger" onclick="Factories.deleteFactory(${this.inlineArgument(f.id)})">删除</button>` : ''}
                        </div>
                    </td>
                </tr>
            `;
            })
            .join('');

        this.updateBatchBar();
    },

    renderDetail(container, factoryId) {
        const factory = DB.getFactory(factoryId);
        if (!factory) {
            container.innerHTML =
                '<div class="card"><div class="card-body text-center text-gray">工厂不存在</div></div>';
            return;
        }
        const orders = DB.getFactoryOrders(factoryId);

        document.getElementById('pageTitle').textContent = '工厂详情 - ' + factory.name;

        container.innerHTML = `
            <div class="flex gap-3 mb-4">
                <button class="btn btn-secondary" onclick="window.location.hash='#/factories'">← 返回列表</button>
                ${this.canMutate('edit', factory) ? `<button class="btn btn-primary" onclick="Factories.showEditForm(${this.inlineArgument(factory.id)})">✏️ 编辑工厂</button>` : ''}
                <div style="margin-left:auto">
                    ${this.canMutate('delete', factory) ? `<button class="btn btn-danger" onclick="Factories.deleteFactory(${this.inlineArgument(factory.id)})">🗑️ 删除工厂</button>` : ''}
                </div>
            </div>

            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon blue">📋</div></div>
                    <div class="stat-label">关联订单</div>
                    <div class="stat-value">${orders.length}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon green">🏭</div></div>
                    <div class="stat-label">产品类型</div>
                    <div class="stat-value">${escapeHtml(factory.products)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-card-header"><div class="stat-icon cyan">👤</div></div>
                    <div class="stat-label">联系人</div>
                    <div class="stat-value">${escapeHtml(factory.contact) || '-'}</div>
                    <div class="stat-sub">📞 ${escapeHtml(factory.phone) || '-'} ${factory.mobilePhone ? '| 📱 ' + escapeHtml(factory.mobilePhone) : ''}</div>
                </div>
            </div>

            <div class="card mb-6">
                <div class="card-header"><span class="card-title">工厂信息</span></div>
                <div class="card-body">
                    <div class="detail-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                        <div class="detail-item"><div class="detail-label">工厂编号</div><div class="detail-value">${escapeHtml(factory.id)}</div></div>
                        <div class="detail-item"><div class="detail-label">工厂名称</div><div class="detail-value">${escapeHtml(factory.name)}</div></div>
                        <div class="detail-item"><div class="detail-label">联系人</div><div class="detail-value">${escapeHtml(factory.contact) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">电话</div><div class="detail-value">${escapeHtml(factory.phone) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">手机</div><div class="detail-value">${escapeHtml(factory.mobilePhone) || '-'}</div></div>
                        <div class="detail-item"><div class="detail-label">产品类型</div><div class="detail-value">${escapeHtml(factory.products)}</div></div>
                    </div>
                </div>
            </div>

            <div class="card mb-6">
                <div class="card-header"><span class="card-title">工厂地址 & 银行信息</span></div>
                <div class="card-body">
                    <div class="detail-item mb-3"><div class="detail-label">工厂地址</div><div class="detail-value">${escapeHtml(factory.address) || '-'}</div></div>
                    <div class="detail-item"><div class="detail-label">银行信息</div><div class="detail-value">${escapeHtml(factory.bankInfo) || '-'}</div></div>
                </div>
            </div>

            <div class="card">
                <div class="card-header"><span class="card-title">关联订单</span></div>
                <div class="table-container">
                    <table>
                        <thead>
                            <tr><th>订单号</th><th>客户</th><th>产品</th><th class="text-right">金额(USD)</th><th>订单状态</th></tr>
                        </thead>
                        <tbody>
                            ${
                                orders.length > 0
                                    ? orders
                                          .map(
                                              o => `
                                <tr>
                                    <td><span class="table-link" onclick="window.location.hash=${this.inlineArgument('#/orders/' + encodeURIComponent(o.id))}">${escapeHtml(o.id)}</span></td>
                                    <td>${escapeHtml(o.customerName)}</td>
                                    <td class="text-sm">${escapeHtml(o.productName)}</td>
                                    <td class="text-right font-semi">${App.formatMoney(o.orderAmountUSD, 'USD')}</td>
                                    <td>${App.getStatusBadge(escapeHtml(o.status))}</td>
                                </tr>
                            `
                                          )
                                          .join('')
                                    : '<tr><td colspan="5" class="text-center text-gray" style="padding:30px">暂无关联订单</td></tr>'
                            }
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    },

    showAddForm() {
        if (!this.canMutate('create')) {
            this.denyMutation();
            return;
        }
        const bodyHtml = `
            <form id="factoryForm" onsubmit="Factories.saveFactory(event); return false;">
                <div class="form-group">
                    <label class="form-label">工厂名称 <span class="required">*</span></label>
                    <input type="text" class="form-input" name="name" required placeholder="例：深圳市盛达电子科技有限公司">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">联系人 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="contact" required placeholder="例：张经理">
                    </div>
                    <div class="form-group">
                        <label class="form-label">电话 <span class="required">*</span></label>
                        <input type="tel" class="form-input" name="phone" required placeholder="例：0755-12345678">
                    </div>
                    <div class="form-group">
                        <label class="form-label">手机 <span class="required">*</span></label>
                        <input type="tel" class="form-input" name="mobilePhone" required placeholder="例：13800138001">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">产品类型 <span class="required">*</span></label>
                    <input type="text" class="form-input" name="products" required placeholder="例：电子产品、五金制品">
                </div>
                <div class="form-group">
                    <label class="form-label">工厂地址 <span class="required">*</span></label>
                    <textarea class="form-textarea" name="address" required placeholder="例：深圳市宝安区沙井街道中心路88号" style="min-height:60px"></textarea>
                </div>
                ${
                    Auth.hasCapability('finance.write') === true
                        ? `<div class="form-group">
                    <label class="form-label">工厂银行信息</label>
                    <textarea class="form-textarea" name="bankInfo" placeholder="例：中国银行深圳宝安支行 / 6217007200012345678" style="min-height:60px"></textarea>
                </div>`
                        : ''
                }
            </form>
        `;
        App.showModal('新建工厂', bodyHtml, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="document.getElementById('factoryForm').requestSubmit()">💾 保存</button>`
        });
    },

    showEditForm(factoryId) {
        const f = DB.getFactory(factoryId);
        if (!f) return;
        if (!this.canMutate('edit', f)) {
            this.denyMutation();
            return;
        }
        const bodyHtml = `
            <form id="factoryForm" onsubmit="Factories.saveFactory(event, ${this.inlineArgument(factoryId)}); return false;">
                <div class="form-group">
                    <label class="form-label">工厂名称 <span class="required">*</span></label>
                    <input type="text" class="form-input" name="name" required value="${escapeHtml(f.name)}">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">联系人 <span class="required">*</span></label>
                        <input type="text" class="form-input" name="contact" required value="${escapeHtml(f.contact || '')}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">电话 <span class="required">*</span></label>
                        <input type="tel" class="form-input" name="phone" required value="${escapeHtml(f.phone || '')}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">手机 <span class="required">*</span></label>
                        <input type="tel" class="form-input" name="mobilePhone" required value="${escapeHtml(f.mobilePhone || '')}">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">产品类型 <span class="required">*</span></label>
                    <input type="text" class="form-input" name="products" required value="${escapeHtml(f.products)}">
                </div>
                <div class="form-group">
                    <label class="form-label">工厂地址 <span class="required">*</span></label>
                    <textarea class="form-textarea" name="address" required style="min-height:60px">${escapeHtml(f.address || '')}</textarea>
                </div>
                ${
                    Auth.hasCapability('finance.write') === true
                        ? `<div class="form-group">
                    <label class="form-label">工厂银行信息</label>
                    <textarea class="form-textarea" name="bankInfo" style="min-height:60px">${escapeHtml(f.bankInfo || '')}</textarea>
                </div>`
                        : ''
                }
            </form>
        `;
        App.showModal('编辑工厂 - ' + escapeHtml(f.name), bodyHtml, {
            footer: `<button class="btn btn-secondary" onclick="App.closeModal()">取消</button><button class="btn btn-primary" onclick="document.getElementById('factoryForm').requestSubmit()">💾 保存修改</button>`
        });
    },

    async saveFactory(event, factoryId = null) {
        event.preventDefault();

        if (!DB._cloudReady) {
            App.toast('⚠️ 云端未连接，请检查网络后刷新重试', 'error');
            return;
        }

        const form = event.target;
        const pendingId = factoryId || form.dataset.pendingRecordId || null;
        const pendingFactory = pendingId ? DB.getFactory(pendingId) : null;
        if (pendingId && !pendingFactory) {
            App.toast('⚠️ 工厂不存在，无法更新', 'error');
            return;
        }
        if (!this.canMutate(factoryId ? 'edit' : 'create', pendingFactory)) {
            this.denyMutation();
            return;
        }
        const fd = new FormData(form);
        const data = {
            name: fd.get('name'),
            contact: fd.get('contact'),
            phone: fd.get('phone'),
            mobilePhone: fd.get('mobilePhone'),
            products: fd.get('products'),
            address: fd.get('address')
        };
        if (Auth.hasCapability('finance.write') === true && fd.has('bankInfo')) data.bankInfo = fd.get('bankInfo');
        if (pendingId) {
            const updated = DB.updateFactory(pendingId, data);
            if (!updated) {
                App.toast('⚠️ 工厂不存在，无法更新', 'error');
                return;
            }
        } else {
            const newFactory = DB.addFactory(data);
            if (!newFactory) {
                App.toast('⚠️ 工厂创建失败，请检查必填字段', 'error');
                return;
            }
            form.dataset.pendingRecordId = newFactory.id;
        }

        const ok = await DB.flush();
        if (!ok) {
            App.toast('⚠️ 保存到云端失败，请稍后重试', 'error');
            return;
        }

        App.toast(factoryId ? '工厂信息已更新' : '工厂创建成功');
        App.closeModal();
        if (factoryId) {
            this.renderDetail(document.getElementById('pageContent'), factoryId);
        } else {
            this.renderTable();
        }
    },

    deleteFactory(id) {
        const factory = DB.getFactory(id);
        if (!factory) return;
        if (!this.canMutate('delete', factory)) {
            this.denyMutation();
            return;
        }
        const orders = DB.getFactoryOrders(id);
        // showConfirm accepts plain text and escapes it in the dialog.
        const warnMsg =
            orders.length > 0
                ? `确定要删除工厂 ${factory.name} 吗？该工厂关联了 ${orders.length} 笔订单，删除后订单仍会保留，但工厂信息将无法查看。`
                : `确定要删除工厂 ${factory.name} 吗？此操作不可恢复。`;

        App.showConfirm(warnMsg, async () => {
            if (!this.canMutate('delete', DB.getFactory(id))) {
                this.denyMutation();
                return;
            }
            App.toast('正在删除...', 'info');
            DB.deleteFactory(id);
            const ok = await DB.flush();
            if (!ok) {
                App.toast('⚠️ 删除保存失败，请刷新页面重试', 'error');
                return;
            }
            this.selectedFactories.delete(id);
            App.toast('工厂已删除');
            App.closeModal();
            if (window.location.hash === '#/factories/' + id) {
                window.location.hash = '#/factories';
            } else {
                const search = document.getElementById('factorySearchInput')?.value || '';
                this.renderTable(search);
            }
        });
    },

    // ==================== 多选功能 ====================

    toggleSelectAll() {
        const selectAll = document.getElementById('selectAllCheckbox');
        const factories = DB.getFactories(document.getElementById('factorySearchInput')?.value || '').filter(f =>
            this.canMutate('delete', f)
        );
        if (selectAll.checked) {
            factories.forEach(f => this.selectedFactories.add(f.id));
        } else {
            factories.forEach(f => this.selectedFactories.delete(f.id));
        }
        this.renderTable(document.getElementById('factorySearchInput')?.value || '');
    },

    toggleSelect(id) {
        if (!this.canMutate('delete', DB.getFactory(id))) return;
        if (this.selectedFactories.has(id)) {
            this.selectedFactories.delete(id);
        } else {
            this.selectedFactories.add(id);
        }
        const selectAll = document.getElementById('selectAllCheckbox');
        const factories = DB.getFactories(document.getElementById('factorySearchInput')?.value || '').filter(f =>
            this.canMutate('delete', f)
        );
        if (selectAll) {
            const selectedCount = factories.filter(f => this.selectedFactories.has(f.id)).length;
            selectAll.checked = factories.length > 0 && selectedCount === factories.length;
            selectAll.indeterminate = selectedCount > 0 && selectedCount < factories.length;
        }
        this.updateBatchBar();
    },

    updateBatchBar() {
        const bar = document.getElementById('factoryBatchBar');
        const count = document.getElementById('batchCount');
        if (bar && count) {
            bar.classList.toggle('visible', this.selectedFactories.size > 0);
            count.textContent = this.selectedFactories.size;
        }
    },

    clearSelection() {
        this.selectedFactories.clear();
        this.renderTable(document.getElementById('factorySearchInput')?.value || '');
    },

    batchDelete() {
        if (this.selectedFactories.size === 0) return;
        const ids = [...this.selectedFactories];
        if (ids.some(id => !this.canMutate('delete', DB.getFactory(id)))) {
            this.denyMutation();
            return;
        }
        const totalOrders = ids.reduce((sum, id) => sum + DB.getFactoryOrders(id).length, 0);
        const warnMsg =
            totalOrders > 0
                ? `确定要批量删除 ${ids.length} 个工厂吗？这些工厂共关联了 ${totalOrders} 笔订单，删除后订单仍会保留，但工厂信息将无法查看。此操作不可恢复。`
                : `确定要批量删除 ${ids.length} 个工厂吗？此操作不可恢复。`;

        App.showConfirm(warnMsg, async () => {
            if (ids.some(id => !this.canMutate('delete', DB.getFactory(id)))) {
                this.denyMutation();
                return;
            }
            App.toast('正在批量删除...', 'info');
            ids.forEach(id => DB.deleteFactory(id));
            const ok = await DB.flush();
            if (!ok) {
                App.toast('⚠️ 批量删除保存失败，请刷新页面重试', 'error');
                return;
            }
            this.selectedFactories.clear();
            App.toast(`已删除 ${ids.length} 个工厂`);
            App.closeModal();
            const search = document.getElementById('factorySearchInput')?.value || '';
            this.renderTable(search);
        });
    }
};

window.Factories = Factories;
