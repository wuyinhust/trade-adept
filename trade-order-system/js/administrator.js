import { Auth } from './auth.js';
import { App } from './app.js';
import { escapeHtml, toast } from './utils.js';

const api = () => window.Workspace.api;
const permissionLabels = {
    read: '查看业务',
    create: '新建业务',
    edit: '修改业务',
    delete: '删除业务',
    assign: '分配业务',
    'finance.read': '查看成本与利润',
    'finance.write': '处理金额与款项',
    'rates.write': '管理汇率',
    'snapshots.read': '查看快照',
    'snapshots.restore': '恢复快照',
    'accounts.configure': '管理企业配置'
};
const pageLabels = {
    dashboard: '工作台',
    orders: '订单',
    customers: '客户',
    factories: '采购与工厂',
    shipping: '物流单证',
    profit: '利润报表',
    settings: '业务设置',
    admin: '管理中心'
};
const tabs = [
    ['overview', '管理概览'],
    ['enterprise', '企业与公司'],
    ['departments', '部门与团队'],
    ['members', '成员'],
    ['roles', '角色与权限'],
    ['email', '邮箱与通知'],
    ['business', '业务设置'],
    ['data', '数据与审计']
];
const steps = [
    ['enterprise', '企业资料', '确认企业名称、语言和时区'],
    ['company', '建立公司', '建立至少一个实际经营主体'],
    ['organization', '组织与权限', '确认角色并建立部门'],
    ['members', '添加成员', '为团队分配岗位和公司范围'],
    ['business', '业务准备', '配置邮箱，其他资料可稍后补充'],
    ['finish', '开始使用', '核对必需配置并进入工作台']
];

const value = (form, name) => form.elements.namedItem(name)?.value?.trim() || '';
const checked = (form, name) => [...form.querySelectorAll(`[name="${name}"]:checked`)].map(input => input.value);
const selected = (items, id) => items.find(item => String(item.id ?? item.key) === String(id));
const raw = value => ({ __html: String(value) });
const enabled = (value, fallback = false) => (value == null ? fallback : [true, 1, '1'].includes(value));
const optionList = (items, current, empty = '请选择') =>
    `<option value="">${escapeHtml(empty)}</option>${items
        .map(item => {
            const id = item.id ?? item.key;
            return `<option value="${escapeHtml(id)}" ${String(id) === String(current || '') ? 'selected' : ''}>${escapeHtml(item.name || item.label || id)}</option>`;
        })
        .join('')}`;
