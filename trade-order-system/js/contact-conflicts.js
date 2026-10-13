import { escapeHtml } from './utils.js';

const names = {
    name: '姓名',
    position: '职位',
    email: '邮箱',
    phone: '电话',
    mobilePhone: '手机',
    homeAddress: '地址'
};
const text = side =>
    side?.present
        ? typeof side.value === 'object'
            ? JSON.stringify(side.value)
            : String(side.value ?? '')
        : '已删除或未填写';

/** The user reviews a fresh server copy. No baseline changes until its CAS is accepted. */
export async function showContactConflicts({ api, DB, App, drafts, onSaved = () => {} }) {
    const previousForm = document.getElementById('customerForm');
    if (App.closeModal() === false) return false;
    let preview;
    try {
        preview = await api.prepareContactMerge({ expectedBaseVersion: DB._draftBaseVersion ?? api.lastMeta.version });
    } catch (error) {
        App.toast(error.message, 'warning');
        return false;
    }
    const blocked = preview.customers.some(customer => customer.plan.issues.length);
    const body = `<div id="contactMergeReview"><p>原读取版本 ${escapeHtml(preview.baseVersion)}，服务器版本 ${escapeHtml(preview.serverVersion)}。独立新增和不同字段的修改会合并；同一字段及删除冲突需要逐项选择。确认后仅提交联系人修改，其他资料使用服务器版本。</p>${preview.customers
        .map(
            customer => `
        <section class="form-section"><h3>${escapeHtml(customer.name)}</h3>
        ${customer.plan.issues.map(issue => `<p class="text-danger">${escapeHtml(issue.message || JSON.stringify(issue))}。此项需要人工核对，请保留或下载原草稿。</p>`).join('')}
        <details><summary>查看合并预览</summary><pre>${escapeHtml(JSON.stringify(customer.plan.proposal, null, 2))}</pre></details>
        ${customer.plan.conflicts
            .map(conflict => {
                const key = `${customer.id}:${conflict.id}`;
                const label =
                    conflict.kind === 'delete-vs-edit'
                        ? '联系人删除与修改冲突'
                        : names[conflict.field] || '联系人内容冲突';
                const option = side =>
                    conflict.kind === 'delete-vs-edit'
                        ? side.present
                            ? '确认保留此联系人（另一版本已删除）'
                            : '确认删除此联系人'
                        : side === conflict.local
                          ? '保留我的修改'
                          : '使用服务器版本';
                return `<div class="form-group"><label class="form-label">${escapeHtml(label)} · ${escapeHtml(conflict.contactId)}</label><p>我的版本：${escapeHtml(text(conflict.local))}</p><p>服务器版本：${escapeHtml(text(conflict.server))}</p><select class="form-select" data-contact-choice="${escapeHtml(key)}"><option value="">请选择</option><option value="local">${option(conflict.local)}</option><option value="server">${option(conflict.server)}</option></select></div>`;
            })
            .join('')}</section>`
        )
        .join('')}</div>`;
    App.showModal('核对联系人冲突', body, {
        large: true,
        footer: `<button class="btn btn-secondary" id="cancelContactMerge">暂不合并</button><button class="btn btn-primary" id="confirmContactMerge" ${blocked ? 'disabled' : ''}>确认合并并保存</button>`
    });
    const review = document.getElementById('contactMergeReview');
    const button = document.getElementById('confirmContactMerge');
    document.getElementById('cancelContactMerge').onclick = () => App.closeModal();
    button.onclick = async () => {
        const choices = Object.fromEntries(
            [...review.querySelectorAll('[data-contact-choice]')].map(input => [
                input.dataset.contactChoice,
                input.value
            ])
        );
        button.disabled = true;
        const previousBackup = localStorage.getItem(DB._BACKUP_KEY);
        try {
            const result = await api.applyContactMerge(preview.id, choices);
            DB.data = result.data;
            DB.exchangeRates = result.exchangeRates;
            DB.rateMetas = result.rateMetas;
            DB._cloudVersion = result.meta.version;
            DB._cloudUpdatedAt = result.meta.updatedAt;
            DB._saveConflict = false;
            DB._draftBaseVersion = undefined;
            DB._overlayLiveExchangeData?.();
            api.bindWorkingData(DB.data, DB.exchangeRates, DB.rateMetas);
            DB._clearLocalBackup(previousBackup);
            if (previousForm) drafts.acknowledgeStaged?.(previousForm, { allowDetached: true });
            if (document.getElementById('contactMergeReview') === review) App.closeModal();
            onSaved();
            App.updateSaveStatus('saved');
            App.toast('联系人已合并并保存', 'success');
            await App.router();
        } catch (error) {
            DB._handleSaveFailure?.(error);
            App.toast(error.message || '合并未保存，原草稿仍保留', 'warning');
            button.disabled = blocked;
        }
    };
    return true;
}
