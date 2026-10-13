import { Auth } from './auth.js';
import { DB } from './data.js';
import { escapeHtml } from './utils.js';

const h = value => escapeHtml(String(value ?? ''));
const api = () => window.Workspace?.api;
const app = () => window.App;
const clone = value => JSON.parse(JSON.stringify(value));
const key = () => {
    if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
    return [...globalThis.crypto.getRandomValues(new Uint8Array(16))]
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
};
const identity = () =>
    JSON.stringify([
        Auth.currentUser?.tenantId,
        Auth.currentUser?.id,
        Auth.currentUser?.role,
        Auth.currentUser?.permissions,
        Auth.currentUser?.visibleCompanyIds,
        DB.currentCompanyId
    ]);
const labels = {
    itemCode: '商品编码',
    itemName: '商品名称',
    itemGroup: '商品分组',
    stockUom: '计量单位',
    description: '商品说明'
};
const valueOf = (item, field) =>
    item?.[field] ?? (field === 'itemName' ? item?.label : field === 'stockUom' ? item?.uom : undefined) ?? '';
const textInput = (name, value, readonly = false) =>
    `<label class="form-group"><span class="form-label">${labels[name]}</span><input class="form-input" name="${name}" value="${h(value)}" required ${readonly ? 'readonly' : ''}></label>`;
const select = (name, items, current) => {
    const choices = (items || []).map(item => (typeof item === 'string' ? { name: item } : item));
    // An existing historical value may be retained, but is not invented as a new choice.
    const retained = current && !choices.some(item => String(item.name) === String(current));
    return `<label class="form-group"><span class="form-label">${labels[name]}</span><select class="form-select" name="${name}" required><option value="">请选择</option>${retained ? `<option value="${h(current)}" selected>${h(current)}（当前值）</option>` : ''}${choices.map(item => `<option value="${h(item.name)}" ${String(item.name) === String(current) ? 'selected' : ''}>${h(item.label || item.name)}</option>`).join('')}</select></label>`;
};
const conflict = error =>
    error.status === 409 || ['CONFLICT', 'VERSION_CONFLICT', 'STALE_VERSION', 'STALE_DOCUMENT'].includes(error.code);
const uncertain = error =>
    error.code === 'NETWORK' ||
    error.code === 'INVALID_RESPONSE' ||
    error.name === 'AbortError' ||
    Number(error.status) >= 500 ||
    (!error.status && !['INVALID_REQUEST', 'INVALID_RECORD', 'LOCAL_CHANGES'].includes(error.code));