const checkboxList = (name, options, current = []) =>
    `<div class="admin-check-grid">${options
        .map(
            ([id, label]) =>
                `<label><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(id)}" ${current.includes(id) ? 'checked' : ''}> <span>${escapeHtml(label)}</span></label>`
        )
        .join('')}</div>`;

function formModal(title, body, onSubmit, { submitLabel = '保存' } = {}) {
    const id = `adminForm-${Date.now()}`;
    App.showModal(title, `<form id="${id}" class="admin-form">${body}</form>`, {
        large: true,
        footer: `<button type="button" class="btn btn-secondary" id="adminFormCancel">取消</button><button type="submit" form="${id}" class="btn btn-primary" id="adminFormSubmit">${escapeHtml(submitLabel)}</button>`
    });
    const form = document.getElementById(id);
    document.getElementById('adminFormCancel').onclick = () => App.closeModal();
    form.onsubmit = async event => {
        event.preventDefault();
        const button = document.getElementById('adminFormSubmit');
        button.disabled = true;
        try {
            await onSubmit(form);
            App.closeModal();
        } catch (error) {
            toast(error.message || '保存失败', 'error');
            button.disabled = false;
        }
    };
}

const AdminCenter = {
    state: null,
    tab: 'overview',
    target: null,
    returnToOnboarding: false,

    async load() {
        this.state = await api().adminState();
        return this.state;
    },

    async render(target = document.getElementById('pageContent')) {
        this.target = target;
        this.returnToOnboarding = false;
        if (Auth.hasCapability('accounts.configure') !== true) {
            target.innerHTML = '<div class="card"><div class="card-body">当前账号没有企业管理权限。</div></div>';
            return;
        }
        try {
            await this.load();
            this.draw();
        } catch (error) {
            target.innerHTML = `<div class="card"><div class="card-body"><p>${escapeHtml(error.message)}</p></div></div>`;
        }
    },

    draw() {
        if (!this.state || !this.target) return;
        this.target.innerHTML = `
            <section class="page-intro admin-intro">
                <div><p class="page-eyebrow">ADMINISTRATOR</p><h2>管理中心</h2><p class="page-description">管理当前企业的公司、组织、成员、权限和邮箱。</p></div>
                <div class="admin-status ${this.state.onboarding.status === 'complete' ? 'is-complete' : ''}">${this.state.onboarding.status === 'complete' ? '企业配置已就绪' : '企业配置待完成'}</div>
            </section>
            <div class="admin-layout">
                <nav class="admin-tabs" aria-label="管理中心栏目">${tabs.map(([key, label]) => `<button type="button" data-admin-tab="${key}" class="${this.tab === key ? 'active' : ''}">${escapeHtml(label)}</button>`).join('')}</nav>
                <section class="admin-panel" id="adminPanel">${this.panel()}</section>
            </div>`;
        for (const button of this.target.querySelectorAll('[data-admin-tab]')) {
            button.onclick = () => {
                this.tab = button.dataset.adminTab;
                this.draw();
            };
        }
        this.bindActions();
    },

    panel() {
        const renderer = this[`panel_${this.tab}`] || this.panel_overview;
        return renderer.call(this);
    },

    panel_overview() {
        const onboarding = this.state.onboarding;
        const cards = [
            ['企业资料', onboarding.checks.enterprise, this.state.enterprise.name || '未填写'],
            ['公司主体', onboarding.checks.company, `${this.state.companies.length} 个`],
            [
                '组织与角色',
                onboarding.checks.organization,
                `${this.state.departments.length} 个部门 · ${this.state.roles.length} 个角色`
            ],
            ['成员', onboarding.checks.members, `${this.state.members.filter(item => item.enabled).length} 位启用成员`],
            [
                '企业邮箱',
                this.state.emailAccounts.length > 0,
                this.state.emailAccounts.length ? `${this.state.emailAccounts.length} 个` : '可稍后配置'
            ]
        ];
        return `<div class="admin-panel-heading"><div><h3>配置进度</h3><p>必需配置完成后即可开始正式业务。</p></div>${onboarding.status === 'complete' ? '' : '<button class="btn btn-primary" data-admin-action="onboarding">继续初始化</button>'}</div>
            <div class="admin-summary-grid">${cards.map(([label, ready, detail]) => `<article class="admin-summary-card ${ready ? 'ready' : ''}"><span>${ready ? '✓' : '○'}</span><div><strong>${escapeHtml(label)}</strong><p>${escapeHtml(detail)}</p></div></article>`).join('')}</div>
            <div class="card admin-note"><div class="card-body"><strong>权限提示</strong><p>企业管理权限与财务权限分别配置。成员只有被明确授权的公司和数据范围。</p></div></div>`;
    },

    panel_enterprise() {
        return `<div class="admin-panel-heading"><div><h3>企业与公司</h3><p>企业空间可包含多个独立经营主体。</p></div><div><button class="btn btn-secondary" data-admin-action="enterprise">编辑企业</button> <button class="btn btn-primary" data-admin-action="company">新增公司</button></div></div>
            <div class="card admin-enterprise-card"><div class="card-body"><strong>${escapeHtml(this.state.enterprise.name || '未命名企业')}</strong><p>${escapeHtml(this.state.enterprise.id)} · ${escapeHtml(this.state.enterprise.language)} · ${escapeHtml(this.state.enterprise.timezone)}</p></div></div>
            ${this.table(
                ['公司', '法域', '本位币', '订单前缀', ''],
                this.state.companies.map(item => [
                    item.name,
                    item.jurisdiction || item.country,
                    item.settlementCurrency,
                    item.orderPrefix || '—',
                    raw(
                        `<button class="btn btn-secondary btn-sm" data-edit-company="${escapeHtml(item.id)}">编辑</button>`
                    )
                ])
            )}`;
    },

    panel_departments() {
        return `<div class="admin-panel-heading"><div><h3>部门与团队</h3><p>部门表达组织关系，公司范围决定可访问的数据。</p></div><button class="btn btn-primary" data-admin-action="department">新增部门</button></div>
            ${this.table(
                ['部门', '上级', '负责人', '公司范围', '成员', ''],
                this.state.departments.map(item => [
                    item.name,
                    selected(this.state.departments, item.parentId)?.name || '—',
                    selected(this.state.members, item.managerId)?.name || '—',
                    (item.visibleCompanyIds || [])
                        .map(id => selected(this.state.companies, id)?.name || id)
                        .join('、') || '未授权',
                    `${(item.memberIds || []).length} 人`,
                    raw(
                        `<button class="btn btn-secondary btn-sm" data-edit-department="${escapeHtml(item.id)}">编辑</button>`
                    )
                ])
            )}`;
    },

    panel_members() {
        return `<div class="admin-panel-heading"><div><h3>成员</h3><p>创建账号并明确角色、部门和公司范围。</p></div><button class="btn btn-primary" data-admin-action="member">添加成员</button></div>
            ${this.table(
                ['成员', '登录账号', '角色', '部门', '公司范围', '状态', ''],
                this.state.members.map(item => [
                    item.name || item.id,
                    item.username || item.email,
                    selected(this.state.roles, item.role)?.label || item.role,
                    selected(this.state.departments, item.departmentId || item.teamId)?.name || '—',
                    (item.visibleCompanyIds || [])
                        .map(id => selected(this.state.companies, id)?.name || id)
                        .join('、') || '未授权',
                    item.enabled ? '启用' : '停用',
                    raw(
                        `<button class="btn btn-secondary btn-sm" data-edit-member="${escapeHtml(item.id)}">编辑</button>`
                    )
                ])
            )}`;
    },

    panel_roles() {
        return `<div class="admin-panel-heading"><div><h3>角色与权限</h3><p>角色决定能做什么，部门和公司授权决定能看到哪些数据。</p></div><button class="btn btn-primary" data-admin-action="role">新增角色</button></div>
            ${this.table(
                ['角色', '数据范围', '主要权限', '页面', ''],
                this.state.roles.map(item => [
                    item.label || item.key,
                    { self: '本人', team: '部门', tenant: '全企业' }[item.scope] || item.scope,
                    (item.permissions || []).map(id => permissionLabels[id] || id).join('、'),
                    (item.pages || []).map(id => pageLabels[id] || id).join('、'),
                    raw(
                        `<button class="btn btn-secondary btn-sm" data-edit-role="${escapeHtml(item.key)}">编辑</button>`
                    )
                ])
            )}`;
    },

    panel_email() {
        const unavailable = !this.state.options.emailAvailable
            ? '<div class="card admin-note"><div class="card-body">当前 ERP 环境没有启用 Email Account，需先安装对应模块。</div></div>'
            : '';
        return `<div class="admin-panel-heading"><div><h3>邮箱与通知</h3><p>密码只保存到服务器，不会回传到浏览器。</p></div>${this.state.options.emailAvailable ? '<button class="btn btn-primary" data-admin-action="email">添加邮箱</button>' : ''}</div>${unavailable}
            ${this.table(
                ['邮箱', '用途', '状态', '收信', '发信', '授权成员', ''],
                this.state.emailAccounts.map(item => [
                    item.emailId,
                    [
                        item.label || item.service || '企业邮箱',
                        item.defaultIncoming ? '默认收信' : '',
                        item.defaultOutgoing ? '默认发信' : ''
                    ]
                        .filter(Boolean)
                        .join(' · '),
                    item.awaitingPassword ? '待填写密码' : '已配置',
                    item.enableIncoming ? '启用' : '关闭',
                    item.enableOutgoing ? '启用' : '关闭',
                    `${(item.allowedUserIds || []).length} 人`,
                    raw(
                        `<button class="btn btn-secondary btn-sm" data-edit-email="${escapeHtml(item.id)}">编辑</button>`
                    )
                ])
            )}`;
    },

    panel_business() {
        return `<div class="admin-panel-heading"><div><h3>业务设置</h3><p>集中管理业务运行所需的基础配置。</p></div></div><div class="admin-link-grid">
            <a href="#/settings"><strong>汇率与业务数据库</strong><span>查看当前汇率、正式业务状态与快照</span></a>
            <div><strong>编号与付款条件</strong><span>将在完整业务闭环阶段接入</span></div>
            <div><strong>商品与财务资料</strong><span>将在完整业务闭环阶段接入</span></div></div>`;
    },

    panel_data() {
        return `<div class="admin-panel-heading"><div><h3>数据与审计</h3><p>企业配置变更会记录操作者、版本和时间。</p></div></div><div class="admin-summary-grid">
            <article class="admin-summary-card ready"><span>v</span><div><strong>当前数据版本</strong><p>${escapeHtml(String(this.state.meta.version))}</p></div></article>
            <article class="admin-summary-card"><span>↺</span><div><strong>最近更新</strong><p>${escapeHtml(this.state.meta.updatedAt || '—')}</p></div></article>
            <article class="admin-summary-card"><span>人</span><div><strong>最近操作者</strong><p>${escapeHtml(this.state.meta.updatedBy || '—')}</p></div></article></div>
            <div class="card admin-note"><div class="card-body"><p>业务快照和恢复继续在业务设置中管理。恢复不会覆盖账号、角色或被撤销的权限。</p></div></div>`;
    },

    table(headers, rows) {
        const cellHtml = cell =>
            cell && typeof cell === 'object' && Object.hasOwn(cell, '__html') ? cell.__html : escapeHtml(cell ?? '—');
        return `<div class="card"><div class="table-responsive"><table class="table"><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${cellHtml(cell)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}">暂无数据</td></tr>`}</tbody></table></div></div>`;
    },

    bindActions() {
        const action = name =>
            this.target
                .querySelector(`[data-admin-action="${name}"]`)
                ?.addEventListener('click', () => this[`open_${name}`]?.());
        ['enterprise', 'company', 'department', 'member', 'role', 'email'].forEach(action);
        action('onboarding');
        for (const button of this.target.querySelectorAll('[data-edit-company]')) {
            button.onclick = () => this.open_company(selected(this.state.companies, button.dataset.editCompany));
        }
        for (const button of this.target.querySelectorAll('[data-edit-department]')) {
            button.onclick = () =>
                this.open_department(selected(this.state.departments, button.dataset.editDepartment));
        }
        for (const button of this.target.querySelectorAll('[data-edit-member]')) {
            button.onclick = () => this.open_member(selected(this.state.members, button.dataset.editMember));
        }
        for (const button of this.target.querySelectorAll('[data-edit-role]')) {
            button.onclick = () => this.open_role(selected(this.state.roles, button.dataset.editRole));
        }
        for (const button of this.target.querySelectorAll('[data-edit-email]')) {
            button.onclick = () => this.open_email(selected(this.state.emailAccounts, button.dataset.editEmail));
        }
    },

    async save(resource, value, completedStep) {
        await api().adminUpdate({ resource, value, expectedVersion: this.state.meta.version, completedStep });
        if (window.Workspace.refreshSession) await window.Workspace.refreshSession();
        await this.load();
        const returnToOnboarding = this.returnToOnboarding;
        this.returnToOnboarding = false;
        if (returnToOnboarding) await Onboarding.render(this.target);
        else this.draw();
        toast('企业配置已保存', 'success');
    },

    open_enterprise() {
        const item = this.state.enterprise;
        formModal(
            '企业资料',
            `<div class="admin-form-grid"><label class="form-group"><span class="form-label">企业名称</span><input class="form-input" name="name" required value="${escapeHtml(item.name || '')}"></label><label class="form-group"><span class="form-label">语言</span><select class="form-select" name="language"><option value="zh-CN" ${item.language === 'zh-CN' ? 'selected' : ''}>简体中文</option><option value="en" ${item.language === 'en' ? 'selected' : ''}>English</option></select></label><label class="form-group"><span class="form-label">时区</span><input class="form-input" name="timezone" required value="${escapeHtml(item.timezone || 'Asia/Shanghai')}"></label><label class="form-group"><span class="form-label">工作区显示名称</span><input class="form-input" name="displayName" value="${escapeHtml(item.branding?.displayName || '')}"></label></div>`,
            form =>
                this.save(
                    'enterprise',
                    {
                        name: value(form, 'name'),
                        language: value(form, 'language'),
                        timezone: value(form, 'timezone'),
                        displayName: value(form, 'displayName')
                    },
                    'enterprise'
                )
        );
    },

    open_company(item = {}) {
        formModal(
            item.id ? '编辑公司' : '新增公司',
            `<div class="admin-form-grid"><label class="form-group"><span class="form-label">公司编号</span><input class="form-input" name="id" required ${item.id ? 'readonly' : ''} value="${escapeHtml(item.id || '')}" placeholder="如 CO-SH"></label><label class="form-group"><span class="form-label">公司主体名称</span><input class="form-input" name="name" required ${item.id ? 'readonly' : ''} value="${escapeHtml(item.name || '')}"></label><label class="form-group"><span class="form-label">国家或地区</span><input class="form-input" name="country" required ${item.id ? 'readonly' : ''} value="${escapeHtml(item.country || { CN: 'China', HK: 'Hong Kong', US: 'United States' }[item.jurisdiction] || 'China')}"></label><label class="form-group"><span class="form-label">法域代码</span><input class="form-input" name="jurisdiction" required ${item.id ? 'readonly' : ''} value="${escapeHtml(item.jurisdiction || 'CN')}"></label><label class="form-group"><span class="form-label">本位币</span><select class="form-select" name="settlementCurrency" ${item.id ? 'disabled' : ''}><option>CNY</option><option ${item.settlementCurrency === 'USD' ? 'selected' : ''}>USD</option><option ${item.settlementCurrency === 'HKD' ? 'selected' : ''}>HKD</option><option ${item.settlementCurrency === 'EUR' ? 'selected' : ''}>EUR</option></select></label><label class="form-group"><span class="form-label">订单前缀</span><input class="form-input" name="orderPrefix" required value="${escapeHtml(item.orderPrefix || '')}"></label></div>${item.id ? `<p>当前可修改订单前缀。公司主体名称、国家或地区、法域和本位币建立后固定。</p><p>原生账务主体：${escapeHtml(item.nativeCompanyName || item.name || '')}</p>` : ''} `,
            form =>
                this.save(
                    'company',
                    {
                        id: value(form, 'id'),
                        create: !item.id,
                        name: value(form, 'name'),
                        country: value(form, 'country'),
                        jurisdiction: value(form, 'jurisdiction'),
                        settlementCurrency: value(form, 'settlementCurrency') || item.settlementCurrency,
                        orderPrefix: value(form, 'orderPrefix'),
                        profitPolicy: item.profitPolicy || 'generic-native'
                    },
                    'company'
                )
        );
    },

    open_department(item = {}) {
        formModal(
            item.id ? '编辑部门' : '新增部门',
            `<div class="admin-form-grid"><label class="form-group"><span class="form-label">部门编号</span><input class="form-input" name="id" required ${item.id ? 'readonly' : ''} value="${escapeHtml(item.id || '')}"></label><label class="form-group"><span class="form-label">部门名称</span><input class="form-input" name="name" required value="${escapeHtml(item.name || '')}"></label><label class="form-group"><span class="form-label">上级部门</span><select class="form-select" name="parentId">${optionList(
                this.state.departments.filter(other => other.id !== item.id),
                item.parentId,
                '无上级部门'
            )}</select></label><label class="form-group"><span class="form-label">负责人</span><select class="form-select" name="managerId">${optionList(this.state.members, item.managerId)}</select></label></div><fieldset><legend>可访问公司</legend>${checkboxList(
                'visibleCompanyIds',
                this.state.companies.map(company => [company.id, company.name]),
                item.visibleCompanyIds || []
            )}</fieldset>`,
            form =>
                this.save(
                    'department',
                    {
                        id: value(form, 'id'),
                        create: !item.id,
                        name: value(form, 'name'),
                        parentId: value(form, 'parentId'),
                        managerId: value(form, 'managerId'),
                        memberIds: item.memberIds || [],
                        visibleCompanyIds: checked(form, 'visibleCompanyIds')
                    },
                    'organization'
                )
        );
    },

    open_member(item = {}) {
        formModal(
            item.id ? '编辑成员' : '添加成员',
            `<div class="admin-form-grid"><label class="form-group"><span class="form-label">成员编号</span><input class="form-input" name="id" required ${item.id ? 'readonly' : ''} value="${escapeHtml(item.id || '')}"></label><label class="form-group"><span class="form-label">姓名</span><input class="form-input" name="name" required value="${escapeHtml(item.name || '')}"></label><label class="form-group"><span class="form-label">登录邮箱</span><input class="form-input" type="email" name="email" required ${item.id ? 'readonly' : ''} value="${escapeHtml(item.email || '')}"></label><label class="form-group"><span class="form-label">登录名</span><input class="form-input" name="username" required value="${escapeHtml(item.username || '')}"></label><label class="form-group"><span class="form-label">角色</span><select class="form-select" name="role" required>${optionList(this.state.roles, item.role)}</select></label><label class="form-group"><span class="form-label">部门</span><select class="form-select" name="departmentId">${optionList(this.state.departments, item.departmentId || item.teamId, '暂不分配')}</select></label><label class="form-group"><span class="form-label">${item.id ? '重置临时密码（可留空）' : '临时密码（至少 12 位）'}</span><input class="form-input" type="password" name="temporaryPassword" ${item.id ? '' : 'required minlength="12"'} autocomplete="new-password"></label><label class="form-group admin-switch"><input type="checkbox" name="disabled" ${item.enabled === false ? 'checked' : ''}> <span>停用该成员</span></label></div><fieldset><legend>可访问公司</legend>${checkboxList(
                'visibleCompanyIds',
                this.state.companies.map(company => [company.id, company.name]),
                item.visibleCompanyIds || []
            )}</fieldset>`,
            form =>
                this.save(
                    'member',
                    {
                        id: value(form, 'id'),
                        create: !item.id,
                        name: value(form, 'name'),
                        email: value(form, 'email'),
                        username: value(form, 'username'),
                        role: value(form, 'role'),
                        departmentId: value(form, 'departmentId'),
                        temporaryPassword: value(form, 'temporaryPassword') || undefined,
                        disabled: form.elements.namedItem('disabled').checked,
                        visibleCompanyIds: checked(form, 'visibleCompanyIds')
                    },
                    'members'
                )
        );
    },

    open_role(item = {}) {
        formModal(
            item.key ? '编辑角色' : '新增角色',
            `<div class="admin-form-grid"><label class="form-group"><span class="form-label">角色编号</span><input class="form-input" name="key" required ${item.key ? 'readonly' : ''} value="${escapeHtml(item.key || '')}"></label><label class="form-group"><span class="form-label">角色名称</span><input class="form-input" name="label" required value="${escapeHtml(item.label || '')}"></label><label class="form-group"><span class="form-label">数据范围</span><select class="form-select" name="scope"><option value="self" ${item.scope === 'self' ? 'selected' : ''}>本人</option><option value="team" ${item.scope === 'team' ? 'selected' : ''}>本部门</option><option value="tenant" ${item.scope === 'tenant' ? 'selected' : ''}>全企业</option></select></label></div><fieldset><legend>操作权限</legend>${checkboxList(
                'permissions',
                this.state.options.permissions.map(id => [id, permissionLabels[id] || id]),
                item.permissions || []
            )}</fieldset><fieldset><legend>可见页面</legend>${checkboxList(
                'pages',
                this.state.options.pages.map(id => [id, pageLabels[id] || id]),
                item.pages || []
            )}</fieldset>`,
            form =>
                this.save(
                    'role',
                    {
                        key: value(form, 'key'),
                        create: !item.key,
                        label: value(form, 'label'),
                        baseRole: item.baseRole || value(form, 'key'),
                        scope: value(form, 'scope'),
                        permissions: checked(form, 'permissions'),
                        pages: checked(form, 'pages'),
                        readScopes: item.readScopes || {}
                    },
                    'organization'
                )
        );
    },

    open_email(item = {}) {
        formModal(
            item.id ? '编辑企业邮箱' : '添加企业邮箱',
            `<input type="hidden" name="id" value="${escapeHtml(item.id || '')}"><div class="admin-form-grid"><label class="form-group"><span class="form-label">邮箱名称</span><input class="form-input" name="label" required value="${escapeHtml(item.label || '')}"></label><label class="form-group"><span class="form-label">邮箱地址</span><input class="form-input" type="email" name="emailId" required value="${escapeHtml(item.emailId || '')}"></label><label class="form-group"><span class="form-label">服务商</span><select class="form-select" name="service"><option value="">自定义</option><option value="GMail" ${item.service === 'GMail' ? 'selected' : ''}>Gmail</option><option value="Outlook.com" ${['Outlook.com', 'Outlook'].includes(item.service) ? 'selected' : ''}>Outlook</option></select></label><label class="form-group"><span class="form-label">登录名</span><input class="form-input" name="loginId" value="${escapeHtml(item.loginId || item.emailId || '')}"></label><label class="form-group"><span class="form-label">邮箱密码或授权码</span><input class="form-input" type="password" name="password" autocomplete="new-password"></label><label class="form-group admin-switch"><input type="checkbox" name="awaitingPassword" ${enabled(item.awaitingPassword, !item.id) ? 'checked' : ''}> <span>稍后填写密码（邮箱待连接）</span></label><label class="form-group"><span class="form-label">IMAP 服务器</span><input class="form-input" name="incomingServer" value="${escapeHtml(item.incomingServer || '')}"></label><label class="form-group"><span class="form-label">IMAP 端口</span><input class="form-input" type="number" min="1" max="65535" name="incomingPort" value="${escapeHtml(item.incomingPort || '')}"></label><label class="form-group"><span class="form-label">SMTP 服务器</span><input class="form-input" name="smtpServer" value="${escapeHtml(item.smtpServer || '')}"></label><label class="form-group"><span class="form-label">SMTP 端口</span><input class="form-input" type="number" min="1" max="65535" name="smtpPort" value="${escapeHtml(item.smtpPort || '')}"></label><label class="form-group"><span class="form-label">收信加密</span><select class="form-select" name="incomingEncryption"><option value="ssl" ${enabled(item.useSsl, !item.id) ? 'selected' : ''}>SSL（通常 993）</option><option value="starttls" ${enabled(item.useStarttls) ? 'selected' : ''}>STARTTLS（通常 143）</option><option value="none" ${item.id && !enabled(item.useSsl) && !enabled(item.useStarttls) ? 'selected' : ''}>不加密</option></select></label><label class="form-group"><span class="form-label">发信加密</span><select class="form-select" name="outgoingEncryption"><option value="tls" ${enabled(item.useTls, !item.id) ? 'selected' : ''}>STARTTLS（通常 587）</option><option value="ssl" ${enabled(item.useSslForOutgoing) ? 'selected' : ''}>SSL（通常 465）</option><option value="none" ${item.id && !enabled(item.useTls) && !enabled(item.useSslForOutgoing) ? 'selected' : ''}>不加密</option></select></label><label class="form-group admin-switch"><input type="checkbox" name="enableIncoming" ${enabled(item.enableIncoming, !item.id) ? 'checked' : ''}> <span>启用收信</span></label><label class="form-group admin-switch"><input type="checkbox" name="enableOutgoing" ${enabled(item.enableOutgoing, !item.id) ? 'checked' : ''}> <span>启用发信</span></label><label class="form-group admin-switch"><input type="checkbox" name="defaultIncoming" ${item.defaultIncoming ? 'checked' : ''}> <span>设为默认收信邮箱</span></label><label class="form-group admin-switch"><input type="checkbox" name="defaultOutgoing" ${item.defaultOutgoing ? 'checked' : ''}> <span>设为默认发信邮箱</span></label></div><fieldset><legend>可使用成员</legend>${checkboxList(
                'allowedUserIds',
                this.state.members.map(member => [member.id, member.name || member.id]),
                item.allowedUserIds || []
            )}</fieldset>`,
            form =>
                this.save(
                    'email',
                    {
                        id: value(form, 'id'),
                        label: value(form, 'label'),
                        emailId: value(form, 'emailId'),
                        service: value(form, 'service'),
                        loginId: value(form, 'loginId'),
                        password: value(form, 'password') || undefined,
                        awaitingPassword: form.elements.namedItem('awaitingPassword').checked,
                        incomingServer: value(form, 'incomingServer'),
                        incomingPort: value(form, 'incomingPort') || undefined,
                        smtpServer: value(form, 'smtpServer'),
                        smtpPort: value(form, 'smtpPort') || undefined,
                        enableIncoming: form.elements.namedItem('enableIncoming').checked,
                        enableOutgoing: form.elements.namedItem('enableOutgoing').checked,
                        defaultIncoming: form.elements.namedItem('defaultIncoming').checked,
                        defaultOutgoing: form.elements.namedItem('defaultOutgoing').checked,
                        useImap: true,
                        useSsl: value(form, 'incomingEncryption') === 'ssl',
                        useStarttls: value(form, 'incomingEncryption') === 'starttls',
                        useTls: value(form, 'outgoingEncryption') === 'tls',
                        useSslForOutgoing: value(form, 'outgoingEncryption') === 'ssl',
                        allowedUserIds: checked(form, 'allowedUserIds')
                    },
                    'business'
                )
        );
    },

    open_onboarding() {
        window.location.hash = '#/onboarding';
    }
};

