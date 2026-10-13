/** Session-local business input drafts. Never submits data or stores credentials. */
const FORMS = new Set(['customerForm', 'factoryForm', 'shipmentForm', 'statusForm', 'orderForm']);
const SECRET = /password|passwd|secret|token|credential|api.?key|csrf|authorization/i;
const controllers = new WeakMap();
const active = new Set();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sensitive = name => SECRET.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name);
const usable = input =>
    input.name &&
    !input.disabled &&
    !input.readOnly &&
    !['password', 'file', 'hidden', 'submit', 'button', 'reset'].includes(input.type) &&
    !sensitive(input.name);
const controls = (form, options = {}) =>
    [...form.elements].filter(input => usable(input) && options.allowField?.(input) !== false);
const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => !sensitive(key))
                .map(([key, item]) => [key, clean(item)])
        );
    }
    return value;
};
function capture(form, options, generateIds = false) {
    const fields = Object.create(null);
    for (const input of controls(form, options)) {
        if (options.dynamic && input.closest('[data-draft-dynamic], #contactsContainer')) continue;
        (fields[input.name] ||= []).push({
            type: input.type,
            value: input.value,
            ...(['checkbox', 'radio'].includes(input.type) ? { checked: input.checked } : {})
        });
    }
    return {
        fields,
        ...(options.dynamic ? { dynamic: dynamicValue(options, options.dynamic.capture({ generateIds })) } : {})
    };
}
function dynamicValue(options, value) {
    return clean(options.dynamic?.sanitize ? options.dynamic.sanitize(value) : value);
}
function dynamicReason(options, value, base) {
    const result = options.dynamic?.validate?.(value, base);
    return typeof result === 'string' ? result : result === false ? '关联资料已不可用，请重新选择。' : '';
}
function dynamicEqual(options, a, b) {
    return options.dynamic?.equal ? options.dynamic.equal(a, b) : equal(a, b);
}
function stateEqual(options, a, b) {
    return equal(a.fields, b.fields) && (!options.dynamic || dynamicEqual(options, a.dynamic, b.dynamic));
}
function keyFor(form, options) {
    const scope = options.scope || {};
    if (!FORMS.has(form.id) || !scope.tenantId || !scope.userId || !scope.companyId || !scope.instance) return null;
    return (
        'tradept:form-draft:v1:' +
        encodeURIComponent(
            JSON.stringify([
                scope.origin || window.location.origin,
                scope.instance,
                scope.tenantId,
                scope.userId,
                scope.companyId,
                form.id,
                options.recordId || 'new'
            ])
        )
    );
}
function read(key) {
    if (!key) return null;
    try {
        const value = JSON.parse(sessionStorage.getItem(key));
        return value?.v === 1 && value.base?.fields && value.state?.fields ? value : null;
    } catch {
        return null;
    }
}
function showNotice(controller) {
    controller.form.querySelector('[data-form-draft-notice]')?.remove();
    if (!controller.conflicts.length) return;
    const box = document.createElement('div');
    box.dataset.formDraftNotice = 'true';
    box.setAttribute('role', 'alert');
    const text = document.createElement('p');
    text.textContent =
        '服务器资料、权限或可用选项已变化。冲突草稿已保留，未覆盖当前资料；请核对后确认使用当前页面资料。';
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '查看保留的冲突草稿';
    const values = document.createElement('pre');
    values.textContent = Object.entries(controller.retained)
        .map(([name, value]) => {
            if (name === 'dynamic') {
                return (
                    controller.options.dynamic?.describe?.(value) ||
                    `已保留 ${value.length || 0} 行资料，请重新打开后核对。`
                );
            }
            if (name === 'pendingRecordId') return '上次创建的记录暂时无法核实，请重新打开后核对。';
            if (!Array.isArray(value)) return String(value);
            const input = controls(controller.form, controller.options).find(field => field.name === name);
            const label =
                input?.closest('.form-group')?.querySelector('label')?.textContent.replace(/\*/g, '').trim() ||
                '填写内容';
            return `${label}：${value.map(item => item.value).join('、')}`;
        })
        .join('\n');
    details.append(summary, values);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = controller.reloadRequired ? '请关闭并重新打开此记录后核对' : '确认使用当前页面资料继续';
    button.disabled = Boolean(controller.reloadRequired);
    button.addEventListener('click', () => {
        controller.conflicts = [];
        controller.retained = {};
        box.remove();
        persist(controller.form);
    });
    box.append(text, details, button);
    controller.form.prepend(box);
}
function restore(controller, saved) {
    const { form, options, base } = controller;
    // DB may still contain our own staged, unacknowledged record after a failed
    // save. Compare a reopened form against that snapshot before restoring edits
    // made after staging; genuine server changes still use three-way checks.
    const priorBase = saved.stagedState || saved.base;
    const retained = {};
    for (const [name, current] of Object.entries(base.fields)) {
        const old = priorBase.fields[name];
        const draft = saved.state.fields[name];
        if (!draft) continue;
        const inputs = controls(form, options).filter(input => input.name === name);
        const unavailable = inputs.some(
            (input, index) =>
                input.tagName === 'SELECT' && ![...input.options].some(option => option.value === draft[index]?.value)
        );
        if (unavailable || (!equal(current, old) && !equal(draft, old) && !equal(current, draft))) {
            retained[name] = draft;
            continue;
        }
        if (!equal(current, old)) continue;
        inputs.forEach((input, index) => {
            if (!draft[index] || draft[index].type !== input.type) return;
            input.value = draft[index].value;
            if (Object.hasOwn(draft[index], 'checked')) input.checked = draft[index].checked;
        });
    }
    if (options.dynamic && saved.state.dynamic) {
        const draft = dynamicValue(options, saved.state.dynamic);
        const prior = dynamicValue(options, priorBase.dynamic);
        const reason = dynamicReason(options, draft, base.dynamic);
        if (reason) {
            retained.dynamic = draft;
            retained.dynamicReason = reason;
        } else if (dynamicEqual(options, base.dynamic, prior) || dynamicEqual(options, base.dynamic, draft)) {
            options.dynamic.restore(draft);
        } else if (!dynamicEqual(options, draft, prior) && !dynamicEqual(options, base.dynamic, draft)) {
            retained.dynamic = draft;
        }
    }
    // Keep only still-rendered fields; permission changes never resurrect hidden financial inputs.
    for (const [name, value] of Object.entries(saved.retained || {})) {
        if (name === 'dynamic' && options.dynamic) retained.dynamic = dynamicValue(options, value);
        else if (name === 'dynamicReason' && options.dynamic) retained.dynamicReason = value;
        else if (Object.hasOwn(base.fields, name)) retained[name] = value;
    }
    const pendingRecordId = saved.pendingRecordId || saved.retained?.pendingRecordId;
    if (pendingRecordId) {
        if (options.pendingExists?.(pendingRecordId)) form.dataset.pendingRecordId = pendingRecordId;
        else retained.pendingRecordId = pendingRecordId;
    }
    controller.retained = retained;
    controller.conflicts = Object.keys(retained);
    showNotice(controller);
}
function dirty(controller) {
    return (
        !controller.acknowledged &&
        (controller.conflicts.length > 0 ||
            Boolean(controller.form.dataset.pendingRecordId) ||
            !equal(capture(controller.form, controller.options), controller.base))
    );
}
function persist(form) {
    const controller = controllers.get(form);
    if (!controller || controller.acknowledged || !controller.key) return false;
    if (!dirty(controller) && !controller.hasSaved) return true;
    const state = capture(form, controller.options, true);
    const names = new Set(Object.keys(state.fields));
    const retained = Object.fromEntries(
        Object.entries(controller.retained)
            .filter(
                ([name]) =>
                    names.has(name) ||
                    ['dynamic', 'dynamicReason', 'pendingRecordId', 'recordChanged', 'scopeChanged'].includes(name)
            )
            .map(([name, value]) => [name, name === 'dynamic' ? dynamicValue(controller.options, value) : value])
    );
    const entry = {
        v: 1,
        base: {
            fields: Object.fromEntries(Object.entries(controller.base.fields).filter(([name]) => names.has(name))),
            ...(controller.options.dynamic
                ? { dynamic: dynamicValue(controller.options, controller.base.dynamic) }
                : {})
        },
        state,
        ...(controller.stagedState
            ? {
                  stagedState: {
                      fields: Object.fromEntries(
                          Object.entries(controller.stagedState.fields).filter(([name]) => names.has(name))
                      ),
                      ...(controller.options.dynamic
                          ? { dynamic: dynamicValue(controller.options, controller.stagedState.dynamic) }
                          : {})
                  }
              }
            : {}),
        retained,
        pendingRecordId: form.dataset.pendingRecordId || null
    };
    controller.retained = retained;
    controller.conflicts = Object.keys(retained);
    try {
        sessionStorage.setItem(controller.key, JSON.stringify(entry));
        controller.hasSaved = true;
        return true;
    } catch {
        if (!form.querySelector('[data-draft-storage-error]')) {
            const warning = document.createElement('p');
            warning.dataset.draftStorageError = 'true';
            warning.setAttribute('role', 'alert');
            warning.textContent = '浏览器无法保存输入草稿，请保持此页面打开并完成保存。';
            form.prepend(warning);
        }
        return false;
    }
}
function checkCurrentRecord(controller) {
    if (!controller || controller.acknowledged) return;
    if (controller.options.dynamic) {
        const value = capture(controller.form, controller.options).dynamic;
        const reason = dynamicReason(controller.options, value, controller.base.dynamic);
        if (reason) {
            controller.dynamicInvalid = true;
            controller.retained.dynamic = value;
            controller.retained.dynamicReason = reason;
            controller.conflicts = Object.keys(controller.retained);
            showNotice(controller);
            persist(controller.form);
        } else if (controller.dynamicInvalid) {
            controller.dynamicInvalid = false;
            delete controller.retained.dynamic;
            delete controller.retained.dynamicReason;
            controller.conflicts = Object.keys(controller.retained);
            showNotice(controller);
            persist(controller.form);
        }
    }
    if (controller.options.getScope && !equal(controller.options.scope, controller.options.getScope())) {
        persist(controller.form);
        controller.reloadRequired = true;
        controller.retained.scopeChanged =
            '账号、实例或当前公司已变化，请重新打开业务表单。原草稿仍按原账号和公司隔离。';
        controller.conflicts = Object.keys(controller.retained);
        showNotice(controller);
        persist(controller.form);
        return;
    }
    if (!controller.options.getRecord) return;
    if (equal(controller.recordBase, clean(controller.options.getRecord()))) return;
    // A poll may replace DB records while this form is open. Preserve its old base
    // and require reopening; never adopt the new DB version with stale inputs.
    persist(controller.form);
    controller.reloadRequired = true;
    controller.retained.recordChanged = '记录已在服务器更新，请关闭并重新打开后核对保留的草稿。';
    controller.conflicts = Object.keys(controller.retained);
    showNotice(controller);
    persist(controller.form);
}
function watch(form, options = {}) {
    if (!form || !FORMS.has(form.id)) return null;
    for (const controller of active) {
        if (!controller.form.isConnected) active.delete(controller);
    }
    const previous = controllers.get(form);
    const key = keyFor(form, options);
    // A cancelled modal replacement leaves the original DOM in place. Its draft
    // must not be relabelled as another record/account by the caller's next hook.
    if (previous?.key && previous.key !== key) return previous;
    if (previous) {
        form.removeEventListener('input', previous.onInput);
        form.removeEventListener('change', previous.onInput);
        form.removeEventListener('submit', previous.onSubmit, true);
        active.delete(previous);
    }
    const controller = {
        form,
        options,
        key,
        base: capture(form, options),
        retained: {},
        conflicts: [],
        acknowledged: false,
        hasSaved: false
    };
    controller.recordBase = options.getRecord ? clean(options.getRecord()) : null;
    controller.onInput = () => persist(form);
    controller.onSubmit = event => {
        checkCurrentRecord(controller);
        persist(form);
        if (controller.conflicts.length) {
            event.preventDefault();
            event.stopImmediatePropagation();
            showNotice(controller);
        }
    };
    controllers.set(form, controller);
    active.add(controller);
    form.addEventListener('input', controller.onInput);
    form.addEventListener('change', controller.onInput);
    form.addEventListener('submit', controller.onSubmit, true);
    const saved = read(controller.key);
    if (saved) {
        controller.hasSaved = true;
        restore(controller, saved);
        persist(form);
    }
    return controller;
}
export const FormDrafts = {
    attach: watch,
    pendingFor(formId, options) {
        const saved = read(keyFor({ id: formId }, options));
        return saved?.pendingRecordId || saved?.retained?.pendingRecordId || null;
    },
    watch: form => controllers.get(form) || watch(form),
    dismissAll() {
        let preserved = true;
        for (const controller of [...active]) {
            if (!controller.form.isConnected) {
                active.delete(controller);
                continue;
            }
            // On forced login, preserve the last saved draft under its original
            // user key rather than relabelling it using the cleared auth state.
            const changedScope =
                controller.options.getScope && !equal(controller.options.scope, controller.options.getScope());
            if (!(changedScope && controller.hasSaved)) {
                const ok = persist(controller.form);
                if (dirty(controller) && controller.key && !ok) preserved = false;
            }
            controller.form.removeEventListener('input', controller.onInput);
            controller.form.removeEventListener('change', controller.onInput);
            controller.form.removeEventListener('submit', controller.onSubmit, true);
            controllers.delete(controller.form);
            active.delete(controller);
        }
        return preserved;
    },
    persist,
    stageRecord(form) {
        const controller = controllers.get(form);
        if (controller) controller.stagedState = capture(form, controller.options, true);
        if (controller?.options.getRecord) controller.recordBase = clean(controller.options.getRecord());
        // Own unacknowledged DB edits are not a remote change; keep the saved form base.
        return persist(form);
    },
    canSubmit(form) {
        const controller = controllers.get(form);
        checkCurrentRecord(controller);
        return !controller?.conflicts.length;
    },
    acknowledgeStaged(form, { allowDetached = false } = {}) {
        const controller = controllers.get(form);
        // Unregistered callers have no persisted draft. Registered forms must
        // acknowledge exactly the input captured when their request started.
        if (!controller) return true;
        if (!controller.stagedState) return false;
        if (controller.options.getRecord) controller.recordBase = clean(controller.options.getRecord());
        const staged = controller.stagedState;
        controller.stagedState = null;
        // A completed request belongs to the form that started it. Never let an
        // older modal's ACK clear or close a newer modal using the same draft key.
        const replacement = [...active].find(
            other => other !== controller && other.form.isConnected && controller.key && other.key === controller.key
        );
        if (replacement) {
            replacement.base = staged;
            if (replacement.options.getRecord) replacement.recordBase = clean(replacement.options.getRecord());
            persist(replacement.form);
            return false;
        }
        if (!form.isConnected) {
            const saved = read(controller.key);
            const changed = saved && !stateEqual(controller.options, saved.state, staged);
            if (changed || !allowDetached) {
                // Keep the newer stored state if there is no live replacement.
                // A review flow may explicitly ACK a detached original form only
                // when its staged input is still the latest saved draft.
                if (saved) {
                    try {
                        sessionStorage.setItem(controller.key, JSON.stringify({ ...saved, base: staged }));
                    } catch {
                        /* Leave the existing draft intact if storage is unavailable. */
                    }
                }
                return false;
            }
        }
        if (!stateEqual(controller.options, capture(form, controller.options), staged)) {
            controller.base = staged;
            persist(form);
            return false;
        }
        if (controller.key) {
            try {
                sessionStorage.removeItem(controller.key);
            } catch {
                /* ACK stays authoritative. */
            }
        }
        controller.acknowledged = true;
        controller.conflicts = [];
        controller.retained = {};
        return true;
    },
    acknowledge(form) {
        return this.acknowledgeStaged(form);
    },
    discard(form) {
        const controller = controllers.get(form);
        if (!controller) return;
        if (controller.key) {
            try {
                sessionStorage.removeItem(controller.key);
            } catch {
                /* Storage may be unavailable. */
            }
        }
        controller.acknowledged = true;
    },
    leave(form, { discard = false } = {}) {
        const controller = controllers.get(form);
        if (!controller) return true;
        const changed = dirty(controller);
        if (
            changed &&
            !window.confirm(
                discard
                    ? '放弃本次未保存输入并删除草稿？'
                    : controller.key
                      ? '还有未保存的输入。关闭后会保留业务草稿，是否继续关闭？'
                      : '此表单尚未启用草稿恢复，关闭会丢失未保存输入，是否继续？'
            )
        ) {
            return false;
        }
        if (discard) this.discard(form);
        else if (persist(form) !== true && changed && controller.key) return false;
        active.delete(controller);
        return true;
    },
    protectUnload(event) {
        let changed = false;
        for (const controller of active) {
            if (!controller.form.isConnected) continue;
            persist(controller.form);
            changed ||= dirty(controller);
        }
        if (changed) {
            event.preventDefault();
            event.returnValue = '';
        }
        return changed;
    },
    contactRows(form, { generateIds = false } = {}) {
        return [...form.querySelectorAll('#contactsContainer .contact-card')].map(row => {
            if (!row.dataset.contactId && generateIds) row.dataset.contactId = 'CONT-' + crypto.randomUUID();
            const contact = { id: row.dataset.contactId || '' };
            for (const [field, suffix] of Object.entries({
                name: 'name',
                position: 'position',
                email: 'email',
                phone: 'phone',
                mobilePhone: 'mobile',
                homeAddress: 'address'
            })) {
                const input = row.querySelector(`[name^="contact_${suffix}_"]`);
                contact[field] = input && usable(input) ? input.value : '';
            }
            return contact;
        });
    }
};