/** Minimal native Item maintenance; ERPNext remains the sole catalog authority. */
export const ItemCatalog = {
    epoch: 0,
    generation: 0,
    state: null,
    root: null,
    pending: null,
    context: null,
    companyId: null,
    onChanged: null,
    observer: null,
    timer: null,
    search: '',
    offset: 0,

    clear(close = true) {
        const owned = this.root?.isConnected;
        this.epoch += 1;
        this.generation += 1;
        this.observer?.disconnect();
        clearInterval(this.timer);
        this.observer = null;
        this.timer = null;
        this.state = null;
        this.pending = null;
        this.context = null;
        this.companyId = null;
        this.onChanged = null;
        this.search = '';
        this.offset = 0;
        this.root = null;
        if (close && owned) app().closeModal();
    },

    active(epoch = this.epoch) {
        if (epoch !== this.epoch) return false;
        if (this.context !== identity()) {
            this.clear();
            return false;
        }
        if (!this.root?.isConnected) {
            this.clear(false);
            return false;
        }
        return true;
    },

    can(operation, item = null) {
        if (Auth.hasCapability(`catalog.${operation}`) !== true) return false;
        const caps = this.state?.capabilities;
        const granted = Array.isArray(caps)
            ? caps.includes(`catalog.${operation}`) || caps.includes(operation) || caps.includes('*')
            : caps?.[operation] === true || caps?.[`catalog.${operation}`] === true || caps?.['*'] === true;
        if (!granted) return false;
        if (item && operation === 'write') return item.canWrite === true;
        if (item && operation === 'disable') return item.canDisable === true;
        return true;
    },

    mount(body, footer) {
        this.observer?.disconnect();
        clearInterval(this.timer);
        const id = `itemCatalog-${key()}`;
        app().showModal('商品目录', `<section id="${id}" data-item-catalog-root>${body}</section>`, {
            large: true,
            footer
        });
        this.root = document.getElementById(id);
        const root = this.root;
        this.observer = new window.MutationObserver(() => {
            if (this.root === root && !root.isConnected) this.clear(false);
        });
        this.observer.observe(document.getElementById('modalContainer'), { childList: true });
        this.timer = setInterval(() => this.active(), 250);
        document.querySelector('[data-catalog-close]').onclick = () => this.clear();
    },

    async open(companyId = DB.currentCompanyId, onChanged = null) {
        this.clear();
        this.companyId = companyId;
        this.context = identity();
        this.onChanged = onChanged;
        if (!Auth.currentUser || Auth.hasCapability('catalog.read') !== true || !companyId) {
            this.mount('<p role="alert">没有商品目录访问权限，或尚未选择公司主体。</p>', this.closeButton());
            return;
        }
        await this.load();
    },

    closeButton(label = '关闭') {
        return `<button type="button" class="btn btn-secondary" data-catalog-close>${label}</button>`;
    },

    async load({ search = this.search, offset = this.offset } = {}) {
        const epoch = this.epoch;
        const generation = ++this.generation;
        this.pending = null;
        this.search = search;
        this.offset = offset;
        this.mount('<p role="status">正在读取商品目录…</p>', this.closeButton());
        try {
            const state = await api().catalogState({
                companyId: this.companyId,
                includeDisabled: true,
                search,
                offset,
                limit: 100
            });
            if (!this.active(epoch) || generation !== this.generation) return;
            this.state = state;
            if (!this.can('read')) throw new Error('商品目录权限已变化，请由企业管理员核对授权。');
            this.draw();
        } catch (error) {
            if (!this.active(epoch) || generation !== this.generation) return;
            this.state = null;
            this.mount(
                `<p role="alert">${h(error.message || '商品目录未能加载。')}</p><button type="button" class="btn btn-secondary" data-catalog-reload>重新读取</button>`,
                this.closeButton()
            );
            this.root.querySelector('[data-catalog-reload]').onclick = () => this.load();
        }
    },

    draw(message = '') {
        if (!this.active() || !this.can('read')) return;
        const items = this.state.items || [];
        const company = this.state.companies?.find(item => String(item.id) === String(this.companyId));
        const hasMore = this.state.pagination?.hasMore ?? items.length === 100;
        this.mount(
            `<p class="form-hint">${h(company?.name || this.companyId)} · 商品直接保存在企业商品目录中。新商品用于采购转售，不记录库存；报价、订单和账单使用同一商品编码。</p>${message ? `<p role="status">${h(message)}</p>` : ''}<form class="filter-bar" data-catalog-query><label class="form-group"><span class="form-label">查找商品</span><input class="form-input" type="search" data-catalog-search placeholder="编码或名称" value="${h(this.search)}"></label><button type="submit" class="btn btn-secondary">查找</button>${this.can('create') ? '<button type="button" class="btn btn-primary" data-catalog-create>新建商品</button>' : ''}<button type="button" class="btn btn-secondary" data-catalog-reload>重新读取</button></form><div class="table-container"><table><thead><tr><th>商品编码</th><th>商品名称</th><th>分组 / 单位</th><th>状态</th><th>操作</th></tr></thead><tbody>${items.length ? items.map((item, index) => `<tr data-catalog-row="${index}"><td>${h(item.itemCode || item.name)}</td><td>${h(valueOf(item, 'itemName'))}${item.shared ? '<small> · 共享商品</small>' : ''}</td><td>${h(item.itemGroup)} / ${h(valueOf(item, 'stockUom'))}</td><td>${item.disabled ? '已停用' : '可用'}</td><td>${this.can('write', item) ? `<button type="button" class="btn btn-secondary btn-sm" data-catalog-edit="${index}">编辑</button>` : ''}${this.can('disable', item) ? `<button type="button" class="btn btn-secondary btn-sm" data-catalog-disable="${index}">${item.disabled ? '启用' : '停用'}</button>` : ''}${!this.can('write', item) && !this.can('disable', item) ? '只读' : ''}</td></tr>`).join('') : `<tr><td colspan="5">${this.search || this.offset ? '当前查询没有商品，请调整查找条件。' : '暂无商品。先建立真实商品，再为订单或账单选择商品编码。'}</td></tr>`}</tbody></table></div>${this.offset || hasMore ? `<div class="filter-bar"><button type="button" class="btn btn-secondary" data-catalog-previous ${this.offset ? '' : 'disabled'}>上一页</button><span>第 ${Math.floor(this.offset / 100) + 1} 页</span><button type="button" class="btn btn-secondary" data-catalog-next ${hasMore ? '' : 'disabled'}>下一页</button></div>` : ''}<p class="form-hint">停用商品保留历史关联，不能用于新单据。共享商品的修改与停用以企业授权为准。</p>`,
            this.closeButton()
        );
        this.root.querySelector('[data-catalog-create]')?.addEventListener('click', () => this.editor());
        this.root.querySelector('[data-catalog-reload]').onclick = () => this.load();
        this.root.querySelector('[data-catalog-query]').onsubmit = event => {
            event.preventDefault();
            return this.load({ search: this.root.querySelector('[data-catalog-search]').value.trim(), offset: 0 });
        };
        this.root
            .querySelector('[data-catalog-previous]')
            ?.addEventListener('click', () => this.load({ offset: Math.max(0, this.offset - 100) }));
        this.root
            .querySelector('[data-catalog-next]')
            ?.addEventListener('click', () => this.load({ offset: this.offset + 100 }));
        for (const button of this.root.querySelectorAll('[data-catalog-edit]')) {
            button.onclick = () => this.editor(items[Number(button.dataset.catalogEdit)]);
        }
        for (const button of this.root.querySelectorAll('[data-catalog-disable]')) {
            button.onclick = () => this.toggle(items[Number(button.dataset.catalogDisable)]);
        }
        this.root.querySelector('[data-catalog-search]').oninput = event => {
            const query = event.target.value.trim().toLocaleLowerCase();
            for (const row of this.root.querySelectorAll('[data-catalog-row]')) {
                const item = items[Number(row.dataset.catalogRow)];
                row.hidden = !`${item.itemCode || item.name} ${valueOf(item, 'itemName')}`
                    .toLocaleLowerCase()
                    .includes(query);
            }
        };
    },

    editor(item = null) {
        if (!this.active() || !this.can(item ? 'write' : 'create', item)) return;
        const groups = this.state.options?.itemGroups || [];
        const uoms = this.state.options?.uoms || [];
        const value = field => valueOf(item, field);
        const group = item ? value('itemGroup') : groups.length === 1 ? groups[0].name || groups[0] : '';
        const uom = item ? value('stockUom') : uoms.length === 1 ? uoms[0].name || uoms[0] : '';
        this.form(
            item ? 'save' : 'create',
            item,
            `<h3>${item ? '编辑商品' : '新建商品'}</h3><div class="form-row">${textInput('itemCode', item?.itemCode || item?.name || '', !!item)}${textInput('itemName', value('itemName'))}</div><div class="form-row">${select('itemGroup', groups, group)}${select('stockUom', uoms, uom)}</div><label class="form-group"><span class="form-label">商品说明</span><textarea class="form-input" name="description" rows="3">${h(value('description'))}</textarea></label><div class="form-row"><label><input type="checkbox" name="isSalesItem" ${!item || item.isSalesItem == null || item.isSalesItem ? 'checked' : ''}> 可销售</label><label><input type="checkbox" name="isPurchaseItem" ${!item || item.isPurchaseItem == null || item.isPurchaseItem ? 'checked' : ''}> 可采购</label></div><p class="form-hint">${item ? `商品编码保持不变。${item.isStockItem ? '此商品原有库存设置保持不变。' : '此商品用于采购转售，不记录库存。'}` : '新商品固定为非库存商品，用于采购转售。库存、价格和公司账务设置由原生规则管理。'}</p>`,
            form => {
                const values = Object.fromEntries(
                    ['itemName', 'itemGroup', 'stockUom', 'description'].map(name => [
                        name,
                        form.elements.namedItem(name).value.trim()
                    ])
                );
                if (!item) values.itemCode = form.elements.namedItem('itemCode').value.trim();
                values.isSalesItem = form.elements.namedItem('isSalesItem').checked;
                values.isPurchaseItem = form.elements.namedItem('isPurchaseItem').checked;
                return values;
            }
        );
    },

    toggle(item) {
        if (!this.active() || !this.can('disable', item)) return;
        this.form(
            'disable',
            item,
            `<h3>${item.disabled ? '启用' : '停用'}商品 · ${h(item.itemCode || item.name)}</h3><p>${h(valueOf(item, 'itemName'))}</p><p>${item.disabled ? '启用后，可按原有销售与采购设置用于新单据。' : '停用后不能用于新单据；已有订单、账单和历史记录保留。'}</p>`,
            () => ({ disabled: !item.disabled }),
            item.disabled ? '确认启用' : '确认停用'
        );
    },

    form(operation, item, body, prepare, label = '保存') {
        const epoch = this.epoch;
        const pending = {
            operation,
            item,
            version: this.state.version,
            key: key(),
            command: null,
            uncertain: false,
            blocked: false,
            inFlight: false,
            applied: false
        };
        this.pending = pending;
        const formId = `catalogForm-${key()}`;
        this.mount(
            `<form id="${formId}" data-catalog-form>${body}<div data-catalog-message role="status" hidden></div></form>`,
            `${this.closeButton('取消')}<button type="button" class="btn btn-secondary" data-catalog-latest hidden>读取最新版本</button><button type="submit" form="${formId}" class="btn btn-primary" data-catalog-save>${label}</button>`
        );
        const form = this.root.querySelector('form');
        const button = document.querySelector('[data-catalog-save]');
        const latest = document.querySelector('[data-catalog-latest]');
        const message = form.querySelector('[data-catalog-message]');
        const current = () => this.active(epoch) && this.pending === pending && form.isConnected;
        form.onsubmit = async event => {
            event.preventDefault();
            if (!current() || pending.inFlight || pending.blocked || pending.applied) return;
            if (!pending.uncertain && !form.reportValidity()) return;
            if (!this.can(operation === 'save' ? 'write' : operation, item)) return;
            pending.inFlight = true;
            button.disabled = true;
            message.hidden = true;
            try {
                if (!pending.command) {
                    pending.command = {
                        companyId: this.companyId,
                        operation,
                        expectedVersion: pending.version,
                        idempotencyKey: pending.key,
                        values: prepare(form),
                        ...(item ? { name: item.name, expectedModified: item.modified } : {})
                    };
                }
                const result = await api().catalogOperation(clone(pending.command));
                if (!current()) return;
                pending.applied = true;
                this.search = '';
                this.offset = 0;
                for (const control of form.elements) control.disabled = true;
                message.hidden = false;
                message.textContent = '商品已保存，正在读取最新目录…';
                const state = await api().catalogState({
                    companyId: this.companyId,
                    includeDisabled: true,
                    limit: 100
                });
                if (!current()) return;
                this.state = state;
                this.pending = null;
                this.draw('商品已保存。');
                if (this.onChanged) {
                    try {
                        await this.onChanged({
                            companyId: this.companyId,
                            document: result.document,
                            version: state.version
                        });
                    } catch (_) {
                        // The native write is acknowledged; a business-view refresh is a separate step.
                        if (this.active(epoch)) this.draw('商品已保存。业务视图尚未刷新，请重新读取业务数据。');
                    }
                }
            } catch (error) {
                if (!current()) return;
                message.hidden = false;
                if (pending.applied) {
                    message.textContent = `商品已保存，但最新目录未能读取：${error.message || '请重新读取。'}`;
                    latest.hidden = false;
                    latest.textContent = '重新读取目录';
                    latest.onclick = () => this.load();
                } else if (conflict(error)) {
                    pending.blocked = true;
                    message.textContent =
                        '商品或企业版本已变化，当前输入已保留。请读取服务器最新内容并核对后重新编辑。';
                    latest.hidden = false;
                } else if (uncertain(error)) {
                    pending.uncertain = true;
                    for (const control of form.elements) control.disabled = true;
                    message.textContent = '保存结果尚不确定。再次确认会使用相同请求标识和内容，避免重复创建商品。';
                    button.textContent = '使用同一请求确认结果';
                    button.disabled = false;
                } else {
                    pending.command = null;
                    pending.key = key();
                    pending.blocked = error.status === 403 || error.status === 401;
                    message.textContent = error.message || '保存失败，当前输入已保留。';
                    button.disabled = pending.blocked;
                }
            } finally {
                pending.inFlight = false;
                if (current() && !pending.applied && !pending.blocked) button.disabled = false;
            }
        };
        latest.onclick = async () => {
            if (!current() || latest.disabled) return;
            latest.disabled = true;
            try {
                const state = await api().catalogState({
                    companyId: this.companyId,
                    ...(item ? { name: item.name } : {}),
                    includeDisabled: true,
                    limit: 100
                });
                if (!current()) return;
                const document = state.document || state.items?.find(entry => entry.name === item?.name);
                message.innerHTML = `<p>原输入保留在上方，旧保存按钮保持关闭。请以服务器最新内容重新编辑。</p>${document ? this.summary(document) : '<p>服务器最新目录已读取。</p>'}<button type="button" class="btn btn-secondary" data-catalog-reopen>${item ? '以最新内容重新编辑' : '以最新版本重新新建'}</button>`;
                const reopen = message.querySelector('[data-catalog-reopen]');
                const permission = operation === 'save' ? 'write' : operation;
                this.state = state;
                reopen.disabled = !this.can(permission, item ? document : null) || (!!item && !document);
                reopen.onclick = () => {
                    if (!current() || reopen.disabled) return;
                    this.pending = null;
                    if (operation === 'disable') this.toggle(document);
                    else this.editor(item ? document : null);
                };
                latest.hidden = true;
            } catch (error) {
                if (current()) message.textContent = `${error.message || '最新内容未能读取。'} 当前输入仍保留。`;
            } finally {
                if (current()) latest.disabled = false;
            }
        };
    },

    summary(item) {
        return `<div class="card"><h4>服务器最新商品 · 只读</h4>${Object.entries(labels)
            .map(
                ([field, label]) =>
                    `<p><strong>${label}</strong>：${h(field === 'itemCode' ? item.itemCode || item.name : valueOf(item, field))}</p>`
            )
            .join('')}<p>状态：${item.disabled ? '已停用' : '可用'}</p></div>`;
    }
};

window.ItemCatalog = ItemCatalog;