const Onboarding = {
    target: null,
    async render(target = document.getElementById('pageContent')) {
        this.target = target;
        try {
            if (Auth.hasCapability('accounts.configure') !== true) throw new Error('当前账号没有企业管理权限。');
            await AdminCenter.load();
            this.draw();
        } catch (error) {
            target.innerHTML = `<div class="card"><div class="card-body">${escapeHtml(error.message)}</div></div>`;
        }
    },
    draw() {
        const state = AdminCenter.state;
        const currentIndex = Math.max(
            0,
            steps.findIndex(([key]) => key === state.onboarding.currentStep)
        );
        this.target.innerHTML = `<section class="onboarding-shell"><header><p class="page-eyebrow">WELCOME TO TRADEPT</p><h2>${state.onboarding.status === 'complete' ? '企业配置已完成' : '建立你的企业工作区'}</h2><p>进度会自动保存，可以随时退出后继续。</p><div class="onboarding-progress"><span style="width:${Math.round((state.onboarding.completedSteps.length / steps.length) * 100)}%"></span></div></header><div class="onboarding-steps">${steps
            .map(([key, title, description], index) => {
                const done = state.onboarding.completedSteps.includes(key);
                return `<article class="${done ? 'done' : ''} ${index === currentIndex ? 'current' : ''}"><span>${done ? '✓' : index + 1}</span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div><button class="btn ${index === currentIndex ? 'btn-primary' : 'btn-secondary'} btn-sm" data-onboarding-step="${key}">${done ? '查看' : '开始'}</button></article>`;
            })
            .join(
                ''
            )}</div><footer><a href="#/admin" class="btn btn-secondary">进入管理中心</a>${state.onboarding.requiredReady && state.onboarding.status !== 'complete' ? '<button class="btn btn-primary" data-onboarding-complete>完成初始化</button>' : state.onboarding.status === 'complete' ? '<a href="#/dashboard" class="btn btn-primary">进入工作台</a>' : '<span>完成企业资料、公司、角色和管理员后即可开始使用。</span>'}</footer></section>`;
        for (const button of this.target.querySelectorAll('[data-onboarding-step]')) {
            button.onclick = () => this.open(button.dataset.onboardingStep);
        }
        this.target.querySelector('[data-onboarding-complete]')?.addEventListener('click', () => this.complete());
    },
    open(step) {
        const actions = {
            enterprise: () => AdminCenter.open_enterprise(),
            company: () => AdminCenter.open_company(AdminCenter.state.companies[0]),
            organization: () => AdminCenter.open_department(AdminCenter.state.departments[0]),
            members: () => AdminCenter.open_member(AdminCenter.state.members[0]),
            business: () =>
                AdminCenter.state.options.emailAvailable
                    ? AdminCenter.open_email(AdminCenter.state.emailAccounts[0])
                    : this.markBusinessReady(),
            finish: () => this.complete()
        };
        AdminCenter.target = this.target;
        AdminCenter.returnToOnboarding = true;
        actions[step]?.();
    },
    async markBusinessReady() {
        try {
            await api().adminUpdate({
                resource: 'onboarding',
                expectedVersion: AdminCenter.state.meta.version,
                value: { currentStep: 'finish', completedSteps: ['business'], businessPrepared: true }
            });
            if (window.Workspace.refreshSession) await window.Workspace.refreshSession();
            await this.render(this.target);
        } catch (error) {
            toast(error.message || '保存失败', 'warning');
        }
    },
    async complete() {
        try {
            await api().adminUpdate({
                resource: 'onboarding',
                expectedVersion: AdminCenter.state.meta.version,
                value: {
                    currentStep: 'finish',
                    completedSteps: ['finish'],
                    businessPrepared: AdminCenter.state.onboarding.checks.business,
                    complete: true
                }
            });
            if (window.Workspace.refreshSession) await window.Workspace.refreshSession();
            toast('企业初始化已完成', 'success');
            window.location.hash = '#/dashboard';
        } catch (error) {
            toast(error.message || '初始化尚未完成', 'warning');
        }
    }
};

window.AdminCenter = AdminCenter;
window.Onboarding = Onboarding;
export { AdminCenter, Onboarding };
