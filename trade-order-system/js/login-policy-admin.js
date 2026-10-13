import { escapeHtml } from './utils.js';

const modes = [
    ['accounts', '账号登录（不要求邮箱）'],
    ['all', '邮箱登录 · 任意邮箱后缀'],
    ['domains', '邮箱登录 · 企业域名白名单'],
    ['addresses', '邮箱登录 · 指定邮箱白名单']
];

export function policyPanel(policy = {}) {
    const verification = policy.emailVerificationRequired === true;
    return `<div class="admin-panel-heading"><div><h3>登录方式与成员准入</h3><p>由管理员配置账号和权限，不开放自行注册。</p></div><button class="btn btn-primary" data-admin-action="login_policy">编辑登录规则</button></div>
        <div class="card"><div class="card-body"><p>准入模式：${escapeHtml(modes.find(([key]) => key === policy.mode)?.[1] || '尚未配置')}</p>
        <p>${escapeHtml((policy[policy.mode] || []).join('、'))}</p>
        <p>邮箱验证：${verification ? '已要求验证；新成员通过邮件设置本人密码' : '未要求邮件验证；由管理员配置登录名和密码'}</p>
        <p>登录入口：${escapeHtml(policy.publicOrigin || '可稍后配置')}</p>
        ${policy.setupRequired ? '<p>先选择登录方式。无 SMTP 时可使用账号登录并完成初始化，邮箱与通知可稍后配置。</p>' : ''}
        <p>公司、角色和数据范围仍须由管理员明确授权。</p></div></div>`;
}

export function editPolicy(center, formModal) {
    const current = center.state.loginPolicy || {};
    const setup = current.setupRequired === true;
    const smtpReady = current.smtpReady === true;
    formModal(
        '企业登录方式',
        `<label class="form-group"><span class="form-label">登录方式</span><select class="form-select" name="mode">${modes
            .map(([key, label]) => `<option value="${key}" ${(current.mode || 'accounts') === key ? 'selected' : ''}>${label}</option>`)
            .join('')}</select></label>
        ${setup ? `<label class="form-group"><span class="form-label">管理员邮箱（可留空）</span><input class="form-input" type="email" name="administratorEmail" value="${escapeHtml(current.administratorEmail || '')}"></label>` : ''}
        <label class="form-group"><span class="form-label">企业登录域名（发送验证邮件时必填）</span><input class="form-input" type="url" name="publicOrigin" placeholder="https://trade.company.com" value="${escapeHtml(current.publicOrigin || '')}"></label>
        <label class="form-group" data-policy-domains><span class="form-label">域名白名单（每行一个，例如 company.com）</span><textarea class="form-input" name="domains">${escapeHtml((current.domains || []).join('\n'))}</textarea></label>
        <label class="form-group" data-policy-addresses><span class="form-label">邮箱白名单（每行一个）</span><textarea class="form-input" name="addresses">${escapeHtml((current.addresses || []).join('\n'))}</textarea></label>
        <label class="form-group" data-policy-verification><input type="checkbox" name="emailVerificationRequired" ${smtpReady && current.emailVerificationRequired === true ? 'checked' : ''} ${smtpReady ? '' : 'disabled'}> 要求邮件验证并由成员设置密码</label>
        <p data-policy-mail-note>${smtpReady ? '启用邮件验证后，需要实际收取验证邮件。不启用时由管理员配置成员密码。' : 'SMTP 尚未配置，邮件验证不可启用。邮箱可选填，无须收取验证邮件。'}</p>
        ${setup ? '<label class="form-group" data-policy-send><input type="checkbox" name="sendVerification" disabled> 保存并发送管理员验证邮件</label><p>不要求邮件验证时，当前管理员账号和密码继续使用，不切换身份，也不会将邮箱标记为已验证。</p>' : '<p>规则保存后生效。邮箱白名单仍限制普通成员，不开放注册。</p>'}`,
        form => {
            const value = name => form.elements.namedItem(name)?.value?.trim() || '';
            const mode = value('mode');
            const verification = mode !== 'accounts' && smtpReady && form.elements.namedItem('emailVerificationRequired').checked;
            const list = name => value(name).split(/[\s,;，；]+/).filter(Boolean);
            return center.save('login-policy', {
                ...(setup ? {
                    administratorEmail: value('administratorEmail'),
                    sendVerification: verification && form.elements.namedItem('sendVerification').checked
                } : {}),
                publicOrigin: value('publicOrigin'),
                mode,
                emailVerificationRequired: verification,
                domains: list('domains'),
                addresses: list('addresses')
            });
        }
    );
    const form = document.querySelector('[name="emailVerificationRequired"]')?.form;
    if (!form) return;
    const sync = () => {
        const mode = form.elements.namedItem('mode').value;
        const mailbox = mode !== 'accounts';
        const proof = form.elements.namedItem('emailVerificationRequired');
        if (!mailbox || !smtpReady) proof.checked = false;
        proof.disabled = !mailbox || !smtpReady;
        form.querySelector('[data-policy-domains]').hidden = mode !== 'domains';
        form.querySelector('[data-policy-addresses]').hidden = mode !== 'addresses';
        form.querySelector('[data-policy-verification]').hidden = !mailbox;
        const verification = mailbox && smtpReady && proof.checked;
        form.elements.namedItem('publicOrigin').required = verification;
        const adminEmail = form.elements.namedItem('administratorEmail');
        if (adminEmail) adminEmail.required = verification;
        const send = form.elements.namedItem('sendVerification');
        if (send) {
            send.disabled = !verification;
            if (!verification) send.checked = false;
        }
    };
    form.elements.namedItem('mode').addEventListener('change', sync);
    form.elements.namedItem('emailVerificationRequired').addEventListener('change', sync);
    sync();
}
